import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
import pymupdf
from PIL import Image, ImageDraw

PYTHON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_DIR))

from preprocessing import PreparationError, PreparationOptions, prepare_document


def encode_image(image, format="PNG", **kwargs):
    output = io.BytesIO()
    image.save(output, format=format, **kwargs)
    return output.getvalue()


def decode_page(page):
    with Image.open(io.BytesIO(base64.b64decode(page["contentBase64"], validate=True))) as image:
        image.load()
        return image.copy()


def paragraph_image(background=255, foreground=0):
    pixels = np.full((700, 1000, 3), background, dtype=np.uint8)
    for index in range(8):
        y = 80 + index * 75
        cv2.putText(pixels, "STUDENT CERTIFICATE 001234567", (70, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (foreground,) * 3, 2)
        cv2.line(pixels, (70, y + 15), (900, y + 15), (foreground,) * 3, 2)
    return Image.fromarray(pixels)


def pdf_bytes(pages=1, scanned=False, rotation=0, encrypted=False, large_page=False):
    with pymupdf.open() as document:
        for _ in range(pages):
            page = document.new_page(width=20000 if large_page else 600, height=30000 if large_page else 800)
            if scanned:
                page.insert_image(page.rect, stream=encode_image(paragraph_image()))
                assert page.get_text().strip() == ""
            else:
                page.insert_text((50, 80), "SYNTHETIC STUDENT CERTIFICATE 001234567")
            page.set_rotation(rotation)
        if encrypted:
            return document.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="synthetic-owner", user_pw="synthetic-user")
        return document.tobytes()


class PreparationTests(unittest.TestCase):
    def assert_preparation_error(self, content, mime_type, code, **options):
        with self.assertRaises(PreparationError) as raised:
            prepare_document(content, mime_type, PreparationOptions(**options))
        self.assertEqual(raised.exception.code, code)

    def test_text_and_scanned_pdf_pages_render_in_order(self):
        for scanned in (False, True):
            with self.subTest(scanned=scanned):
                result = prepare_document(pdf_bytes(3, scanned=scanned), "application/pdf")
                self.assertEqual(result["status"], "prepared")
                self.assertEqual(result["pageCount"], 3)
                self.assertEqual([page["pageNumber"] for page in result["pages"]], [1, 2, 3])
                for page in result["pages"]:
                    image = decode_page(page)
                    self.assertEqual(image.mode, "RGB")
                    self.assertEqual(image.size, (page["width"], page["height"]))
                    self.assertLessEqual(max(image.size), 2000)
                    self.assertLess(np.asarray(image).min(), 100)

    def test_jpg_and_png_inputs_are_supported(self):
        for format, mime_type in (("JPEG", "image/jpeg"), ("PNG", "image/png")):
            with self.subTest(format=format):
                result = prepare_document(encode_image(paragraph_image(), format), mime_type)
                self.assertEqual(result["pageCount"], 1)
                self.assertEqual(result["pages"][0]["mimeType"], "image/png")
                self.assertEqual(decode_page(result["pages"][0]).mode, "RGB")

    def test_distinct_pdf_page_content_keeps_its_order(self):
        with pymupdf.open() as document:
            for color in ((1, 0, 0), (0, 0, 1)):
                page = document.new_page(width=200, height=300)
                page.draw_rect(pymupdf.Rect(20, 20, 120, 120), color=color, fill=color)
            result = prepare_document(document.tobytes(), "application/pdf", PreparationOptions(dpi=72, deskew=False, enhance_contrast=False))
        self.assertEqual(decode_page(result["pages"][0]).getpixel((50, 50)), (255, 0, 0))
        self.assertEqual(decode_page(result["pages"][1]).getpixel((50, 50)), (0, 0, 255))

    def test_exif_orientation_is_applied(self):
        image = Image.new("RGB", (100, 60), "white")
        ImageDraw.Draw(image).rectangle((0, 0, 25, 25), fill="red")
        exif = Image.Exif()
        exif[274] = 6  # Display the stored image rotated 90 degrees clockwise.
        data = encode_image(image, "JPEG", exif=exif)
        page = prepare_document(data, "image/jpeg", PreparationOptions(deskew=False, enhance_contrast=False))["pages"][0]
        self.assertEqual((page["width"], page["height"]), (60, 100))
        self.assertTrue(page["transforms"]["exifOrientationApplied"])
        red, green, blue = decode_page(page).getpixel((50, 10))
        self.assertGreater(red, 180)
        self.assertLess(green + blue, 100)

    def test_pdf_rotation_metadata_is_respected(self):
        page = prepare_document(pdf_bytes(rotation=90), "application/pdf", PreparationOptions(dpi=72, deskew=False))["pages"][0]
        self.assertEqual((page["width"], page["height"]), (800, 600))
        self.assertEqual(page["transforms"]["pdfRotationDegrees"], 90)

    def test_explicit_clockwise_rotation_does_not_require_orientation_detection(self):
        image = Image.new("RGB", (100, 60), "white")
        ImageDraw.Draw(image).rectangle((0, 0, 20, 20), fill="red")
        page = prepare_document(encode_image(image), "image/png", PreparationOptions(rotate_clockwise=90, deskew=False, enhance_contrast=False))["pages"][0]
        self.assertEqual(decode_page(page).size, (60, 100))
        self.assertEqual(decode_page(page).getpixel((50, 10)), (255, 0, 0))
        self.assertEqual(page["transforms"]["manualRotationClockwiseDegrees"], 90)

    def test_deskew_reduces_tilt_without_cropping_known_rules(self):
        for angle in (-6, 6):
            with self.subTest(angle=angle):
                image = paragraph_image().rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="white")
                page = prepare_document(encode_image(image), "image/png", PreparationOptions(enhance_contrast=False))["pages"][0]
                self.assertAlmostEqual(page["transforms"]["deskewCounterClockwiseDegrees"], -angle, delta=1)
                gray = cv2.cvtColor(np.asarray(decode_page(page)), cv2.COLOR_RGB2GRAY)
                _, mask = cv2.threshold(gray, 100, 255, cv2.THRESH_BINARY_INV)
                _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
                long_rules = [item for item in stats[1:] if item[cv2.CC_STAT_WIDTH] > 650]
                self.assertEqual(len(long_rules), 8)
                self.assertTrue(all(item[cv2.CC_STAT_HEIGHT] < 18 for item in long_rules))

    def test_blank_page_is_not_rotated_or_given_fabricated_text(self):
        page = prepare_document(encode_image(Image.new("RGB", (400, 500), "white")), "image/png")["pages"][0]
        self.assertEqual(page["transforms"]["deskewCounterClockwiseDegrees"], 0)
        self.assertTrue(np.all(np.asarray(decode_page(page)) == 255))

    def test_faded_text_has_wider_contrast_after_auto_enhancement(self):
        source = paragraph_image(background=220, foreground=165)
        page = prepare_document(encode_image(source), "image/png", PreparationOptions(deskew=False))["pages"][0]
        self.assertTrue(page["transforms"]["contrastEnhanced"])
        self.assertGreater(np.asarray(decode_page(page)).std(), np.asarray(source).std() * 1.5)

    def test_high_contrast_input_is_unchanged_when_no_transform_is_needed(self):
        source = paragraph_image()
        page = prepare_document(encode_image(source), "image/png", PreparationOptions(deskew=False))["pages"][0]
        self.assertFalse(page["transforms"]["contrastEnhanced"])
        self.assertFalse(page["transforms"]["denoised"])
        np.testing.assert_array_equal(np.asarray(source), np.asarray(decode_page(page)))

    def test_opt_in_denoising_reduces_background_noise(self):
        random = np.random.default_rng(42)
        pixels = np.clip(200 + random.normal(0, 8, (300, 400, 3)), 0, 255).astype(np.uint8)
        cv2.putText(pixels, "001234567", (30, 220), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
        page = prepare_document(encode_image(Image.fromarray(pixels)), "image/png", PreparationOptions(deskew=False, enhance_contrast=False, denoise=True))["pages"][0]
        prepared = np.asarray(decode_page(page))
        self.assertTrue(page["transforms"]["denoised"])
        self.assertLess(prepared[:100].std(), pixels[:100].std() * 0.8)
        self.assertLess(prepared.min(), 10)

    def test_transparency_is_flattened_onto_white(self):
        image = Image.new("RGBA", (100, 80), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((10, 10, 30, 30), fill=(0, 0, 0, 255))
        page = prepare_document(encode_image(image), "image/png", PreparationOptions(deskew=False, enhance_contrast=False))["pages"][0]
        prepared = decode_page(page)
        self.assertEqual(prepared.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(prepared.getpixel((20, 20)), (0, 0, 0))

    def test_large_image_and_large_pdf_pages_have_bounded_output(self):
        image = Image.new("RGB", (2500, 1500), "white")
        for content, mime_type in ((encode_image(image), "image/png"), (pdf_bytes(large_page=True), "application/pdf")):
            with self.subTest(mime_type=mime_type):
                page = prepare_document(content, mime_type, PreparationOptions(max_side=600))["pages"][0]
                self.assertLessEqual(max(page["width"], page["height"]), 600)

    def test_malformed_files_and_mime_mismatches_are_rejected(self):
        for content, mime_type in ((b"%PDF-1.7 corrupt", "application/pdf"), (b"not an image", "image/png"), (encode_image(Image.new("RGB", (10, 10)), "JPEG"), "image/png")):
            with self.subTest(mime_type=mime_type):
                self.assert_preparation_error(content, mime_type, "unsupported_file")

    def test_encrypted_and_overlong_pdfs_are_rejected(self):
        self.assert_preparation_error(pdf_bytes(encrypted=True), "application/pdf", "unreadable_document")
        self.assert_preparation_error(pdf_bytes(4), "application/pdf", "page_limit_exceeded")

    def test_input_pixel_and_byte_limits_are_checked(self):
        data = encode_image(Image.new("RGB", (100, 100), "white"))
        self.assert_preparation_error(data, "image/png", "file_too_large", max_pixels=100)
        self.assert_preparation_error(data, "image/png", "file_too_large", max_file_bytes=20)

    def test_truncated_image_and_invalid_options_are_rejected(self):
        data = encode_image(paragraph_image())
        self.assert_preparation_error(data[:100], "image/png", "unsupported_file")
        for options in ({"max_pages": 4}, {"max_side": 100000}, {"rotate_clockwise": 45}):
            with self.subTest(options=options), self.assertRaises(PreparationError):
                PreparationOptions(**options)


class CommandLineTests(unittest.TestCase):
    def cli(self, *arguments, content=None):
        return subprocess.run([sys.executable, str(PYTHON_DIR / "preprocess.py"), *arguments], input=content, capture_output=True, timeout=20)

    def test_raw_stdin_returns_one_json_object_without_native_diagnostics(self):
        result = self.cli("--stdin", "--mime-type", "application/pdf", content=pdf_bytes(scanned=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "prepared")
        self.assertEqual(payload["pageCount"], 1)

    def test_invalid_input_has_safe_json_error_and_nonzero_exit(self):
        for content, mime_type in ((b"private-document-text", "image/png"), (b"%PDF-1.7 private-document-text", "application/pdf")):
            with self.subTest(mime_type=mime_type):
                result = self.cli("--stdin", "--mime-type", mime_type, content=content)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout)["error"]["code"], "unsupported_file")
                self.assertNotIn(b"private-document-text", result.stdout + result.stderr)

    def test_local_preview_does_not_change_input_or_overwrite_previous_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            original = encode_image(paragraph_image())
            source.write_bytes(original)
            output = Path(directory) / "previews"
            result = self.cli("--input", str(source), "--output-dir", str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(source.read_bytes(), original)
            preview = (output / "page-001.png").read_bytes()
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertNotIn("contentBase64", manifest["pages"][0])
            repeated = self.cli("--input", str(source), "--output-dir", str(output))
            self.assertEqual(repeated.returncode, 2)
            self.assertEqual(json.loads(repeated.stdout)["error"]["code"], "invalid_request")
            self.assertEqual((output / "page-001.png").read_bytes(), preview)
            self.assertEqual(source.read_bytes(), original)

    def test_invalid_arguments_do_not_echo_arbitrary_argument_values(self):
        result = self.cli("--input", "private-filename.png", "--rotate", "not-a-number")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "invalid_request")
        self.assertNotIn(b"private-filename", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
