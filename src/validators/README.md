# Validation Layer

`process-request.js` validates the exact request shape, canonical identifiers/types, MIME declarations, strict Base64 encoding, and decoded byte limits. It rejects unsupported/medical types before decoding the file.

`document-file.js` checks actual PDF/image contents. It uses `pdf-lib` for PDF structure, encryption, and page counts, and `sharp` for image format, dimensions, and full pixel decoding. Invalid files never reach the processing boundary. Files remain in memory and are not rewritten.

Use [OCR_API_CONTRACT.md](../../OCR_API_CONTRACT.md), [openapi.json](../../openapi.json), and [DOCUMENT_PROFILES.md](../../DOCUMENT_PROFILES.md) as the contract. [Synthetic cases](../../examples/document-profile-cases.json) provide expected results for future validation tests.

Extracted-field validators are introduced in task 9. Configuration validation lives in `src/config/env.js`; service authentication and bounded UTF-8 JSON parsing run before these request validators.

`prepared-document.js` validates the Python result before it can reach the AI client: exact keys and types, page count/order, dimensions/transformation metadata, canonical Base64 and decoded RGB PNG content. Malformed child output becomes a fixed internal error rather than being treated as a successful preparation.
