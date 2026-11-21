# Early OCR Accuracy and Timing Check

Task 10 adds a repeatable **certificate-only** evaluation runner, a generated Bulgarian dataset, and JSON/Markdown reports. It reuses the actual admission validators and Python → AI → field-validation pipeline.

**Current evidence:** the 12-document generated corpus passes file/annotation validation, and the evaluator is covered by deterministic tests. A real-provider recognition run has **not** been performed yet. No measured OCR accuracy or live-provider latency is claimed here.

## 1. Generate the Initial Corpus

From the repository root in Windows PowerShell, after installing `python/requirements.txt`:

```powershell
.\.venv\Scripts\python.exe python/generate_benchmark_dataset.py
```

This creates `tmp/benchmark-certificates/dataset.json` and **12 different synthetic certificates**, using a bundled font with Bulgarian glyphs:

| Quality label | Input |
| --- | --- |
| `clean_png` | Clean Bulgarian certificate PNG |
| `clean_jpeg` | Different student/fields, JPEG |
| `text_pdf` | Selectable Bulgarian text PDF |
| `scanned_pdf` | Image-only PDF |
| `skewed` | Small page tilt |
| `low_contrast` | Faded text |
| `noise` | Mild noise and JPEG compression |
| `low_resolution` | Reduced-resolution image |
| `exif_rotation` | Sideways stored JPEG with orientation metadata |
| `two_page_pdf` | Fields split over two pages |
| `missing_specialty` | Genuinely absent specialty |
| `missing_year` | Genuinely absent course, with an academic-year distractor |

Each document has distinct known values, including leading-zero identifiers. There are **48 field slots: 46 present and 2 absent**. Generated files are clearly labeled synthetic; they do not represent official university templates or a representative final test set. The variants are correlated examples for an early check.

Existing files are never overwritten. For another set, use `--output-dir tmp/benchmark-certificates-2`. Keep the original generated files when comparing runs: source SHA-256 hashes are recorded, and regenerated PDF metadata may change file hashes.

## 2. Validate Without Any Provider Calls

```powershell
npm run evaluate -- --dataset tmp/benchmark-certificates/dataset.json --validate-only
```

This works with `AI_PROVIDER=mock` and without AI/Python credentials. It checks the manifest, at least 10 samples, field types, relative paths, unique IDs/content hashes, real file formats, byte/pixel/page limits, and expected values. It prints dataset counts with `providerCalls: 0`; it does **not** generate an accuracy result.

The editor schema is [examples/benchmark-manifest.schema.json](examples/benchmark-manifest.schema.json). Runtime validation additionally checks file contents, uniqueness, canonical annotations and filesystem constraints.

## 3. Configure a Real Extraction Run

In the local root `.env`:

```dotenv
AI_PROVIDER=openai
PYTHON_COMMAND=.venv/Scripts/python.exe
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_DETAIL=high
OPENAI_TEMPERATURE=0
```

Use `.venv/bin/python` on Linux/macOS. Select a supported vision/strict-schema model and omit temperature for models that do not support it. First verify `npm run check:python` and one readable certificate through Postman as described in [README.md](README.md).

Run the corpus explicitly:

```powershell
npm run evaluate -- --dataset tmp/benchmark-certificates/dataset.json --output-dir tmp/early-evaluation-001
```

This makes real provider requests and can incur API charges: one request per document, with at most one internal provider retry, so up to 24 calls for this corpus. Documents are processed **sequentially**. No HTTP server or service token is required because the runner invokes the same validators and processor in-process.

`AI_PROVIDER=mock` is rejected for measurement. A response marked `mock_result` also aborts evaluation rather than producing a fake recognition score. Automated fixture-provider tests verify the tool only; they are not recognition measurements.

## 4. Read the Reports

The selected **new** output directory receives:

- `report.json`: per-document/per-field outcomes, source/manifest hashes, model/settings, runtime environment, stage timings, review issues, quality groups and target indicators.
- `report.md`: readable field and timing tables and a document-level error list.

Existing output directories are refused before provider calls. By default, reports contain field match/presence flags and issue codes, **not names or raw expected/predicted field values**. For local value-level debugging, explicitly add `--include-values`; these extra values appear in JSON only. Console progress contains document IDs, states and error codes, not document content or provider error bodies.

Default datasets/reports are under the ignored `tmp/` directory. For reproducibility, retain the dataset, source hashes, report and application revision together. The report records Node/platform/CPU and provider settings; record Python/library versions and unusual system load alongside it when comparing different environments.

## 5. Comparison Rules — `certificate-v1`

Define ground truth **before** running extraction; score returned fields before human correction.

- Compare only `fullName`, `facultyNumber`, `specialty`, `yearOfStudy`.
- Strings use Unicode NFC and surrounding trim. Names/specialties additionally collapse internal whitespace. Faculty-number internal spaces/separators are not removed.
- Case, spelling, accents, alphabet, leading zeros and JSON field types remain significant. Do not replace `O`/`0`, Cyrillic `З`/`3`, or otherwise repair predictions during scoring.
- The expected year is an integer or `null`, never the string `"2"` or `"II"`; a visible Roman course has canonical numeric ground truth. No semester/academic-year inference is allowed.
- Explicit `null` means the source field is genuinely absent. Empty strings are rejected as ambiguous annotations.
- Ground truth describes the **visible source**, not application eligibility. A source year of `9` can be annotated as `9` and correctly recognized while the application validator still flags its format.
- A correct value with an `uncertain`/`invalid_format` issue still counts as correct recognition. A `completed` result with a wrong digit counts as incorrect. Review flags/status are reported separately.
- Processor failures, invalid result shapes, cancellations and unattempted documents receive zero matches for every planned field, **including annotated absences**. Failed documents are never dropped to inflate the denominator.

Primary field accuracy:

```text
correctly matched field slots / all planned field slots
```

The report also provides **present-field accuracy**, correct absent fields, hallucinated absent values, and per-field/per-quality metrics. Inspect these alongside the primary score so true-negative controls do not conceal poor extraction of present values.

## 6. Timing Boundary and Targets

The runner measures:

| Stage | Included work |
| --- | --- |
| `admissionMs` | Request-shape/Base64 decoding and actual file inspection |
| `preprocessingMs` | Python startup, rendering/preparation and output validation |
| `aiMs` | Request construction/transport, provider work, internal retries/backoff and structured-output checks |
| `validationMs` | Field normalization, semantic checks and response classification |
| `totalMs` | Admission through the completed processor response, including failure handling |

Source-file reads, local Base64 encoding, manifest validation, scoring/report writing, HTTP upload and streaming JSON parsing are **outside** this in-process boundary. This is not a deployed HTTP/load benchmark. New Python-process startup is included for each document, matching the current service design. Failed-stage time is retained; an unstarted stage is `null`, not zero.

Timing summaries include mean, median, min/max and **nearest-rank p95** (`sorted[ceil(0.95*n)-1]`). All attempted cases with an available processing duration, including failures, contribute to the overall distribution; successful-only timings are also available. A source read failure before processing has no duration and aborts the corpus check. A quick failure is not counted as a successfully processed document within 15 seconds.

The early indicators compare all-field accuracy with **90%** and successful completion with **15 seconds per document**. Reports show individual indicators rather than declaring overall project acceptance. Interrupted/configuration-aborted runs leave target indicators unassessed. Fewer than 30 documents, only one supported document type, correlated synthetic variants and no human-reviewed real corpus mean **final acceptance is not assessed** by this tool.

## 7. Failures and Interruption

Transient document/provider failures are recorded and evaluation continues unless the final error includes a positive provider cooldown. In that case the batch stops with `provider_retry_after` and records the delay, rather than immediately sending the next document. Rerun later into a fresh output directory. Fatal configuration, missing Python setup, or changed/unreadable source files also abort further calls; remaining documents stay `not_attempted` and earn no correct-field credit. Inputs are rehashed just before processing.

`Ctrl+C` cancels the current request/worker and writes an incomplete report. Exit codes:

- `0`: dataset validation succeeded, or a complete error-free measurement was saved; accuracy/time targets may still be missed.
- `1`: measurement saved with processing failures or an aborted run.
- `2`: invalid configuration/dataset/output, mock measurement attempt, or report-writing failure.
- `130`: interrupted measurement, with a partial report when available.

## 8. Add Real Layouts and Improve Results

Copy anonymized certificates or forms filled with synthetic values into a dataset folder. Create a manifest with at least 10 **distinct** documents, using the schema above. Keep filenames relative to the manifest with forward slashes; no absolute, drive-relative or traversal paths. Fill all four `expectedFields` keys and independently verify every annotation against the source.

After a real run, inspect wrong fields and review issues by quality group. Change one preprocessing/prompt/model setting at a time, rerun the **same hashed inputs** into a new output directory, and compare accuracy and p95 rather than optimizing a single successful example. Record both improvements and regressions.

**Still pending for task 10:** a real-provider run over at least 10 documents, initial measured results, and decisions based on the observed errors. Generating/validating the corpus and passing unit tests do not establish OCR accuracy or completion of that acceptance criterion.

## Tests

```powershell
npm test
npm run test:python
.\.venv\Scripts\python.exe -m unittest discover -s python/tests -v
```

These verify scoring, failure denominators, reports, timing observation, mock rejection, generator text/annotations and runtime integration using synthetic/local fixtures. They make no paid AI calls.
