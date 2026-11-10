# OCR Microservice Tasks — Simona Ognyanova

This checklist describes the steps for developing the student dormitory OCR microservice. Follow them in order and mark completed items with `[x]`.

**First working version:** extract data from a student status certificate.
**Required scope under the Software Requirements Specification (SRS):** student status certificates and placement orders.
**Optional scope:** placement forms and address registration applications.

## What I Am Building

The detailed OCR technical specification describes the following flow:

```text
FastAPI monolith
    → Node.js / Express API
    → Python: document preprocessing
    → Node.js: GPT Vision request
    → validated fields in JSON
    → FastAPI monolith
    → React: user review and correction
```

My service receives a document from the monolith, prepares it, extracts its fields, and returns the result. The monolith stores originals and results and manages user access and processing jobs. The human review interface is integrated with the teammate responsible for forms and the administration panel. JEV evaluation of motivational letters is Daniel's separate task.

## Stage 1. Agree on the Contract

### 1. Confirm the Technology Stack

- [ ] Agree with the team on **Node.js + Express**, **Python + PyMuPDF/OpenCV/Pillow**, and **GPT Vision**, as described in the detailed OCR specification.
- [ ] Resolve the differences with the general project proposal, which lists Tesseract, and the architecture `.docx`, which lists FastAPI for the OCR service.
- [ ] Document the confirmed choice in the microservice README.

**Done when:** there is one agreed technology stack for implementation.

### 2. Agree on the API with the Monolith Developer

- [ ] Confirm `POST /api/v1/ocr/process` and JSON with Base64, as proposed in the OCR specification. Resolve the difference with the multipart contract in the architecture document.
- [ ] Describe the input fields: `documentId`, `documentType`, `file.mimeType`, and `file.contentBase64`.
- [ ] Clarify the accepted `documentId` format; do not require UUIDs without agreement.
- [ ] Describe the output: `documentId`, `status`, `fields`, and `requiresManualReview`, including how individual fields requiring review are identified.
- [ ] Agree on consistent document type and field names. For example, do not mix `student_certificate`/`student_status_certificate` or `fullName`/`full_name`.
- [ ] Agree on the error format, HTTP status codes, and which errors are retryable.
- [ ] Confirm file size and page limits. **10 MB and 3 pages for processable document types are proposals from the architecture document.**

**Done when:** both sides accept examples of a request, a successful response, a partial result, and an error.

### 3. Define Document Profiles

- [ ] For student status certificates: full name, faculty number, specialty, and year of study.
- [ ] For placement orders: order number, date, dormitory, and room.
- [ ] Clarify with the team which fields are required by the form and which may be absent from the document.
- [ ] Define the medical document type as excluded from automatic processing.
- [ ] Prepare examples with expected values for the first document type.

**Done when:** field names, data types, and validation rules are defined for each required document type.

## Stage 2. Minimal Service Skeleton

### 4. Create the Project Structure and Configuration

- [ ] Initialize the Node.js project and add Express.
- [ ] Separate API routes, document processing, the AI client, and validators into clear modules.
- [ ] Create a directory for Python scripts and a Python dependency file.
- [ ] Add `.gitignore` entries for `.env`, `node_modules`, the Python environment, and temporary files.
- [ ] Add `.env.example` with the service token, GPT API key, model, port, Python command, and file limits.
- [ ] Add startup commands and `GET /health` without calling GPT.

**Done when:** the service starts locally and the health check returns a successful response.

### 5. Implement Authenticated Request Handling

- [ ] Check the service token before starting processing.
- [ ] Validate the input JSON structure and document type.
- [ ] Validate the Base64 content and actual file format: PDF, JPG, or PNG.
- [ ] Limit both the JSON request size and the decoded file size, accounting for Base64 overhead.
- [ ] Reject medical and unsupported document types **before Python processing or any GPT request**.
- [ ] Return the agreed errors for invalid requests.

**Done when:** valid requests are accepted, while invalid or unauthorized requests do not reach processing.

## Stage 3. Python Preprocessing

### 6. Implement File Preparation

- [ ] Open PDFs with PyMuPDF and check the page count.
- [ ] Convert pages to images, including scanned PDFs without selectable text.
- [ ] Support JPG/PNG input directly.
- [ ] Correct image orientation and skew.
- [ ] Add suitable resizing, contrast enhancement, and noise reduction, comparing results before and after processing.
- [ ] Handle corrupt files, password-protected PDFs, and exceeded limits.

**Done when:** supported files are converted into readable images with predictable dimensions.

### 7. Connect Node.js and Python

- [ ] Start the script using `child_process.spawn()` with separate arguments, without constructing a shell command from user input.
- [ ] Define how input and results are passed between processes.
- [ ] Keep machine-readable output separate from diagnostic messages.
- [ ] Handle startup failures, nonzero exit codes, and invalid Python output.
- [ ] Add an execution timeout and terminate stalled processes.
- [ ] If temporary files are used, isolate them per request and delete them on both success and failure.

**Done when:** an API request receives prepared images, and concurrent requests do not mix their files.

## Stage 4. First Complete Document Type — Student Status Certificate

### 8. Integrate GPT Vision

- [ ] Create an AI client with a configurable key and vision-capable model.
- [ ] Send the prepared images with specific instructions for the certificate's four fields.
- [ ] Require structured JSON without additional free text.
- [ ] Instruct the model to return `null` for missing values rather than inventing information.
- [ ] Instruct the model to treat document content as data rather than instructions.
- [ ] Add a replaceable test/mock client for development without real AI calls and clearly label it as a simulation.

**Done when:** a real provider returns extracted values from a sample certificate.

### 9. Validate Fields and Return the Result

- [ ] Accept only fields defined by the profile and check their data types.
- [ ] Preserve faculty numbers as strings, including leading zeros.
- [ ] Validate the faculty number format and year-of-study range according to the agreed rules.
- [ ] Flag missing and invalid fields and set `requiresManualReview` according to the agreed rules.
- [ ] Do not present a valid format as proof of correct recognition. If returning a confidence estimate, describe its source and limitations.
- [ ] Return partial results for missing fields so the monolith can offer manual entry.

**Done when:** a certificate completes the entire flow and the API returns a JSON result that can be reviewed against the original.

### 10. Check Performance and Quality Early

- [ ] Try at least 10 sample/synthetic documents of varying quality.
- [ ] Compare extracted fields with known expected values.
- [ ] Measure preprocessing time, AI request time, and total time.
- [ ] Adjust preprocessing, prompts, or the selected model as needed before adding other document types.

**Done when:** initial measurements are available and the errors requiring improvement are identified.

## Stage 5. Reliability and the Second Required Document Type

### 11. Handle Failures and Execution Deadlines

- [ ] Handle timeouts, network errors, rate limits, and provider failures.
- [ ] Handle invalid/incomplete AI JSON and unreadable documents.
- [ ] Add bounded retries only for suitable errors.
- [ ] Align the overall time budget with the monolith's timeout and retry behavior, including Python processing.
- [ ] Return errors without API keys, personal data, or the provider's full response content.
- [ ] Verify that the monolith can retain the original and allow manual entry regardless of the OCR outcome.

**Done when:** failures leave no stalled processes or temporary files and produce predictable API responses.

### 12. Add Placement Orders

- [ ] Create a separate profile for order number, date, dormitory, and room.
- [ ] Normalize dates to the agreed format, such as `YYYY-MM-DD`.
- [ ] Preserve letters, separators, and leading zeros in identifiers.
- [ ] Return partial results and review flags when information is incomplete.
- [ ] Agree that the monolith matches dormitory and room values against its own records; the OCR service has no direct database connection.

**Done when:** both required document types work through the same API with separate profiles.

## Stage 6. Integration and Evaluation

### 13. Test the Essential Scenarios

- [ ] Valid text-based PDF, scanned PDF, JPG, and PNG.
- [ ] Missing fields, invalid values, and unreadable images.
- [ ] Incorrect document types and documents that do not match the requested type.
- [ ] Invalid JSON/Base64, corrupt files, and exceeded limits.
- [ ] Missing/incorrect service tokens and medical document types, without calling GPT.
- [ ] GPT and Python errors, retries, and cleanup after failure.
- [ ] Concurrent requests without mixed results.

**Done when:** tests verify expected responses, rather than only whether the service starts.

### 14. Integrate with FastAPI and the User Interface

- [ ] Provide teammates with a sample request, responses, and startup instructions.
- [ ] Verify sending a real file from the monolith to the OCR service.
- [ ] Verify form prefilling, highlighting fields requiring review, and human correction.
- [ ] Verify that the monolith saves confirmed values.
- [ ] Verify manual entry even after a complete OCR failure.
- [ ] Verify that the service token and GPT key never reach the browser client.

**Done when:** the complete user flow works with the main application.

### 15. Measure Accuracy and Performance

- [ ] Prepare at least **30 readable documents** with manually verified expected fields, including both required document types.
- [ ] Define comparison, normalization, and genuinely absent-field scoring rules in advance.
- [ ] Create a repeatable script that compares extraction results with ground truth before human correction.
- [ ] Calculate accuracy: **correctly extracted fields / all evaluated fields × 100**.
- [ ] Report overall accuracy and results by document type and field.
- [ ] Measure elapsed time from receiving the document to the final OCR result under documented conditions and load.
- [ ] Compare results against the targets of **at least 90% accuracy** and **no more than 15 seconds per document**; the SRS time target applies to documents of up to 3 pages.
- [ ] Document unmet targets, causes, and potential improvements. Do not report mock results as measured OCR accuracy.

**Done when:** a test dataset and a reproducible report with actual results are available.

## Stage 7. Extensions and Handover

### 16. Add Optional Document Types If Time Allows

- [ ] Placement form: clarify the fields, such as full name, phone number, and permanent address.
- [ ] Address registration application: clarify the locality and address fields.
- [ ] Add a profile, validators, sample documents, and checks for each type.
- [ ] Verify with the monolith developer that these types are processed only when requested.

**Done when:** optional profiles work without breaking the required ones.

### 17. Prepare Documentation and the Demonstration

- [ ] Describe Node.js/Python versions, dependencies, configuration, and startup commands.
- [ ] Document the API, document types, fields, limits, statuses, and errors.
- [ ] Document internal access and deployment HTTPS configuration with the teammate responsible for integration.
- [ ] Prepare sample documents demonstrating successful, partial, and failed OCR results.
- [ ] Include the accuracy and timing report, known limitations, and instructions for reproducing the measurements.
- [ ] Verify startup from a clean environment by following the README.
- [ ] Prepare a Pull Request to `dev` for team review.

**Done when:** another teammate can start, integrate, and demonstrate the service using only its documentation.

## Final Checklist for My Deliverable

- [ ] Certificates and placement orders are processed from input to structured output.
- [ ] Uncertain and missing fields are flagged for review.
- [ ] Medical document types are not processed or sent to GPT.
- [ ] The microservice has no permanent storage of originals or direct PostgreSQL access.
- [ ] Confirmation and administrative decisions remain in the main application.
- [ ] Working integration, meaningful tests, measurements, and startup instructions are provided.
