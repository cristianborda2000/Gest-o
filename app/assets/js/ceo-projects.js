/* Projects live in their own permission-checked database, never in the app backup. */
(function (root) {
  'use strict';
  const statuses = Object.freeze({ planning: 'Planejamento', in_progress: 'Em andamento', waiting: 'Aguardando cliente', completed: 'Concluído' });
  const catalogDefaults = ['Receber produtos, fotos e preços', 'Organizar categorias do catálogo', 'Montar e revisar o catálogo', 'Aprovar com o cliente', 'Publicar e entregar o catálogo'];
  const onboardingDefaults = ['Reunir dados e acessos do cliente', 'Definir estrutura e objetivos', 'Configurar a estrutura do cliente', 'Validar configurações e acessos', 'Orientar o cliente e concluir a entrega'];
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
  let errorMessage = '', notice = '', secretSequence = 0, secretTimer = null;
  const filters = { search: '', status: '' };

  // The allowlist makes it impossible for an accidental RPC password property to
  // enter the metadata cache, exports, the general app state, or local storage.
  function metadata(source) {
    if (!source || typeof source !== 'object' || !source.id) throw new Error('PROJECT_INVALID_RESPONSE');
    const record = {};
    ['id', 'title', 'client_name', 'company_name', 'client_email', 'access_url', 'responsible_email', 'responsible_name', 'status', 'due_date', 'notes', 'created_at', 'updated_at'].forEach(key => { record[key] = text(source[key]); });
    record.revision = Number(source.revision || 0);
    record.has_password = Boolean(source.has_password);
    ['catalog_steps', 'onboarding_steps'].forEach(key => {
      record[key] = Array.isArray(source[key]) ? source[key].map(step => ({ id: text(step.id), label: text(step.label), done: step.done === true })) : [];
    });
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
    filters.search = filters.status = ''; errorMessage = notice = '';
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
    const allSteps = [...row.catalog_steps, ...row.onboarding_steps], completion = progress(allSteps);
    const late = row.due_date && row.due_date < today() && row.status !== 'completed';
    const person = row.responsible_name || row.responsible_email;
    return `<article class="ceo-project-card" data-project-id="${esc(row.id)}">
      <div class="ceo-project-card-meta"><span class="ceo-project-status is-${row.status}"><i></i>${statuses[row.status]}</span><span class="ceo-project-total">${completion.percent}%</span></div>
      <h3>${esc(row.title)}</h3><p class="ceo-project-company">${esc(row.company_name || row.client_name)}</p>${row.company_name ? `<p class="ceo-project-client">${esc(row.client_name)}</p>` : ''}
      <div class="ceo-project-tracks">${meter('Catálogo', row.catalog_steps)}${meter('Estruturação', row.onboarding_steps, 'is-onboarding')}</div>
      <div class="ceo-project-card-footer"><span class="ceo-project-person"><span class="ceo-project-avatar" aria-hidden="true">${esc((person || '?').slice(0, 1).toUpperCase())}</span><span>${esc(person || 'Sem responsável')}</span></span><span class="ceo-project-due ${late ? 'is-late' : ''}">${late ? 'Atrasado · ' : ''}${dateLabel(row.due_date)}</span></div>
      <button class="ceo-button ceo-project-open" type="button" data-project-open="${esc(row.id)}" aria-label="Abrir projeto ${esc(row.title)}">Acompanhar projeto <span aria-hidden="true">↗</span></button>
    </article>`;
  }
  function renderBoard() {
    const board = container?.querySelector('[data-project-board]'); if (!board) return;
    const query = fold(filters.search).trim();
    const visible = rows.filter(row => (!filters.status || row.status === filters.status) && (!query || fold(`${row.title} ${row.client_name} ${row.company_name} ${row.client_email} ${row.responsible_name} ${row.responsible_email}`).includes(query)));
    container.querySelector('[data-project-count]').textContent = `${visible.length} ${visible.length === 1 ? 'projeto encontrado' : 'projetos encontrados'}`;
    if (!visible.length) {
      board.innerHTML = `<div class="ceo-project-empty"><span class="ceo-project-empty-icon" aria-hidden="true">▤</span><h3>${rows.length ? 'Nenhum projeto com estes filtros' : 'Cada cliente, uma entrega bem acompanhada'}</h3><p>${rows.length ? 'Tente outro nome ou situação para encontrar seu projeto.' : isOwner() ? 'Cadastre o cliente, defina o responsável e acompanhe cada etapa do catálogo e da estruturação.' : 'Os projetos atribuídos a você aparecerão aqui. O proprietário gerencia essas atribuições.'}</p>${!rows.length && isOwner() ? '<button type="button" class="ceo-button primary" data-project-new>+ Criar primeiro projeto</button>' : ''}</div>`;
      board.querySelector('[data-project-new]')?.addEventListener('click', () => openEditor());
    } else board.innerHTML = visible.map(card).join('');
  }
  function paint() {
    if (!container?.isConnected) return;
    const active = rows.filter(row => row.status !== 'completed').length;
    container.innerHTML = `<section class="ceo-projects"><div class="ceo-project-heading"><div><span class="ceo-project-eyebrow">DO PRIMEIRO ACESSO À ENTREGA</span><h2>Projetos de clientes</h2><p>Catálogos, estruturação e próximos passos em um só lugar.</p></div><div class="ceo-project-heading-actions"><button type="button" class="ceo-button" data-project-refresh ${loading ? 'disabled' : ''}>${loading ? 'Atualizando…' : 'Atualizar'}</button>${isOwner() ? `<button type="button" class="ceo-button" data-project-team>Acesso do time</button><button type="button" class="ceo-button primary" data-project-new ${!loaded || loading || errorMessage ? 'disabled' : ''}>+ Novo projeto</button>` : ''}</div></div>
      ${workspace()?.isProjectsOnly?.() ? '<p class="ceo-project-access-note">Seu espaço de trabalho: acompanhe os clientes atribuídos a você e atualize as etapas de cada entrega.</p>' : role() === 'viewer' ? '<p class="ceo-project-access-note">Você tem acesso de leitura. As atualizações ficam com o proprietário e os responsáveis.</p>' : ''}
      <div class="ceo-project-stats"><div><span>Projetos ativos</span><strong>${active}</strong><small>Do planejamento à entrega</small></div><div><span>Em andamento</span><strong>${rows.filter(row => row.status === 'in_progress').length}</strong><small>Produção em movimento</small></div><div><span>Aguardando cliente</span><strong>${rows.filter(row => row.status === 'waiting').length}</strong><small>Aprovações e materiais</small></div><div><span>Concluídos</span><strong>${rows.filter(row => row.status === 'completed').length}</strong><small>Entregas realizadas</small></div></div>
      ${notice ? `<p class="ceo-project-notice" role="status">${esc(notice)}</p>` : ''}
      ${errorMessage ? `<div class="ceo-project-error" role="alert"><strong>Não foi possível carregar os projetos</strong><p>${esc(errorMessage)}</p><button class="ceo-button" type="button" data-project-retry>Tentar novamente</button></div>` : ''}
      ${loading && !loaded ? '<div class="ceo-project-empty" role="status"><h3>Carregando seus projetos…</h3><p>Consultando os projetos disponíveis para sua conta.</p></div>' : !errorMessage && loaded ? `<div class="ceo-project-filters"><label class="ceo-field ceo-project-search">Pesquisar projetos<input type="search" data-project-search value="${esc(filters.search)}" placeholder="Cliente, empresa ou responsável"></label><label class="ceo-field">Situação<select data-project-status><option value="">Todas as situações</option>${options(filters.status)}</select></label></div><p class="ceo-project-results" data-project-count aria-live="polite"></p><div class="ceo-project-board" data-project-board></div>` : ''}
    </section>`;
    container.querySelector('[data-project-new]')?.addEventListener('click', () => openEditor());
    container.querySelector('[data-project-team]')?.addEventListener('click', () => { if (isOwner()) workspace()?.openTeam?.(); });
    container.querySelector('[data-project-refresh]')?.addEventListener('click', () => void load());
    container.querySelector('[data-project-retry]')?.addEventListener('click', () => void load());
    container.querySelector('[data-project-search]')?.addEventListener('input', event => { filters.search = event.target.value; renderBoard(); });
    container.querySelector('[data-project-status]')?.addEventListener('change', event => { filters.status = event.target.value; renderBoard(); });
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
      const result = await rpc('zama_projects_list', { p_owner: ticket.owner });
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
  function checklist(label, steps) {
    return `<section class="ceo-project-detail-track"><h3>${esc(label)}</h3>${meter('Etapas concluídas', steps)}<ul class="ceo-project-checklist">${steps.length ? steps.map(step => `<li class="${step.done ? 'is-done' : ''}"><span class="ceo-project-check" aria-hidden="true">${step.done ? '✓' : ''}</span><span>${esc(step.label)}${step.done ? '<span class="ceo-project-sr"> — Concluída</span>' : ''}</span></li>`).join('') : '<li class="ceo-muted">Nenhuma etapa cadastrada.</li>'}</ul></section>`;
  }
  function openDetail(id) {
    const row = rows.find(item => item.id === id); if (!row) return;
    const ticket = capture(), url = safeUrl(row.access_url);
    const dialog = newDialog(row.title, `<div class="ceo-project-detail-meta"><span class="ceo-project-status is-${row.status}"><i></i>${statuses[row.status]}</span><span>Prazo: ${dateLabel(row.due_date)}</span></div>
      <dl class="ceo-project-info"><div><dt>Cliente</dt><dd>${esc(row.client_name || 'Não informado')}</dd></div><div><dt>Empresa</dt><dd>${esc(row.company_name || 'Não informada')}</dd></div><div><dt>Responsável</dt><dd>${esc(row.responsible_name || 'Não definido')}${row.responsible_email ? `<small>${esc(row.responsible_email)}</small>` : ''}</dd></div></dl>
      <section class="ceo-project-credentials"><div><h3>Acessos do cliente</h3><p>Dados usados para trabalhar neste projeto.</p></div><dl class="ceo-project-info"><div><dt>E-mail de acesso</dt><dd>${esc(row.client_email || 'Não informado')}</dd></div><div><dt>Página de acesso</dt><dd>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Abrir página de acesso ↗</a>` : esc(row.access_url || 'Não informada')}</dd></div></dl>
      <div class="ceo-project-secret"><label class="ceo-field">Senha<input type="password" readonly data-private-value aria-label="Senha do cliente" placeholder="${row.has_password ? '••••••••••••' : 'Não cadastrada'}" autocomplete="off"></label>${row.has_password && canEdit() ? '<button class="ceo-button" type="button" data-reveal aria-pressed="false">Mostrar senha</button>' : ''}</div><p class="ceo-project-secret-note">${role() === 'viewer' ? 'A senha é reservada ao proprietário e aos responsáveis autorizados.' : 'A senha é consultada somente ao clicar e ocultada ao sair desta janela.'}</p></section>
      <div class="ceo-project-detail-tracks">${checklist('Criação do catálogo', row.catalog_steps)}${checklist('Estruturação do cliente', row.onboarding_steps)}</div>
      <section class="ceo-project-notes"><h3>Notas e próximos passos</h3><p>${esc(row.notes || 'Nenhuma observação por enquanto.')}</p></section>
      ${isOwner() && row.responsible_email ? `<section class="ceo-project-invite"><h3>Acesso do responsável</h3><p>Gere um convite para <strong>${esc(row.responsible_email)}</strong>. A pessoa usa sua própria conta e recebe acesso somente aos projetos atribuídos a ela.</p><button type="button" class="ceo-button" data-project-invite>Gerar convite para projetos</button><div data-invite-result hidden></div></section>` : ''}
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
    dialog.querySelector('[data-project-invite]')?.addEventListener('click', async event => {
      if (!dialogCurrent(ticket, dialog) || !isOwner()) return;
      const button = event.currentTarget, output = dialog.querySelector('[data-invite-result]'), errorBox = dialog.querySelector('[data-dialog-error]');
      button.disabled = true; errorBox.hidden = true;
      try {
        if (!workspace()?.inviteProjects) throw new Error('PROJECT_UNAVAILABLE');
        const link = await workspace().inviteProjects(row.responsible_email);
        if (!dialogCurrent(ticket, dialog)) return;
        output.hidden = false;
        output.innerHTML = `<label class="ceo-field">Link de acesso do responsável<input type="text" readonly aria-label="Link de acesso do responsável"></label><button type="button" class="ceo-button" data-copy-invite>Copiar link</button><p>Envie este link ao responsável. O convite só pode ser aceito pela conta com o e-mail indicado.</p>`;
        output.querySelector('input').value = text(link);
        output.querySelector('[data-copy-invite]').addEventListener('click', async event => {
          const copyButton = event.currentTarget;
          try { await root.navigator.clipboard.writeText(text(link)); if (dialogCurrent(ticket, dialog)) copyButton.textContent = 'Link copiado'; }
          catch { if (dialogCurrent(ticket, dialog)) { output.querySelector('input').select(); copyButton.textContent = 'Selecione e copie o link'; } }
        });
      } catch (error) { if (dialogCurrent(ticket, dialog)) { errorBox.textContent = friendly(error); errorBox.hidden = false; } }
      finally { if (dialogCurrent(ticket, dialog)) button.disabled = false; }
    });
  }
  function stepEditor(step, track) {
    return `<div class="ceo-project-step-editor" data-step-id="${esc(step.id)}"><input type="checkbox" data-step-done ${step.done ? 'checked' : ''} aria-label="Concluir etapa: ${esc(step.label || 'Nova etapa')}"><input type="text" data-step-label value="${esc(step.label)}" required maxlength="200" aria-label="Nome da etapa de ${track === 'catalog_steps' ? 'catálogo' : 'estruturação'}"><button type="button" class="ceo-button" data-step-remove aria-label="Remover etapa: ${esc(step.label || 'Nova etapa')}">×</button></div>`;
  }
  function trackEditor(label, track, steps) {
    return `<fieldset class="ceo-project-track-editor"><legend>${label}</legend><p>Marque as etapas concluídas e ajuste os próximos passos.</p><div data-track="${track}">${steps.map(step => stepEditor(step, track)).join('')}</div><button type="button" class="ceo-button" data-step-add="${track}">+ Adicionar etapa</button></fieldset>`;
  }
  function openEditor(id = null) {
    if (!canEdit() || (!id && !isOwner())) return;
    const row = id ? rows.find(item => item.id === id) : { title: '', client_name: '', company_name: '', client_email: '', access_url: '', responsible_name: '', responsible_email: '', due_date: '', status: 'planning', notes: '', catalog_steps: catalogDefaults.map(label => ({ id: makeId(), label, done: false })), onboarding_steps: onboardingDefaults.map(label => ({ id: makeId(), label, done: false })) };
    if (!row) return;
    const ticket = capture();
    const dialog = newDialog(id ? isOwner() ? 'Editar projeto' : 'Atualizar andamento' : 'Novo projeto', `<form class="ceo-project-form" autocomplete="off">
      ${isOwner() ? `<section><h3>Cliente e projeto</h3><div class="ceo-project-form-grid"><label class="ceo-field ceo-project-wide">Nome do projeto<input name="title" required maxlength="180" value="${esc(row.title)}" placeholder="Ex.: Catálogo e estruturação · Loja Aurora"></label><label class="ceo-field">Nome do cliente<input name="client_name" required maxlength="180" value="${esc(row.client_name)}" placeholder="Nome do contato"></label><label class="ceo-field">Nome da empresa<input name="company_name" maxlength="180" value="${esc(row.company_name)}" placeholder="Empresa do cliente"></label></div></section>
      <section><h3>Acessos do cliente</h3><div class="ceo-project-form-grid"><label class="ceo-field">E-mail de acesso<input name="client_email" type="email" maxlength="254" value="${esc(row.client_email)}" placeholder="cliente@empresa.com" autocomplete="off"></label><label class="ceo-field">Página de acesso<input name="access_url" type="url" maxlength="2000" value="${esc(row.access_url)}" placeholder="https://" autocomplete="off"></label><label class="ceo-field ceo-project-wide">${row.has_password ? 'Nova senha (opcional)' : 'Senha do cliente'}<input name="password" type="password" data-private-value maxlength="2000" autocomplete="new-password" placeholder="${row.has_password ? 'Deixe vazio para manter a senha atual' : 'Informe a senha de acesso do cliente'}"></label>${row.has_password ? '<label class="ceo-project-remove-secret ceo-project-wide"><input type="checkbox" name="remove_password"> Remover a senha cadastrada</label>' : ''}</div><p>A senha não aparece nas listagens ou nos backups da central.</p></section>
      <section><h3>Responsável pela entrega</h3><div class="ceo-project-form-grid"><label class="ceo-field">Nome do responsável<input name="responsible_name" maxlength="180" value="${esc(row.responsible_name)}" placeholder="Quem cuidará do projeto?"></label><label class="ceo-field">E-mail do responsável<input name="responsible_email" type="email" maxlength="254" value="${esc(row.responsible_email)}" placeholder="responsavel@empresa.com"></label><label class="ceo-field">Prazo da entrega<input name="due_date" type="date" value="${esc(row.due_date)}"></label></div><p>Após salvar, abra o projeto para gerar o convite. O responsável usa sua própria conta e acessa somente os projetos atribuídos a ele.</p></section>` : `<p class="ceo-project-edit-summary">${esc(row.title)} · ${esc(row.client_name)}</p>`}
      <label class="ceo-field">Situação do projeto<select name="status">${options(row.status)}</select></label>
      ${trackEditor('Criação do catálogo', 'catalog_steps', row.catalog_steps)}${trackEditor('Estruturação do cliente', 'onboarding_steps', row.onboarding_steps)}
      <label class="ceo-field">Notas e próximos passos<textarea name="notes" rows="4" maxlength="10000" placeholder="O que já foi feito, o que falta e o que depende do cliente.">${esc(row.notes)}</textarea></label>
      <p class="ceo-form-error" data-dialog-error role="alert" hidden></p><footer class="ceo-project-dialog-footer ceo-dialog-actions"><span>As alterações são salvas neste projeto.</span><div><button type="button" class="ceo-button" data-close>Cancelar</button><button type="submit" class="ceo-button primary">${id ? 'Salvar alterações' : 'Criar projeto'}</button></div></footer></form>`);
    const form = dialog.querySelector('form');
    form.querySelector('[name="remove_password"]')?.addEventListener('change', event => {
      const input = form.elements.password; input.value = ''; input.disabled = event.target.checked;
    });
    form.addEventListener('input', event => {
      if (!event.target.matches('[data-step-label]')) return;
      const step = event.target.closest('[data-step-id]'), label = event.target.value.trim() || 'Nova etapa';
      step.querySelector('[data-step-done]').setAttribute('aria-label', `Concluir etapa: ${label}`);
      step.querySelector('[data-step-remove]').setAttribute('aria-label', `Remover etapa: ${label}`);
    });
    form.addEventListener('click', event => {
      const add = event.target.closest('[data-step-add]'), remove = event.target.closest('[data-step-remove]');
      if (remove) remove.closest('[data-step-id]').remove();
      if (add) {
        const track = form.querySelector(`[data-track="${add.dataset.stepAdd}"]`);
        if (track.children.length >= 50) { const output = form.querySelector('[data-dialog-error]'); output.textContent = 'Use até 50 etapas em cada frente do projeto.'; output.hidden = false; return; }
        track.insertAdjacentHTML('beforeend', stepEditor({ id: makeId(), label: '', done: false }, add.dataset.stepAdd));
        track.lastElementChild.querySelector('[data-step-label]').focus();
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!dialogCurrent(ticket, dialog) || !form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]'), output = form.querySelector('[data-dialog-error]');
      if (submit.disabled) return;
      const project = { status: form.elements.status.value, notes: form.elements.notes.value.trim() };
      if (id) { project.id = id; project.revision = row.revision; }
      ['catalog_steps', 'onboarding_steps'].forEach(key => { project[key] = [...form.querySelector(`[data-track="${key}"]`).children].map(item => ({ id: item.dataset.stepId, label: item.querySelector('[data-step-label]').value.trim(), done: item.querySelector('[data-step-done]').checked })); });
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
  root.addEventListener('focus', () => { if (container?.isConnected && !activeDialog && !loading && !document.hidden) void load(); });
  root.ZamaProjects = Object.freeze({ render, reset, leave });
})(window);
