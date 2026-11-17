const sharp = require('sharp');
const { ApiError } = require('../errors/api-error');

const MAX_PREPARED_SIDE = 2000;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function invalidPreparedOutput() {
  return new ApiError(500, 'internal_error', 'Python returned an invalid preprocessing result.');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validTransforms(value) {
  const booleans = ['exifOrientationApplied', 'resized', 'contrastEnhanced', 'denoised'];
  return exactKeys(value, [...booleans, 'pdfRotationDegrees', 'manualRotationClockwiseDegrees', 'deskewCounterClockwiseDegrees'])
    && booleans.every((key) => typeof value[key] === 'boolean')
    && [0, 90, 180, 270].includes(value.pdfRotationDegrees)
    && [0, 90, 180, 270].includes(value.manualRotationClockwiseDegrees)
    && typeof value.deskewCounterClockwiseDegrees === 'number'
    && Number.isFinite(value.deskewCounterClockwiseDegrees)
    && Math.abs(value.deskewCounterClockwiseDegrees) <= 10;
}

async function validatePreparedDocument(result, input, config) {
  if (!exactKeys(result, ['status', 'pageCount', 'pages']) || result.status !== 'prepared'
    || !Number.isInteger(result.pageCount) || result.pageCount < 1
    || result.pageCount > config.limits.maxPdfPages || !Array.isArray(result.pages)
    || result.pages.length !== result.pageCount
    || (input.mimeType !== 'application/pdf' && result.pageCount !== 1)
    || (input.metadata && input.metadata.pageCount !== result.pageCount)) {
    throw invalidPreparedOutput();
  }

  for (const [index, page] of result.pages.entries()) {
    if (!exactKeys(page, ['pageNumber', 'mimeType', 'width', 'height', 'contentBase64', 'transforms'])
      || page.pageNumber !== index + 1 || page.mimeType !== 'image/png'
      || ![page.width, page.height].every((side) => Number.isInteger(side) && side > 0 && side <= MAX_PREPARED_SIDE)
      || !validTransforms(page.transforms)) {
      throw invalidPreparedOutput();
    }
    const encoded = page.contentBase64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_PNG_BYTES / 3)
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw invalidPreparedOutput();
    }
    const image = Buffer.from(encoded, 'base64');
    if (image.length > MAX_PNG_BYTES || image.toString('base64') !== encoded
      || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw invalidPreparedOutput();
    }
    try {
      const metadata = await sharp(image, { limitInputPixels: MAX_PREPARED_SIDE ** 2 }).metadata();
      if (metadata.format !== 'png' || metadata.width !== page.width || metadata.height !== page.height
        || metadata.channels !== 3 || metadata.pages > 1) {
        throw invalidPreparedOutput();
      }
      await sharp(image, { failOn: 'warning', limitInputPixels: MAX_PREPARED_SIDE ** 2 }).stats();
    } catch {
      throw invalidPreparedOutput();
    }
  }
  return result;
}

module.exports = { MAX_PREPARED_SIDE, invalidPreparedOutput, validatePreparedDocument };
