# Placement Order Extraction

Task 12 enables **`placement_order`** on the same OCR endpoint as student certificates:

```http
POST /api/v1/ocr/process
Content-Type: application/json
X-Service-Token: <shared-service-token>
```

Both profiles use the existing file admission, Python preparation, provider transport, shared deadline, bounded retries and error handling. Each request selects its own schema, prompt, field validator and mock values; mixed concurrent requests do not share mutable profile state.

## Fields

| Key | JSON value | Meaning |
| --- | --- | --- |
| `orderNumber` | string or `null` | Identifier of the order, preserving prefixes, separators and leading zeros |
| `orderDate` | string or `null` | The order's date, not upload/signature/placement-start date |
| `dormitory` | string or `null` | Visible dormitory/block identifier or name; not a database ID |
| `room` | string or `null` | Visible room identifier, including zeros and suffixes; not a floor or database ID |

Every response includes all four keys. Missing fields remain `null` with review issues. Declared medical and optional types remain excluded. A different detected document type produces a mismatch warning without silently switching to another field set.

## Generate a Readable Test Document

```powershell
.\.venv\Scripts\python.exe python/generate_order_demo.py
```

This creates `tmp/order-demo/placement-order.pdf`, `.png`, `.jpg`, and `expected-fields.json`. The Bulgarian source is explicitly synthetic and contains an order date of **3 November 2026** plus a different **10 November placement-start date**, so date selection can be checked. Existing files are never overwritten; use `--output-dir <new folder>` for another run.

The fixed ground truth is:

```json
{
  "orderNumber": "РД-001",
  "orderDate": "2026-11-03",
  "dormitory": "01",
  "room": "012А"
}
```

The final letter of `012А` is Cyrillic. Normalization never changes alphabets or substitutes visually similar characters.

## Postman Request

Use the same service token and Python configuration as for certificates. Prepare a real file body in PowerShell:

```powershell
$filePath = (Resolve-Path "tmp/order-demo/placement-order.pdf").Path
$body = @{
    documentId = "order-test-001"
    documentType = "placement_order"
    file = @{
        mimeType = "application/pdf"
        contentBase64 = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($filePath)
        )
    }
} | ConvertTo-Json -Depth 3
$body | Set-Clipboard
```

Paste into **Body → raw → JSON** and send to `http://127.0.0.1:3000/api/v1/ocr/process`. PNG/JPG use `image/png`/`image/jpeg` with the matching file bytes. A new `orderTransportExample` in [openapi.json](openapi.json) also provides a blank-PNG transport request; it is suitable for mock demonstration, not real recognition.

### Mock Mode

Set `AI_PROVIDER=mock` in `.env` and restart. File checks and Python preparation are real; extraction returns fixed synthetic values for any valid image, including blank input:

```json
{
  "documentId": "order-test-001",
  "documentType": "placement_order",
  "detectedDocumentType": "placement_order",
  "status": "partial",
  "fields": {
    "orderNumber": "РД-001",
    "orderDate": "2026-11-03",
    "dormitory": "01",
    "room": "012А"
  },
  "fieldIssues": [],
  "warnings": ["mock_result"],
  "requiresManualReview": true
}
```

The header is `X-OCR-AI-Provider: mock`. These values do not demonstrate recognition accuracy.

### Real Mode

Use `AI_PROVIDER=openai`, a configured key/model, and a readable order. The profile asks only for order fields, excluding student names/faculty numbers/national identifiers. It asks for the visible date without repairing it, and the server then performs calendar validation. Real-provider tests on anonymized order layouts remain pending; local provider fixtures verify the integration, not image-reading quality.

## Normalization and Validation

- Text uses Unicode NFC, boundary trim and collapsed whitespace for identifiers/names. Preserve spelling, case, prefixes, punctuation, zeros and room suffixes. Do not coerce numeric JSON identifiers into strings, because leading zeros may already be lost.
- Nonempty strings longer than 200 code points remain visible with `invalid_format`; they are not truncated.
- Dates accept exact `YYYY-MM-DD` or day-first `D.M.YYYY`, `D/M/YYYY`, `D-M-YYYY` with a four-digit year and optional trailing Bulgarian `г.`/`Г.`. Day/month may have one or two digits in day-first input.
- Validate actual Gregorian dates, including century leap rules; valid values become `YYYY-MM-DD`. No locale-dependent `Date.parse`, timezone conversion or JavaScript year-0..99 coercion is used.
- For example, `3.11.2026 г.` becomes `2026-11-03`; `31.02.2026` stays unchanged with `invalid_format`. Two-digit years, mixed separators, timestamps and month-first guessing are not accepted.
- Missing values produce `missing`. Ambiguous values retain `uncertain` independently of other problems. Date failures remain partial data rather than provider retries.

`completed` requires valid present fields, matching type and no uncertainty/warnings. Otherwise return `partial`. Mock is always partial. Completed format checks still require human confirmation against the original.

## Tables and Multiple Students

The request has no target-student selector. The prompt instructs the model not to choose an arbitrary table row: conflicting dormitory/room values become null with uncertainty; even shared candidates should remain flagged when the intended placement cannot be established. The backend preserves those flags and requires review.

This is prompt-level recognition behavior, not a programmatic guarantee that every multi-row layout will be detected correctly. Representative real orders and human verification are needed. The API does not return student identities or automatically allocate a place.

## Main Application Responsibilities

The monolith matches returned dormitory/room text against its own records. If there is no confirmed match, keep the text available for review rather than guessing a foreign key or creating a room/placement. Capacity checks, eligibility, administrative approval and database writes stay outside OCR. Agreement and live integration with the main application remain pending.

The early evaluation tool in [EVALUATION.md](EVALUATION.md) intentionally still accepts certificate datasets only. It rejects order manifests instead of scoring order values against certificate keys. Mixed-profile quantitative evaluation is a later extension; use the generated order and Postman for the initial live check.

## Verification

- [placement-order.test.js](tests/placement-order.test.js): fixture outputs, date layouts/leap years, preserved identifiers, missing/invalid/uncertain data, schema isolation, provider requests and HTTP results.
- [request-handling.test.js](tests/request-handling.test.js): order admission and continued exclusion of medical/optional types.
- [python-integration.test.js](tests/python-integration.test.js): actual Python preparation for concurrent certificate/order requests using explicit mock extraction.
- [test_order_demo.py](python/tests/test_order_demo.py): readable generated source/annotations and admission limits.
