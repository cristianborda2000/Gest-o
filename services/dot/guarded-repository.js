'use strict';
const { createRepository } = require('../jarvis/repository');
const { JarvisError } = require('../jarvis/errors');
// The grant and app-state commit are checked atomically inside the database.
function createGuardedRepository(client, principal) {
  const base = createRepository(client, principal.userId);
  return { userId: base.userId, consumeRate: base.consumeRate, withTool(tool) {
    if (!principal.allowedTools.includes(tool)) throw new JarvisError('Tool denied.', 403, 'DOT_FORBIDDEN');
    return { userId: base.userId, read: base.read, async transact(mutate) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const snapshot = await base.read(), existing = new Set(snapshot.jarvis.actions.map(action => action.id));
        const change = mutate(snapshot);
        if (change?.then) throw new Error('Transaction callback must be synchronous');
        for (const action of snapshot.jarvis.actions) {
          if (!existing.has(action.id) && action.source === 'dot') Object.assign(action, { grant_id: principal.grantId, grant_version: principal.grantVersion, client_id: principal.clientId, transport: 'streamable-http' });
        }
        const { error } = await client.rpc('dot_guarded_commit', {
          p_grant_id: principal.grantId, p_version: principal.grantVersion, p_user_id: principal.userId,
          p_client_id: principal.clientId, p_resource: principal.audience, p_tool: tool,
          p_revision: snapshot.revision, p_data: snapshot.jarvis, p_write_state: Boolean(change?.writeState),
          p_state_revision: snapshot.stateRevision, p_state: change?.writeState ? snapshot.state : null,
          p_unchanged: Boolean(change?.unchanged)
        });
        if (!error) return change?.result;
        if (error.code === '42501') throw new JarvisError('Connection revoked or no longer authorized.', 403, 'DOT_GRANT_DENIED');
        if (['40001', '23505'].includes(error.code) && attempt < 3) continue;
        throw new JarvisError('Could not verify and save operation.', 503, 'DATABASE_UNAVAILABLE');
      }
    } };
  } };
}
module.exports = { createGuardedRepository };
