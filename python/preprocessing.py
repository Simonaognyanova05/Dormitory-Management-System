"""Bounded, in-memory preparation of PDF/JPG/PNG pages for vision extraction."""

import base64
import io
import math
import warnings
from dataclasses import dataclass

import cv2
import numpy as np
import pymupdf
from PIL import Image, ImageOps

# Keep the future child-process stdout protocol free of native-library diagnostics.
pymupdf.TOOLS.mupdf_display_errors(False)
pymupdf.TOOLS.mupdf_display_warnings(False)

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 3
MAX_IMAGE_PIXELS = 20_000_000
MIME_TYPES = {"application/pdf", "image/jpeg", "image/png"}


class PreparationError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}

    def payload(self):
        return {"error": {
            "code": self.code,
            "message": self.message,
            "retryable": False,
            "details": self.details,
        }}


@dataclass(frozen=True)
class PreparationOptions:
    max_file_bytes: int = MAX_FILE_BYTES
    max_pages: int = MAX_PDF_PAGES
    max_pixels: int = MAX_IMAGE_PIXELS
    dpi: int = 150
    max_side: int = 2000
    rotate_clockwise: int = 0
    deskew: bool = True
    enhance_contrast: bool = True
    denoise: bool = False

    def __post_init__(self):
        ranges = {
            "max_file_bytes": (1, MAX_FILE_BYTES),
            "max_pages": (1, MAX_PDF_PAGES),
            "max_pixels": (1, MAX_IMAGE_PIXELS),
            "dpi": (72, 300),
            "max_side": (128, 2400),
        }
        for name, (minimum, maximum) in ranges.items():
            value = getattr(self, name)
            if type(value) is not int or not minimum <= value <= maximum:
                raise PreparationError(400, "invalid_request", f"Invalid preprocessing option: {name}.")
        if type(self.rotate_clockwise) is not int or self.rotate_clockwise not in {0, 90, 180, 270}:
            raise PreparationError(400, "invalid_request", "Rotation must be 0, 90, 180 or 270 degrees.")


def _unsupported():
    return PreparationError(415, "unsupported_file", "Invalid file or MIME type mismatch.")


def _flatten_rgb(image):
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    background.alpha_composite(rgba)
    return background.convert("RGB")


def _resize(image, maximum):
    if max(image.size) <= maximum:
        return image, False
    resized = image.copy()
    resized.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
    return resized, True


def estimate_deskew(rgb):
    """Estimate a small corrective CCW rotation; never infer 90/180-degree turns."""
    height, width = rgb.shape[:2]
    if min(height, width) < 80:
        return 0.0
    if max(height, width) > 1000:
        scale = 1000 / max(height, width)
        rgb = cv2.resize(rgb, (max(1, round(width * scale)), max(1, round(height * scale))))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    foreground = np.count_nonzero(mask) / mask.size
    if not 0.001 <= foreground <= 0.35:
        return 0.0

    width = mask.shape[1]
    joined = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((1, max(3, width // 100)), np.uint8))
    lines = cv2.HoughLinesP(
        joined, 1, np.pi / 180, threshold=max(20, width // 30),
        minLineLength=max(40, width // 8), maxLineGap=max(10, width // 40),
    )
    if lines is None:
        return 0.0

    candidates = []
    for x1, y1, x2, y2 in lines[:, 0]:
        dx, dy = float(x2 - x1), float(y2 - y1)
        angle = math.degrees(math.atan2(dy, dx))
        angle = (angle + 90) % 180 - 90
        if abs(angle) <= 10:
            candidates.append((angle, math.hypot(dx, dy)))
    if len(candidates) < 3:
        return 0.0

    candidates.sort()
    half_weight = sum(length for _, length in candidates) / 2
    weight = 0.0
    angle = 0.0
    for candidate, length in candidates:
        weight += length
        if weight >= half_weight:
            angle = candidate
            break
    consistent = sum(length for candidate, length in candidates if abs(candidate - angle) <= 1.5)
    if consistent < 0.7 * (half_weight * 2) or abs(angle) < 0.3:
        return 0.0
    return round(angle, 3)


def _enhance_contrast(rgb):
    # Stretch luminance only for a genuinely narrow range; preserve chromatic channels.
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    luminance = lab[:, :, 0]
    low, high = np.percentile(luminance, (0.5, 99.5))
    if not 1 < high - low < 140:
        return rgb, False
    lab[:, :, 0] = np.clip((luminance.astype(np.float32) - low) * 255 / (high - low), 0, 255).astype(np.uint8)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), True


def _prepare_page(image, options, page_number, *, exif_applied=False, pdf_rotation=0):
    image = _flatten_rgb(image)
    if options.rotate_clockwise:
        image = image.rotate(-options.rotate_clockwise, expand=True, fillcolor="white")
    image, resized = _resize(image, options.max_side)
    angle = estimate_deskew(np.asarray(image)) if options.deskew else 0.0
    if angle:
        # Expansion avoids cropping edge text; resize again to retain the output bound.
        image = image.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="white")
        image, resized_after_rotation = _resize(image, options.max_side)
        resized = resized or resized_after_rotation

    rgb = np.asarray(image)
    contrast_applied = False
    if options.enhance_contrast:
        rgb, contrast_applied = _enhance_contrast(rgb)
    if options.denoise:
        # Opt-in, edge-preserving filtering rather than aggressive thresholding.
        rgb = cv2.bilateralFilter(rgb, d=5, sigmaColor=25, sigmaSpace=3)

    output = io.BytesIO()
    prepared = Image.fromarray(rgb)
    prepared.save(output, format="PNG")
    return {
        "pageNumber": page_number,
        "mimeType": "image/png",
        "width": prepared.width,
        "height": prepared.height,
        "contentBase64": base64.b64encode(output.getvalue()).decode("ascii"),
        "transforms": {
            "exifOrientationApplied": exif_applied,
            "pdfRotationDegrees": pdf_rotation,
            "manualRotationClockwiseDegrees": options.rotate_clockwise,
            "deskewCounterClockwiseDegrees": angle,
            "resized": resized,
            "contrastEnhanced": contrast_applied,
            "denoised": options.denoise,
        },
    }


def _prepare_pdf(content, options):
    if not content.startswith(b"%PDF-"):
        raise _unsupported()
    try:
        with pymupdf.open(stream=content, filetype="pdf") as document:
            if document.needs_pass or document.is_encrypted:
                raise PreparationError(422, "unreadable_document", "Password-protected PDFs are not supported.")
            if document.page_count == 0:
                raise PreparationError(422, "unreadable_document", "PDF has no pages.")
            if document.page_count > options.max_pages:
                raise PreparationError(413, "page_limit_exceeded", "PDF exceeds the configured page limit.", {"maxPages": options.max_pages})

            pages = []
            for number, page in enumerate(document, 1):
                dimensions = (page.rect.width, page.rect.height)
                if any(not math.isfinite(value) or value <= 0 for value in dimensions):
                    raise PreparationError(422, "unreadable_document", "Invalid PDF page dimensions.")
                # Cap dimensions before rasterization, even for unusually large PDF pages.
                scale = min(options.dpi / 72, options.max_side / max(dimensions))
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
                image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                pages.append(_prepare_page(image, options, number, pdf_rotation=page.rotation))
            return pages
    except PreparationError:
        raise
    except (RuntimeError, ValueError, OSError) as error:
        raise _unsupported() from error


def _prepare_image(content, mime_type, options):
    expected = "JPEG" if mime_type == "image/jpeg" else "PNG"
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with Image.open(io.BytesIO(content)) as source:
                if source.format != expected or getattr(source, "n_frames", 1) != 1:
                    raise _unsupported()
                if source.width * source.height > options.max_pixels:
                    raise PreparationError(413, "file_too_large", "Image exceeds the configured pixel limit.", {"maxPixels": options.max_pixels})
                source.verify()
            with Image.open(io.BytesIO(content)) as source:
                orientation = source.getexif().get(274, 1)
                image = ImageOps.exif_transpose(source)
                image.load()
                return [_prepare_page(image, options, 1, exif_applied=orientation in range(2, 9))]
    except PreparationError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
        raise PreparationError(413, "file_too_large", "Image dimensions are too large.") from error
    except (OSError, ValueError, SyntaxError, Warning) as error:
        raise _unsupported() from error


def prepare_document(content, mime_type, options=None):
    options = options or PreparationOptions()
    if mime_type not in MIME_TYPES:
        raise _unsupported()
    if not isinstance(content, bytes) or not content:
        raise _unsupported()
    if len(content) > options.max_file_bytes:
        raise PreparationError(413, "file_too_large", "File exceeds the configured byte limit.", {"maxBytes": options.max_file_bytes})
    pages = _prepare_pdf(content, options) if mime_type == "application/pdf" else _prepare_image(content, mime_type, options)
    return {"status": "prepared", "pageCount": len(pages), "pages": pages}
