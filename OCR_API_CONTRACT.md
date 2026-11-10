# OCR API Contract

**Version:** 1.0.0-draft  
**Status:** proposed contract for the OCR branch; acceptance by the monolith developer is pending.  
**Machine-readable definition:** [openapi.json](openapi.json), importable into Postman.

This document completes the contract-design work in task 2. It describes the intended API; there is no running implementation yet. Document-specific validation rules and test fixtures are developed in task 3.

## 1. Integration Decisions

| Topic | Proposed decision |
| --- | --- |
| Endpoint | `POST /api/v1/ocr/process` |
| Local base URL | `http://localhost:3000` |
| Request and response encoding | UTF-8 JSON |
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
| `placement_form` | `fullName`, `phone`, `permanentAddress` | Optional; proposed fields to confirm in task 3 |
| `address_registration` | `city`, `addressLine` | Optional; proposed fields to confirm in task 3 |

`medical` and all unknown types are rejected before Python processing or any AI request. The monolith must not send medical documents to this endpoint. This check concerns the declared type; it cannot establish the actual content of a file before reading it.

The architecture's `student_status_certificate` maps to this contract's `student_certificate`; `full_name`, `faculty_number`, and `course` map to `fullName`, `facultyNumber`, and `yearOfStudy`. The monolith performs any necessary mapping; those aliases are not accepted by this API.

### Proposed Limits

- Maximum decoded file: **10 MiB = 10,485,760 bytes**.
- Maximum Base64 length for that file limit: **13,981,016 characters**. Decode and check the actual byte length as well.
- Maximum complete JSON body: **14 MiB = 14,680,064 bytes**, allowing for Base64 and metadata.
- Maximum PDF pages: **3**. Reject longer PDFs; do not silently truncate them.
- Processing target: **15 seconds** for a document of up to 3 pages under documented normal conditions.
- Proposed hard processing deadline: **40 seconds**, including preprocessing, AI calls, and internal retries, starting after request validation. The monolith's response timeout should allow at least **45 seconds**, plus appropriate upload time.

The 10 MiB/3-page limits and hard deadline are implementation proposals, not newly approved requirements. Each retry must fit inside the same processing deadline.

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

Every response includes all keys for the requested document profile. Text fields are strings or `null`; `yearOfStudy` is an integer or `null`. IDs and room/order/faculty numbers remain strings so leading zeros and separators are preserved. `orderDate` is normalized to `YYYY-MM-DD` when valid; exact field-format rules are defined in task 3.

| Property | Meaning |
| --- | --- |
| `documentId` | Original caller-provided identifier |
| `documentType` | Original requested type |
| `detectedDocumentType` | A canonical recognized type, or `unknown` when it cannot be established; a medical detection produces an error instead of a successful response |
| `status` | `completed` when there are no field issues or warnings; otherwise `partial` |
| `fields` | Only the requested profile's fields; all profile keys must be present |
| `fieldIssues` | Array of `{field, code, message}` objects identifying fields needing attention |
| `warnings` | Array of document-level warning codes; currently `document_type_mismatch` |
| `requiresManualReview` | `true` for `partial`, `false` for `completed`; a signal that additional attention is needed, not administrative approval |

Field issue codes:

- `missing`: no value was found; return `null`.
- `invalid_format`: a candidate violates the field rules. Keep it if it has the field's JSON type; otherwise return `null` and flag the issue.
- `uncertain`: a candidate is ambiguous; keep a type-valid candidate or return `null`, and require review.

Each `fieldIssues[].field` must name a field in the requested profile. Every `null` field must have an issue. A field can have more than one issue. Remove fields not in the requested profile.

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
| 413 | `payload_too_large`, `file_too_large`, `page_limit_exceeded` | No | Reduce the request, file size, or PDF page count |
| 415 | `unsupported_media_type`, `unsupported_file` | No | Use JSON containing a supported file with matching MIME type |
| 422 | `unsupported_document_type`, `unreadable_document` | No | Use a supported type, a clearer document, or manual entry |
| 500 | `internal_error` | No | Investigate the service error; allow manual entry |
| 502 | `provider_bad_response` | Yes | Retry later within the monolith's retry policy |
| 502 | `provider_request_rejected` | No | Investigate provider/model compatibility |
| 503 | `provider_unavailable` | Yes | Retry later with bounded backoff |
| 503 | `service_not_configured`, `provider_configuration_error`, `processing_not_configured` | No | Correct service credentials/configuration |
| 504 | `processing_timeout`, `provider_timeout` | Yes | Retry later or allow manual entry |

The monolith checks `retryable`, not HTTP status alone. Do not retry partial results automatically. Transient network errors, provider rate limits/5xx, and invalid model responses allow at most one internal retry within the same deadline. Provider authentication errors and other non-retryable errors are not retried.

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
2. Use `http://localhost:3000` as the base URL when the service has been implemented and started.
3. Open `POST /api/v1/ocr/process` and set API-key authentication to `X-Service-Token: <your-service-token>`; alternatively add that header directly.
4. Set **Body → raw → JSON** and paste the body produced by the PowerShell example above.
5. Send the request and compare the returned values with the original document.
6. Save requests for a complete result, missing-field result, invalid token, invalid Base64, unsupported type, and unreadable document.

The OpenAPI request example contains a valid **1×1 blank PNG** to illustrate transport encoding. Replace it with an actual readable document before testing extraction. It is not a certificate or an accuracy-test fixture. Importing OpenAPI provides request/response documentation; it does not start an OCR server or simulate extraction.

## 7. Review with the Monolith Developer

- [ ] Accept the endpoint and Base64 JSON transport instead of the architecture's multipart variant.
- [ ] Accept the canonical document types, property names, and opaque identifier rules.
- [ ] Accept the complete/partial response semantics, per-field issues, and manual review behavior.
- [ ] Accept the errors, retry policy, proposed limits, and processing/client time budgets.
- [ ] Align the shared architecture and integration code with the accepted version.

Once accepted, record the acceptance here and remove the draft label. Until then, this document is an explicit proposal rather than evidence of team agreement.
