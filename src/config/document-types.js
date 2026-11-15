// Enable additional profiles as their extraction support is implemented.
// Medical and unknown types are never admitted to document processing.
const ENABLED_DOCUMENT_TYPES = Object.freeze(['student_certificate']);

module.exports = { ENABLED_DOCUMENT_TYPES };
