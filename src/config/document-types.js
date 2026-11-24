// Enable additional profiles as their extraction support is implemented.
// Medical and unknown types are never admitted to document processing.
const ENABLED_DOCUMENT_TYPES = Object.freeze(['student_certificate', 'placement_order']);
const DETECTED_DOCUMENT_TYPES = Object.freeze(['student_certificate', 'placement_order', 'placement_form', 'address_registration', 'medical', 'unknown']);

module.exports = { ENABLED_DOCUMENT_TYPES, DETECTED_DOCUMENT_TYPES };
