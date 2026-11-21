# OCR Failure Handling and Recovery

Task 11 verifies and hardens the failure paths of the OCR microservice. These checks use local provider responses and subprocess fault injection, without paid AI calls.

## 1. Failure Contract

Processing failures return the existing safe error envelope. They do not change the candidate's application decision or imply that the original file should be deleted.

| Condition | HTTP / code | Retryable | Behavior |
| --- | --- | --- | --- |
| Network failure, provider 429/5xx | 503 `provider_unavailable` | Yes | At most one internal retry if its backoff fits the remaining deadline |
| Provider timeout | 504 `provider_timeout` | Yes | Abort the attempt; retry only within the shared budget |
| Overall processing deadline | 504 `processing_timeout` | Yes | Stop processing; never start a later stage/retry |
| Malformed/incomplete/oversized AI output | 502 `provider_bad_response` | Yes | One bounded retry; no provider contents in the error |
| Missing credentials or provider 401/403 | 503 `provider_configuration_error` | No | Correct configuration rather than repeatedly sending documents |
| Rejected request or model refusal | 502 `provider_request_rejected` | No | Check compatibility or use manual handling |
| Unreadable document | 422 `unreadable_document` | No | Keep the original and offer clearer input/manual entry |
| Medical/disabled type | 422 `unsupported_document_type` | No | Do not automatically process the declared type |
| Missing Python setup | 503 `processing_not_configured` | No | Correct executable/script/dependencies |
| Invalid Python output or stream failure | 500 `internal_error` | No | Investigate; no invented successful extraction |
| Python input pipe fails and the worker stalls | 500 `internal_error` | No | Allow a short error-reporting grace, then terminate the worker |
| Missing/invalid/uncertain target fields | 200 `partial` | Not a transport retry | Return values/issues for correction; do not repeat AI automatically |
| HTTP client disconnects | No response can be delivered | Not applicable | Cancel active Python/AI work and retry waits |

The original API error codes and `retryable` remain authoritative. A 503 does not always mean retry: configuration failures are deliberately non-retryable.

## 2. One Budget, Bounded Attempts

- `PROCESSING_TIMEOUT_MS` defaults to **40 seconds**, starting at the processor boundary after admission. Python, AI calls/backoff and field validation share that deadline.
- `AI_REQUEST_TIMEOUT_MS` defaults to **20 seconds** per attempt, limited further by the remaining overall budget.
- The orchestration checks cancellation/deadline before entering each stage and after response validation, including when an injected stage/client does not check its own context.
- AI operations race explicit timeout/cancellation promises as well as aborting transport. A replacement transport that ignores `AbortSignal` cannot keep the caller waiting indefinitely.
- Active body readers are explicitly cancelled. Responses arriving after timeout are discarded and cannot become a successful result.
- Each service request makes **at most two provider attempts**. The second attempt is optional, not guaranteed; permanent errors, cancellation and insufficient remaining time prevent it.
- Python workers are stopped before the preprocessing promise rejects. `SIGTERM` has a **250 ms** force-kill fallback. An input-pipe error gets a **250 ms** grace for a structured Python error; if the worker stalls, it is stopped rather than consuming the full processing budget.

Use the actual Python executable, such as `.venv/Scripts/python.exe` or `.venv/bin/python`, as `PYTHON_COMMAND`; do not configure a shell command or wrapper that starts an unrelated process tree. Production processing passes raw bytes through stdin and writes no preview files, so there are no temporary input/output files to lose or clean up.

The monolith should allow at least **45 seconds plus appropriate upload time** for a response. Process termination/stream cleanup can use the short grace after the deadline. These are execution budgets, not a guarantee of 15-second performance; actual latency is measured separately in [EVALUATION.md](EVALUATION.md).

## 3. Rate Limits and Retry-After

For retryable provider statuses, the client accepts a valid `Retry-After` value as integer seconds or an HTTP date. It converts it into safe nonnegative integer `retryAfterSeconds` metadata; invalid/raw header text is never forwarded.

Internal retry delay is **max(250 ms, provider delay)**. If that delay does not fit the remaining processing budget, the service returns the retryable error immediately rather than retrying too early or extending the deadline.

When available, the error response includes:

```json
{
  "error": {
    "code": "provider_unavailable",
    "message": "The AI provider is temporarily unavailable.",
    "retryable": true,
    "details": {"retryAfterSeconds": 120}
  }
}
```

The HTTP response also has `Retry-After: 120`. The monolith's worker must respect this **seconds** value in addition to its own backoff and maximum retry count. If it exceeds the job's retry window, leave the document available for manual handling rather than looping indefinitely.

Repeated HTTP requests with the same document ID are independent and may incur new provider calls. For example, one original worker job plus two external retries can produce up to six provider calls when each service request uses its internal retry. The monolith controls duplicate active jobs and external scheduling; this service is stateless.

The evaluation CLI also respects cooldowns: if a final retryable error requests a positive delay, it stops the batch with `provider_retry_after`, records the delay and leaves remaining documents unattempted. It does not immediately send a different document to the same rate-limited provider.

## 4. Retaining Originals and Manual Entry

The microservice receives bytes, has no original-file path/database access, and does not own the monolith's stored document. Its errors neither delete nor replace that original. Tests show that the same caller-owned bytes/document ID can be resubmitted successfully after provider failure and recovery, with unchanged source hashes. Health and other requests continue working during provider failures.

The main application should implement this order:

1. Check the student's access and store the original in protected storage.
2. Save document metadata and queue the OCR job using the monolith's existing transaction rules.
3. Call OCR from the worker, keeping the original independently of the response.
4. On 200, store extracted suggestions/issues for human review; do not treat `completed` as an admission decision.
5. On a retryable failure, schedule only bounded external retries, respecting `Retry-After`; preserve the original meanwhile.
6. On a permanent failure or exhausted retry budget, mark extraction as failed/manual-entry-required and allow values to be entered or corrected against the retained original.
7. Ignore stale results for deleted/replaced documents and prevent duplicate active jobs.

**The real monolith/storage/frontend are not implemented in this OCR branch.** Their persisted-file retention and manual-entry screens remain an integration acceptance item in tasks 11/14. The tests here verify the stateless API/caller contract and recovery, not a fabricated database or UI implementation.

## 5. Error Privacy and Cleanup

- Public errors use fixed messages and known codes. Provider error bodies, refusal text, image contents, raw Python messages and OS details are not returned or logged.
- Python diagnostics are separately capped and discarded; AI response bodies are bounded before parsing.
- Only normalized numeric retry hints are exposed as provider metadata.
- No automatic switch to mock or invented OCR result occurs on failure.
- A partial field-validation result remains useful data, not a reason to incur another AI call.

## 6. Verification

```powershell
npm test
npm run test:python
```

Relevant suites:

- [reliability.test.js](tests/reliability.test.js): retry hints, too-long backoff, cancellation during backoff/AI, signal-ignoring transports, late-response disposal, stalled body readers, phase-boundary deadlines, source-preserving recovery, safe HTTP errors and no semantic retries.
- [python-preprocessor.test.js](tests/python-preprocessor.test.js): worker startup/protocol/stream failures, limits, cancellation and termination. Input-pipe failure is fault-injected portably on a real owned subprocess rather than assuming OS pipe-buffer behavior.
- [ai-extraction.test.js](tests/ai-extraction.test.js): HTTP status mapping, malformed output, refusals, provider timeouts, schema checks and safe field responses.
- [evaluation.test.js](tests/evaluation.test.js): interrupted/configuration-aborted reports, cooldown stopping and unchanged scoring denominators.
- [python-integration.test.js](tests/python-integration.test.js): actual Python processes, concurrent inputs, page order and the HTTP pipeline with explicit mock extraction.

These tests do not demonstrate recognition accuracy or deployment-level monolith integration. Real-provider measurements from task 10 remain separate and pending configured credentials/model.
