# Dormitory OCR Microservice

Developer: **Simona Ognyanova**

This branch contains the OCR microservice work for the student dormitory management system. The implementation checklist is in [OCR_TASKS.md](OCR_TASKS.md).

## Current Status

The technology baseline is documented below, following the detailed OCR technical specification supplied for this task. Team-wide confirmation and updates to conflicting project documents are still pending. The service has not been implemented yet.

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
| Request contract | The architecture document proposes multipart uploads; the detailed OCR specification proposes Base64 in JSON. | Agree on the final contract with the monolith developer in task 2 before implementing request handling. |

These choices are recorded for development in this branch; they do not imply that the rest of the team has already approved changes to the shared architecture. The conflicting documents need to be aligned with the team.

## Document Scope

| Document | Extraction fields | Priority |
| --- | --- | --- |
| Student status certificate | Full name, faculty number, specialty, year of study | First implementation; required by the SRS |
| Placement order | Order number, date, dormitory, room | Required by the SRS |
| Placement form | Personal/contact fields to be agreed | Optional, on request |
| Address registration application | Missing address fields to be agreed | Optional, on request |
| Medical document | No automatic extraction | Rejected by the OCR service; retained by the monolith for authorized review |

## Integration Responsibilities

- The **monolith** stores original documents, metadata, processing jobs, extraction results, and confirmed values. It controls user access and the application workflow.
- The **OCR service** prepares files, calls the vision model, validates extracted fields, and returns structured results. It has no direct PostgreSQL access and does not store originals permanently.
- The **React interface**, integrated with the monolith, allows users to review and correct proposed values. Valid field formats do not prove recognition accuracy; extracted values still require human confirmation.
- **Daniel's JEV service** evaluates motivational letters. Its evaluation contract is separate from this service's document extraction contract.

## Next Step

Confirm the technology baseline with the team, then agree on the request/response contract with the monolith developer using task 2 in [OCR_TASKS.md](OCR_TASKS.md).
