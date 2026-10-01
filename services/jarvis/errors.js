'use strict';
class JarvisError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
module.exports = { JarvisError };
