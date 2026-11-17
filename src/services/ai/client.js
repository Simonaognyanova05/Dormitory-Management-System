const { createGptVisionClient } = require('./gpt-vision');
const { createMockVisionClient } = require('./mock-vision');

function createVisionClient(config, dependencies) {
  return config.ai.provider === 'mock' ? createMockVisionClient() : createGptVisionClient(config, dependencies);
}

module.exports = { createVisionClient };
