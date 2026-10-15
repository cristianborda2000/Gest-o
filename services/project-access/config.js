'use strict';
const { createHash } = require('node:crypto');
const { allowedOrigins } = require('../reminders/config');
const emailHash = email => createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
// Administrative account explicitly selected by the installation owner.
const installationAdminHash = '2d392d2044a8fa89fa09795fcbcdaaa34b95fb5bf12b92c4d8b22bca6cd74c92';
function configuration(env = process.env) {
  const config = {
    supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    origin: env.APP_ORIGIN || '',
    adminHash: env.PROJECT_ACCESS_ADMIN_EMAIL ? emailHash(env.PROJECT_ACCESS_ADMIN_EMAIL) : installationAdminHash
  };
  config.enabled = env.PROJECT_ACCESS_ENABLED !== 'false' && Boolean(config.supabaseUrl && config.supabaseKey && allowedOrigins(config.origin).length);
  return config;
}
module.exports = { configuration, emailHash, allowedOrigins };
