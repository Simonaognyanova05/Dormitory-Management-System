"""Generate clearly synthetic inputs for visually checking preprocessing."""

import argparse
import io
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageDraw, ImageFont


LINES = [
    "SYNTHETIC STUDENT CERTIFICATE",
    "Demonstration only - not an official document",
    "Student: Ivan Petrov Ivanov",
    "Faculty number: 001234567",
    "Specialty: Computer Systems and Technologies",
    "Year of study: II",
]


def sample_image(background=255, foreground=0):
    image = Image.new("RGB", (1000, 1400), (background,) * 3)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=32)
    for index, text in enumerate(LINES):
        y = 100 + index * 150
        draw.text((60, y), text, fill=(foreground,) * 3, font=font)
        draw.line((60, y + 65, 940, y + 65), fill=(foreground,) * 3, width=2)
    return image


def encode(image, format="PNG", **kwargs):
    output = io.BytesIO()
    image.save(output, format=format, **kwargs)
    return output.getvalue()


def build_samples():
    clean = sample_image()
    sideways = clean.rotate(90, expand=True, fillcolor="white")
    exif = Image.Exif()
    exif[274] = 6
    random = np.random.default_rng(42)
    noisy = np.clip(np.asarray(clean).astype(np.float32) + random.normal(0, 12, (1400, 1000, 3)), 0, 255).astype(np.uint8)
    files = {
        "certificate-clean.png": encode(clean),
        "certificate-tilted.png": encode(clean.rotate(5, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="white")),
        "certificate-faded.png": encode(sample_image(220, 165)),
        "certificate-sideways.png": encode(sideways),
        "certificate-exif.jpg": encode(sideways, "JPEG", exif=exif),
        "certificate-noisy.png": encode(Image.fromarray(noisy)),
    }
    with pymupdf.open() as document:
        page = document.new_page()
        for index, text in enumerate(LINES):
            page.insert_text((40, 80 + index * 60), text, fontsize=12)
        files["certificate-text.pdf"] = document.tobytes()
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=840)
        page.insert_image(page.rect, stream=files["certificate-clean.png"])
        files["certificate-scanned.pdf"] = document.tobytes()
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("tmp/demo-inputs"))
    args = parser.parse_args()
    files = build_samples()
    written = []
    try:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        if any((args.output_dir / name).exists() for name in files):
            parser.exit(2, "Demo files already exist. Choose another output directory.\n")
        for name, content in files.items():
            path = args.output_dir / name
            with path.open("xb") as output:
                written.append(path)
                output.write(content)
    except OSError:
        for path in written:
            path.unlink(missing_ok=True)
        parser.exit(1, "Could not write demo files.\n")
    print(f"Generated {len(files)} synthetic demo documents.")


if __name__ == "__main__":
    main()
