'use strict';
const { JarvisError } = require('./errors');
const empty = () => ({ conversations: [], messages: [], actions: [], memories: [], requests: [], metrics: [] });
function createRepository(client, userId) {
  if (!userId) throw new JarvisError('Sessão necessária.', 401, 'UNAUTHORIZED');
  async function read() {
    const [account, state] = await Promise.all([
      client.from('jarvis_accounts').select('data,revision').eq('user_id', userId).maybeSingle(),
      client.from('app_state').select('data,updated_at').eq('user_id', userId).maybeSingle()
    ]);
    if (account.error || state.error) throw new JarvisError('Não foi possível consultar o JARVIS. Verifique a conexão e a migration do banco.', 503, 'DATABASE_UNAVAILABLE');
    return { jarvis: { ...empty(), ...account.data?.data }, revision: account.data?.revision || 0, state: state.data?.data || {}, stateRevision: state.data?.updated_at || null };
  }
  async function commit(snapshot, writeState) {
    if (Buffer.byteLength(JSON.stringify(snapshot.jarvis)) > 8 * 1024 * 1024) throw new JarvisError('O histórico atingiu o limite. É necessário arquivá-lo antes de continuar.', 413, 'HISTORY_LIMIT');
    const { error } = await client.rpc('jarvis_commit', {
      p_user_id: userId, p_revision: snapshot.revision, p_data: snapshot.jarvis,
      p_write_state: Boolean(writeState), p_state_revision: snapshot.stateRevision, p_state: writeState ? snapshot.state : null
    });
    if (error?.code === '40001' || error?.code === '23505') throw new JarvisError('Dados alterados em outra sessão. Tente novamente.', 409, 'CONFLICT');
    if (error) throw new JarvisError('Não foi possível salvar a ação. Verifique a conexão e a migration do JARVIS.', 503, 'DATABASE_UNAVAILABLE');
  }
  async function transact(mutate) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await read();
      // Pure synchronous callback only: no API/IO side effects may be retried here.
      const change = mutate(snapshot);
      if (change?.then) throw new Error('Transaction callback must be synchronous');
      if (change?.unchanged) return change.result;
      try { await commit(snapshot, change?.writeState); return change?.result; }
      catch (error) { if (error.code !== 'CONFLICT' || attempt === 3) throw error; }
    }
  }
  async function consumeRate(bucket, limit, windowSeconds) {
    const { data, error } = await client.rpc('jarvis_consume_rate', { p_user_id: userId, p_bucket: bucket, p_limit: limit, p_window: windowSeconds });
    if (error) throw new JarvisError('Limite de uso indisponível. Verifique a configuração do JARVIS.', 503, 'RATE_UNAVAILABLE');
    if (data !== true) throw new JarvisError('Limite de solicitações atingido. Aguarde e tente novamente.', 429, 'RATE_LIMITED');
  }
  return { userId, read, transact, consumeRate };
}
module.exports = { createRepository, empty };
