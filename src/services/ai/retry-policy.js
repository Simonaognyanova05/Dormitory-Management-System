function retryAfterSeconds(header, now = Date.now()) {
  if (typeof header !== 'string' || !header.trim() || header.length > 128) return undefined;
  const value = header.trim();
  let seconds;
  if (/^[0-9]+$/.test(value)) seconds = Number(value);
  else {
    // Do not let Date.parse reinterpret fractional seconds as a calendar date.
    if (!/[A-Za-z]/.test(value)) return undefined;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1000) ? seconds : undefined;
}

function retryDelayMs(error) {
  const seconds = error.details?.retryAfterSeconds;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? Math.max(250, seconds * 1000) : 250;
}

module.exports = { retryAfterSeconds, retryDelayMs };
