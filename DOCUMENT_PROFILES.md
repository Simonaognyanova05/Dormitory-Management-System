# OCR Document Profiles

**Version:** 1.0.0-draft  
**Purpose:** task 3 — define extraction fields, normalization, validation, and expected examples.  
**Related contract:** [OCR_API_CONTRACT.md](OCR_API_CONTRACT.md) and [openapi.json](openapi.json).

These are implementation profiles, not eligibility or admission rules. The faculty-number format, study-year range, phone rules, and optional-document fields below are working assumptions based on the architecture document; institution-specific confirmation is still pending.

**Implementation status:** the certificate profile has provider-schema checks, NFC/whitespace normalization, semantic field validation, and completed/partial classification. Mock values remain partial with `mock_result`; type mismatches and field issues also require review. Placement-order and optional-profile rules below are still specifications for later tasks. See [certificate-fields.js](src/validators/certificate-fields.js) and [AI client details](src/services/ai/README.md).

## 1. Profile Registry

| Canonical type | Document | Extraction policy | Implementation priority |
| --- | --- | --- | --- |
| `student_certificate` | Student status certificate | Automatically requested by the monolith when uploaded | First; required by FR-15 |
| `placement_order` | Placement order | Automatically requested by the monolith when uploaded | Second; required by FR-16 |
| `placement_form` | Paper placement form | Only when requested | Optional; FR-17 |
| `address_registration` | Address registration application | Only when requested to fill missing address information | Optional; FR-18 |
| `medical` | Medical document | Never | Reject; FR-19 |

The policy describes when the **monolith** schedules extraction. The OCR service processes an accepted request independently of the application lifecycle. A profile being documented does not mean it is already implemented; unavailable types return `422 unsupported_document_type`.

For `medical`, reject the declared type before preprocessing or AI calls. No extraction fields, examples of medical content, or automatic medical interpretation are defined. If a different declared type is later identified as medical, discard extracted content and return the same error, as specified in the API contract.

## 2. Three Different Meanings of Required

1. **Required document type to support:** the OCR implementation must support certificates and placement orders under the SRS.
2. **Required response key:** every key in the requested profile must exist in `fields`, even when its value is `null`.
3. **Required application value/document:** the monolith's submission rules determine what the student must provide before submitting. OCR does not make that decision or reject readable documents simply because a target field is absent.

| Profile | Expected response keys | Source fields allowed to be missing? | Application-level requirement |
| --- | --- | --- | --- |
| `student_certificate` | All four profile keys | Yes; use `null` plus `missing` | The architecture assumes the certificate is required. The team must confirm which profile/form fields must be completed, including by manual entry. |
| `placement_order` | All four profile keys | Yes; use `null` plus `missing` | Required extraction support does not make the order a prerequisite for an initial application. Its availability and use in the placement workflow must be confirmed. |
| `placement_form` | All three profile keys | Yes; use `null` plus `missing` | Optional extraction; required form values are controlled by the monolith. |
| `address_registration` | Both profile keys | Yes; use `null` plus `missing` | Optional extraction; required address values are controlled by the monolith. |

Human correction must remain possible even when OCR returns no usable values or fails entirely. Never fill missing document data from the user's profile, another document, the current date, or a guessed default inside the OCR service.

## 3. Shared Normalization and Validation

Apply these rules to extracted candidates, not to the uploaded bytes or the caller's `documentId`:

1. Use only the requested profile's keys. Ignore unrelated model output; do not return national identifiers, medical information, or extra personal fields.
2. Treat an absent property, `null`, or a whitespace-only string as `missing`: return `null` and a `missing` issue.
3. For strings, use Unicode NFC normalization and trim surrounding whitespace. For names, specialties, addresses, order numbers, dormitories, and rooms, collapse internal whitespace runs to a single space.
4. Preserve the original alphabet, case, spelling, punctuation, abbreviations, and leading zeros. Do not translate, transliterate, expand abbreviations, or replace lookalike characters such as `O`/`0` or Cyrillic `З`/`3`.
5. Never truncate an overlong candidate to make it valid. A nonempty string longer than 200 Unicode code points is retained with `invalid_format`.
6. Text fields accept only strings. Do not coerce numeric identifiers to text: leading zeros may already have been lost. Return `null` with `invalid_format` for a wrong JSON type, including booleans, objects, and arrays. `yearOfStudy` has its own narrow conversion rules below.
7. A type-correct candidate that fails a semantic field rule is retained with `invalid_format`. A type-incorrect candidate becomes `null` with `invalid_format`, not `missing`.
8. If a value is ambiguous, conflicting, or reported as uncertain, add `uncertain`; retain a type-correct candidate or return `null`. Do not silently choose between conflicting values. More than one issue may apply to a field.
9. A field passing format validation is not evidence that OCR recognized it correctly. Do not fabricate confidence scores; any future confidence estimate must have a documented source.
10. Every `null` value must have an issue, and every issue must refer to a field in the requested profile. Review messages explain the required action without copying the original document or provider response.

Calendar rules, character classes, and study-year checks are **semantic validators**. The OpenAPI schemas describe the response's structural types and allow invalid candidates in partial results; they do not replace these checks.

The certificate normalizer accepts defensive raw candidates for deterministic field tests. The live provider contract remains stricter: for example, numeric faculty IDs or Roman strings in the provider's integer-only year slot violate its JSON Schema and are rejected before normalization. Missing keys, extra properties, or wrong provider types remain structural `provider_bad_response` errors. Do not confuse raw-candidate fixtures with accepted provider/API payloads.

### Response Classification

- Same detected/requested type, all fields valid and present, no uncertainty or warnings: `completed`, empty `fieldIssues`, empty `warnings`, `requiresManualReview: false`.
- Any missing, invalid, or uncertain field: `partial`, corresponding issues, `requiresManualReview: true`.
- Different or `unknown` detected type: add `document_type_mismatch` and return `partial`, even if all field candidates have valid formats. Keep the requested profile.
- Readable text but no target fields: return a partial result with all profile values `null` and issues.
- No readable text: `422 unreadable_document`, not a successful all-null result.

`completed` does not bypass human confirmation in the main application. Missing fields that are optional for the application can still produce a partial OCR result without preventing submission.

## 4. Student Status Certificate

**Canonical type:** `student_certificate`  
**Target:** FR-15 — extract data when it appears in the certificate.

| API field | JSON value type | Meaning and possible source labels | Normalization and valid-value rule |
| --- | --- | --- | --- |
| `fullName` | string or `null` | Student's name; e.g. `Име`, `Имена`, `Студент` | Shared text rules; nonempty, up to 200 code points. Do not require exactly three names or infer missing names. |
| `facultyNumber` | string or `null` | Faculty identifier; e.g. `Факултетен номер`, `Фак. №`, `ФН` | NFC + surrounding trim only; **5–12 Unicode letters or ASCII digits**, with no internal spaces, punctuation, or separators. Preserve leading zeros and case. This is a working format assumption. |
| `specialty` | string or `null` | Degree specialty; e.g. `Специалност` | Shared text rules; nonempty, up to 200 code points. Do not substitute the faculty name or guess a specialty from an abbreviation. |
| `yearOfStudy` | integer or `null` | Year of study; e.g. `Курс` | Accept a safe integer, an exact signed decimal integer string, or an ASCII Roman numeral `I`–`VI` (case-insensitive) as an unambiguous raw candidate. Normalize to an integer and validate **1–6**. No booleans, fractions, ranges, ordinal suffixes, semester-to-year calculations, or guessing. Unsafe or overlong numeric strings become `null` with `invalid_format`; do not round them. The range is a working assumption. |

For example, `"II"` becomes `2`; `"9"` becomes `9` with `invalid_format`; `"2/3"` becomes `null` with `invalid_format`. A numeric faculty identifier becomes `null` with `invalid_format` rather than being padded or converted.

The source labels are recognition hints, not a requirement for an exact document template. Multiple institutions/layouts may use different labels. Always distinguish the student from the issuing official and the year of study from the semester or academic year.

## 5. Placement Order

**Canonical type:** `placement_order`  
**Target:** FR-16 — extract data when it appears in the order.

| API field | JSON value type | Meaning and possible source labels | Normalization and valid-value rule |
| --- | --- | --- | --- |
| `orderNumber` | string or `null` | Order identifier; e.g. `Заповед №`, `Номер на заповед` | Shared text rules; nonempty, up to 200 code points. Preserve prefixes, punctuation, and leading zeros. Do not impose a single numbering pattern. |
| `orderDate` | string or `null` | Date of the order; not an upload, signature, or accommodation start date | Accept exact `YYYY-MM-DD`, or day-first `D.M.YYYY`, `D/M/YYYY`, `D-M-YYYY` (day/month may have one or two digits). Permit surrounding whitespace and a trailing Bulgarian `г.` suffix. Validate the actual Gregorian calendar date, including leap years, and normalize valid dates to `YYYY-MM-DD`. No two-digit years or month-first interpretation. Retain an invalid string with `invalid_format`; do not repair it. |
| `dormitory` | string or `null` | Dormitory/block identifier or name; e.g. `Общежитие`, `Блок` | Shared text rules; nonempty, up to 200 code points. Do not restrict identifiers to digits or claim the dormitory exists. |
| `room` | string or `null` | Room identifier; e.g. `Стая`, `Стая №` | Shared text rules; nonempty, up to 200 code points. Preserve suffixes and leading zeros such as `012А`. Do not infer a room from its floor. |

For example, `"3.11.2026 г."` becomes `"2026-11-03"`; `"31.02.2026"` remains unchanged with `invalid_format`. An ambiguous or unreadable date receives `uncertain` rather than a guessed date.

The monolith matches dormitories and rooms to database records. The OCR service must not create placements, assess room capacity, or replace textual identifiers with guessed database IDs. A multi-student order with no unambiguous target must produce review issues rather than selecting an arbitrary row.

## 6. Optional Profiles

These fields follow the architecture's proposal. They are documented for consistency with the API but still require confirmation before implementation.

### Placement Form — `placement_form`

| Field | JSON value type | Rule |
| --- | --- | --- |
| `fullName` | string or `null` | Same name rules as the certificate profile. |
| `phone` | string or `null` | Trim; remove spaces, `(`, `)`, `-`, and `.`; remove one leading `+` if present. The result must contain **7–15 ASCII digits**. Preserve leading zeros and country-code digits. Do not convert `00`, add a country code, or guess missing digits. Retain an invalid string with an issue. This format follows a working assumption in the architecture. |
| `permanentAddress` | string or `null` | Shared text rules; nonempty, up to 200 code points. Preserve locality, street, building, entrance, floor, and apartment details when supplied. Do not substitute a current address for a permanent address. |

### Address Registration Application — `address_registration`

| Field | JSON value type | Rule |
| --- | --- | --- |
| `city` | string or `null` | Shared text rules; nonempty, up to 200 code points. Includes villages/other localities; not only cities. |
| `addressLine` | string or `null` | Shared text rules; nonempty, up to 200 code points. Extract the address being registered, not the issuing office's address. |

Do not infer missing address values from a postcode or decide eligibility based on a recognized locality.

## 7. Example Cases and Future Tests

[examples/document-profile-cases.json](examples/document-profile-cases.json) contains synthetic source snippets, illustrative raw field candidates, and exact expected HTTP responses:

| Case | Expected behavior |
| --- | --- |
| `certificate_complete` | Preserve Bulgarian text and leading zeros; normalize a Roman study year. |
| `certificate_missing_specialty` | Return `null` and `missing`; do not fabricate a specialty. |
| `certificate_invalid_year` | Retain integer `9` with `invalid_format`. |
| `certificate_uncertain_faculty_number` | Preserve an ambiguous candidate with `uncertain`; do not replace lookalike characters. |
| `certificate_numeric_faculty_number` | Reject an identifier supplied as a number; return `null` with `invalid_format`. |
| `certificate_no_target_fields` | A readable source without target data produces a partial all-null result. |
| `placement_order_complete` | Normalize a Bulgarian date and preserve an alphanumeric room. |
| `placement_order_invalid_date` | Retain an impossible date with `invalid_format`. |
| `medical_declared_rejected` | Reject based on the declared type, without source processing or an AI call. |

`rawFields` and `uncertainFields` are raw normalizer inputs, not an AI-provider payload or an API request. [Certificate tests](tests/certificate-fields.test.js) verify the six certificate cases' exact normalized fields and issues. Placement-order examples remain for task 12. Source snippets are plain text, not PDF/image fixtures; none of these deterministic checks counts toward the 30-document recognition benchmark.

## 8. Items to Confirm with the Team

- [ ] Confirm which values and documents the application requires before submission; support manual entry when OCR cannot supply them.
- [ ] Confirm institution-specific faculty-number formats and the 1–6 study-year assumption.
- [ ] Confirm when placement orders enter the workflow and how multi-student orders should identify their target.
- [ ] Confirm the optional form/address field sets and the phone-number assumptions before implementing them.

The certificate profile is implemented using the documented working assumptions. The team-confirmation items above remain explicitly open rather than being represented as approved university rules.
