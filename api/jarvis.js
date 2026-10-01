// Vercel function: server-only imports; never served as a browser script.
module.exports = require('../services/jarvis/http').createHandler();
