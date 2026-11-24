"""Generate a synthetic Bulgarian placement order in PDF/PNG/JPG formats."""

import argparse
import io
import json
from pathlib import Path

import pymupdf
from PIL import Image


EXPECTED_FIELDS = {"orderNumber": "РД-001", "orderDate": "2026-11-03", "dormitory": "01", "room": "012А"}


def build_demo():
    font = pymupdf.Font("cjk")
    lines = [
        (50, "ЗАПОВЕД ЗА НАСТАНЯВАНЕ", 17),
        (95, "СИНТЕТИЧЕН ПРИМЕР — НЕОФИЦИАЛЕН ДОКУМЕНТ", 10),
        (180, "Заповед № РД-001", 14),
        (260, "Дата на заповедта: 3.11.2026 г.", 14),
        (340, "Общежитие: 01", 14),
        (420, "Стая: 012А", 14),
        (550, "Начална дата на настаняване: 10.11.2026 г.", 12),
        (730, "Документът служи само за софтуерни тестове.", 10),
    ]
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_font(fontname="OrderDemoFont", fontbuffer=font.buffer)
        for y, text, size in lines:
            if page.insert_textbox(pymupdf.Rect(40, y, 555, y + 65), text, fontsize=size, fontname="OrderDemoFont") < 0:
                raise ValueError("Synthetic order text does not fit its reserved area.")
        document.subset_fonts()
        pdf = document.tobytes(garbage=4, deflate=True)
    with pymupdf.open(stream=pdf, filetype="pdf") as document:
        pixmap = document[0].get_pixmap(dpi=150, colorspace=pymupdf.csRGB, alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    files = {"placement-order.pdf": pdf}
    for format, suffix in (("PNG", "png"), ("JPEG", "jpg")):
        output = io.BytesIO()
        image.save(output, format=format)
        files[f"placement-order.{suffix}"] = output.getvalue()
    files["expected-fields.json"] = (json.dumps(EXPECTED_FIELDS, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("tmp/order-demo"))
    args = parser.parse_args()
    files = build_demo()
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
        for path in written: path.unlink(missing_ok=True)
        parser.exit(1, "Could not write order demo files.\n")
    print("Generated a synthetic placement order in PDF/PNG/JPG and expected-fields.json.")


if __name__ == "__main__":
    main()
