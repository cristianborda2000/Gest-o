'use strict';

// Keep raw bytes together until the whole body is available. Decoding each
// network chunk separately can corrupt an accented character split across chunks.
async function readJsonBody(req, { maxBytes, invalidJson, tooLarge }) {
  let raw;
  if (req.body !== undefined) {
    try {
      raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    } catch { throw invalidJson(); }
    if (raw.length > maxBytes) throw tooLarge();
  } else {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw tooLarge();
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks, bytes);
  }
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw invalidJson(); }
}

module.exports = { readJsonBody };
