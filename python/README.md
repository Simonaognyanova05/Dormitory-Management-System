# Python Document Preparation

Task 6 implements standalone preparation of **PDF, scanned PDF, JPG, and PNG** inputs. This is image preprocessing, not OCR: no text fields are extracted and no AI service is called.

Node.js invokes this entry point through `child_process.spawn()` for valid requests, then passes the prepared pages to the configured real or mock vision client. The certificate's semantic validator classifies the HTTP result as completed or partial; mock extraction is always partial and labeled. Python-only commands still make no AI calls.

## Environment

Python **3.10+**. From the repository root in Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python/requirements.txt
```

For the Node.js integration, set this in the root `.env` and restart the HTTP service:

```dotenv
PYTHON_COMMAND=.venv/Scripts/python.exe
```

On Linux/macOS, use `python3 -m venv .venv`, `.venv/bin/python -m pip install -r python/requirements.txt`, and `PYTHON_COMMAND=.venv/bin/python`.

Run `npm run check:python` from the repository root to verify the configured executable and libraries through the actual Node.js adapter. It prints metadata for a tiny synthetic PNG and makes no AI calls.

Dependencies: PyMuPDF renders PDFs; Pillow decodes images and applies orientation metadata; OpenCV and NumPy provide bounded image analysis and transformations. Headless OpenCV has no desktop GUI requirement.

## Generate Documents for a First Test

No real student documents are needed for this stage:

```powershell
.\.venv\Scripts\python.exe python/generate_demo_documents.py
```

This creates eight clearly synthetic files in the ignored `tmp/demo-inputs/` folder: a clean certificate image, tilted/faded/noisy variants, sideways and EXIF-oriented variants, a text PDF, and an image-only scanned PDF. The labels are English and the values are synthetic; they are preprocessing examples, not real Bulgarian templates or an OCR benchmark.

Existing demo files are not overwritten. Choose a different folder for another set:

```powershell
.\.venv\Scripts\python.exe python/generate_demo_documents.py --output-dir tmp/demo-inputs-2
```

For task 10, [generate_benchmark_dataset.py](generate_benchmark_dataset.py) creates a separate 12-document **Bulgarian** corpus with distinct ground-truth values, including absent fields and multi-page/image-only PDFs. Its bundled font supports Cyrillic without a system-font dependency. See [EVALUATION.md](../EVALUATION.md) for generation, annotation and measurement commands; these files are not the same as the eight English preprocessing demos.

For placement orders, run `.\.venv\Scripts\python.exe python/generate_order_demo.py` from the repository root. It creates Bulgarian PDF/PNG/JPG versions plus expected order fields in `tmp/order-demo/`; the order and accommodation-start dates deliberately differ. See [PLACEMENT_ORDERS.md](../PLACEMENT_ORDERS.md).

## Prepare a File and Inspect the Result

```powershell
.\.venv\Scripts\python.exe python/preprocess.py `
  --input tmp/demo-inputs/certificate-tilted.png `
  --output-dir tmp/preview-tilted | Out-Null
```

Open `tmp/preview-tilted/page-001.png` and compare it with the input. `manifest.json` records output dimensions and applied transformations without duplicating the Base64 image data. Use a new output folder for each comparison; preview files are never overwritten and the source file is not changed.

Other useful examples:

```powershell
# Render the image-only PDF.
.\.venv\Scripts\python.exe python/preprocess.py --input tmp/demo-inputs/certificate-scanned.pdf --output-dir tmp/preview-scanned | Out-Null

# Low-contrast input: automatic luminance enhancement.
.\.venv\Scripts\python.exe python/preprocess.py --input tmp/demo-inputs/certificate-faded.png --output-dir tmp/preview-faded | Out-Null

# Sideways image without orientation metadata: explicit clockwise rotation.
.\.venv\Scripts\python.exe python/preprocess.py --input tmp/demo-inputs/certificate-sideways.png --rotate 90 --output-dir tmp/preview-sideways | Out-Null

# Compare opt-in noise reduction with the original noisy image.
.\.venv\Scripts\python.exe python/preprocess.py --input tmp/demo-inputs/certificate-noisy.png --denoise --output-dir tmp/preview-denoised | Out-Null
```

The CLI writes a JSON result containing Base64 images to stdout. `Out-Null` suppresses that large result for manual preview runs; explicitly requested PNGs and the manifest are still saved. Without `--output-dir`, no output files are written.

## Transformations and Their Limits

1. Check input bytes, MIME type, image dimensions, and PDF page count again at the Python boundary.
2. Render every PDF page in order, including image-only scans. Honor PDF page rotation. Cap rendering dimensions before allocating the raster.
3. Apply JPEG/PNG EXIF orientation. Flatten transparency on white and convert to RGB.
4. Apply an explicit clockwise `--rotate` value when requested.
5. Downsize only when needed; never enlarge a small source just to meet the output size.
6. Estimate small skew from near-horizontal lines. Correct only angles within **±10°** with at least three consistent line detections. Expand the canvas to avoid cropping, then restore the output size bound.
7. Automatically stretch luminance only for a narrow contrast range. Preserve high-contrast inputs and chromatic channels.
8. Optionally apply mild edge-preserving denoising with `--denoise`. It is off by default to avoid unnecessary changes to fine text.
9. Encode lossless RGB PNG pages with dimensions and transformation metadata.

EXIF/PDF metadata and an explicit rotation handle right-angle orientation. The script **does not infer a missing 90°/180° orientation from text content**. A reported skew of zero can mean either no measurable tilt or insufficient evidence; it is not a confidence score. Blank pages remain prepared images; readability and field extraction are handled later.

Synthetic tests compare known line geometry, faded-text contrast, background noise, unchanged clean pixels, and source preservation. These checks establish preprocessing behavior; they do not prove increased OCR accuracy. Real layouts and model-based comparisons are needed in tasks 8–10.

## Options

Run `python/preprocess.py --help` for the full CLI usage.

| Option | Default | Accepted values / behavior |
| --- | --- | --- |
| `--input` | None | Local path; mutually exclusive with `--stdin` |
| `--stdin` | Off | Read raw binary file bytes, not Base64 or JSON |
| `--mime-type` | Inferred for local files | `application/pdf`, `image/jpeg`, `image/png`; required with stdin |
| `--output-dir` | None | Explicitly save previews and manifest; reject existing targets |
| `--max-file-bytes` | `10485760` | 1–10,485,760 |
| `--max-pages` | `3` | 1–3; reject excess pages rather than truncating |
| `--max-pixels` | `20000000` | 1–20,000,000 source image pixels |
| `--dpi` | `150` | 72–300, subject to the maximum output side |
| `--max-side` | `2000` | 128–2400 pixels; final longest side never exceeds it |
| `--rotate` | `0` | 0, 90, 180, or 270 degrees clockwise |
| `--no-deskew` | Off | Disable small-angle correction |
| `--no-contrast` | Off | Disable automatic luminance enhancement |
| `--denoise` | Off | Enable mild bilateral filtering |

Limits can be lowered to match the monolith's configuration. Password-protected PDFs, corrupt/mismatched files, and multi-frame image inputs are rejected. The original document remains the monolith's responsibility.

## Internal Result for Node.js Integration

The Node.js adapter uses raw stdin with `--stdin --mime-type ...`, passes the configured byte/page/pixel limits, and fixes the output side bound at 2000 pixels. For a processing invocation, stdout contains exactly one JSON object and a newline:

```text
{
  "status": "prepared",
  "pageCount": 1,
  "pages": [{
    "pageNumber": 1,
    "mimeType": "image/png",
    "width": 1000,
    "height": 1400,
    "contentBase64": "<encoded prepared PNG>",
    "transforms": {
      "exifOrientationApplied": false,
      "pdfRotationDegrees": 0,
      "manualRotationClockwiseDegrees": 0,
      "deskewCounterClockwiseDegrees": 0.0,
      "resized": false,
      "contrastEnhanced": false,
      "denoised": false
    }
  }]
}
```

This is an **internal preprocessing result**, not the public OCR response. Image bytes can be larger than the compressed source. Node.js bounds stdout/stderr, validates page counts/order, image dimensions, transformations, canonical Base64, and actual PNG decoding, and enforces the remaining processing deadline. Production calls omit `--output-dir` and keep pages in memory; only explicit standalone previews write files.

Errors use the shared `{ "error": { "code", "message", "retryable", "details" } }` envelope on stdout with a nonzero exit code. Stderr contains only a short diagnostic code, not input content, filenames, or a traceback. Exit codes: **0** success, **2** invalid/unsupported input or options, **1** internal failure. `--help` is the normal human-readable exception to the JSON output convention.

## Tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s python/tests -v
```

The suite creates synthetic documents in memory and uses temporary directories for CLI preview checks. It requires only the dependencies in `python/requirements.txt` and makes no AI calls. Run `npm test` for Node.js admission/process-failure tests and `npm run test:python` for the real cross-language integration suite.
