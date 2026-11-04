'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const { definitions } = require('./service');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tools = new Set(definitions().map(tool => tool.name));
// No issuance or refresh API. Provisioning requires a separately approved private workflow.
// Only opaque 256-bit keys with a public grant UUID are accepted, never account JWTs.
function createApiKeyAuthenticator({ store, ownerId, clientId, resource, clock = () => new Date() }) {
  if (!store || typeof store.find !== 'function' || !uuid.test(ownerId) || !clientId || !resource) throw new Error('Invalid authentication configuration');
  return async (token, context) => {
    if (context?.resource !== resource || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'zama_dot_v1' || !uuid.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
    if (Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2]) return null;
    let grant; try { grant = await store.find(parts[1]); } catch { return null; }
    if (!grant || !/^[a-f0-9]{64}$/.test(grant.token_hash || '')) return null;
    const hash = createHash('sha256').update(token, 'utf8').digest();
    if (!timingSafeEqual(hash, Buffer.from(grant.token_hash, 'hex'))) return null;
    const now = clock().getTime(), expiresAt = Date.parse(grant.expires_at), startsAt = Date.parse(grant.not_before);
    if (grant.id !== parts[1] || grant.revoked_at !== null || grant.owner_id !== ownerId || grant.client_id !== clientId || grant.resource !== resource || !Number.isFinite(expiresAt) || !Number.isFinite(startsAt) || startsAt > now || expiresAt <= now || !Number.isSafeInteger(grant.version) || grant.version < 1 || !Array.isArray(grant.allowed_tools) || !grant.allowed_tools.length || grant.allowed_tools.some(name => !tools.has(name))) return null;
    return Object.freeze({ active: true, userId: ownerId, clientId, audience: resource, expiresAt, grantId: grant.id, grantVersion: grant.version, allowedTools: Object.freeze([...new Set(grant.allowed_tools)]) });
  };
}
function createGrantStore(client) {
  return { async find(id) {
    const { data, error } = await client.from('dot_api_grants').select('id,owner_id,client_id,resource,token_hash,allowed_tools,not_before,expires_at,revoked_at,version').eq('id', id).maybeSingle();
    if (error) throw new Error('Grant unavailable');
    return data;
  } };
}
module.exports = { createApiKeyAuthenticator, createGrantStore };
