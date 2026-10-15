/* Projects live in their own permission-checked database, never in the app backup. */
(function (root) {
  'use strict';
  const statuses = Object.freeze({ planning: 'Planejamento', in_progress: 'Em andamento', waiting: 'Aguardando cliente', completed: 'Concluído' });
  const text = value => String(value ?? '');
  const esc = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const fold = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const makeId = () => root.crypto.randomUUID();
  const workspace = () => root.ZamaWorkspace;
  const client = () => typeof supabaseClient !== 'undefined' ? supabaseClient : root.supabaseClient;
  const accountId = () => typeof cloudUserId !== 'undefined' ? cloudUserId : null;
  const ownerId = () => workspace()?.ownerId();
  const role = () => workspace()?.role?.() || (workspace()?.isOwner?.() ? 'owner' : 'viewer');
  const isOwner = () => Boolean(workspace()?.isOwner?.());
  const canEdit = () => isOwner() || ['editor', 'projects'].includes(role());
  const today = () => {
    if (root.ZamaTime?.today) return root.ZamaTime.today();
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(item => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : 'Sem prazo';
  let container = null, activeDialog = null, rows = [], loaded = false, loading = false;
  let generation = 0, requestSequence = 0, activeOwner = null, activeAccount = null, activeRole = null;
  let errorMessage = '', notice = '', secretSequence = 0, secretTimer = null, planningAvailable = false;
  const filters = { search: '', status: '', priority: 'all', order: 'priority' };
  const summary = row => root.ZamaProjectPlanning.summarize(row, today());
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${({ all: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z', overdue: 'M12 3 2 21h20L12 3ZM12 9v5m0 3v.1', upcoming: 'M5 5h14v15H5zM8 3v4m8-4v4M5 10h14m-10 4h2m2 0h2', waiting: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v5l3 2' })[name]}"></path></svg>`;

  function productionLists(source) {
    const lists = Array.isArray(source.production_lists) ? source.production_lists : [
      { id: 'catalog', title: 'Catálogo', steps: source.catalog_steps },
      { id: 'onboarding', title: 'Estruturação', steps: source.onboarding_steps }
    ].filter(list => Array.isArray(list.steps) && list.steps.length);
    return lists.map(list => ({ id: text(list.id), title: text(list.title), steps: Array.isArray(list.steps) ? list.steps.map(step => ({ id: text(step.id), label: text(step.label), done: step.done === true, ...(step.due_date ? { due_date: text(step.due_date) } : {}) })) : [] }));
  }

  // The allowlist makes it impossible for an accidental RPC password property to
  // enter the metadata cache, exports, the general app state, or local storage.
  function metadata(source) {
    if (!source || typeof source !== 'object' || !source.id) throw new Error('PROJECT_INVALID_RESPONSE');
    const record = {};
    ['id', 'title', 'client_name', 'company_name', 'client_email', 'access_url', 'responsible_email', 'responsible_name', 'status', 'due_date', 'notes', 'created_at', 'updated_at'].forEach(key => { record[key] = text(source[key]); });
    record.revision = Number(source.revision || 0);
    record.has_password = Boolean(source.has_password);
    record.production_lists = productionLists(source);
    if (!statuses[record.status]) record.status = 'planning';
    return record;
  }
  function capture() { return { generation, owner: activeOwner, account: activeAccount, role: activeRole }; }
  function current(ticket) {
    return ticket.generation === generation && ticket.owner === activeOwner && ticket.owner === ownerId()
      && ticket.account === activeAccount && ticket.account === accountId() && ticket.role === role() && Boolean(container?.isConnected);
  }
  function dialogCurrent(ticket, dialog) { return current(ticket) && activeDialog === dialog && dialog.isConnected && dialog.open; }
  function friendly(error) {
    const value = `${error?.code || ''} ${error?.message || ''}`;
    const inviteMessages = ['Confirme seu e-mail antes de convidar pessoas.', 'Você já é o proprietário desta empresa.', 'Salve os dados da sua empresa antes de gerar um convite.', 'Limite de convites atingido. Tente novamente mais tarde.', 'Convite inválido.'];
    if (inviteMessages.includes(error?.message)) return error.message;
    if (/40001|PROJECT_CONFLICT/.test(value)) return 'Este projeto foi atualizado por outra pessoa. Feche esta janela, atualize a lista e tente novamente.';
    if (/42501|PROJECT_ACCESS_DENIED|permission denied/i.test(value)) return 'Seu acesso a este projeto mudou. Atualize a lista para verificar os projetos disponíveis.';
    if (/PGRST202|42883|does not exist|schema cache|PROJECT_UNAVAILABLE/i.test(value)) return 'A área de projetos ainda não está disponível nesta instalação. A configuração do banco de dados precisa ser concluída. Depois, tente novamente.';
    if (/22023|PROJECT_INVALID/.test(value)) return 'Confira os campos e as etapas do projeto antes de salvar. Use um e-mail válido e preencha o nome do cliente e o título.';
    return 'Não foi possível concluir a operação. Verifique sua conexão e tente novamente.';
  }
  async function rpc(name, params) {
    if (!client()?.rpc) throw new Error('PROJECT_UNAVAILABLE');
    const result = await client().rpc(name, params);
    if (result.error) throw result.error;
    return result.data;
  }
  function progress(steps) {
    const total = steps.length, done = steps.filter(step => step.done).length;
    return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
  }
  function meter(label, steps, extra = '') {
    const value = progress(steps);
    return `<div class="ceo-project-progress ${extra}"><div><span>${esc(label)}</span><strong>${value.percent}% <small>· ${value.done}/${value.total}</small></strong></div><progress value="${value.done}" max="${value.total || 1}" aria-label="${esc(label)}: ${value.done} de ${value.total} etapas concluídas"></progress></div>`;
  }
  function options(selected) { return Object.entries(statuses).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join(''); }
  function clearSecrets() {
    secretSequence++;
    if (secretTimer) root.clearTimeout(secretTimer);
    secretTimer = null;
    activeDialog?.querySelectorAll('[data-private-value]').forEach(input => { input.value = ''; input.type = 'password'; });
    const button = activeDialog?.querySelector('[data-reveal]');
    if (button) { button.textContent = 'Mostrar senha'; button.disabled = false; button.setAttribute('aria-pressed', 'false'); }
  }
  function closeDialog() {
    clearSecrets();
    if (!activeDialog) return;
    const dialog = activeDialog; activeDialog = null;
    dialog.close(); dialog.replaceChildren(); dialog.remove();
  }
  function leave() {
    generation++; requestSequence++; loading = false; closeDialog();
    container = null; rows = []; loaded = false;
  }
  function reset() {
    const previous = container;
    leave(); rows = []; loaded = false; activeOwner = activeAccount = activeRole = null;
    filters.search = filters.status = ''; filters.priority = 'all'; filters.order = 'priority'; planningAvailable = false; errorMessage = notice = '';
    previous?.replaceChildren();
  }
  function newDialog(title, markup) {
    closeDialog();
    const dialog = document.createElement('dialog');
    dialog.id = 'ceoProjectDialog'; dialog.className = 'ceo-dialog ceo-project-dialog';
    dialog.setAttribute('aria-labelledby', 'ceoProjectDialogTitle');
    dialog.innerHTML = `<header class="ceo-project-dialog-heading ceo-toolbar"><div><span class="ceo-project-eyebrow">PROJETOS DE CLIENTES</span><h2 id="ceoProjectDialogTitle">${esc(title)}</h2></div><button type="button" class="ceo-button" data-close aria-label="Fechar projeto">×</button></header>${markup}`;
    activeDialog = dialog;
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { if (activeDialog === dialog) closeDialog(); }));
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (activeDialog === dialog) closeDialog(); });
    dialog.addEventListener('close', () => { if (activeDialog === dialog) { clearSecrets(); activeDialog = null; } dialog.replaceChildren(); dialog.remove(); });
    dialog.querySelectorAll('label.ceo-field').forEach(label => {
      const control = label.querySelector('input,textarea,select');
      if (control && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label.firstChild.textContent.trim());
    });
    root.ZamaMobileForms?.prepare(dialog);
    document.body.appendChild(dialog); dialog.showModal();
    return dialog;
  }
  function card(row) {
    const completion = summary(row), late = completion.overdue;
    const person = row.responsible_name || row.responsible_email;
    return `<article class="ceo-project-card ${late ? 'is-overdue' : completion.upcoming ? 'is-upcoming' : ''}" data-project-id="${esc(row.id)}">
      <div class="ceo-project-card-meta"><span class="ceo-project-status is-${row.status}"><i></i>${statuses[row.status]}</span>${late ? '<span class="ceo-project-urgency">Prazo vencido</span>' : `<span class="ceo-project-total">${completion.done}/${completion.total} etapas</span>`}</div>
      <h3>${esc(row.title)}</h3><p class="ceo-project-company">${esc(row.company_name || row.client_name)}</p>${row.company_name ? `<p class="ceo-project-client">${esc(row.client_name)}</p>` : ''}
      <div class="ceo-project-tracks">${row.production_lists.length ? row.production_lists.slice(0, 3).map(list => meter(list.title, list.steps)).join('') : '<p class="ceo-project-no-stages">Adicione as etapas da sua produção.</p>'}${row.production_lists.length > 3 ? `<small>Mais ${row.production_lists.length - 3} listas neste projeto</small>` : ''}</div>
      ${completion.next && row.status !== 'completed' ? `<div class="ceo-project-next"><span>PRÓXIMA ETAPA</span><strong>${esc(completion.next.label)}</strong>${completion.next.due_date ? `<small>${dateLabel(completion.next.due_date)}</small>` : ''}</div>` : ''}
      <div class="ceo-project-card-footer"><span class="ceo-project-person"><span class="ceo-project-avatar" aria-hidden="true">${esc((person || '?').slice(0, 1).toUpperCase())}</span><span>${esc(person || 'Sem responsável')}</span></span><span class="ceo-project-due ${row.due_date && row.due_date < today() && row.status !== 'completed' ? 'is-late' : ''}">${dateLabel(row.due_date)}</span></div>
      <button class="ceo-button ceo-project-open" type="button" data-project-open="${esc(row.id)}" aria-label="Abrir projeto ${esc(row.title)}">Acompanhar projeto <span aria-hidden="true">↗</span></button>
    </article>`;
  }
  function renderBoard() {
    const board = container?.querySelector('[data-project-board]'); if (!board) return;
    const query = fold(filters.search).trim();
    const visible = rows.filter(row => (!filters.status || row.status === filters.status) && (filters.priority === 'all' || filters.priority === 'waiting' && row.status === 'waiting' || summary(row)[filters.priority] === true) && (!query || fold(`${row.title} ${row.client_name} ${row.company_name} ${row.client_email} ${row.responsible_name} ${row.responsible_email}`).includes(query))).sort((a, b) => root.ZamaProjectPlanning.compare(a, b, filters.order, today()));
    container.querySelectorAll('[data-priority]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.priority === filters.priority)));
    container.querySelector('[data-project-count]').textContent = `${visible.length} ${visible.length === 1 ? 'projeto encontrado' : 'projetos encontrados'}`;
    if (!visible.length) {
      board.innerHTML = `<div class="ceo-project-empty"><span class="ceo-project-empty-icon" aria-hidden="true">▤</span><h3>${rows.length ? 'Nenhum projeto com estes filtros' : 'Cada cliente, uma entrega bem acompanhada'}</h3><p>${rows.length ? 'Tente outro nome, prioridade ou situação para encontrar seu projeto.' : isOwner() ? 'Cadastre o cliente, defina o responsável e crie as listas de produção do seu jeito.' : 'Os projetos da equipe ZAMA aparecerão aqui.'}</p>${rows.length ? '<button type="button" class="ceo-button" data-clear-project-filters>Limpar filtros</button>' : isOwner() ? '<button type="button" class="ceo-button primary" data-project-new>+ Criar primeiro projeto</button>' : ''}</div>`;
      board.querySelector('[data-clear-project-filters]')?.addEventListener('click', () => { filters.search = filters.status = ''; filters.priority = 'all'; paint(); });
      board.querySelector('[data-project-new]')?.addEventListener('click', () => openEditor());
    } else board.innerHTML = visible.map(card).join('');
  }
  function paint() {
    if (!container?.isConnected) return;
    const active = rows.filter(row => row.status !== 'completed').length;
    const summaries = rows.map(summary), total = summaries.reduce((sum, item) => sum + item.total, 0), done = summaries.reduce((sum, item) => sum + item.done, 0);
    const focus = rows.filter(row => summary(row).attention).sort((a, b) => root.ZamaProjectPlanning.compare(a, b, 'priority', today())).slice(0, 4);
    const priorities = [ ['all','Todos os projetos',rows.length,`${active} em produção`], ['overdue','Precisam de atenção',summaries.filter(item => item.overdue).length,'Projetos ou etapas atrasados'], ['upcoming','Próximos 7 dias',summaries.filter(item => item.upcoming).length,'Entregas chegando'], ['waiting','Aguardando cliente',rows.filter(row => row.status === 'waiting').length,'Retornos e aprovações'] ];
    container.innerHTML = `<section class="ceo-projects"><div class="ceo-project-hero"><div class="ceo-project-heading"><div class="ceo-project-hero-copy"><span class="ceo-project-eyebrow">ZAMA / ESPAÇO DA EQUIPE</span><h2>Projetos de clientes</h2><p>Uma visão clara da produção.<br>Cada etapa, mais perto da entrega.</p></div><div class="ceo-project-hero-summary"><strong>${total ? Math.round(done / total * 100) : 0}<span>%</span></strong><span>das etapas concluídas</span><small>${done} de ${total} etapas · ${active} projetos ativos</small></div></div><div class="ceo-project-heading-actions"><span class="ceo-project-shared-label">${icon('all')} Compartilhado com a equipe</span><button type="button" class="ceo-button" data-project-refresh ${loading ? 'disabled' : ''}>${loading ? 'Atualizando…' : 'Atualizar'}</button>${isOwner() ? `<button type="button" class="ceo-button" data-project-team ${!loaded || loading || errorMessage ? 'disabled' : ''}>Criar acesso</button><button type="button" class="ceo-button primary" data-project-new ${!loaded || loading || errorMessage ? 'disabled' : ''}>+ Novo projeto</button>` : ''}</div></div>
      ${role() === 'viewer' ? '<p class="ceo-project-access-note">Você pode acompanhar todos os projetos. As atualizações ficam com os responsáveis pela produção.</p>' : ''}
      <div class="ceo-project-priorities" aria-label="Prioridades dos projetos">${priorities.map(([key,label,count,hint]) => `<button type="button" class="ceo-project-priority is-${key}" data-priority="${key}" aria-pressed="${filters.priority === key}" ${!loaded || loading ? 'disabled' : ''}><span class="ceo-project-priority-icon">${icon(key)}</span><strong>${count}</strong><span>${label}</span><small>${hint}</small></button>`).join('')}</div>
      ${notice ? `<p class="ceo-project-notice" role="status">${esc(notice)}</p>` : ''}
      ${errorMessage ? `<div class="ceo-project-error" role="alert"><strong>Não foi possível carregar os projetos</strong><p>${esc(errorMessage)}</p><button class="ceo-button" type="button" data-project-retry>Tentar novamente</button></div>` : ''}
      ${loading && !loaded ? '<div class="ceo-project-empty" role="status"><h3>Carregando seus projetos…</h3><p>Consultando a produção da equipe.</p></div>' : !errorMessage && loaded ? `${focus.length ? `<section class="ceo-project-focus"><div><span class="ceo-project-eyebrow">PARA ACOMPANHAR DE PERTO</span><h3>Próximas entregas</h3></div><div class="ceo-project-focus-list">${focus.map(row => { const info = summary(row); return `<button type="button" class="ceo-project-focus-item" data-focus-project="${esc(row.id)}"><span class="ceo-project-focus-dot ${info.overdue ? 'is-late' : ''}"></span><span><strong>${esc(row.title)}</strong><small>${esc(info.attention.label)}</small></span><time class="${info.overdue ? 'is-late' : ''}">${info.overdue ? 'Atrasado · ' : ''}${dateLabel(info.attention.date)}</time><span aria-hidden="true">↗</span></button>`; }).join('')}</div></section>` : ''}<div class="ceo-project-board-heading"><h3>Produção da equipe</h3><p class="ceo-project-results" data-project-count aria-live="polite"></p></div><div class="ceo-project-filters"><label class="ceo-field ceo-project-search">Pesquisar projetos<input type="search" data-project-search value="${esc(filters.search)}" placeholder="Cliente, projeto ou responsável"></label><label class="ceo-field">Situação<select data-project-status><option value="">Todas as situações</option>${options(filters.status)}</select></label><label class="ceo-field">Ordenar por<select data-project-order><option value="priority" ${filters.order === 'priority' ? 'selected' : ''}>Prioridade e prazo</option><option value="updated" ${filters.order === 'updated' ? 'selected' : ''}>Atualizados recentemente</option><option value="name" ${filters.order === 'name' ? 'selected' : ''}>Nome do projeto</option></select></label></div><div class="ceo-project-board" data-project-board></div>` : ''}
    </section>`;
    container.querySelector('[data-project-new]')?.addEventListener('click', () => openEditor());
    container.querySelector('[data-project-team]')?.addEventListener('click', () => openTeamAccess());
    container.querySelector('[data-project-refresh]')?.addEventListener('click', () => void load());
    container.querySelector('[data-project-retry]')?.addEventListener('click', () => void load());
    container.querySelector('[data-project-search]')?.addEventListener('input', event => { filters.search = event.target.value; renderBoard(); });
    container.querySelector('[data-project-status]')?.addEventListener('change', event => { filters.status = event.target.value; renderBoard(); });
    container.querySelector('[data-project-order]')?.addEventListener('change', event => { filters.order = event.target.value; renderBoard(); });
    container.querySelectorAll('[data-priority]').forEach(button => button.addEventListener('click', () => { filters.priority = button.dataset.priority; renderBoard(); }));
    container.querySelectorAll('[data-focus-project]').forEach(button => button.addEventListener('click', () => openDetail(button.dataset.focusProject)));
    container.querySelector('[data-project-board]')?.addEventListener('click', event => {
      const button = event.target.closest('[data-project-open]');
      if (button) openDetail(button.dataset.projectOpen);
    });
    renderBoard();
  }
  async function load() {
    if (!container || loading) return;
    closeDialog(); loading = true; errorMessage = ''; notice = '';
    const ticket = capture(), sequence = ++requestSequence;
    paint();
    try {
      let result;
      try { result = await rpc('zama_projects_list_v3', { p_owner: ticket.owner }); if (current(ticket)) planningAvailable = true; }
      catch (error) {
        if (!['PGRST202', '42883'].includes(error?.code)) throw error;
        result = await rpc('zama_projects_list_v2', { p_owner: ticket.owner }); if (current(ticket)) planningAvailable = false;
      }
      if (!current(ticket) || sequence !== requestSequence) return;
      if (!Array.isArray(result)) throw new Error('PROJECT_INVALID_RESPONSE');
      rows = result.map(metadata).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); loaded = true;
    } catch (error) {
      if (!current(ticket) || sequence !== requestSequence) return;
      rows = []; loaded = false; errorMessage = friendly(error);
    } finally {
      if (current(ticket) && sequence === requestSequence) { loading = false; paint(); }
    }
  }
  function safeUrl(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function openTeamAccess(initialEmail = '') {
    if (!isOwner() || !loaded || loading || errorMessage) return;
    const ticket = capture();
    const dialog = newDialog('Acesso à equipe ZAMA', `<div class="ceo-project-access-note"><strong>Um acesso separado para sua equipe</strong><p>A pessoa terá Agenda, Projetos e Ideias. Projetos e ideias são compartilhados com toda a equipe; a agenda é individual e privada. Financeiro e administração continuam reservados ao administrador.</p></div>
      <form class="ceo-project-team-form" data-team-form><label class="ceo-field">E-mail da pessoa<input type="email" name="email" required maxlength="254" autocomplete="off" placeholder="pessoa@empresa.com"></label>
      <section class="ceo-project-team-preview" aria-live="polite"><h3>Projetos compartilhados com a equipe</h3><div data-team-preview></div></section>
      <p data-team-permission aria-live="polite"></p>
      <div class="ceo-project-team-passwords" data-team-passwords hidden><div class="ceo-project-form-grid"><label class="ceo-field">Senha de acesso<input type="password" name="access_password" minlength="10" maxlength="72" autocomplete="new-password" data-private-value></label><label class="ceo-field">Confirmar senha<input type="password" name="confirm_password" minlength="10" maxlength="72" autocomplete="new-password" data-private-value></label></div><p>Use pelo menos 10 caracteres. A pessoa entra com este e-mail e senha, sem precisar receber um convite.</p></div>
      <p class="ceo-project-team-capability" data-team-capability role="status">Verificando a criação de acesso com senha…</p>
      <div class="ceo-project-team-form-actions"><button class="ceo-button primary" type="submit" data-team-create hidden disabled>Criar acesso com senha</button><button class="ceo-button primary" type="button" disabled data-team-submit>Gerar link de acesso</button></div></form>
      <div class="ceo-project-invite" data-team-result hidden></div><p class="ceo-project-notice" data-team-notice role="status" hidden></p>
      <p class="ceo-form-error" data-team-error role="alert" hidden></p>
      <section class="ceo-project-team-list"><div class="ceo-project-team-list-heading"><h3>Equipe ZAMA</h3><button type="button" class="ceo-button" data-team-refresh>Atualizar acessos</button></div><div data-team-roster aria-live="polite">Carregando acessos…</div></section>
      <footer class="ceo-project-dialog-footer"><button type="button" class="ceo-button" data-close>Fechar</button></footer>`);
    const form = dialog.querySelector('[data-team-form]'), emailInput = form.elements.email;
    emailInput.value = initialEmail;
    const submit = dialog.querySelector('[data-team-submit]'), preview = dialog.querySelector('[data-team-preview]');
    const createButton = dialog.querySelector('[data-team-create]'), passwordFields = dialog.querySelector('[data-team-passwords]');
    const passwordInput = form.elements.access_password, confirmationInput = form.elements.confirm_password;
    const capabilityNote = dialog.querySelector('[data-team-capability]');
    const permission = dialog.querySelector('[data-team-permission]'), rosterBox = dialog.querySelector('[data-team-roster]');
    const output = dialog.querySelector('[data-team-result]'), errorBox = dialog.querySelector('[data-team-error]'), status = dialog.querySelector('[data-team-notice]');
    let roster = null, busy = false, generatedEmail = '', passwordAccess = false, capabilityLoading = true;
    const valid = () => dialogCurrent(ticket, dialog) && isOwner();
    const normalize = value => text(value).trim().toLowerCase();
    const email = () => normalize(emailInput.value);
    const memberFor = address => roster?.members.find(member => normalize(member.email) === address);
    const assignments = () => rows;
    function assignmentList(address) {
      const projects = assignments(address);
      return projects.length ? `<ul>${projects.map(row => `<li>${esc(row.title)}</li>`).join('')}</ul>` : '<p>Nenhum projeto cadastrado ainda. Os próximos projetos estarão disponíveis para toda a equipe.</p>';
    }
    function clearResult() { clearSecrets(); output.replaceChildren(); output.hidden = true; generatedEmail = ''; }
    function accessError(error) {
      if (['NOT_CONFIGURED', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'INVALID_PASSWORD', 'ACCOUNT_EXISTS', 'RATE_LIMITED', 'ACCOUNT_SETUP_INCOMPLETE', 'INTERNAL_ERROR', 'PROJECT_UNAVAILABLE'].includes(error?.code) && error.publicMessage) return error.publicMessage;
      if (error?.status === 409) return 'Já existe uma conta com este e-mail. A senha dela não foi alterada. Gere um link de acesso para a pessoa entrar com a própria conta.';
      if (error?.status === 403) return 'A criação de contas com senha está disponível somente para o administrador autorizado.';
      if (error?.status === 401) return 'Sua sessão expirou. Entre novamente para criar o acesso.';
      if (error?.status === 400) return 'Confira o e-mail e a senha. Use pelo menos 10 caracteres e no máximo 72 bytes na senha.';
      if (error?.status === 429) return 'Muitas tentativas de criação. Aguarde um pouco e tente novamente.';
      if (error?.status === 503) return 'A criação de acesso com senha ainda precisa ser habilitada pelo administrador. Você pode gerar um link de acesso abaixo.';
      return 'Não foi possível criar o acesso. Confira a lista da equipe antes de tentar novamente.';
    }
    async function accessRequest(method, body) {
      if (!valid()) throw new Error('PROJECT_ACCESS_DENIED');
      const auth = await client()?.auth?.getSession();
      if (!valid()) throw new Error('PROJECT_ACCESS_DENIED');
      const session = auth?.data?.session;
      if (auth?.error || session?.user?.id !== ticket.account || !session?.access_token) throw Object.assign(new Error('PROJECT_ACCESS_DENIED'), { status: 401 });
      const response = await root.fetch('/api/project-access', { method, cache: 'no-store', headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!valid()) throw new Error('PROJECT_ACCESS_DENIED');
      const result = await response.json();
      if (!valid()) throw new Error('PROJECT_ACCESS_DENIED');
      if (!response.ok) throw Object.assign(new Error('PROJECT_ACCESS_FAILED'), { status: response.status, code: result?.code, publicMessage: typeof result?.error === 'string' ? result.error.slice(0, 500) : '' });
      return result;
    }
    async function loadCapability() {
      try {
        const result = await accessRequest('GET');
        if (!valid()) return;
        passwordAccess = result?.enabled === true;
        capabilityNote.textContent = passwordAccess ? '' : 'A criação de acesso com senha ainda não está habilitada. Você pode gerar um link de acesso.';
      } catch (error) {
        if (!valid()) return;
        passwordAccess = false;
        capabilityNote.textContent = error?.status === 403 ? 'Use o convite por link para conceder acesso. O cadastro com senha é reservado ao administrador autorizado.' : 'A criação de acesso com senha está indisponível no momento. Você pode gerar um link de acesso.';
      } finally { if (valid()) { capabilityLoading = false; syncForm(); } }
    }
    function showTeamError(error, saved = false) {
      errorBox.textContent = saved ? 'A alteração foi salva, mas não foi possível consultar os acessos atualizados. Clique em Atualizar acessos para continuar.' : friendly(error);
      errorBox.hidden = false;
      if (!roster) rosterBox.textContent = 'Não foi possível consultar a equipe. Clique em Atualizar acessos para tentar novamente.';
    }
    function syncForm() {
      const address = email(), member = memberFor(address);
      preview.innerHTML = address && emailInput.validity.valid ? assignmentList(address) : '<p>Informe o e-mail para conferir os projetos que essa pessoa poderá acessar.</p>';
      permission.textContent = !roster ? busy ? 'Aguarde a consulta dos acessos.' : 'Atualize os acessos para continuar.' : member?.role === 'projects' ? 'Esta pessoa já faz parte da equipe ZAMA. Ela pode entrar com a própria conta.' : member ? 'Esta pessoa já tem um acesso cadastrado. Use o perfil da equipe para Agenda privada, Projetos e Ideias compartilhados. A senha atual será mantida.' : passwordAccess ? 'Acesso à equipe: Agenda privada, Projetos e Ideias compartilhados. Cadastre a senha e entregue os dados de acesso à pessoa.' : 'Acesso à equipe: Agenda privada, Projetos e Ideias compartilhados. A pessoa cria sua própria senha ao abrir o convite ou entra com uma conta existente.';
      const canCreate = passwordAccess && Boolean(roster) && !member;
      createButton.type = canCreate ? 'submit' : 'button';
      submit.type = canCreate ? 'button' : 'submit';
      passwordFields.hidden = createButton.hidden = !canCreate;
      passwordInput.disabled = confirmationInput.disabled = busy || !canCreate;
      if (member) { passwordInput.value = ''; confirmationInput.value = ''; }
      createButton.disabled = busy || !canCreate;
      createButton.textContent = busy ? 'Aguarde…' : 'Criar acesso com senha';
      submit.classList.toggle('primary', !canCreate);
      capabilityNote.hidden = !capabilityLoading && (passwordAccess || Boolean(member));
      submit.textContent = busy ? 'Aguarde…' : member?.role === 'projects' ? 'Acesso já ativo' : member ? 'Usar perfil da equipe' : 'Gerar link de acesso';
      submit.disabled = busy || !roster || member?.role === 'projects';
      emailInput.disabled = busy && Boolean(roster);
      dialog.querySelector('[data-team-refresh]').disabled = busy;
      rosterBox.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    }
    function renderRoster() {
      const members = roster.members;
      const invites = roster.invites;
      rosterBox.innerHTML = members.map(member => `<article class="ceo-project-team-entry" data-team-entry><div><strong>${esc(member.email)}</strong><span class="ceo-project-team-badge">Acesso ativo · ${member.role === 'viewer' ? 'Leitura' : 'Equipe ZAMA'}</span>${assignmentList(normalize(member.email))}</div><div data-team-actions><button type="button" class="ceo-button danger" data-team-revoke="${esc(member.user_id)}">Remover acesso</button></div></article>`).join('')
        + invites.map(invite => `<article class="ceo-project-team-entry" data-team-entry><div><strong>${esc(invite.email)}</strong><span class="ceo-project-team-badge is-pending">Convite pendente · Equipe ZAMA</span>${assignmentList(normalize(invite.email))}</div><div data-team-actions><button type="button" class="ceo-button" data-team-cancel="${esc(invite.id)}">Cancelar convite</button></div></article>`).join('');
      if (!members.length && !invites.length) rosterBox.innerHTML = '<p>Nenhuma pessoa cadastrada na equipe ainda. Cadastre o primeiro acesso usando o formulário acima.</p>';
    }
    async function refreshRoster() {
      roster = null; rosterBox.textContent = 'Carregando acessos…';
      const result = await rpc('zama_workspace_roster', {});
      if (!valid()) return;
      if (!Array.isArray(result?.members) || !Array.isArray(result?.invites)) throw new Error('PROJECT_INVALID_RESPONSE');
      roster = result; renderRoster();
    }
    async function reloadRoster() {
      if (!valid() || busy) return;
      busy = true; roster = null; clearResult(); errorBox.hidden = true; status.hidden = true; syncForm();
      rosterBox.textContent = 'Carregando acessos…';
      try { await refreshRoster(); }
      catch (error) { if (valid()) showTeamError(error); }
      finally { if (valid()) { busy = false; syncForm(); } }
    }
    emailInput.addEventListener('input', () => { clearResult(); status.hidden = errorBox.hidden = true; syncForm(); });
    dialog.querySelector('[data-team-refresh]').addEventListener('click', () => void reloadRoster());
    submit.addEventListener('click', async event => {
      event.preventDefault();
      if (!valid() || busy || !roster || !emailInput.reportValidity()) return;
      const address = email(), member = memberFor(address);
      if (member?.role === 'projects') return;
      let saved = false;
      busy = true; clearResult(); errorBox.hidden = status.hidden = true; syncForm();
      try {
        if (member) {
          await rpc('zama_workspace_set_role', { p_user: member.user_id, p_role: 'projects' });
          if (!valid()) return;
          saved = true;
          status.textContent = `Acesso de ${address} atualizado para a equipe desta empresa.`; status.hidden = false;
        } else {
          if (!workspace()?.inviteProjects) throw new Error('PROJECT_UNAVAILABLE');
          const link = await workspace().inviteProjects(address);
          if (!valid()) return;
          saved = true;
          generatedEmail = address; output.hidden = false;
          output.innerHTML = `<h3>Convite pronto para ${esc(address)}</h3><label class="ceo-field">Link de acesso à equipe<input type="text" readonly aria-label="Link de acesso à equipe"></label><button type="button" class="ceo-button" data-team-copy>Copiar link</button><p>Copie e envie o link à pessoa. O convite é válido por 7 dias e só pode ser aceito com o e-mail indicado.</p><ol><li>Abra o link e entre na sua conta ou clique em “Criar acesso” para cadastrar a própria senha.</li><li>Se precisar confirmar o e-mail, confirme e abra este convite novamente.</li><li>Clique em “Aceitar convite” para entrar no espaço da equipe.</li></ol>`;
          output.querySelector('input').value = text(link);
          output.querySelector('[data-team-copy]').addEventListener('click', async event => {
            const button = event.currentTarget;
            try { await root.navigator.clipboard.writeText(text(link)); if (valid() && generatedEmail === address) button.textContent = 'Link copiado'; }
            catch { if (valid() && generatedEmail === address) { output.querySelector('input').select(); button.textContent = 'Selecione e copie o link'; } }
          });
        }
        await refreshRoster();
      } catch (error) { if (valid()) showTeamError(error, saved); }
      finally { if (valid()) { busy = false; syncForm(); } }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!valid() || busy || !roster || !emailInput.reportValidity()) return;
      if (!passwordAccess || memberFor(email())) { if (!submit.disabled) submit.click(); return; }
      let password = passwordInput.value;
      if (password.length < 10 || new TextEncoder().encode(password).length > 72 || password !== confirmationInput.value) {
        errorBox.textContent = password !== confirmationInput.value ? 'As senhas não coincidem. Digite a mesma senha nos dois campos.' : 'Use uma senha com pelo menos 10 caracteres e no máximo 72 bytes.';
        errorBox.hidden = false; password = ''; return;
      }
      const address = email();
      let saved = false;
      busy = true; clearResult(); errorBox.hidden = status.hidden = true; syncForm();
      const sequence = secretSequence;
      try {
        const result = await accessRequest('POST', { email: address, password });
        if (!valid()) return;
        if (result?.created !== true || normalize(result.email) !== address || result.role !== 'projects') throw new Error('PROJECT_INVALID_RESPONSE');
        saved = true; generatedEmail = address;
        output.innerHTML = '<h3>Acesso criado · Equipe ZAMA</h3><div class="ceo-project-form-grid"><label class="ceo-field">E-mail de acesso<input type="email" readonly data-created-email aria-label="E-mail de acesso"></label><label class="ceo-field">Senha cadastrada<input type="password" readonly data-created-password data-private-value autocomplete="off" aria-label="Senha cadastrada"></label><label class="ceo-field ceo-project-wide">Site para entrar<input type="url" readonly data-created-site aria-label="Site para entrar"></label></div><button type="button" class="ceo-button" data-team-copy-credentials>Copiar dados de acesso</button><p data-created-help>Copie e entregue os dados à pessoa. A senha será apagada desta tela após um minuto ou ao sair da janela. Nenhum e-mail foi enviado.</p>';
        output.querySelector('[data-created-email]').value = address;
        output.querySelector('[data-created-site]').value = safeUrl(result.loginUrl) || `${root.location.origin}/`;
        if (sequence === secretSequence && !document.hidden) {
          output.querySelector('[data-created-password]').value = password;
          secretTimer = root.setTimeout(clearSecrets, 60000);
        } else output.querySelector('[data-created-help]').textContent = 'Acesso criado. A senha foi apagada desta tela porque você saiu da janela. Ela não pode ser consultada novamente aqui. Nenhum e-mail foi enviado.';
        password = ''; output.hidden = false;
        output.querySelector('[data-team-copy-credentials]').addEventListener('click', async event => {
          if (!valid()) return;
          const button = event.currentTarget, savedPassword = output.querySelector('[data-created-password]');
          if (!savedPassword?.value) {
            status.textContent = 'A senha já foi apagada desta tela e não pode ser consultada novamente aqui.'; status.hidden = false; return;
          }
          try {
            await root.navigator.clipboard.writeText(`Site: ${output.querySelector('[data-created-site]').value}\nE-mail: ${output.querySelector('[data-created-email]').value}\nSenha: ${savedPassword.value}`);
            if (valid() && generatedEmail === address) button.textContent = 'Dados de acesso copiados';
          } catch { if (valid() && generatedEmail === address) { status.textContent = 'Não foi possível copiar os dados. Permita o acesso à área de transferência e tente novamente.'; status.hidden = false; } }
        });
        status.textContent = `Acesso de ${address} criado. A pessoa já pode entrar com a senha cadastrada.`; status.hidden = false;
        await refreshRoster();
      } catch (error) {
        if (valid()) {
          if (saved) showTeamError(error, true);
          else { errorBox.textContent = accessError(error); errorBox.hidden = false; }
        }
      } finally { password = ''; if (valid()) { passwordInput.value = confirmationInput.value = ''; busy = false; syncForm(); } }
    });
    rosterBox.addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button || !valid() || busy || !roster) return;
      if (button.hasAttribute('data-team-keep')) { renderRoster(); return; }
      if (button.dataset.teamRevoke) {
        button.parentElement.innerHTML = `<p>Remover o acesso desta pessoa à empresa? Os projetos serão mantidos.</p><button type="button" class="ceo-button danger" data-team-confirm="${esc(button.dataset.teamRevoke)}">Confirmar remoção</button><button type="button" class="ceo-button" data-team-keep>Manter acesso</button>`;
        return;
      }
      const member = roster.members.find(item => item.user_id === button.dataset.teamConfirm && item.role === 'projects');
      const invite = roster.invites.find(item => item.id === button.dataset.teamCancel && item.role === 'projects');
      if (!member && !invite) return;
      let saved = false;
      busy = true; errorBox.hidden = status.hidden = true; syncForm();
      try {
        await rpc(member ? 'zama_workspace_revoke' : 'zama_workspace_cancel_invite', member ? { p_user: member.user_id } : { p_id: invite.id });
        if (!valid()) return;
        saved = true;
        if (generatedEmail === normalize((member || invite).email)) clearResult();
        status.textContent = member ? 'Acesso removido. Os projetos foram mantidos.' : 'Convite cancelado. O link não permite mais aceitar o acesso.'; status.hidden = false;
        await refreshRoster();
      } catch (error) { if (valid()) showTeamError(error, saved); }
      finally { if (valid()) { busy = false; syncForm(); } }
    });
    syncForm(); emailInput.focus(); void reloadRoster(); void loadCapability();
  }
  function checklist(label, steps) {
    return `<section class="ceo-project-detail-track"><h3>${esc(label)}</h3>${meter('Etapas concluídas', steps)}<ul class="ceo-project-checklist">${steps.length ? steps.map(step => `<li class="${step.done ? 'is-done' : ''}"><span class="ceo-project-check" aria-hidden="true">${step.done ? '✓' : ''}</span><span class="ceo-project-step-copy">${esc(step.label)}${step.done ? '<span class="ceo-project-sr"> — Concluída</span>' : ''}${step.due_date ? `<small class="${!step.done && step.due_date < today() ? 'is-late' : ''}">${!step.done && step.due_date < today() ? 'Atrasada · ' : 'Prazo · '}${dateLabel(step.due_date)}</small>` : ''}</span></li>`).join('') : '<li class="ceo-muted">Nenhuma etapa cadastrada.</li>'}</ul></section>`;
  }
  function openDetail(id) {
    const row = rows.find(item => item.id === id); if (!row) return;
    const ticket = capture(), url = safeUrl(row.access_url);
    const dialog = newDialog(row.title, `<div class="ceo-project-detail-meta"><span class="ceo-project-status is-${row.status}"><i></i>${statuses[row.status]}</span><span>Prazo: ${dateLabel(row.due_date)}</span></div>
      <dl class="ceo-project-info"><div><dt>Cliente</dt><dd>${esc(row.client_name || 'Não informado')}</dd></div><div><dt>Empresa</dt><dd>${esc(row.company_name || 'Não informada')}</dd></div><div><dt>Responsável</dt><dd>${esc(row.responsible_name || 'Não definido')}${row.responsible_email ? `<small>${esc(row.responsible_email)}</small>` : ''}</dd></div></dl>
      <section class="ceo-project-credentials"><div><h3>Acessos do cliente</h3><p>Dados usados para trabalhar neste projeto.</p></div><dl class="ceo-project-info"><div><dt>E-mail de acesso</dt><dd>${esc(row.client_email || 'Não informado')}</dd></div><div><dt>Página de acesso</dt><dd>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Abrir página de acesso ↗</a>` : esc(row.access_url || 'Não informada')}</dd></div></dl>
      <div class="ceo-project-secret"><label class="ceo-field">Senha<input type="password" readonly data-private-value aria-label="Senha do cliente" placeholder="${row.has_password ? '••••••••••••' : 'Não cadastrada'}" autocomplete="off"></label>${row.has_password && canEdit() && (isOwner() || row.responsible_email === workspace()?.email?.()?.toLowerCase()) ? '<button class="ceo-button" type="button" data-reveal aria-pressed="false">Mostrar senha</button>' : ''}</div><p class="ceo-project-secret-note">A senha é reservada ao administrador e ao responsável atribuído, e é ocultada ao sair desta janela.</p></section>
      <div class="ceo-project-detail-tracks">${row.production_lists.length ? row.production_lists.map(list => checklist(list.title, list.steps)).join('') : '<p class="ceo-project-no-stages">Nenhuma lista de produção cadastrada.</p>'}</div>
      <section class="ceo-project-notes"><h3>Notas e próximos passos</h3><p>${esc(row.notes || 'Nenhuma observação por enquanto.')}</p></section>
      ${isOwner() && row.responsible_email ? `<section class="ceo-project-invite"><h3>Acesso do responsável</h3><p>Crie ou gerencie o acesso de <strong>${esc(row.responsible_email)}</strong> aos projetos desta empresa.</p><button type="button" class="ceo-button" data-project-invite>Gerenciar acesso do responsável</button></section>` : ''}
      <p class="ceo-form-error" data-dialog-error role="alert" hidden></p><footer class="ceo-project-dialog-footer">${isOwner() ? '<button type="button" class="ceo-button danger" data-project-delete>Excluir projeto</button>' : ''}<div><button type="button" class="ceo-button" data-close>Fechar</button>${canEdit() ? `<button type="button" class="ceo-button primary" data-project-edit>${isOwner() ? 'Editar projeto' : 'Atualizar andamento'}</button>` : ''}</div></footer>`);
    dialog.querySelector('[data-project-edit]')?.addEventListener('click', () => { if (dialogCurrent(ticket, dialog)) openEditor(id); });
    dialog.querySelector('[data-project-delete]')?.addEventListener('click', () => { if (dialogCurrent(ticket, dialog)) openDelete(row); });
    dialog.querySelector('[data-reveal]')?.addEventListener('click', async event => {
      if (!dialogCurrent(ticket, dialog) || !canEdit()) return;
      const input = dialog.querySelector('[data-private-value]'), button = event.currentTarget;
      if (input.value) { clearSecrets(); return; }
      const sequence = ++secretSequence;
      button.disabled = true; button.textContent = 'Consultando…';
      const errorBox = dialog.querySelector('[data-dialog-error]'); errorBox.hidden = true;
      try {
        let value = await rpc('zama_project_secret', { p_owner: ticket.owner, p_id: row.id });
        if (!dialogCurrent(ticket, dialog) || sequence !== secretSequence || document.hidden) { value = null; return; }
        input.value = typeof value === 'string' ? value : ''; value = null;
        if (!input.value) { input.placeholder = 'Não cadastrada'; button.textContent = 'Mostrar senha'; return; }
        input.type = 'text'; button.textContent = 'Ocultar senha'; button.setAttribute('aria-pressed', 'true');
        secretTimer = root.setTimeout(clearSecrets, 60000);
      } catch (error) {
        if (dialogCurrent(ticket, dialog) && sequence === secretSequence) { errorBox.textContent = friendly(error); errorBox.hidden = false; button.textContent = 'Mostrar senha'; }
      } finally { if (dialogCurrent(ticket, dialog) && sequence === secretSequence) button.disabled = false; }
    });
    dialog.querySelector('[data-project-invite]')?.addEventListener('click', () => {
      if (dialogCurrent(ticket, dialog) && isOwner()) openTeamAccess(row.responsible_email);
    });
  }
  function stepEditor(step) {
    return `<div class="ceo-project-step-editor" data-step-id="${esc(step.id)}"><input type="checkbox" data-step-done ${step.done ? 'checked' : ''} aria-label="Concluir etapa: ${esc(step.label || 'Nova etapa')}"><input type="text" data-step-label value="${esc(step.label)}" required maxlength="254" aria-label="Nome da etapa" placeholder="O que precisa ser feito?">${planningAvailable ? `<label class="ceo-project-step-date">Prazo<input type="date" data-step-due value="${esc(step.due_date || '')}" aria-label="Prazo da etapa: ${esc(step.label || 'Nova etapa')}"></label>` : ''}<div class="ceo-project-step-actions"><button type="button" class="ceo-button" data-step-up aria-label="Mover etapa para cima: ${esc(step.label || 'Nova etapa')}">↑</button><button type="button" class="ceo-button" data-step-down aria-label="Mover etapa para baixo: ${esc(step.label || 'Nova etapa')}">↓</button><button type="button" class="ceo-button" data-step-remove aria-label="Remover etapa: ${esc(step.label || 'Nova etapa')}">×</button></div></div>`;
  }
  function listEditor(list) {
    return `<fieldset class="ceo-project-track-editor" data-production-list data-list-id="${esc(list.id)}"><legend>Lista de produção</legend><div class="ceo-project-list-heading"><label class="ceo-field">Nome da lista<input type="text" data-list-title value="${esc(list.title)}" required maxlength="254" aria-label="Nome da lista" placeholder="Ex.: Design, Gravação, Entrega"></label><button type="button" class="ceo-button" data-list-remove aria-label="Excluir lista: ${esc(list.title || 'Nova lista')}">Excluir lista</button></div><p data-steps-empty ${list.steps.length ? 'hidden' : ''}>Comece adicionando uma etapa. Você define o que precisa ser feito.</p><div data-list-steps>${list.steps.map(stepEditor).join('')}</div><button type="button" class="ceo-button" data-step-add>+ Adicionar etapa</button></fieldset>`;
  }
  function syncListControls(form) {
    const lists = [...form.querySelectorAll('[data-production-list]')];
    form.querySelector('[data-lists-empty]').hidden = lists.length > 0;
    form.querySelector('[data-list-add]').disabled = lists.length >= 20;
    lists.forEach(list => {
      const title = list.querySelector('[data-list-title]').value.trim() || 'Nova lista';
      list.querySelector('[data-list-remove]').setAttribute('aria-label', `Excluir lista: ${title}`);
      const steps = [...list.querySelector('[data-list-steps]').children];
      list.querySelector('[data-steps-empty]').hidden = steps.length > 0;
      list.querySelector('[data-step-add]').disabled = steps.length >= 100;
      steps.forEach((step, index) => {
        const label = step.querySelector('[data-step-label]').value.trim() || 'Nova etapa';
        step.querySelector('[data-step-done]').setAttribute('aria-label', `Concluir etapa: ${label}`);
        step.querySelector('[data-step-due]')?.setAttribute('aria-label', `Prazo da etapa: ${label}`);
        step.querySelector('[data-step-remove]').setAttribute('aria-label', `Remover etapa: ${label}`);
        step.querySelector('[data-step-up]').setAttribute('aria-label', `Mover etapa para cima: ${label}`);
        step.querySelector('[data-step-down]').setAttribute('aria-label', `Mover etapa para baixo: ${label}`);
        step.querySelector('[data-step-up]').disabled = index === 0;
        step.querySelector('[data-step-down]').disabled = index === steps.length - 1;
      });
    });
  }
  function openEditor(id = null) {
    if (!canEdit() || (!id && !isOwner())) return;
    const row = id ? rows.find(item => item.id === id) : { title: '', client_name: '', company_name: '', client_email: '', access_url: '', responsible_name: '', responsible_email: '', due_date: '', status: 'planning', notes: '', production_lists: [{ id: makeId(), title: 'Lista de produção', steps: [] }] };
    if (!row) return;
    const ticket = capture();
    const dialog = newDialog(id ? isOwner() ? 'Editar projeto' : 'Atualizar andamento' : 'Novo projeto', `<form class="ceo-project-form" autocomplete="off">
      ${isOwner() ? `<section><h3>Cliente e projeto</h3><div class="ceo-project-form-grid"><label class="ceo-field ceo-project-wide">Nome do projeto<input name="title" required maxlength="180" value="${esc(row.title)}" placeholder="Dê um nome ao seu projeto"></label><label class="ceo-field">Nome do cliente<input name="client_name" required maxlength="180" value="${esc(row.client_name)}" placeholder="Nome do contato"></label><label class="ceo-field">Nome da empresa<input name="company_name" maxlength="180" value="${esc(row.company_name)}" placeholder="Empresa do cliente"></label></div></section>
      <section><h3>Acessos do cliente</h3><div class="ceo-project-form-grid"><label class="ceo-field">E-mail de acesso<input name="client_email" type="email" maxlength="254" value="${esc(row.client_email)}" placeholder="cliente@empresa.com" autocomplete="off"></label><label class="ceo-field">Página de acesso<input name="access_url" type="url" maxlength="2000" value="${esc(row.access_url)}" placeholder="https://" autocomplete="off"></label><label class="ceo-field ceo-project-wide">${row.has_password ? 'Nova senha (opcional)' : 'Senha do cliente'}<input name="password" type="password" data-private-value maxlength="2000" autocomplete="new-password" placeholder="${row.has_password ? 'Deixe vazio para manter a senha atual' : 'Informe a senha de acesso do cliente'}"></label>${row.has_password ? '<label class="ceo-project-remove-secret ceo-project-wide"><input type="checkbox" name="remove_password"> Remover a senha cadastrada</label>' : ''}</div><p>A senha não aparece nas listagens ou nos backups da central.</p></section>
      <section><h3>Responsável pela entrega</h3><div class="ceo-project-form-grid"><label class="ceo-field">Nome do responsável<input name="responsible_name" maxlength="180" value="${esc(row.responsible_name)}" placeholder="Quem cuidará do projeto?"></label><label class="ceo-field">E-mail do responsável<input name="responsible_email" type="email" maxlength="254" value="${esc(row.responsible_email)}" placeholder="responsavel@empresa.com"></label><label class="ceo-field">Prazo da entrega<input name="due_date" type="date" value="${esc(row.due_date)}"></label></div><p>Após salvar, abra o projeto para gerar o convite. O responsável usa sua própria conta. Todos da equipe acompanham os projetos e as ideias; a agenda permanece privada.</p></section>` : `<p class="ceo-project-edit-summary">${esc(row.title)} · ${esc(row.client_name)}</p>`}
      <label class="ceo-field">Situação do projeto<select name="status">${options(row.status)}</select></label>
      <section class="ceo-project-production"><h3>Listas de produção</h3><p>Crie suas listas e escreva as etapas na ordem que você precisa. Os nomes e as etapas ficam por sua conta.</p><div data-production-lists>${row.production_lists.map(listEditor).join('')}</div><p data-lists-empty ${row.production_lists.length ? 'hidden' : ''}>Nenhuma lista criada. Você pode adicionar uma agora ou depois.</p><button type="button" class="ceo-button" data-list-add>+ Adicionar lista</button></section>
      <label class="ceo-field">Notas e próximos passos<textarea name="notes" rows="4" maxlength="10000" placeholder="O que já foi feito, o que falta e o que depende do cliente.">${esc(row.notes)}</textarea></label>
      <p class="ceo-form-error" data-dialog-error role="alert" hidden></p><footer class="ceo-project-dialog-footer ceo-dialog-actions"><span>As alterações são salvas neste projeto.</span><div><button type="button" class="ceo-button" data-close>Cancelar</button><button type="submit" class="ceo-button primary">${id ? 'Salvar alterações' : 'Criar projeto'}</button></div></footer></form>`);
    const form = dialog.querySelector('form');
    if (isOwner() && planningAvailable) setupTemplates(form, ticket, dialog);
    syncListControls(form);
    form.querySelector('[name="remove_password"]')?.addEventListener('change', event => {
      const input = form.elements.password; input.value = ''; input.disabled = event.target.checked;
    });
    form.addEventListener('input', event => {
      if (event.target.matches('[data-step-label], [data-list-title]')) syncListControls(form);
    });
    form.addEventListener('click', event => {
      const listAdd = event.target.closest('[data-list-add]'), listRemove = event.target.closest('[data-list-remove]');
      const add = event.target.closest('[data-step-add]'), remove = event.target.closest('[data-step-remove]');
      const move = event.target.closest('[data-step-up], [data-step-down]');
      if (listAdd && form.querySelectorAll('[data-production-list]').length < 20) {
        const lists = form.querySelector('[data-production-lists]');
        lists.insertAdjacentHTML('beforeend', listEditor({ id: makeId(), title: '', steps: [] }));
        lists.lastElementChild.querySelector('[data-list-title]').focus();
      }
      if (listRemove) { listRemove.closest('[data-production-list]').remove(); form.querySelector('[data-list-add]').focus(); }
      if (remove) {
        const list = remove.closest('[data-production-list]');
        remove.closest('[data-step-id]').remove(); list.querySelector('[data-step-add]').focus();
      }
      if (add) {
        const track = add.closest('[data-production-list]').querySelector('[data-list-steps]');
        if (track.children.length >= 100) return;
        track.insertAdjacentHTML('beforeend', stepEditor({ id: makeId(), label: '', done: false }));
        track.lastElementChild.querySelector('[data-step-label]').focus();
      }
      if (move) {
        const step = move.closest('[data-step-id]'), track = step.parentElement;
        if (move.hasAttribute('data-step-up') && step.previousElementSibling) track.insertBefore(step, step.previousElementSibling);
        else if (move.hasAttribute('data-step-down') && step.nextElementSibling) track.insertBefore(step.nextElementSibling, step);
        step.querySelector('[data-step-label]').focus();
      }
      if (listAdd || listRemove || add || remove || move) syncListControls(form);
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!dialogCurrent(ticket, dialog) || !form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]'), output = form.querySelector('[data-dialog-error]');
      if (submit.disabled) return;
      const project = { status: form.elements.status.value, notes: form.elements.notes.value.trim() };
      if (id) { project.id = id; project.revision = row.revision; }
      project.production_lists = [...form.querySelectorAll('[data-production-list]')].map(list => ({
        id: list.dataset.listId, title: list.querySelector('[data-list-title]').value.trim(),
        steps: [...list.querySelector('[data-list-steps]').children].map(item => ({ id: item.dataset.stepId, label: item.querySelector('[data-step-label]').value.trim(), done: item.querySelector('[data-step-done]').checked, ...(planningAvailable ? { due_date: item.querySelector('[data-step-due]').value || null } : {}) }))
      }));
      if (project.production_lists.some(list => !list.title || list.steps.some(step => !step.label))) {
        output.textContent = 'Preencha o nome de cada lista e de cada etapa antes de salvar.'; output.hidden = false; return;
      }
      if (isOwner()) {
        ['title', 'client_name', 'company_name', 'client_email', 'access_url', 'responsible_name', 'responsible_email', 'due_date'].forEach(key => { project[key] = form.elements[key].value.trim(); });
        if (form.elements.remove_password?.checked) project.password = '';
        else if (form.elements.password.value) project.password = form.elements.password.value;
      }
      const oldLabel = submit.textContent; submit.disabled = true; submit.textContent = 'Salvando…'; output.hidden = true;
      try {
        const result = await rpc('zama_project_save', { p_owner: ticket.owner, p_project: project });
        delete project.password;
        if (!current(ticket)) return;
        const saved = metadata(result); rows = [saved, ...rows.filter(item => item.id !== saved.id)];
        notice = id ? 'Projeto atualizado.' : 'Projeto criado. Você já pode acompanhar as etapas e convidar o responsável.';
        paint();
        if (dialogCurrent(ticket, dialog)) { closeDialog(); openDetail(saved.id); }
      } catch (error) { if (dialogCurrent(ticket, dialog)) { output.textContent = friendly(error); output.hidden = false; } }
      finally {
        delete project.password;
        if (dialogCurrent(ticket, dialog)) { submit.disabled = false; submit.textContent = oldLabel; }
      }
    });
  }
  function setupTemplates(form, ticket, dialog) {
    const section = form.querySelector('.ceo-project-production');
    section.insertAdjacentHTML('afterbegin', `<details class="ceo-project-templates"><summary>Modelos de produção <span>Reaproveite suas listas</span></summary><p>Use um modelo para começar mais rápido. Clientes, senhas, datas e etapas concluídas não são copiados.</p><div class="ceo-project-template-row"><label class="ceo-field">Modelo de produção<select data-template-select disabled><option value="">Carregando modelos…</option></select></label><button type="button" class="ceo-button" data-template-apply disabled>Adicionar modelo</button><button type="button" class="ceo-button" data-template-delete disabled>Excluir modelo</button></div><div class="ceo-project-template-confirm" hidden data-template-confirm><span>Excluir este modelo? Os projetos já criados serão mantidos.</span><button type="button" class="ceo-button danger" data-template-confirm-delete>Confirmar exclusão</button><button type="button" class="ceo-button" data-template-cancel>Cancelar</button></div><div class="ceo-project-template-row"><label class="ceo-field">Nome do modelo<input data-template-name maxlength="180" placeholder="Ex.: Produção de vídeo"></label><button type="button" class="ceo-button" data-template-save disabled>Salvar como modelo</button></div><p data-template-message role="status"></p></details>`);
    const box = section.querySelector('[data-template-message]'), select = section.querySelector('[data-template-select]');
    select.setAttribute('aria-label', 'Modelo de produção');
    let models = [], busy = false, ready = false;
    const valid = () => dialogCurrent(ticket, dialog) && isOwner();
    function sync() {
      select.disabled = busy || !ready;
      section.querySelector('[data-template-apply]').disabled = busy || !select.value;
      section.querySelector('[data-template-delete]').disabled = busy || !select.value;
      section.querySelector('[data-template-save]').disabled = busy || !ready;
      section.querySelector('[data-template-confirm-delete]').disabled = busy;
    }
    async function refresh() {
      busy = true; sync();
      try {
        const result = await rpc('zama_project_templates_list', {});
        if (!valid()) return;
        if (!Array.isArray(result)) throw new Error('PROJECT_INVALID_RESPONSE');
        models = result; ready = true;
        select.innerHTML = `<option value="">${models.length ? 'Selecione um modelo' : 'Nenhum modelo salvo ainda'}</option>${models.map(model => `<option value="${esc(model.id)}">${esc(model.title)}</option>`).join('')}`;
      } catch (error) { if (valid()) box.textContent = friendly(error); }
      finally { if (valid()) { busy = false; sync(); } }
    }
    select.addEventListener('change', () => { section.querySelector('[data-template-confirm]').hidden = true; sync(); });
    section.querySelector('[data-template-apply]').addEventListener('click', () => {
      if (!valid() || busy) return;
      const model = models.find(item => item.id === select.value); if (!model) return;
      const lists = form.querySelector('[data-production-lists]');
      const blank = lists.children.length === 1 && !lists.querySelector('[data-step-id]') && lists.querySelector('[data-list-title]').value === 'Lista de produção';
      if (lists.children.length - Number(blank) + model.production_lists.length > 20) { box.textContent = 'Cada projeto pode ter até 20 listas.'; return; }
      if (blank) lists.replaceChildren();
      model.production_lists.forEach(list => lists.insertAdjacentHTML('beforeend', listEditor({ id: makeId(), title: list.title, steps: list.steps.map(step => ({ id: makeId(), label: step.label, done: false })) })));
      syncListControls(form); box.textContent = 'Modelo adicionado. Ajuste as etapas e defina os prazos antes de salvar o projeto.';
    });
    section.querySelector('[data-template-save]').addEventListener('click', async () => {
      if (!valid() || busy || !ready) return;
      const title = section.querySelector('[data-template-name]').value.trim();
      const lists = [...form.querySelectorAll('[data-production-list]')].map(list => ({ id: makeId(), title: list.querySelector('[data-list-title]').value.trim(), steps: [...list.querySelectorAll('[data-step-id]')].map(item => ({ id: makeId(), label: item.querySelector('[data-step-label]').value.trim(), done: false })) }));
      if (!title || !lists.length || lists.some(list => !list.title || list.steps.some(step => !step.label))) { box.textContent = 'Informe o nome do modelo e preencha os nomes das listas e etapas.'; return; }
      busy = true; sync();
      try {
        await rpc('zama_project_template_save', { p_template: { title, production_lists: lists } });
        if (!valid()) return;
        section.querySelector('[data-template-name]').value = ''; box.textContent = 'Modelo salvo. Ele estará disponível nos próximos projetos.';
        await refresh();
      } catch (error) { if (valid()) box.textContent = friendly(error); }
      finally { if (valid()) { busy = false; sync(); } }
    });
    section.querySelector('[data-template-delete]').addEventListener('click', () => { section.querySelector('[data-template-confirm]').hidden = false; });
    section.querySelector('[data-template-cancel]').addEventListener('click', () => { section.querySelector('[data-template-confirm]').hidden = true; });
    section.querySelector('[data-template-confirm-delete]').addEventListener('click', async () => {
      const model = models.find(item => item.id === select.value); if (!valid() || busy || !model) return;
      busy = true; sync();
      try {
        await rpc('zama_project_template_delete', { p_id: model.id, p_revision: model.revision });
        if (!valid()) return;
        section.querySelector('[data-template-confirm]').hidden = true; box.textContent = 'Modelo excluído. Os projetos foram mantidos.';
        await refresh();
      } catch (error) { if (valid()) box.textContent = friendly(error); }
      finally { if (valid()) { busy = false; sync(); } }
    });
    void refresh();
  }
  function openDelete(row) {
    if (!isOwner()) return;
    const ticket = capture();
    const dialog = newDialog('Excluir projeto?', `<p class="ceo-project-delete-message">O projeto <strong>${esc(row.title)}</strong>, suas etapas e os acessos cadastrados serão excluídos. Esta ação não pode ser desfeita.</p><p class="ceo-form-error" data-dialog-error role="alert" hidden></p><footer class="ceo-project-dialog-footer"><div><button type="button" class="ceo-button" data-close>Cancelar</button><button type="button" class="ceo-button danger" data-confirm-delete>Excluir projeto</button></div></footer>`);
    dialog.querySelector('[data-confirm-delete]').addEventListener('click', async event => {
      if (!dialogCurrent(ticket, dialog) || !isOwner()) return;
      const button = event.currentTarget, output = dialog.querySelector('[data-dialog-error]'); button.disabled = true; output.hidden = true;
      try {
        await rpc('zama_project_delete', { p_owner: ticket.owner, p_id: row.id });
        if (!current(ticket)) return;
        rows = rows.filter(item => item.id !== row.id); notice = 'Projeto excluído.'; paint();
        if (dialogCurrent(ticket, dialog)) closeDialog();
      } catch (error) { if (dialogCurrent(ticket, dialog)) { output.textContent = friendly(error); output.hidden = false; } }
      finally { if (dialogCurrent(ticket, dialog)) button.disabled = false; }
    });
  }
  function render(target) {
    if (activeOwner !== ownerId() || activeAccount !== accountId() || activeRole !== role()) reset();
    activeOwner = ownerId(); activeAccount = accountId(); activeRole = role(); container = target;
    paint();
    if (!loaded && !loading) void load();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearSecrets(); });
  root.addEventListener('pagehide', clearSecrets);
  root.addEventListener('blur', clearSecrets);
  root.addEventListener('focus', () => { if (container?.isConnected && !activeDialog && !loading && !document.hidden) void load(); });
  root.ZamaProjects = Object.freeze({ render, reset, leave });
})(window);
