# Dormitory OCR Microservice

Developer: **Simona Ognyanova**

This branch contains the OCR microservice work for the student dormitory management system. The implementation checklist is in [OCR_TASKS.md](OCR_TASKS.md).

## Current Status

The service implements `GET /health` and authenticated request/file validation for `POST /api/v1/ocr/process`. Validation currently enables `student_certificate` with PDF/JPG/PNG input. Other document types are enabled in later implementation steps.

Python preprocessing and AI extraction are not implemented yet. A valid request currently returns **503 `processing_not_configured`**, explicitly indicating that it passed admission checks but the extraction pipeline is pending. No fabricated OCR fields are returned.

A draft [API contract](OCR_API_CONTRACT.md), [OpenAPI definition](openapi.json), and [document profiles](DOCUMENT_PROFILES.md) with [synthetic example cases](examples/document-profile-cases.json) describe the planned extraction flow. Team-wide confirmation and updates to conflicting project documents are still pending.

## Run Locally

Requirements: **Node.js 20.9+** and npm. Use a current LTS release for a new Node.js installation. Python **3.10+** is needed for preprocessing in later tasks. Health and request/file validation work without Python or GPT credentials.

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

### Test OCR Request Validation with Postman

1. Set a local shared token in `.env`, for example `SERVICE_TOKEN=your-local-service-token`.
2. Restart the server after changing `.env`.
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

This is a valid **blank 1×1 PNG**, not a student document. At the current development stage, the expected response is HTTP **503**:

```json
{
  "error": {
    "code": "processing_not_configured",
    "message": "Request and file are valid, but OCR processing is not implemented yet.",
    "retryable": false,
    "details": {}
  }
}
```

This confirms the authenticated JSON, Base64, and file checks succeeded. It does not mean text was recognized. For an actual local file, use the PowerShell Base64/JSON instructions in [OCR_API_CONTRACT.md](OCR_API_CONTRACT.md).

| Test change | Expected response |
| --- | --- |
| Leave the server's `SERVICE_TOKEN` empty | 503 `service_not_configured` |
| Omit the header or use a different token | 401 `unauthorized` |
| Break the JSON syntax | 400 `invalid_json` |
| Use `!!!!` as Base64 | 400 `invalid_base64` |
| Declare the example PNG as `image/jpeg` | 415 `unsupported_file` |
| Set `documentType` to `medical` or a not-yet-enabled type | 422 `unsupported_document_type` |
| Exceed the byte, pixel, or PDF page limits | 413 with the corresponding limit code |

Medical/unsupported types are rejected before file decoding and inspection. Authentication runs before JSON body parsing. Requests use uncompressed UTF-8 JSON; image formats are checked against signatures, headers, and pixel decoding. PDF structure, encryption, and page counts are checked with `pdf-lib`. Image validation uses `sharp`; recognition/readability checks are added with the extraction pipeline.

No actual student documents are needed for these checks. The automated tests generate synthetic PDF/PNG/JPEG inputs and include a synthetic encrypted PDF. Layout examples become useful for preprocessing and extraction in later tasks.

### Python Environment

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python/requirements.txt
```

After setup, set `PYTHON_COMMAND=.venv/Scripts/python.exe` in `.env` for later preprocessing. See [python/README.md](python/README.md) for Linux/macOS commands and library responsibilities.

### Configuration

`.env` is loaded from the repository root; environment variables already set by the shell take precedence. `.env.example` is the shared template. Never print the complete configuration object, which contains credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address; deployment may use `0.0.0.0` |
| `PORT` | `3000` | HTTP port, 1–65535 |
| `SERVICE_TOKEN` | Empty | Required shared token for OCR requests; `/health` stays public |
| `PYTHON_COMMAND` | `python` | Python executable path, without command-line arguments |
| `OPENAI_API_KEY` | Empty | Provider key used in task 8 |
| `OPENAI_MODEL` | Empty | Vision-capable model to select before real extraction |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `MAX_FILE_BYTES` | `10485760` | Decoded-file limit; cannot exceed the draft contract's 10 MiB |
| `MAX_JSON_BODY_BYTES` | `14680064` | JSON body limit; must fit Base64 plus metadata |
| `MAX_PDF_PAGES` | `3` | PDF page limit; 1–3 |
| `MAX_IMAGE_PIXELS` | `20000000` | Decoded image area limit; 1–20,000,000 pixels |
| `PROCESSING_TIMEOUT_MS` | `40000` | Overall processing deadline; 1–40000 ms |

Request/file/page/pixel limits are enforced during admission. The overall processing deadline is prepared for the later pipeline. Images with multiple decoder-reported pages are unsupported. Missing service/AI credentials do not prevent `/health` from starting; an absent service token causes OCR requests to return `service_not_configured`.

### Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the HTTP service |
| `npm run dev` | Start with Node.js watch mode |
| `npm run check` | Check the JavaScript modules for syntax errors |
| `npm test` | Run request-validation integration tests with generated files; no AI calls or Python installation required |

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
  services/document-processing/ # Explicit pending-pipeline boundary; tasks 6–7
  services/ai/                 # Reserved for task 8
  validators/                  # JSON/Base64/file checks; field validators in task 9
python/
  requirements.txt             # PyMuPDF, OpenCV headless, Pillow
  README.md                    # Python setup and preprocessing boundary
examples/
  document-profile-cases.json   # Synthetic expected-result cases
tests/
  request-handling.test.js      # HTTP admission and rejected-input checks
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

The next development step is task 6 of [OCR_TASKS.md](OCR_TASKS.md): Python preparation of PDF pages and images. Task 7 connects the Python process to Node.js; task 8 adds GPT extraction. Continue reviewing the contract and institution-specific profile assumptions with the team alongside implementation.
