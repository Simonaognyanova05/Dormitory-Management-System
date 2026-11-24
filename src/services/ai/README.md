# Vision Extraction Client

The **OpenAI-compatible Chat Completions** adapter and explicitly selected mock client support `student_certificate` and `placement_order`. Both consume prepared PNG pages and return the shared internal envelope with the requested profile's exact field set. Schemas/prompts are per-request, so concurrent types do not mix.

## Files

- `certificate-profile.js`: the four target fields, document-type hints, prompt, and strict JSON Schema.
- `placement-order-profile.js`: order number/date/dormitory/room schema, date-source hints and multi-student ambiguity instructions.
- `document-profiles.js`: metadata-only profile selection; no validator imports or mutable per-request state.
- `vision-request.js`: shared ordered image request builder using the selected profile.
- `gpt-vision.js`: native `fetch` transport, bounded response reading, provider errors, deadlines, cancellation, and at most one retry.
- `mock-vision.js`: fresh fixed synthetic values for every request; it never reads the document or calls an API.
- `client.js`: selects the provider from `AI_PROVIDER`; no automatic fallback to mock.
- `extraction-response.js`: normalizes/validates certificate values and classifies completed/partial results with review issues/warnings.
- [ai-extraction.js](../../validators/ai-extraction.js): runtime validation of the provider's internal JSON shape.
- [certificate-fields.js](../../validators/certificate-fields.js): semantic certificate-field normalization and validation.
- [placement-order-fields.js](../../validators/placement-order-fields.js): calendar-date and textual order/location normalization.

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

One provider request contains all prepared page images in order, profile-specific descriptions/instructions and strict JSON Schema. It does not include the original filename, document ID, student profile, or application history. Images use Base64 data URLs with the configured detail level. The request sets `store: false` and requests no tools.

The prompts treat document content as untrusted data, preserve original-language values and leading zeros, and require `null` rather than guessed facts. Certificate instructions distinguish student/issuer names and course/semester. Order instructions distinguish order/placement-start dates and refuse arbitrary row selection in multi-student tables. Ambiguity uses names in `uncertainFields`, not numeric confidence.

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

This is the certificate example. Order extraction uses exactly `orderNumber`, `orderDate`, `dormitory`, `room`, each string-or-null, and its own uncertainty enum. All envelope/profile properties are required; extra properties, wrong types and another profile's fields are rejected. Missing values are nullable. The runtime validator independently checks the selected schema shape.

`readable: false` becomes `422 unreadable_document`; a medical detection becomes `422 unsupported_document_type`. A different/unknown detected type returns a reviewable result with `document_type_mismatch`. Provider refusal is a non-retryable `502 provider_request_rejected`, not invented data.

## Field Validation and Review State

The provider schema verifies JSON structure, not the correctness of recognized values. [Certificate validation](../../validators/certificate-fields.js) checks faculty identifiers and years; [order validation](../../validators/placement-order-fields.js) checks source identifiers and Gregorian calendar dates, normalizing valid dates to ISO without locale/timezone conversion. Both use shared own-key iteration/missing/uncertain handling and preserve invalid candidates for review under [DOCUMENT_PROFILES.md](../../../DOCUMENT_PROFILES.md).

Successful extraction returns HTTP **200**. If all values pass the semantic rules, the type matches and no issues/warnings remain, the response is `completed` with `requiresManualReview: false`. Missing, invalid, uncertain or mismatched data remains `partial`. Mock mode always remains partial. The temporary validation-pending warning is no longer emitted.

Absent/blank values become `null` with `missing`. Type-correct invalid values (such as integer year `9`) are retained with `invalid_format`; wrong raw candidate types become `null` rather than guessed strings. `uncertain` is an independent issue and can coexist with another field problem. Issues describe the required action without including candidate values. Semantic problems do not trigger provider retries.

The provider's strict schema is still enforced first. Defensive normalizer tests with Roman strings, missing keys or numeric identifiers do not imply that nonconforming provider JSON is accepted. Completed format checks do not prove recognition accuracy or bypass the user's confirmation in the monolith.

## Mock Mode

```dotenv
AI_PROVIDER=mock
```

Restart after changing `.env`. This mode requires no AI key/model and makes no provider requests. Admission and Python preparation are real. Each profile returns its own fixed synthetic fields for **any valid image, including a blank one**; this is not OCR and cannot measure accuracy. Order demo values and Postman usage are in [PLACEMENT_ORDERS.md](../../../PLACEMENT_ORDERS.md).

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
