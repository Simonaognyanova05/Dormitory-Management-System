# Dormitory OCR Microservice

Developer: **Simona Ognyanova**

This branch contains the OCR microservice work for the student dormitory management system. The implementation checklist is in [OCR_TASKS.md](OCR_TASKS.md).

## Current Status

The service implements `GET /health` and authenticated request/file validation for `POST /api/v1/ocr/process`. Validation currently enables `student_certificate` with PDF/JPG/PNG input. Other document types are enabled in later implementation steps.

Node.js invokes Python for valid requests, receives prepared PNG pages, and validates their metadata and decoded content. Each request has an isolated child process, bounded output, a processing deadline, and cancellation on client disconnect. No temporary files are written by the HTTP pipeline.

GPT Vision extraction and semantic field validation are implemented for the certificate profile, with an explicitly selected mock mode. Successful requests return HTTP **200**: `completed` when all fields pass validation with no issues/warnings, or `partial` when manual attention is needed. Mock responses always carry `mock_result` and remain `partial`; they never represent actual recognition.

The real HTTP adapter was tested against local provider fixtures; a real-provider smoke test and measured extraction quality remain pending a configured key/model and sample documents.

A draft [API contract](OCR_API_CONTRACT.md), [OpenAPI definition](openapi.json), and [document profiles](DOCUMENT_PROFILES.md) with [synthetic example cases](examples/document-profile-cases.json) describe the planned extraction flow. Team-wide confirmation and updates to conflicting project documents are still pending.

## Run Locally

Requirements: **Node.js 20.9+** and npm. Use a current LTS release for a new Node.js installation. Python **3.10+** and its dependencies are required for valid OCR requests. Health and admission checks remain independent of Python/GPT credentials.

From the repository root in Windows PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

The default address is **http://127.0.0.1:3000**. For automatic restarts while editing JavaScript, use `npm run dev` instead of `npm start`. Stop the process with `Ctrl+C`.

### Test with Postman

Create this request; no body or authentication is needed:

```http
GET http://127.0.0.1:3000/health
```

Expected HTTP **200**:

```json
{"status": "ok", "service": "dormitory-ocr"}
```

Alternatively, in PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

Unknown routes return HTTP **404** with an `error.code` of `not_found`. The health check establishes process liveness only.

### Test the Pipeline with Postman (No API Cost)

1. Set a local shared token in `.env`, for example `SERVICE_TOKEN=your-local-service-token`.
2. Set `PYTHON_COMMAND=.venv/Scripts/python.exe` after installing the Python dependencies below, and set **`AI_PROVIDER=mock`** for this demonstration. Restart after changing `.env`.
3. Create `POST http://127.0.0.1:3000/api/v1/ocr/process`.
4. Add `Content-Type: application/json` and `X-Service-Token: your-local-service-token` headers.
5. Select **Body → raw → JSON** and paste this transport example:

```json
{
  "documentId": "test-doc-001",
  "documentType": "student_certificate",
  "file": {
    "mimeType": "image/png",
    "contentBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC"
  }
}
```

This is a valid **blank 1×1 PNG**, not a student document. Mock mode returns HTTP **200** and the following **fixed synthetic values**, independently of the image:

```json
{
  "documentId": "test-doc-001",
  "documentType": "student_certificate",
  "detectedDocumentType": "student_certificate",
  "status": "partial",
  "fields": {
    "fullName": "Иван Петров Иванов",
    "facultyNumber": "001234567",
    "specialty": "Компютърни системи и технологии",
    "yearOfStudy": 2
  },
  "fieldIssues": [],
  "warnings": ["mock_result"],
  "requiresManualReview": true
}
```

The response header is `X-OCR-AI-Provider: mock`. This confirms admission and real Python preparation succeeded, but the field values are simulated. A `503 processing_not_configured` at stage `preprocessing` means Python could not start; check its executable and dependencies.

### Real GPT Extraction

Set these values in `.env`, keeping your actual key in that local file:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_DETAIL=high
OPENAI_TEMPERATURE=0
```

The model is a configurable starting example; it must support image inputs and strict JSON Schema via Chat Completions. Leave temperature empty for models that do not support it. Restart the server, use a **readable certificate** instead of the blank PNG, and prepare its JSON body using the PowerShell instructions in [OCR_API_CONTRACT.md](OCR_API_CONTRACT.md).

Real mode sends prepared images to the configured provider and can incur API charges. It never falls back to mock. Missing credentials/model return `503 provider_configuration_error` before Python starts. The response header is `X-OCR-AI-Provider: openai`. The response now applies certificate-field normalization and validation; the temporary validation-pending warning has been removed.

For this live check, use anonymized certificate layouts or forms filled with known synthetic values and compare the four returned fields to the source. A real-provider call has not been verified in this coding session. Full configuration, provider protocol and retry behavior are documented in [src/services/ai/README.md](src/services/ai/README.md).

### Field Normalization and Review Status

- Names and specialties use Unicode NFC, surrounding trim, and collapsed whitespace, without translation or spelling changes; up to 200 Unicode code points.
- Faculty numbers remain strings with leading zeros. The working rule is 5–12 Unicode letters or ASCII digits; internal separators are retained and flagged rather than silently removed.
- Study years must be integers from 1 to 6. The defensive field normalizer also accepts exact integer strings and ASCII Roman `I`–`VI`; it never infers a year from a semester or repairs an ambiguous value.
- Missing values become `null` with `missing`. Invalid candidates get `invalid_format`; type-correct candidates such as year `9` remain visible for correction. Model uncertainty is preserved separately as `uncertain`.
- `completed` means all automatic field checks passed, the detected type matches, and there are no issues/warnings. Missing/invalid/uncertain data, a type mismatch, or mock mode gives `partial` and `requiresManualReview: true`.

**A valid format is not proof of correct recognition.** Even a `completed` result still requires user confirmation against the original in the main application; this service does not approve applications. Field problems are returned as HTTP 200 partial data, allowing manual entry without another AI request.

See [DOCUMENT_PROFILES.md](DOCUMENT_PROFILES.md) for the working rules. Placement-order and optional-document semantics remain for their later implementation steps. Structural provider-schema errors still return `provider_bad_response`; defensive raw-value tests do not relax that schema.

| Test change | Expected response |
| --- | --- |
| Leave the server's `SERVICE_TOKEN` empty | 503 `service_not_configured` |
| Omit the header or use a different token | 401 `unauthorized` |
| Break the JSON syntax | 400 `invalid_json` |
| Use `!!!!` as Base64 | 400 `invalid_base64` |
| Declare the example PNG as `image/jpeg` | 415 `unsupported_file` |
| Set `documentType` to `medical` or a not-yet-enabled type | 422 `unsupported_document_type` |
| Exceed the byte, pixel, or PDF page limits | 413 with the corresponding limit code |
| Configure an unavailable Python executable | 503 `processing_not_configured`, stage `preprocessing` |
| Python does not finish within the deadline | 504 `processing_timeout` |
| Use real mode with a missing AI key/model | 503 `provider_configuration_error` |
| The model finds no readable text | 422 `unreadable_document` |
| AI output is malformed after one retry | 502 `provider_bad_response` |

Medical/unsupported types are rejected before file decoding and inspection. Authentication runs before JSON body parsing. Requests use uncompressed UTF-8 JSON; image formats are checked against signatures, headers, and pixel decoding. PDF structure, encryption, and page counts are checked with `pdf-lib`. Image validation uses `sharp`, and the extraction adapter handles model-reported readability and type mismatch.

No actual student documents are needed for transport/mock tests. The automated tests generate synthetic inputs and use local provider responses. Real layouts are now useful for the live extraction check and later accuracy measurement; mock results cannot establish recognition quality.

### Python Environment

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python/requirements.txt
```

After setup, set `PYTHON_COMMAND=.venv/Scripts/python.exe` in `.env` on Windows, or `PYTHON_COMMAND=.venv/bin/python` on Linux/macOS. A path is resolved from the repository root and is passed as one executable, even if it contains spaces; do not add arguments or shell commands to this value. Restart the server after changing it. See [python/README.md](python/README.md) for standalone usage.

Verify Node.js → Python independently of the HTTP service:

```powershell
npm run check:python
```

This sends the synthetic 1×1 PNG to the actual Python process and prints page dimensions/transforms without image data. It requires neither a service token nor a GPT key. The check uses the same `PYTHON_COMMAND` configuration as production.

Try preprocessing without real documents:

```powershell
.\.venv\Scripts\python.exe python/generate_demo_documents.py
.\.venv\Scripts\python.exe python/preprocess.py --input tmp/demo-inputs/certificate-tilted.png --output-dir tmp/preview-tilted | Out-Null
```

Compare `tmp/preview-tilted/page-001.png` with the synthetic input; inspect `manifest.json` for dimensions and applied transformations. Use a fresh output directory when repeating a run. More examples, including scanned PDFs, EXIF rotation, explicit `--rotate`, contrast, and optional denoising, are in [python/README.md](python/README.md).

Python checks:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s python/tests -v
```

### Configuration

`.env` is loaded from the repository root; environment variables already set by the shell take precedence. `.env.example` is the shared template. Never print the complete configuration object, which contains credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address; deployment may use `0.0.0.0` |
| `PORT` | `3000` | HTTP port, 1–65535 |
| `SERVICE_TOKEN` | Empty | Required shared token for OCR requests; `/health` stays public |
| `PYTHON_COMMAND` | `python` | Python executable path, without command-line arguments |
| `AI_PROVIDER` | `openai` | `openai` for real extraction; explicit `mock` for fixed demonstration values |
| `OPENAI_API_KEY` | Empty | Required for real provider requests |
| `OPENAI_MODEL` | Empty | Vision-capable model to select before real extraction |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `OPENAI_IMAGE_DETAIL` | `high` | `low`, `high`, `auto`, or model-specific `original` |
| `OPENAI_TEMPERATURE` | Omitted | Optional value 0–2; leave empty for incompatible models |
| `AI_MAX_OUTPUT_TOKENS` | `2048` | Provider completion token limit, 1–8192 |
| `AI_REQUEST_TIMEOUT_MS` | `20000` | Per-attempt cap; bounded by the remaining overall deadline |
| `MAX_AI_RESPONSE_BYTES` | `262144` | Streamed provider-response limit, up to 256 KiB |
| `MAX_FILE_BYTES` | `10485760` | Decoded-file limit; cannot exceed the draft contract's 10 MiB |
| `MAX_JSON_BODY_BYTES` | `14680064` | JSON body limit; must fit Base64 plus metadata |
| `MAX_PDF_PAGES` | `3` | PDF page limit; 1–3 |
| `MAX_IMAGE_PIXELS` | `20000000` | Decoded image area limit; 1–20,000,000 pixels |
| `PROCESSING_TIMEOUT_MS` | `40000` | Overall processing deadline; 1–40000 ms |
| `MAX_PREPROCESS_STDOUT_BYTES` | `67108864` | Maximum Python JSON output; 1–64 MiB |
| `MAX_PREPROCESS_STDERR_BYTES` | `65536` | Maximum Python diagnostics; 1–64 KiB; counted and discarded |

Request/file/page/pixel limits are enforced during admission and passed to Python. The processing deadline covers Python and the AI stage, including at most one provider retry; it is not reset after preprocessing. Python workers are terminated on cancellation/timeout/output overflow, with a 250 ms force-kill fallback. AI transport is aborted on timeout/disconnect. Images with multiple decoder-reported pages are unsupported. Missing service/AI credentials do not prevent `/health` from starting.

### Failure Handling and Manual Recovery

AI deadlines/cancellation also bound replacement transports that ignore abort signals; late responses and active body readers are discarded/cancelled. The pipeline rechecks its budget before starting each stage. Input-pipe failures stop stalled Python workers after a short structured-error grace.

Valid provider `Retry-After` hints are honored when they fit the budget, or returned as `error.details.retryAfterSeconds` and an HTTP `Retry-After` header when a retryable error is returned. There are still at most two provider attempts per service request. The worker in the monolith must additionally bound its own retries and retain the original for manual entry. The evaluation CLI stops a batch on an explicit positive provider cooldown.

See **[RELIABILITY.md](RELIABILITY.md)** for the failure matrix, budgets, retry scheduling and integration responsibilities. Real persisted-file/manual-entry verification needs the monolith/frontend and remains pending; the stateless microservice recovery contract is tested.

### Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the HTTP service |
| `npm run dev` | Start with Node.js watch mode |
| `npm run check` | Check the JavaScript modules for syntax errors |
| `npm test` | Run admission, child-process and AI client tests with local/injected provider responses; no paid AI calls |
| `npm run test:python` | Run real Python integration tests, including the HTTP pipeline with explicit mock extraction |
| `npm run check:python` | Check the configured Python process and print a safe preparation summary |
| `npm run evaluate -- --dataset <file> --validate-only` | Validate a 10+ document dataset without provider calls |
| `npm run evaluate -- --dataset <file> --output-dir <new folder>` | Measure real-provider extraction and write JSON/Markdown reports |

For `test:python`, configure Python in `.env` or `PYTHON_COMMAND`; if neither is set, the tests detect a local `.venv` before falling back to `python`. Production and `check:python` use the configured command directly.

### Early Accuracy and Timing Evaluation

Generate 12 distinct Bulgarian synthetic certificates and their known field values:

```powershell
.\.venv\Scripts\python.exe python/generate_benchmark_dataset.py
npm run evaluate -- --dataset tmp/benchmark-certificates/dataset.json --validate-only
```

The corpus has clean/tilted/faded/noisy/reduced-resolution/EXIF image variants, text/scanned/two-page PDFs, and genuine missing-field controls. Validation checks all files and annotations without AI calls.

After configuring a real model/key, run:

```powershell
npm run evaluate -- --dataset tmp/benchmark-certificates/dataset.json --output-dir tmp/early-evaluation-001
```

This uses the actual admission/Python/AI/field-validation code sequentially and can incur provider charges. Mock mode/results are rejected for measurement. Reports compare returned values with ground truth and record per-field errors, preprocessing/AI/validation/overall times, median/p95, failures and coverage. A completed extraction is not automatically a correct value match.

See **[EVALUATION.md](EVALUATION.md)** for comparison/null rules, timing boundaries, report contents, interruption, and adding real layouts. Tooling and corpus validation are verified; real-provider accuracy/timing measurements are still pending. This early certificate-only set does not replace final 30-document acceptance.

### Project Structure

```text
src/
  server.js                    # Load .env, start HTTP, handle shutdown
  app.js                       # Assemble Express routes and middleware
  config/env.js                # Configuration defaults and validation
  routes/health.routes.js      # GET /health
  routes/ocr.routes.js         # Authenticated OCR admission route
  errors/api-error.js          # Safe API error envelope
  middleware/                  # Service authentication and error responses
  services/document-processing/ # Python → AI orchestration and shared deadline
  services/ai/                 # GPT client, strict schema, mock and response mapping
  validators/                  # Request/file/PNG/model-shape and certificate-field checks
  evaluation/                 # Dataset validation, scoring and measurement reports
scripts/
  check-python.js              # Actual Node.js → Python smoke check
  evaluate.js                  # Validation-only or real-provider evaluation CLI
  check-syntax.js              # Syntax checks for all Node.js source/tests
python/
  requirements.txt             # PyMuPDF, OpenCV headless, Pillow, NumPy
  preprocessing.py             # In-memory rendering and image preparation
  preprocess.py                # Standalone CLI/raw-stdin entry point
  generate_demo_documents.py   # Synthetic manual-test inputs
  generate_benchmark_dataset.py # 12 Bulgarian samples and canonical ground truth
  tests/test_preprocessing.py  # Rendering, geometry, quality and CLI checks
  README.md                    # Python setup and preprocessing boundary
examples/
  document-profile-cases.json   # Synthetic expected-result cases
tests/
  request-handling.test.js      # HTTP admission and rejected-input checks
  python-preprocessor.test.js  # Process failures, output validation, deadlines and cancellation
  python-integration.test.js   # Real Python and HTTP integration
  ai-extraction.test.js        # Provider protocol, errors, deadlines, mock and HTTP extraction
  reliability.test.js          # Cooldowns, independent deadlines, cleanup and recovery
  certificate-fields.test.js   # Golden certificate cases and semantic/Unicode/status checks
  evaluation.test.js           # Scoring, failure coverage, CLI reports and timing checks
  fixtures/encrypted-pdf.json   # Synthetic password-protected PDF
```

## Technology Baseline

| Technology | Responsibility |
| --- | --- |
| **Node.js** | Runs the OCR service, coordinates processing, and communicates with the AI provider. |
| **Express.js** | Exposes the REST API used by the FastAPI monolith and handles requests, service authentication, and responses. |
| **Python** | Runs document preprocessing as a child process started by Node.js through `child_process.spawn()`. |
| **PyMuPDF** | Opens PDFs and renders their pages as images, including scanned PDFs without selectable text. |
| **OpenCV** | Supports image preprocessing, including skew correction, contrast enhancement, and noise reduction where these improve extraction. |
| **Pillow** | Opens image files and supports orientation correction, resizing, and image format conversion. |
| **GPT Vision** | Refers to a vision-capable GPT model accessed through an API. It reads prepared images and extracts the fields specified by each document profile. The exact model is still to be selected. |

### Processing Flow

```text
FastAPI monolith
    │ Document and metadata
    ▼
Node.js / Express
    │ Start preprocessing with child_process.spawn()
    ▼
Python: PyMuPDF + OpenCV + Pillow
    │ Prepared page images
    ▼
Node.js: vision-capable GPT API request
    │ Structured extraction result
    ▼
Node.js: field validation and normalization
    │ JSON result with missing/uncertain fields flagged
    ▼
FastAPI monolith → React review and correction
```

### Why This Stack

- **Node.js and Express** implement the API and processing coordinator described in the detailed OCR specification.
- **Python** provides the document and image processing libraries needed before recognition. It is invoked by the Node.js service rather than deployed as a second OCR API.
- **A vision-capable GPT model** extracts document-specific fields from page images. The service adds its own document profiles, instructions, validation, normalization, and review flags.
- **A separate service** allows OCR to be developed and tested independently while the monolith retains application data and workflow responsibilities.

## Alignment with the Other Project Documents

The project documents describe different technology options. For this OCR branch, the detailed OCR technical specification is the working baseline:

| Topic | Other documentation | Baseline for this branch |
| --- | --- | --- |
| OCR engine | The general project proposal lists Node.js and Tesseract. | Use a vision-capable GPT model for extraction, as described in the detailed OCR specification. Tesseract is not part of the initial implementation baseline. |
| OCR API framework | The architecture document lists Python/FastAPI for the extraction microservice. | Use Node.js/Express for the OCR API and Python for preprocessing. FastAPI remains the main application's integration point. |
| Request contract | The architecture document proposes multipart uploads; the detailed OCR specification proposes Base64 in JSON. | The [draft contract](OCR_API_CONTRACT.md) uses Base64 in JSON; confirm it with the monolith developer before implementing request handling. |

These choices are recorded for development in this branch; they do not imply that the rest of the team has already approved changes to the shared architecture. The conflicting documents need to be aligned with the team.

## Document Scope

| Document | Extraction fields | Priority |
| --- | --- | --- |
| Student status certificate | Full name, faculty number, specialty, year of study | First implementation; required by the SRS |
| Placement order | Order number, date, dormitory, room | Required by the SRS |
| Placement form | Full name, phone, permanent address (working profile) | Optional, on request |
| Address registration application | Locality, address line (working profile) | Optional, on request |
| Medical document | No automatic extraction | Rejected by the OCR service; retained by the monolith for authorized review |

See [DOCUMENT_PROFILES.md](DOCUMENT_PROFILES.md) for field types, normalization, missing/invalid-value behavior, and the distinction between response keys and application submission requirements. [Synthetic examples](examples/document-profile-cases.json) provide expected results for future validator tests, not implemented OCR or measured recognition accuracy.

## Integration Responsibilities

- The **monolith** stores original documents, metadata, processing jobs, extraction results, and confirmed values. It controls user access and the application workflow.
- The **OCR service** prepares files, calls the vision model, validates extracted fields, and returns structured results. It has no direct PostgreSQL access and does not store originals permanently.
- The **React interface**, integrated with the monolith, allows users to review and correct proposed values. Valid field formats do not prove recognition accuracy; extracted values still require human confirmation.
- **Daniel's JEV service** evaluates motivational letters. Its evaluation contract is separate from this service's document extraction contract.

## Next Step

Run the real-provider evaluation in [EVALUATION.md](EVALUATION.md) to finish task 8's smoke check and task 10's initial measurements, then use the observed errors to select improvements. The evaluator and 12-document corpus are ready; no real recognition score is claimed yet.
