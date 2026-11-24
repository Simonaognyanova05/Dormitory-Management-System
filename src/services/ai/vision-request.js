const { ApiError } = require('../../errors/api-error');
const { getDocumentProfile } = require('./document-profiles');

function buildVisionRequest(prepared, documentType, config) {
  const profile = getDocumentProfile(documentType);
  if (prepared?.status !== 'prepared' || !Array.isArray(prepared.pages) || !prepared.pages.length
    || prepared.pages.length > config.limits.maxPdfPages
    || !prepared.pages.every((page) => page && page.mimeType === 'image/png' && typeof page.contentBase64 === 'string' && page.contentBase64.length)) {
    throw new ApiError(500, 'internal_error', 'Prepared image pages are required for extraction.');
  }
  const payload = {
    model: config.ai.model, store: false, max_completion_tokens: config.ai.maxOutputTokens,
    response_format: { type: 'json_schema', json_schema: { name: profile.schemaName, strict: true, schema: profile.schema() } },
    messages: [
      { role: 'system', content: profile.systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: profile.instruction },
        ...prepared.pages.map((page) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${page.contentBase64}`, detail: config.ai.imageDetail } })),
      ] },
    ],
  };
  if (config.ai.temperature !== undefined) payload.temperature = config.ai.temperature;
  return payload;
}

module.exports = { buildVisionRequest };
