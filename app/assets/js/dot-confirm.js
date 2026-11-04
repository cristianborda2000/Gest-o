/* Human-only confirmation UI. No write occurs during initialization or preview. */
(async () => {
  'use strict';
  const el = id => document.getElementById(id), status = el('status'), details = el('details');
  let current = null, generation = 0, busy = false;
  const disable = () => { el('confirm').disabled = true; el('cancel').disabled = true; };
  const invalidate = () => { generation++; current = null; disable(); details.replaceChildren(); el('account').textContent = ''; };
  const action = new URLSearchParams(location.search).get('action');
  const config = window.ZAMA_CONFIG || {};
  if (window.top !== window.self || !/^[0-9a-f-]{36}$/i.test(action || '') || !window.supabase || !config.supabaseUrl || !config.supabaseAnonKey) { status.textContent = 'Página ou configuração inválida. Abra o link diretamente no ZAMA.'; return; }
  const client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  async function request(operation, body) {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw new Error('Entre no ZAMA e consulte novamente.');
    const response = await fetch(`/api/dot?operation=${operation}&action=${encodeURIComponent(action)}`, { method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível consultar o pedido.');
    return { result, session: data.session };
  }
  function show(label, value) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = String(value ?? ''); details.append(dt, dd); }
  async function load() {
    if (busy) return;
    invalidate(); const ticket = generation;
    status.textContent = 'Consultando pedido…';
    try {
      const { result, session } = await request('preview'); if (ticket !== generation) return;
      if (result.owner_id !== session.user.id) throw new Error('Pedido não pertence à conta conectada.');
      current = result; details.replaceChildren(); el('account').textContent = `Conta: ${session.user.email || session.user.id}`;
      for (const [label, value] of [['Descrição', result.input.description], ['Valor', result.result.amount], ['Categoria', result.input.category], ['Data', result.input.date], ['Vencimento', result.input.due_date], ['Situação', result.input.status === 'pending' ? 'Pendente' : 'Pago'], ['Observações', result.input.notes || '—']]) show(label, value);
      const pending = result.status === 'pending' && Date.parse(result.expires_at) > Date.now();
      status.textContent = result.status === 'executed' ? 'Despesa registrada.' : result.status === 'cancelled' ? 'Pedido cancelado. Nenhum lançamento foi feito por este pedido.' : pending ? 'Confira os dados antes de confirmar.' : 'Pedido expirado. Prepare um novo pedido.';
      el('confirm').disabled = !pending; el('cancel').disabled = !pending;
    } catch (error) { if (ticket === generation) { invalidate(); status.textContent = error.message; } }
  }
  async function decide(confirmation) {
    if (!current || busy) return;
    busy = true; disable(); el('reload').disabled = true; const ticket = generation;
    const fingerprint = current.confirmation_digest;
    try {
      await request('decide', { confirmation, confirmation_digest: fingerprint });
      if (ticket === generation) { current = null; status.textContent = 'Consultando resultado…'; }
    } catch { if (ticket === generation) { current = null; status.textContent = 'Resultado incerto. Consulte novamente antes de repetir; o mesmo pedido não será executado duas vezes.'; } }
    finally { busy = false; el('reload').disabled = false; }
    // Only GET on recovery; never automatically retry a financial POST.
    if (ticket === generation) await load();
  }
  client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'USER_UPDATED') { invalidate(); status.textContent = 'Sessão alterada. Consulte novamente.'; } });
  el('confirm').addEventListener('click', () => decide(true)); el('cancel').addEventListener('click', () => decide(false)); el('reload').addEventListener('click', load);
  await load();
})();
