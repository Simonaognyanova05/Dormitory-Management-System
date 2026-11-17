# Document Processing Layer

`process-document.js` runs the real Python preparation after authenticated request/file validation. It then returns `503 processing_not_configured` with `details.stage: "extraction"` and the prepared page count until the GPT client is implemented in task 8. No OCR fields are invented.

`python-preprocessor.js` starts [python/preprocess.py](../../../python/preprocess.py) with `child_process.spawn()` and separate arguments, from the repository root, with `shell: false`. A configured relative Python path is resolved from that root. The original bytes go through stdin; the script receives the configured input limits and an explicit 2000-pixel output-side limit. Each request owns its child process and buffers.

Stdout is bounded UTF-8 JSON. Stderr is separately bounded and discarded, never merged into JSON or logged. Both normal completion and error handling wait for child-process closure. Timeout, cancellation, or output overflow terminates the worker, with a 250 ms force-kill fallback. HTTP disconnects cancel the request's worker. No temporary files are created by the HTTP path.

[prepared-document.js](../../validators/prepared-document.js) validates the exact protocol, page count/order against the inspected source, image dimensions, transformations, Base64 and actual RGB PNG decoding. The processing deadline covers startup, execution and output validation; task 8 must reuse the remaining budget for extraction.

Known Python validation codes are mapped to fixed safe API errors. Arbitrary child messages/details are not forwarded. Missing executables/imports are `503 processing_not_configured` at stage `preprocessing`; invalid output or output overflow is `500 internal_error`; deadline expiry is retryable `504 processing_timeout`. Original documents remain unchanged in the monolith.

`npm test` checks admission and real subprocess failure fixtures without needing Python. `npm run test:python` exercises the actual Python script, simultaneous documents, PDF page order, input failures and HTTP processing. `npm run check:python` is a short operator check using the configured executable. Profile rules are defined in [DOCUMENT_PROFILES.md](../../../DOCUMENT_PROFILES.md).
