const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { ApiError } = require('../errors/api-error');

function unsupportedFile() {
  return new ApiError(415, 'unsupported_file', 'File is invalid or does not match the declared MIME type.');
}

async function inspectPdf(buffer, limits) {
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw unsupportedFile();

  let document;
  try {
    document = await PDFDocument.load(buffer, {
      // Inspect the flag explicitly; no decryption or content extraction is attempted.
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch {
    throw unsupportedFile();
  }

  if (document.isEncrypted) {
    throw new ApiError(422, 'unreadable_document', 'Password-protected PDFs are not supported.');
  }

  const pageCount = document.getPageCount();
  if (pageCount === 0) throw new ApiError(422, 'unreadable_document', 'PDF has no pages.');
  if (pageCount > limits.maxPdfPages) {
    throw new ApiError(413, 'page_limit_exceeded', 'PDF exceeds the configured page limit.', {
      details: { maxPages: limits.maxPdfPages },
    });
  }
  return { format: 'pdf', pageCount };
}

async function inspectImage(buffer, mimeType, limits) {
  const expected = mimeType === 'image/png' ? 'png' : 'jpeg';
  const signature = expected === 'png'
    ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    : Buffer.from([255, 216, 255]);
  if (!buffer.subarray(0, signature.length).equals(signature)) throw unsupportedFile();

  try {
    // Reading metadata does not rasterize the image. Check dimensions before decoding.
    const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
    if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.pages > 1) {
      throw unsupportedFile();
    }
    if (metadata.width * metadata.height > limits.maxImagePixels) {
      throw new ApiError(413, 'file_too_large', 'Image exceeds the configured pixel limit.', {
        details: { maxPixels: limits.maxImagePixels },
      });
    }
    // Metadata alone is insufficient: also detect truncated/corrupt pixel data.
    await sharp(buffer, { failOn: 'warning', limitInputPixels: limits.maxImagePixels }).stats();
    return { format: expected, pageCount: 1, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unsupportedFile();
  }
}

async function inspectDocumentFile({ buffer, mimeType }, limits) {
  try {
    return mimeType === 'application/pdf'
      ? await inspectPdf(buffer, limits)
      : await inspectImage(buffer, mimeType, limits);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unsupportedFile();
  }
}

module.exports = { inspectDocumentFile };
