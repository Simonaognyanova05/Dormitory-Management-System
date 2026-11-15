# Document Processing Layer

`process-document.js` is the current boundary after authenticated request/file validation. It deliberately returns `503 processing_not_configured` while the extraction pipeline is pending, rather than inventing a successful OCR response.

Tasks 6–7 add Python preprocessing and coordination: preparing inputs, spawning the Python process, collecting its output, handling deadlines, and cleaning up temporary files. The route passes the original in-memory bytes, validated identifiers/MIME type, and inspection metadata to this layer.

The HTTP tests inject a test-only processor to verify that valid files reach this boundary unchanged and rejected files never reach it. Production does not use that simulated processor. Profile rules are defined in [DOCUMENT_PROFILES.md](../../../DOCUMENT_PROFILES.md).
