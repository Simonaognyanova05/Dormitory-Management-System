# Dormitory OCR Microservice

Developer: **Simona Ognyanova**

This branch contains the OCR microservice work for the student dormitory management system. The implementation checklist is in [OCR_TASKS.md](OCR_TASKS.md).

## Current Status

The Node.js/Express skeleton is implemented with environment configuration, `GET /health`, JSON not-found/error responses, and a Python dependency setup. The OCR processing endpoint is the next implementation step.

A draft [API contract](OCR_API_CONTRACT.md), [OpenAPI definition](openapi.json), and [document profiles](DOCUMENT_PROFILES.md) with [synthetic example cases](examples/document-profile-cases.json) describe the planned extraction flow. Team-wide confirmation and updates to conflicting project documents are still pending.

## Run Locally

Requirements: **Node.js 20.9+** and npm. Use a current LTS release for a new Node.js installation. Python **3.10+** is needed for the preprocessing work in later tasks, but `/health` works without Python or GPT credentials.

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

Other routes currently return HTTP **404** with an `error.code` of `not_found`. `POST /api/v1/ocr/process` is added in subsequent tasks; the current health check establishes process liveness only.

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
| `SERVICE_TOKEN` | Empty | Shared token for the processing route starting in task 5 |
| `PYTHON_COMMAND` | `python` | Python executable path, without command-line arguments |
| `OPENAI_API_KEY` | Empty | Provider key used in task 8 |
| `OPENAI_MODEL` | Empty | Vision-capable model to select before real extraction |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `MAX_FILE_BYTES` | `10485760` | Decoded-file limit; cannot exceed the draft contract's 10 MiB |
| `MAX_JSON_BODY_BYTES` | `14680064` | JSON body limit; must fit Base64 plus metadata |
| `MAX_PDF_PAGES` | `3` | PDF page limit; 1–3 |
| `PROCESSING_TIMEOUT_MS` | `40000` | Overall processing deadline; 1–40000 ms |

File and processing settings are prepared for later tasks. The skeleton validates configuration at startup; request limits will be enforced when the processing route is implemented. Missing service/AI credentials do not prevent `/health` from starting.

### Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the HTTP service |
| `npm run dev` | Start with Node.js watch mode |
| `npm run check` | Check the JavaScript modules for syntax errors |

### Project Structure

```text
src/
  server.js                    # Load .env, start HTTP, handle shutdown
  app.js                       # Assemble Express routes and middleware
  config/env.js                # Configuration defaults and validation
  routes/health.routes.js      # GET /health
  middleware/                  # Safe 404/500 JSON responses
  services/document-processing/ # Reserved for tasks 6–7
  services/ai/                 # Reserved for task 8
  validators/                  # Reserved for tasks 5 and 9
python/
  requirements.txt             # PyMuPDF, OpenCV headless, Pillow
  README.md                    # Python setup and preprocessing boundary
examples/
  document-profile-cases.json   # Synthetic expected-result cases
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

The next development step is task 5 of [OCR_TASKS.md](OCR_TASKS.md): authenticated OCR request handling, JSON/Base64 validation, real file-format checks, and request/file size limits. Continue reviewing the contract and institution-specific profile assumptions with the team alongside implementation.
