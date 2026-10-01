/* JARVIS UI. Only the existing Supabase access token crosses to our own API.
   Business mutations, confirmations and AI credentials remain on the server. */
(function (global) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mic = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const toolNames = { get_today_summary: 'Resumo do dia consultado', list_tasks: 'Tarefas consultadas', get_agenda: 'Agenda consultada', get_financial_summary: 'Financeiro consultado', create_task: 'Tarefa criada', create_agenda_event: 'Compromisso criado', update_task: 'Tarefa atualizada', complete_task: 'Tarefa concluída', save_idea: 'Ideia salva', search_ideas: 'Ideias consultadas', register_expense: 'Registrar despesa', register_income: 'Registrar entrada', save_memory: 'Memória salva', search_memories: 'Memórias consultadas' };
  let host, dialog, account = null, generation = 0, initialized = false;
  let config = null, summary = null, conversations = [], messages = [], actions = [], memories = [], conversation = null;
  let busy = false, loading = false, ready = false, error = '', draft = '', retry = null, pendingMessage = null, activity = '';
  const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);
  async function api(path, options = {}) {
    const { data } = await supabaseClient.auth.getSession();
    if (!data.session?.access_token) throw new Error('Sua sessão expirou. Entre novamente.');
    const response = await fetch(`/api/jarvis${path}`, { method: options.method || 'GET', headers: { Authorization: `Bearer ${data.session.access_token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}), cache: 'no-store' });
    let body; try { body = await response.json(); } catch { throw new Error('A API do JARVIS não está disponível. Inicie o servidor atualizado ou publique o backend.'); }
    if (!response.ok) throw new Error(body.error || 'Não foi possível consultar o JARVIS.');
    return body;
  }
  function reset() {
    generation++; initialized = false; account = null; config = summary = conversation = null;
    conversations = []; messages = []; actions = []; memories = []; error = draft = activity = ''; retry = pendingMessage = null; busy = loading = ready = false;
    if (dialog?.open) dialog.close(); host?.remove(); host = null;
  }
  async function init(user) {
    if (account?.id !== user?.id) reset(); account = user;
    if (initialized) return; initialized = true; await loadHome();
  }
  async function loadHome() {
    const gen = generation; loading = true; ready = false; error = ''; paint();
    try {
      const nextConfig = await api('/config'); if (gen !== generation) return;
      config = nextConfig;
      if (config.enabled) {
        const [home, history, memory] = await Promise.all([api('/summary'), api('/conversations'), config.memoryEnabled ? api('/memories') : Promise.resolve({ memories: [] })]);
        if (gen !== generation) return;
        summary = home.summary; conversations = history.conversations; memories = memory.memories;
        ready = Boolean(config.configured);
      }
    } catch (failure) { if (gen === generation) error = failure.message; }
    finally { if (gen === generation) { loading = false; paint(); } }
  }
  function greeting() {
    const hour = Number(ZamaTime.nowParts().hour);
    const salutation = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    const name = account?.user_metadata?.first_name || account?.user_metadata?.full_name?.split(' ')[0];
    return `${salutation}${name ? `, ${name}` : ''}.`;
  }
  function ensureHost() {
    if (!host) { host = document.createElement('section'); host.className = 'jarvis'; host.setAttribute('aria-label', 'Assistente JARVIS'); }
    return host;
  }
  function render(container) {
    if (!container.contains(ensureHost())) container.replaceChildren(host);
    paint();
  }
  function open() {
    if (typeof state === 'undefined' || !state) return;
    if (activeModule === 'jarvis') { host?.querySelector('textarea')?.focus(); return; }
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'jarvis-dialog'; dialog.setAttribute('aria-label', 'JARVIS — acesso rápido');
      dialog.addEventListener('close', () => { host?.remove(); });
      document.body.appendChild(dialog);
    }
    dialog.replaceChildren(ensureHost()); paint(); dialog.showModal(); host.querySelector('textarea')?.focus();
  }
  function actionCard(action) {
    const pending = action.status === 'pending', input = action.input || {}, result = action.result || {};
    const financial = action.tool_name === 'register_expense' || action.tool_name === 'register_income';
    const states = { pending: 'Aguardando confirmação', executed: 'Concluída', cancelled: 'Cancelada', failed: 'Não executada' };
    if (!financial && action.status === 'executed') return `<div class="jarvis-receipt"><span aria-hidden="true">✓</span> ${esc(toolNames[action.tool_name] || action.tool_name)}${result.title ? ` · ${esc(result.title)}` : ''}</div>`;
    return `<article class="jarvis-action ${pending ? 'pending' : ''}" data-action-id="${esc(action.id)}"><div><span class="ceo-eyebrow">${esc(states[action.status] || action.status)}</span><h3>${esc(toolNames[action.tool_name] || action.tool_name)}</h3></div>${financial ? `<strong class="jarvis-amount">${esc(result.amount || money(Math.round((input.amount || 0) * 100)))}</strong><dl><div><dt>Descrição</dt><dd>${esc(input.description)}</dd></div><div><dt>Categoria</dt><dd>${esc(input.category)}</dd></div><div><dt>Data</dt><dd>${esc(input.date ? input.date.split('-').reverse().join('/') : '')}</dd></div><div><dt>Situação</dt><dd>${input.status === 'pending' ? 'Pendente' : action.tool_name === 'register_income' ? 'Recebida' : 'Paga'}</dd></div>${input.due_date !== input.date ? `<div><dt>Vencimento</dt><dd>${esc(input.due_date?.split('-').reverse().join('/'))}</dd></div>` : ''}</dl>` : ''}${action.status === 'failed' ? `<p>${esc(result.error || 'Ação não executada.')}</p>` : ''}${pending ? `<p>A movimentação será salva somente após sua confirmação.</p><div class="jarvis-confirm-buttons"><button class="ceo-button primary" data-confirm="${esc(action.id)}" ${busy ? 'disabled' : ''}>Confirmar</button><button class="ceo-button" data-cancel="${esc(action.id)}" ${busy ? 'disabled' : ''}>Cancelar</button></div>` : ''}</article>`;
  }
  function homeMarkup() {
    if (!summary) return `<div class="jarvis-welcome"><div class="jarvis-orb" aria-hidden="true">J</div><h2>${esc(greeting())}</h2><p>Seu espaço para pensar, organizar e agir.</p></div>`;
    const tasks = summary.tasks?.tasks || [], overdue = summary.overdue?.total || 0;
    const priority = tasks.find(t => t.priority === 'Alta' && t.status !== 'Concluída');
    const next = summary.nextAppointment;
    return `<div class="jarvis-welcome"><div class="jarvis-orb" aria-hidden="true">J</div><h2>${esc(greeting())}</h2><p>Como posso ajudar hoje?</p></div><div class="jarvis-home-grid"><button data-prompt="Jarvis, como está meu dia?"><span>HOJE</span><strong>${summary.tasks?.total || 0} tarefa(s)</strong><small>${overdue} atrasada(s) nos últimos 366 dias</small></button><button data-prompt="Quais são minhas prioridades de hoje?"><span>PRIORIDADES</span><strong>${esc(priority?.title || 'Sem prioridade alta hoje')}</strong><small>Organize seu próximo passo</small></button><button data-prompt="Quanto a ZAMA gastou este mês?"><span>FINANCEIRO DO MÊS</span><strong>${esc(summary.financial?.expenses || money(0))}</strong><small>Saídas pagas no mês</small></button><button data-prompt="Qual é meu próximo compromisso?"><span>PRÓXIMO COMPROMISSO</span><strong>${esc(next?.title || 'Sem tarefa próxima')}</strong><small>${next ? esc(`${next.date.split('-').reverse().join('/')} · ${next.time || 'Sem horário'}`) : 'Próximos 30 dias'}</small></button></div>`;
  }
  function resizeInput(input) {
    const top = input.scrollTop;
    input.style.height = 'auto';
    input.style.height = `${Math.max(55, Math.min(180, input.scrollHeight))}px`;
    input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
    input.scrollTop = top;
  }
  function paint(options = {}) {
    if (!host) return;
    const previousInput = host.querySelector('textarea');
    const focused = document.activeElement === previousInput;
    const selection = focused ? [previousInput.selectionStart, previousInput.selectionEnd] : null;
    const previousFeed = host.querySelector('.jarvis-feed');
    const feedTop = previousFeed?.scrollTop || 0;
    const followLatest = !previousFeed || previousFeed.scrollHeight - previousFeed.clientHeight - feedTop < 48;
    const canSend = ready && !busy && !loading && !retry;
    const composerHint = busy ? 'Você pode preparar a próxima mensagem enquanto aguarda.' : retry ? 'A resposta não chegou. Use Tentar novamente para recuperar o mesmo envio com segurança.' : loading ? 'Você já pode escrever enquanto verificamos a conexão.' : ready ? 'Enter para enviar · Shift + Enter para nova linha' : config && (!config.enabled || !config.configured) ? 'Você pode escrever. O envio aguarda a configuração da integração.' : 'Você pode escrever. O envio está indisponível; use Atualizar para tentar a conexão novamente.';
    host.innerHTML = `<header class="jarvis-header"><div><span class="ceo-eyebrow">SEU ASSISTENTE EXECUTIVO</span><h2>JARVIS<span class="jarvis-status-dot"></span></h2></div><div class="jarvis-header-actions"><button class="ceo-button" data-new ${busy ? 'disabled' : ''}>Nova conversa</button>${dialog?.open || host.parentElement === dialog ? '<button class="ceo-icon-button" data-close aria-label="Fechar JARVIS">×</button>' : ''}</div></header>
      <div class="jarvis-history-bar"><label>Conversas<select aria-label="Histórico de conversas" ${busy ? 'disabled' : ''}><option value="">Selecione uma conversa</option>${conversations.map(c => `<option value="${esc(c.id)}" ${conversation?.id === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}</select></label><button class="ceo-button" data-refresh ${busy || loading ? 'disabled' : ''} aria-label="Atualizar JARVIS">↻ Atualizar</button></div>
      ${loading ? '<p class="jarvis-notice" role="status">Carregando seu espaço…</p>' : ''}${config && (!config.enabled || !config.configured) ? `<p class="jarvis-notice">${esc(config.reason)}</p>` : ''}
      <div class="jarvis-feed" role="log" aria-label="Conversa com o JARVIS" aria-live="polite">${messages.length ? messages.map(m => `<article class="jarvis-message ${m.role === 'user' ? 'user' : 'assistant'}"><span>${m.role === 'user' ? 'Você' : 'JARVIS'}</span><p>${esc(m.content)}</p></article>`).join('') : pendingMessage ? '' : homeMarkup()}${pendingMessage ? `<article class="jarvis-message user pending" data-pending-request="${esc(pendingMessage.request_id)}"><span>Você</span><p>${esc(pendingMessage.message)}</p><small>${pendingMessage.status === 'sending' ? 'Enviando…' : 'Resposta não recebida'}</small></article>` : ''}${actions.length ? `<section class="jarvis-actions" aria-label="Ações desta conversa">${actions.map(actionCard).join('')}</section>` : ''}${busy ? `<p class="jarvis-thinking" role="status"><span></span> ${esc(activity || 'JARVIS está processando…')}</p>` : ''}</div>
      ${error ? `<div class="jarvis-error" role="alert"><p>${esc(error)}</p>${retry ? '<button class="ceo-button" data-retry>Tentar novamente</button>' : ''}</div>` : ''}
      <div class="jarvis-quick" aria-label="Ações rápidas">${[['Tarefa', 'Crie uma tarefa para '], ['Despesa', 'Registra uma despesa de R$ '], ['Entrada', 'Registra uma entrada de R$ '], ['Ideia', 'Salva uma ideia: ']].map(([label, prompt]) => `<button class="ceo-button" data-draft="${esc(prompt)}">+ ${label}</button>`).join('')}</div>
      <form class="jarvis-composer"><label class="sr-only" for="jarvisInput">Mensagem para o JARVIS</label><textarea id="jarvisInput" rows="2" maxlength="4000" placeholder="Como posso ajudar?" aria-describedby="jarvisComposerHint">${esc(draft)}</textarea><p class="jarvis-composer-hint" id="jarvisComposerHint" role="status">${esc(composerHint)}</p><div class="jarvis-composer-actions"><small>Horário de Brasília · Português e espanhol</small><div class="jarvis-voice-control"><button class="jarvis-microphone" type="button" data-mic aria-label="Informações sobre voz" title="Voz ainda não implementada">${mic}</button><small>Voz indisponível</small></div><button class="ceo-button primary" type="submit" ${canSend && draft.trim() ? '' : 'disabled'}>Enviar <span aria-hidden="true">↑</span></button></div></form>
      <p class="jarvis-footnote">Consulte os registros para decisões importantes. Movimentações financeiras exigem confirmação.</p>
      ${config?.memoryEnabled ? `<details class="jarvis-memories"><summary>Memórias explícitas (${memories.length})</summary><p>Somente o que você pediu para lembrar. Você pode desativar uma memória.</p>${memories.map(m => `<div><p>${esc(m.content)}</p><button class="ceo-button" data-forget="${esc(m.id)}">Esquecer</button></div>`).join('') || '<p>Nenhuma memória salva.</p>'}</details>` : ''}`;
    const input = host.querySelector('textarea'); input.oninput = () => { draft = input.value; resizeInput(input); host.querySelector('[type="submit"]').disabled = !canSend || !draft.trim(); };
    input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && canSend) { event.preventDefault(); host.querySelector('form').requestSubmit(); } };
    host.querySelector('form').onsubmit = event => { event.preventDefault(); if (canSend && draft.trim()) send(); };
    host.querySelector('[data-new]').onclick = () => { conversation = null; messages = []; actions = []; draft = error = ''; retry = pendingMessage = null; paint({ scroll: 'end' }); host.querySelector('textarea').focus({ preventScroll: true }); };
    host.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    host.querySelector('[data-refresh]').onclick = async () => { await loadHome(); if (conversation) await selectConversation(conversation.id); };
    host.querySelector('select').onchange = event => { if (event.target.value) selectConversation(event.target.value); };
    host.querySelectorAll('[data-draft],[data-prompt]').forEach(button => button.onclick = () => { draft = button.dataset.draft || button.dataset.prompt; if (!retry) error = ''; paint(); host.querySelector('textarea').focus({ preventScroll: true }); });
    host.querySelector('[data-mic]').onclick = () => { error = 'Voz ainda não foi implementada; o microfone permanece desligado. Primeiro será validada a conversa por texto. Depois será adicionada a integração de áudio.'; paint(); };
    host.querySelector('[data-retry]')?.addEventListener('click', () => send(retry));
    host.querySelectorAll('[data-confirm],[data-cancel]').forEach(button => button.onclick = () => resolveAction(button.dataset.confirm || button.dataset.cancel, Boolean(button.dataset.confirm)));
    host.querySelectorAll('[data-forget]').forEach(button => button.onclick = async () => { try { await api(`/memories/${encodeURIComponent(button.dataset.forget)}`, { method: 'DELETE' }); await loadHome(); } catch (failure) { error = failure.message; paint(); } });
    resizeInput(input);
    if (focused) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
    const feed = host.querySelector('.jarvis-feed');
    feed.scrollTop = options.scroll === 'end' || followLatest ? feed.scrollHeight : feedTop;
  }
  async function selectConversation(conversationId) {
    const gen = generation; busy = true; activity = 'Carregando conversa…'; error = ''; paint();
    try { const data = await api(`/conversations/${encodeURIComponent(conversationId)}`); if (gen !== generation) return; conversation = data.conversation; messages = data.messages; actions = data.actions; retry = pendingMessage = null; }
    catch (failure) { if (gen === generation) error = failure.message; }
    finally { if (gen === generation) { busy = false; activity = ''; paint({ scroll: 'end' }); } }
  }
  async function syncState() {
    // Never discard an in-progress editor to reflect a chat mutation.
    if (cloudWritePending || editingId || document.querySelector('dialog[open]:not(.jarvis-dialog)')) { showToast('Dados atualizados pelo JARVIS', 'Atualize a página após finalizar a edição aberta.'); return; }
    state = await loadState(); renderApp();
  }
  function renderApp() { if (typeof global.render === 'function') global.render(); }
  async function send(repeated) {
    const gen = generation;
    const body = repeated || { message: draft.trim(), request_id: crypto.randomUUID(), ...(conversation ? { conversation_id: conversation.id } : {}) };
    if (!body.message || busy || loading || !ready || (retry && repeated !== retry)) return;
    let received = false;
    busy = true; activity = 'Aguardando resposta do JARVIS…'; error = ''; retry = null;
    pendingMessage = { ...body, status: 'sending' };
    if (!repeated) draft = '';
    paint({ scroll: 'end' });
    host?.querySelector('textarea')?.focus({ preventScroll: true });
    try {
      const data = await api('/message', { method: 'POST', body }); if (gen !== generation) return;
      received = true;
      conversation = data.conversation; messages = data.messages; actions = data.actions; pendingMessage = null;
      activity = 'Atualizando a conversa…'; paint();
      // Auxiliary refresh errors must never offer to repeat an already acknowledged write.
      if (data.state_changed) await syncState();
      const history = await api('/conversations'); if (gen !== generation) return; conversations = history.conversations;
      if (config?.memoryEnabled) { const saved = await api('/memories'); if (gen !== generation) return; memories = saved.memories; }
    } catch (failure) {
      if (gen === generation) {
        error = received ? `Resposta recebida. Não foi possível atualizar os dados da tela: ${failure.message}` : failure.message;
        if (!received) { retry = body; pendingMessage.status = 'uncertain'; }
      }
    }
    finally { if (gen === generation) { busy = false; activity = ''; paint(); } }
  }
  async function resolveAction(actionId, confirm) {
    if (busy) return; const gen = generation; busy = true; activity = confirm ? 'Confirmando movimentação…' : 'Cancelando ação…'; error = ''; paint();
    try {
      const data = await api(`/actions/${encodeURIComponent(actionId)}/${confirm ? 'confirm' : 'cancel'}`, { method: 'POST', body: confirm ? { confirmation: true } : {} });
      if (gen !== generation) return;
      actions = actions.map(a => a.id === data.action.id ? data.action : a);
      if (data.state_changed) await syncState();
      if (conversation) { const current = await api(`/conversations/${conversation.id}`); if (gen !== generation) return; messages = current.messages; actions = current.actions; }
    } catch (failure) { if (gen === generation) error = failure.message; }
    finally { if (gen === generation) { busy = false; activity = ''; paint(); } }
  }
  global.ZamaJarvis = { init, reset, render, open };
  document.getElementById('jarvisLauncher')?.addEventListener('click', open);
})(window);
