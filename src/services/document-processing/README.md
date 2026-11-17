# Document Processing Layer

`process-document.js` checks real-provider configuration, runs Python preparation, sends the prepared pages to the selected [vision client](../ai/README.md), and builds the reviewable HTTP response. Mock mode is explicit and marked in the result. Semantic field validation follows in task 9; current extraction results remain `partial` with `field_validation_pending`.

`python-preprocessor.js` starts [python/preprocess.py](../../../python/preprocess.py) with `child_process.spawn()` and separate arguments, from the repository root, with `shell: false`. A configured relative Python path is resolved from that root. The original bytes go through stdin; the script receives the configured input limits and an explicit 2000-pixel output-side limit. Each request owns its child process and buffers.

Stdout is bounded UTF-8 JSON. Stderr is separately bounded and discarded, never merged into JSON or logged. Both normal completion and error handling wait for child-process closure. Timeout, cancellation, or output overflow terminates the worker, with a 250 ms force-kill fallback. HTTP disconnects cancel the request's worker. No temporary files are created by the HTTP path.

[prepared-document.js](../../validators/prepared-document.js) validates the exact protocol, page count/order against the inspected source, image dimensions, transformations, Base64 and actual RGB PNG decoding. Python and AI reuse one processing deadline; provider retries do not reset the budget.

Known Python validation codes are mapped to fixed safe API errors. Arbitrary child messages/details are not forwarded. Missing executables/imports are `503 processing_not_configured` at stage `preprocessing`; invalid output or output overflow is `500 internal_error`; deadline expiry is retryable `504 processing_timeout`. Original documents remain unchanged in the monolith.

`npm test` checks admission, subprocess failures and the AI adapter using injected/local HTTP responses. `npm run test:python` exercises actual Python, concurrent documents, PDF page order and HTTP processing with clearly marked mock extraction. `npm run check:python` checks only Python using the configured executable. No automated test calls a paid provider. Profile rules are defined in [DOCUMENT_PROFILES.md](../../../DOCUMENT_PROFILES.md).
