# Vision Extraction Client

Task 8 adds a real **OpenAI-compatible Chat Completions** adapter and an explicit, replaceable mock client for `student_certificate`. Both consume the prepared PNG pages from Python and return the same internal extraction shape.

## Files

- `certificate-profile.js`: the four target fields, document-type hints, prompt, and strict JSON Schema.
- `gpt-vision.js`: native `fetch` transport, bounded response reading, provider errors, deadlines, cancellation, and at most one retry.
- `mock-vision.js`: fresh fixed synthetic values for every request; it never reads the document or calls an API.
- `client.js`: selects the provider from `AI_PROVIDER`; no automatic fallback to mock.
- `extraction-response.js`: normalizes/validates certificate values and classifies completed/partial results with review issues/warnings.
- [ai-extraction.js](../../validators/ai-extraction.js): runtime validation of the provider's internal JSON shape.
- [certificate-fields.js](../../validators/certificate-fields.js): semantic certificate-field normalization and validation.

## Real Provider Configuration

In the root `.env`:

```dotenv
AI_PROVIDER=openai
PYTHON_COMMAND=.venv/Scripts/python.exe
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_DETAIL=high
OPENAI_TEMPERATURE=0
```

`gpt-4.1-mini` is a configurable starting example, not a measured best model. Select an available model supporting image inputs, Chat Completions, strict `response_format=json_schema`, and `max_completion_tokens`. Leave `OPENAI_TEMPERATURE` empty for models that do not accept it. `original` image detail is model-specific; `high` is the default.

The endpoint is `<OPENAI_BASE_URL>/chat/completions`. The base URL must not contain embedded credentials, query parameters, or a fragment. Credentials/model are checked before preprocessing; a missing key/model returns non-retryable `503 provider_configuration_error`. Health and Python-only checks do not require AI credentials.

## What Is Sent

One provider request contains all prepared page images in order, field descriptions, and a strict JSON Schema. It does not include the original filename, document ID, student profile, or application history. Images use Base64 data URLs with the configured detail level. The request sets `store: false` and requests no tools.

The prompt treats all document content as untrusted data, asks for original-language values and leading zeros, and requires `null` rather than guessed facts. It distinguishes the student's name from the issuer's name and course from semester/academic year. Ambiguity is represented by field names in `uncertainFields`, not fabricated numeric confidence.

Declared medical/disabled types are rejected before processing by the API and cannot be requested directly from this client. If the model identifies a medical document, the response adapter rejects it and returns no extracted content.

## Internal Extraction Shape

```json
{
  "readable": true,
  "detectedDocumentType": "student_certificate",
  "fields": {
    "fullName": "Иван Петров Иванов",
    "facultyNumber": "001234567",
    "specialty": "Компютърни системи и технологии",
    "yearOfStudy": 2
  },
  "uncertainFields": []
}
```

All properties are required, and extra properties/wrong types are rejected. `fields` has exactly the four certificate keys. Missing values are nullable. The runtime validator also checks the schema independently of the provider's schema promise.

`readable: false` becomes `422 unreadable_document`; a medical detection becomes `422 unsupported_document_type`. A different/unknown detected type returns a reviewable result with `document_type_mismatch`. Provider refusal is a non-retryable `502 provider_request_rejected`, not invented data.

## Field Validation and Review State

The provider schema verifies JSON structure, not the correctness of recognized values. [The semantic normalizer](../../validators/certificate-fields.js) applies the certificate rules from [DOCUMENT_PROFILES.md](../../../DOCUMENT_PROFILES.md): NFC/whitespace normalization, string identifiers with preserved leading zeros, the working 5–12 letter/digit faculty-number format, a 200-code-point text limit, and study years 1–6.

Successful extraction returns HTTP **200**. If all values pass the semantic rules, the type matches and no issues/warnings remain, the response is `completed` with `requiresManualReview: false`. Missing, invalid, uncertain or mismatched data remains `partial`. Mock mode always remains partial. The temporary validation-pending warning is no longer emitted.

Absent/blank values become `null` with `missing`. Type-correct invalid values (such as integer year `9`) are retained with `invalid_format`; wrong raw candidate types become `null` rather than guessed strings. `uncertain` is an independent issue and can coexist with another field problem. Issues describe the required action without including candidate values. Semantic problems do not trigger provider retries.

The provider's strict schema is still enforced first. Defensive normalizer tests with Roman strings, missing keys or numeric identifiers do not imply that nonconforming provider JSON is accepted. Completed format checks do not prove recognition accuracy or bypass the user's confirmation in the monolith.

## Mock Mode

```dotenv
AI_PROVIDER=mock
```

Restart after changing `.env`. This mode requires no AI key/model and makes no provider requests. It still performs real admission and Python image preparation. It returns the same fixed synthetic certificate fields for **any valid image, including a blank one**, so it is not OCR and cannot be used for accuracy evaluation.

The public response includes **`mock_result`**, `status: "partial"`, `requiresManualReview: true`, and `X-OCR-AI-Provider: mock`, even when every synthetic value has a valid format. Real mode uses the `openai` header value. Selecting mock is explicit; transport errors never silently turn into demonstration results.

## Timeouts, Retries, and Error Handling

- Python and AI share `PROCESSING_TIMEOUT_MS`; extraction receives the remaining deadline rather than starting a new full budget.
- `AI_REQUEST_TIMEOUT_MS` caps each provider attempt. Overall expiry is `504 processing_timeout`; per-attempt/provider expiry is `504 provider_timeout`.
- Network errors, 429/5xx, and malformed/incomplete structured output allow **one retry**. Backoff is max(250 ms, valid provider `Retry-After`), only when it fits the remaining budget. Numeric retry metadata is returned to the caller when available.
- Provider authentication errors, other rejected requests, refusals, unreadable documents, and medical detections are not retried.
- Explicit timeout/cancellation promises bound even replacement transports that ignore their abort signal. Active readers are cancelled and late responses discarded. Client disconnection aborts transport and retry waits.
- `MAX_AI_RESPONSE_BYTES` caps the streamed, decoded response body. Oversized/non-JSON/invalid UTF-8 output is `502 provider_bad_response`.
- Provider error bodies, refusal text, API keys, image data, and raw extracted content are not written to logs or included in error messages. Redirects are not followed.

## Verification

`npm test` uses injected responses and a local HTTP provider to test payloads, strict output handling, failures, budgets, and cancellation. `npm run test:python` exercises real Python with the explicitly marked mock client. These tests do not call a paid AI provider.

**Still pending:** a real-provider smoke test with a configured key/model and a readable certificate, followed by comparison with known values. Anonymized real layouts or real forms filled with synthetic data are useful here. These integration checks do not establish the 90% accuracy target.

The [early evaluator](../../../EVALUATION.md) now provides a 12-document Bulgarian corpus, fixed comparison rules and stage timing reports for that follow-up. It requires real mode and rejects `mock_result`; local provider fixtures test the evaluator only, not recognition quality.

Provider references:

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
