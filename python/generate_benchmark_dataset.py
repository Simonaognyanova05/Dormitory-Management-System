"""Generate 12 distinct Bulgarian synthetic certificates and ground truth."""

import argparse
import io
import json
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image


NAMES = [
    "Иван Петров Иванов", "Мария Георгиева Петрова", "Георги Иванов Димитров",
    "Николай Тодоров Колев", "Елена Петрова Стоянова", "Петър Георгиев Николов",
    "Десислава Иванова Тодорова", "Александър Колев Петров", "Виктория Димитрова Иванова",
    "Даниела Стоянова Георгиева", "Стефан Николов Тодоров", "Радостина Петрова Колева",
]
SPECIALTIES = ["Компютърни системи и технологии", "Информатика и софтуерни науки", "Автоматика, информационна и управляваща техника", "Електроника"]
LABELS = {"fullName": "Студент", "facultyNumber": "Факултетен номер", "specialty": "Специалност", "yearOfStudy": "Курс"}
VARIANTS = ["clean_png", "clean_jpeg", "text_pdf", "scanned_pdf", "skewed", "low_contrast", "noise", "low_resolution", "exif_rotation", "two_page_pdf", "missing_specialty", "missing_year"]
ROMAN = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI"}


def certificate_pdf(fields, font, split=False):
    with pymupdf.open() as document:
        groups = [list(fields)[:2], list(fields)[2:]] if split else [list(fields)]
        for group in groups:
            page = document.new_page()
            page.insert_font(fontname="BenchmarkFont", fontbuffer=font.buffer)

            def text(y, value, size=14):
                remaining = page.insert_textbox(pymupdf.Rect(40, y, 555, y + 65), value, fontname="BenchmarkFont", fontsize=size)
                if remaining < 0:
                    raise ValueError("Synthetic text does not fit its reserved area.")

            text(50, "УВЕРЕНИЕ ЗА СТУДЕНТСКИ СТАТУС", 16)
            text(95, "СИНТЕТИЧЕН ПРИМЕР — НЕОФИЦИАЛЕН ДОКУМЕНТ", 10)
            for index, key in enumerate(group):
                value = fields[key]
                if value is None:
                    continue
                if key == "yearOfStudy":
                    value = ROMAN[value]
                text(180 + index * 95, f"{LABELS[key]}: {value}")
            text(660, "Учебна година: 2026/2027", 11)
            text(730, "Издава се само за тестване на софтуер.", 10)
        document.subset_fonts()
        return document.tobytes(garbage=4, deflate=True)


def render(pdf):
    with pymupdf.open(stream=pdf, filetype="pdf") as document:
        pixmap = document[0].get_pixmap(dpi=150, colorspace=pymupdf.csRGB, alpha=False)
        return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def encode(image, format="PNG", **options):
    output = io.BytesIO()
    image.save(output, format=format, **options)
    return output.getvalue()


def build_dataset():
    font = pymupdf.Font("cjk")  # Bundled font: no external/system font dependency.
    required = "".join(NAMES + SPECIALTIES + list(LABELS.values()) + ["УВЕРЕНИЕ ЗА СТУДЕНТСКИ СТАТУС — НЕОФИЦИАЛЕН ДОКУМЕНТ"])
    if not all(character.isspace() or font.has_glyph(ord(character)) for character in required):
        raise ValueError("The bundled font must support the Bulgarian source text.")
    files = {}
    documents = []
    random = np.random.default_rng(42)
    for index, variant in enumerate(VARIANTS):
        fields = {"fullName": NAMES[index], "facultyNumber": f"00012{index + 1:04d}", "specialty": SPECIALTIES[index % len(SPECIALTIES)], "yearOfStudy": index % 6 + 1}
        if variant == "missing_specialty": fields["specialty"] = None
        if variant == "missing_year": fields["yearOfStudy"] = None
        pdf = certificate_pdf(fields, font, split=variant == "two_page_pdf")
        extension, mime_type = ".png", "image/png"
        if variant in {"text_pdf", "two_page_pdf"}:
            content, extension, mime_type = pdf, ".pdf", "application/pdf"
        else:
            image = render(pdf)
            if variant == "skewed": image = image.rotate(4, resample=Image.Resampling.BICUBIC, expand=True, fillcolor="white")
            if variant == "low_contrast": image = Image.fromarray((165 + np.asarray(image).astype(np.float32) * 55 / 255).astype(np.uint8))
            if variant == "noise": image = Image.fromarray(np.clip(np.asarray(image).astype(np.float32) + random.normal(0, 8, (image.height, image.width, 3)), 0, 255).astype(np.uint8))
            if variant == "low_resolution": image.thumbnail((900, 900), Image.Resampling.LANCZOS)
            if variant == "exif_rotation":
                image = image.rotate(90, expand=True)
                exif = Image.Exif()
                exif[274] = 6
                content, extension, mime_type = encode(image, "JPEG", quality=90, exif=exif), ".jpg", "image/jpeg"
            elif variant in {"clean_jpeg", "noise"}:
                content, extension, mime_type = encode(image, "JPEG", quality=88), ".jpg", "image/jpeg"
            elif variant == "scanned_pdf":
                with pymupdf.open() as document:
                    page = document.new_page()
                    page.insert_image(page.rect, stream=encode(image))
                    content = document.tobytes(deflate=True)
                extension, mime_type = ".pdf", "application/pdf"
            else:
                content = encode(image)
        identifier = f"cert-{index + 1:03d}"
        filename = identifier + extension
        files[filename] = content
        documents.append({"id": identifier, "file": filename, "mimeType": mime_type, "documentType": "student_certificate", "quality": variant, "expectedFields": fields})
    manifest = {"schemaVersion": 1, "datasetId": "bg-certificates-early-v1", "synthetic": True, "language": "bg", "description": "12 synthetic Bulgarian layouts/qualities with distinct known values. Early check only, not the final 30-document benchmark.", "documents": documents}
    files["dataset.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return files, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("tmp/benchmark-certificates"))
    args = parser.parse_args()
    files, manifest = build_dataset()
    written = []
    try:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        if any((args.output_dir / name).exists() for name in files):
            parser.exit(2, "Dataset files already exist. Choose another output directory.\n")
        for name, content in files.items():
            path = args.output_dir / name
            with path.open("xb") as output:
                written.append(path)
                output.write(content)
    except OSError:
        for path in written: path.unlink(missing_ok=True)
        parser.exit(1, "Could not write the benchmark dataset.\n")
    print(f"Generated {len(manifest['documents'])} synthetic Bulgarian certificates and dataset.json.")


if __name__ == "__main__":
    main()
