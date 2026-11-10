# Dormitory Evaluation Service

A small FastAPI service that accepts a Bulgarian motivational letter as a
text-based PDF, extracts its text, sends the text to Jev-1.13, and returns
five quality scores plus three provisional eligibility assessments.

## Files

- `main.py` — API implementation
- `requirements.txt` — Python dependencies
- `.env.example` — environment-variable template

## Requirements

- Python 3.10 or newer
- Visual Studio with the Python workload, or Visual Studio Code with the
  Microsoft Python extension
- A Jev API key

## Run in Visual Studio / VS Code

1. Open this folder as a project or workspace.
2. Create a virtual environment.
3. Open the integrated terminal.
4. Install dependencies:

   ```bash
   python -m pip install -r requirements.txt
   ```

5. Copy `.env.example` to `.env`.
6. Put your real API key in `.env`. Do not commit `.env` to Git.
7. Start the API:

   ```bash
   python -m uvicorn main:app --reload
   ```

8. Open `http://127.0.0.1:8000/docs`.
9. Expand `POST /evaluate`, choose a PDF and click Execute.

Health check: `http://127.0.0.1:8000/health`

## Fixed eligibility conditions

1. The student's residence is outside Sofia.
2. Neither parent owns real estate in Sofia.
3. The student is currently enrolled at any university located in Sofia.
   The student does not have to attend the university operating the dormitory.

The letter alone cannot prove these facts. The result is an aid for
administrators and must be checked against official documents.

## Important Jev integration note

The Jev request builder and response adapter use the prototype structure
discussed during development. Before relying on the service, compare the
request fields and response envelope with the exact Jev-1.13 API
documentation and your account's actual response. In particular, confirm:

- Whether the endpoint is `https://api.defapi.org/api/v1/decisions`.
- The exact `score` and `choice` question field names.
- Whether the response contains an `answers` object.
- Whether Jev scores are 0-4 or 1-5.

The adapter currently expects Jev scores from 0 to 4 and converts them to
1 to 5. If the API returns 1 to 5 directly, remove the `+ 1` conversion.

## Limitations

- Scanned PDFs are not OCR-processed in this version.
- Maximum upload size: 10 MB.
- Maximum PDF length: 20 pages.
- Do not use the AI assessment as the sole basis for an admission decision.
