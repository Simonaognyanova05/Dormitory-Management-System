# Validation Layer

`process-request.js` validates the exact request shape, canonical identifiers/types, MIME declarations, strict Base64 encoding, and decoded byte limits. It rejects unsupported/medical types before decoding the file.

`document-file.js` checks actual PDF/image contents. It uses `pdf-lib` for PDF structure, encryption, and page counts, and `sharp` for image format, dimensions, and full pixel decoding. Invalid files never reach the processing boundary. Files remain in memory and are not rewritten.

Use [OCR_API_CONTRACT.md](../../OCR_API_CONTRACT.md), [openapi.json](../../openapi.json), and [DOCUMENT_PROFILES.md](../../DOCUMENT_PROFILES.md) as the contract. [Synthetic cases](../../examples/document-profile-cases.json) provide expected results for future validation tests.

Configuration validation lives in `src/config/env.js`; service authentication and bounded UTF-8 JSON parsing run before the request validators.

`ai-extraction.js` checks the model's structural schema, required keys, nullable JSON types, detected document type and uncertainty-field names. Invalid provider JSON is rejected before semantic normalization.

`certificate-fields.js` implements the certificate's NFC/whitespace normalization, faculty-number and study-year rules, code-point limits, and missing/invalid/uncertain issues. It copies only own profile keys, never guesses lost leading zeros, and retains type-correct invalid values for review. Its defensive raw-candidate tests do not weaken the provider schema. The response adapter classifies the normalized result as completed only when no issues/warnings remain; mock results are always partial.

`prepared-document.js` validates the Python result before it can reach the AI client: exact keys and types, page count/order, dimensions/transformation metadata, canonical Base64 and decoded RGB PNG content. Malformed child output becomes a fixed internal error rather than being treated as a successful preparation.
