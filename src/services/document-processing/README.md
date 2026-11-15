# Document Processing Layer

`process-document.js` is the current boundary after authenticated request/file validation. It deliberately returns `503 processing_not_configured` while the extraction pipeline is pending, rather than inventing a successful OCR response.

Task 6 implements standalone [Python preprocessing](../../../python/README.md). Task 7 adds the Node.js coordination: starting `python/preprocess.py --stdin --mime-type ...`, passing original bytes, bounding/validating stdout, handling deadlines, and process failures. Production calls use no preview output directory. The route passes the original in-memory bytes, validated identifiers/MIME type, and inspection metadata to this layer.

The HTTP tests inject a test-only processor to verify that valid files reach this boundary unchanged and rejected files never reach it. Production does not use that simulated processor. Profile rules are defined in [DOCUMENT_PROFILES.md](../../../DOCUMENT_PROFILES.md).
