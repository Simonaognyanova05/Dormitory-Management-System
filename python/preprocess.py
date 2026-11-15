"""Standalone preview CLI and raw-stdin preparation entry point for task 7."""

import argparse
import base64
import json
import sys
from pathlib import Path

import cv2

from preprocessing import MIME_TYPES, PreparationError, PreparationOptions, prepare_document


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # Do not echo arbitrary filenames or argument values into machine diagnostics.
        raise PreparationError(400, "invalid_request", "Invalid command line arguments. Use --help.")


def parse_arguments(argv):
    parser = Parser(description="Prepare PDF/JPG/PNG pages for vision extraction; no OCR or AI calls.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Local file to read without modifying it")
    source.add_argument("--stdin", action="store_true", help="Read raw file bytes from stdin")
    parser.add_argument("--mime-type", choices=sorted(MIME_TYPES), help="Required for stdin; inferred from the extension for local files")
    parser.add_argument("--output-dir", type=Path, help="Optionally save PNG previews and manifest.json; never overwrite existing output files")
    parser.add_argument("--max-file-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--max-pages", type=int, default=3)
    parser.add_argument("--max-pixels", type=int, default=20_000_000)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--max-side", type=int, default=2000)
    parser.add_argument("--rotate", type=int, default=0, help="Explicit clockwise rotation: 0, 90, 180 or 270")
    parser.add_argument("--no-deskew", action="store_true")
    parser.add_argument("--no-contrast", action="store_true")
    parser.add_argument("--denoise", action="store_true", help="Opt-in edge-preserving noise reduction")
    return parser.parse_args(argv)


def write_previews(result, output_dir):
    written = []
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        targets = [output_dir / f"page-{page['pageNumber']:03d}.png" for page in result["pages"]]
        targets.append(output_dir / "manifest.json")
        if any(path.exists() for path in targets):
            raise PreparationError(400, "invalid_request", "Preview outputs already exist. Choose another output directory.")
        manifest = {"status": result["status"], "pageCount": result["pageCount"], "pages": []}
        for page, path in zip(result["pages"], targets):
            with path.open("xb") as output:
                written.append(path)
                output.write(base64.b64decode(page["contentBase64"], validate=True))
            metadata = {key: value for key, value in page.items() if key != "contentBase64"}
            manifest["pages"].append({**metadata, "outputFile": path.name})
        with targets[-1].open("x", encoding="utf-8") as output:
            written.append(targets[-1])
            json.dump(manifest, output, ensure_ascii=True, indent=2)
    except (OSError, PreparationError) as error:
        for path in written:
            try:
                path.unlink()
            except OSError:
                pass
        if isinstance(error, PreparationError):
            raise
        raise PreparationError(500, "internal_error", "Could not write preview files.") from error


def run(argv=None):
    args = parse_arguments(argv)
    options = PreparationOptions(
        max_file_bytes=args.max_file_bytes, max_pages=args.max_pages,
        max_pixels=args.max_pixels, dpi=args.dpi, max_side=args.max_side,
        rotate_clockwise=args.rotate, deskew=not args.no_deskew,
        enhance_contrast=not args.no_contrast, denoise=args.denoise,
    )
    mime_type = args.mime_type
    if mime_type is None and args.input:
        mime_type = {".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}.get(args.input.suffix.lower())
    if mime_type is None:
        raise PreparationError(400, "invalid_request", "Supply a supported MIME type or file extension.")

    try:
        if args.stdin:
            content = sys.stdin.buffer.read(options.max_file_bytes + 1)
        else:
            with args.input.open("rb") as source:
                content = source.read(options.max_file_bytes + 1)
    except OSError as error:
        raise PreparationError(400, "invalid_request", "Could not read the input file.") from error

    result = prepare_document(content, mime_type, options)
    if args.output_dir:
        write_previews(result, args.output_dir)
    return result


def main(argv=None):
    cv2.setNumThreads(1)
    try:
        result = run(argv)
        exit_code = 0
    except PreparationError as error:
        result = error.payload()
        exit_code = 1 if error.status >= 500 else 2
        print(f"[preprocess] {error.code}", file=sys.stderr)
    except Exception:
        result = PreparationError(500, "internal_error", "Document preparation failed.").payload()
        exit_code = 1
        print("[preprocess] internal_error", file=sys.stderr)
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
