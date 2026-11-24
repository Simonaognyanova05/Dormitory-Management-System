# OCR API Contract

**Version:** 1.0.0-draft  
**Status:** proposed contract for the OCR branch; acceptance by the monolith developer is pending.  
**Machine-readable definition:** [openapi.json](openapi.json), importable into Postman.

This document defines extraction for `student_certificate` and `placement_order`, each with its own schema, prompt and semantic validator. Admission, Python and transport/error handling are shared. Successful extraction returns HTTP 200 with completed/partial classification; explicit mock mode always returns partial synthetic data. Real-provider layout/accuracy checks remain pending. Python startup failures are `503 processing_not_configured`; missing AI configuration is `503 provider_configuration_error`. Optional/medical types remain excluded.

Semantic rules are in [DOCUMENT_PROFILES.md](DOCUMENT_PROFILES.md); [AI documentation](src/services/ai/README.md) describes profile-specific internal schemas. [PLACEMENT_ORDERS.md](PLACEMENT_ORDERS.md) includes order examples, calendar rules and the monolith's record-matching responsibilities.

## 1. Integration Decisions

| Topic | Proposed decision |
| --- | --- |
| Endpoint | `POST /api/v1/ocr/process` |
| Local base URL | `http://localhost:3000` |
| Request and response encoding | UTF-8 JSON; compressed request bodies are not accepted |
| File transport | Base64 inside JSON, following the detailed OCR specification |
| Authentication | Shared service token in `X-Service-Token` |
| Identifiers | Opaque strings, not UUID-only |
| JSON naming | `camelCase` for properties and extracted fields |
| Document type naming | Fixed `snake_case` identifiers from the table below |
| Processing | One synchronous HTTP request per document; the monolith's worker calls it asynchronously relative to the student's upload |
| Persistence | No permanent document storage or database writes in the OCR service |

The multipart endpoint and names in the architecture document must be aligned with this proposal before integration. V1 accepts one JSON contract; it does not silently accept legacy aliases or multipart uploads.

## 2. Request

```http
POST /api/v1/ocr/process
Content-Type: application/json
X-Service-Token: <shared-service-token>
```

All properties below are required. Unknown properties are rejected.

| Property | Type | Rules |
| --- | --- | --- |
| `documentId` | string | 1–128 ASCII characters: starts with a letter or digit; remaining characters may also include `.`, `_`, `:`, and `-`. Values such as `doc-123` and UUID strings are accepted. Echoed unchanged in successful responses. |
| `documentType` | string | One of the canonical types below. Unsupported or not-yet-implemented types return `422 unsupported_document_type`. |
| `file.mimeType` | string | Exactly `application/pdf`, `image/jpeg`, or `image/png`. Must match the decoded file contents. |
| `file.contentBase64` | string | Nonempty, standard padded Base64, without whitespace, URL-safe substitutions, or a `data:...;base64,` prefix. The decoded file must be valid. |

### Canonical Document Types and Output Fields

| `documentType` | Field keys | Scope |
| --- | --- | --- |
| `student_certificate` | `fullName`, `facultyNumber`, `specialty`, `yearOfStudy` | First implementation; required by the SRS |
| `placement_order` | `orderNumber`, `orderDate`, `dormitory`, `room` | Required by the SRS |
| `placement_form` | `fullName`, `phone`, `permanentAddress` | Optional; working profile documented in task 3, pending team confirmation |
| `address_registration` | `city`, `addressLine` | Optional; working profile documented in task 3, pending team confirmation |

`medical` and all unknown types are rejected before Python processing or any AI request. The monolith must not send medical documents to this endpoint. This check concerns the declared type; it cannot establish the actual content of a file before reading it.

The architecture's `student_status_certificate` maps to this contract's `student_certificate`; `full_name`, `faculty_number`, and `course` map to `fullName`, `facultyNumber`, and `yearOfStudy`. The monolith performs any necessary mapping; those aliases are not accepted by this API.

### Proposed Limits

- Maximum decoded file: **10 MiB = 10,485,760 bytes**.
- Maximum Base64 length for that file limit: **13,981,016 characters**. Decode and check the actual byte length as well.
- Maximum complete JSON body: **14 MiB = 14,680,064 bytes**, allowing for Base64 and metadata.
- Maximum PDF pages: **3**. Reject longer PDFs; do not silently truncate them.
- Maximum image area: **20,000,000 pixels**. Read dimensions before decoding pixels; reject larger images as `413 file_too_large`. Images with multiple decoder-reported pages are unsupported. This is an additional working admission limit, configurable downward through `MAX_IMAGE_PIXELS`.
- Processing target: **15 seconds** for a document of up to 3 pages under documented normal conditions.
- Proposed hard processing deadline: **40 seconds**, including preprocessing, AI calls, and internal retries, starting after request validation. The monolith's response timeout should allow at least **45 seconds**, plus appropriate upload time.

The implemented preprocessing adapter includes Python startup/execution and output validation in that budget. Timeout terminates the child process before responding; cancellation also stops it. A 250 ms force-kill fallback is reserved for cleanup. Python stdout is capped at **64 MiB** and stderr at **64 KiB**; exceeding either cap is an internal preprocessing error. Stderr is discarded and never included in responses. The HTTP pipeline uses in-memory stdin/stdout and no preview output directory.

AI attempts use only the remaining shared deadline, with a default per-attempt cap of **20 seconds** and a **256 KiB** decoded provider-response limit. At most one internal retry is made, with backoff max(250 ms, valid provider `Retry-After`) when it fits the remaining budget. Otherwise the retryable error returns immediately with numeric `retryAfterSeconds` details and an HTTP `Retry-After` header when available. Explicit timeout/cancellation bounds the operation independently of transport abort compliance; active readers and late responses are cleaned up. See [RELIABILITY.md](RELIABILITY.md).

The size/page/pixel limits and hard deadline are implementation proposals, not newly approved requirements. Each retry must fit inside the same processing deadline.

### Preparing a Real Request in PowerShell

This produces a JSON body on the clipboard without manually editing a large Base64 string:

```powershell
$filePath = "C:\Documents\certificate.pdf"
$body = @{
    documentId = "test-doc-001"
    documentType = "student_certificate"
    file = @{
        mimeType = "application/pdf"
        contentBase64 = [Convert]::ToBase64String(
            [System.IO.File]::ReadAllBytes($filePath)
        )
    }
} | ConvertTo-Json -Depth 3
$body | Set-Clipboard
```

For JPG/PNG, use the matching MIME type. The original filename and filesystem path are not sent to the OCR service.

## 3. Successful and Partial Responses

Both fully extracted and partial results return **HTTP 200**. A partial result is useful data, not a transport failure.

Responses use the requested profile after structural checks, normalization and semantic validation. `completed` requires present, valid, unambiguous values, matching type and no warnings; otherwise return `partial`. A different detected type never switches field sets silently. Success responses include `X-OCR-AI-Provider: openai` or `mock`.

Every successful or partial response includes all keys for the requested document profile. Text fields are strings or `null`; `yearOfStudy` is an integer or `null`. IDs and room/order/faculty numbers remain strings so leading zeros and separators are preserved. `orderDate` is normalized to `YYYY-MM-DD` when valid; exact field-format and normalization rules are defined in [DOCUMENT_PROFILES.md](DOCUMENT_PROFILES.md). Required response keys are not the same as required application values: missing source fields remain reviewable partial results, while the monolith controls submission requirements.

| Property | Meaning |
| --- | --- |
| `documentId` | Original caller-provided identifier |
| `documentType` | Original requested type |
| `detectedDocumentType` | A canonical recognized type, or `unknown` when it cannot be established; a medical detection produces an error instead of a successful response |
| `status` | `completed` when there are no field issues or warnings; otherwise `partial` |
| `fields` | Only the requested profile's fields; all profile keys must be present |
| `fieldIssues` | Array of `{field, code, message}` objects identifying fields needing attention |
| `warnings` | Array of document-level warning codes: `document_type_mismatch`, `mock_result` |
| `requiresManualReview` | `true` for `partial`, `false` for `completed`; a signal that additional attention is needed, not administrative approval |

Field issue codes:

- `missing`: no value was found; return `null`.
- `invalid_format`: a candidate violates the field rules. Keep it if it has the field's JSON type; otherwise return `null` and flag the issue.
- `uncertain`: a candidate is ambiguous; keep a type-valid candidate or return `null`, and require review.

Each `fieldIssues[].field` must name a field in the requested profile. Every `null` field must have an issue. A field can have more than one issue. Remove fields not in the requested profile.

Document-level warnings:

- `document_type_mismatch`: the detected type differs from the requested type or is unknown; keep the requested profile and require review.
- `mock_result`: values are fixed synthetic examples and are unrelated to the input's contents. Always require review and exclude these results from accuracy measurement.

Either warning forces `partial` and `requiresManualReview: true`. A blank image in mock mode still yields synthetic values; a blank/unreadable image in real mode should be identified by the model and produce `422 unreadable_document`. The temporary task-8 validation-pending marker is no longer emitted.

If the detected type differs from the requested type or is `unknown`, return `document_type_mismatch`, `partial`, and `requiresManualReview: true`. Do not switch profiles silently. If the model identifies a medical document, discard the extraction and return `422 unsupported_document_type`; do not return medical content.

`completed` means that all target values passed extraction checks. **The user still reviews and confirms them in the main application.** If readable text exists but none of the target fields is found, return a partial result with `null` values and issues. If the document itself is unreadable, return `422 unreadable_document`.

### Complete Certificate Example

```json
{
  "documentId": "test-doc-001",
  "documentType": "student_certificate",
  "detectedDocumentType": "student_certificate",
  "status": "completed",
  "fields": {
    "fullName": "Ivan Petrov Ivanov",
    "facultyNumber": "001234567",
    "specialty": "Computer Systems and Technologies",
    "yearOfStudy": 2
  },
  "fieldIssues": [],
  "warnings": [],
  "requiresManualReview": false
}
```

Examples use synthetic values. Actual Bulgarian document values retain their original language and alphabet; do not translate or transliterate them.

### Partial Certificate Example

```json
{
  "documentId": "test-doc-001",
  "documentType": "student_certificate",
  "detectedDocumentType": "student_certificate",
  "status": "partial",
  "fields": {
    "fullName": "Ivan Petrov Ivanov",
    "facultyNumber": "001234567",
    "specialty": null,
    "yearOfStudy": 2
  },
  "fieldIssues": [
    {
      "field": "specialty",
      "code": "missing",
      "message": "Specialty was not found. Enter it manually."
    }
  ],
  "warnings": [],
  "requiresManualReview": true
}
```

## 4. Errors and Retry Rules

Errors use this envelope. `details` contains safe field-level metadata, never file contents, tokens, or the provider's response body. `documentId` is not required on errors because the request may not contain a valid identifier.

```json
{
  "error": {
    "code": "provider_unavailable",
    "message": "The AI provider is temporarily unavailable.",
    "retryable": true,
    "details": {}
  }
}
```

| HTTP | `error.code` | Retryable | Caller action |
| --- | --- | --- | --- |
| 400 | `invalid_json`, `invalid_request`, `invalid_base64` | No | Correct the request |
| 401 | `unauthorized` | No | Supply a valid service token |
| 404 | `not_found` | No | Check the endpoint and HTTP method |
| 413 | `payload_too_large`, `file_too_large`, `page_limit_exceeded` | No | Reduce request/file size, image dimensions, or PDF page count |
| 415 | `unsupported_media_type`, `unsupported_file` | No | Use JSON containing a supported file with matching MIME type |
| 422 | `unsupported_document_type`, `unreadable_document` | No | Use a supported type, a clearer document, or manual entry |
| 500 | `internal_error` | No | Investigate the service error, invalid Python output, or exceeded subprocess output limit; allow manual entry |
| 502 | `provider_bad_response` | Yes | Retry later within the monolith's retry policy |
| 502 | `provider_request_rejected` | No | Investigate provider/model compatibility or refusal; use manual review |
| 503 | `provider_unavailable` | Yes | Retry later with bounded backoff |
| 503 | `service_not_configured`, `provider_configuration_error`, `processing_not_configured` | No | Correct credentials/model/configuration. `processing_not_configured` at stage `preprocessing` means Python startup/dependencies failed. |
| 504 | `processing_timeout`, `provider_timeout` | Yes | Retry later or allow manual entry |

The monolith checks `retryable`, not HTTP status alone, and respects the optional `Retry-After` header/`error.details.retryAfterSeconds` in addition to its own capped backoff. Do not retry partial results automatically. Transient network errors, provider rate limits/5xx, and invalid model responses allow at most one internal retry within the same deadline. Authentication and other permanent errors are not retried. An input-pipe failure that leaves Python stalled is terminated after a short structured-error grace and returns a non-retryable internal error.

Repeated calls with the same `documentId` may run extraction again and incur another AI call. The service does not store or deduplicate jobs, and it does not promise identical AI results. The monolith prevents duplicate active jobs and ignores results for outdated/deleted documents.

On any failure, the monolith retains the original and allows manual entry. A retryable error never requires deleting or reuploading the original.

## 5. Health Endpoint

```http
GET /health
```

No service token or AI call is required. HTTP 200:

```json
{"status": "ok", "service": "dormitory-ocr"}
```

This is process liveness, not proof that Python, the AI provider, or credentials are available.

## 6. Testing with Postman

1. Choose **Import → Files** and select [openapi.json](openapi.json); generate a collection if prompted.
2. Configure `SERVICE_TOKEN`, Python, and `AI_PROVIDER` in `.env`; real mode also needs the AI key/model. Restart the service and use `http://127.0.0.1:3000` as the base URL.
3. Open `POST /api/v1/ocr/process` and set API-key authentication to `X-Service-Token: <your-service-token>`; alternatively add that header directly.
4. Set **Body → raw → JSON** and paste the body produced by the PowerShell example above.
5. Send the request. In mock mode, expect fixed synthetic fields and `mock_result`. In real mode, compare returned values with a readable certificate. Complete format checks return `completed`; missing/invalid/uncertain fields or a type mismatch return `partial`. Human confirmation remains necessary.
6. Save requests for a complete result, missing-field result, invalid token, invalid Base64, unsupported type, and unreadable document.

The OpenAPI request example contains a valid **1×1 blank PNG** to illustrate transport encoding. Replace it with an actual readable document before testing extraction. It is not a certificate or an accuracy-test fixture. Importing OpenAPI provides request/response documentation; it does not start an OCR server or simulate extraction.

## 7. Review with the Monolith Developer

- [ ] Accept the endpoint and Base64 JSON transport instead of the architecture's multipart variant.
- [ ] Accept the canonical document types, property names, and opaque identifier rules.
- [ ] Accept the complete/partial response semantics, per-field issues, and manual review behavior.
- [ ] Accept the errors, retry policy, proposed limits, and processing/client time budgets.
- [ ] Align the shared architecture and integration code with the accepted version.

Once accepted, record the acceptance here and remove the draft label. Until then, this document is an explicit proposal rather than evidence of team agreement.
