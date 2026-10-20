/* Projects live in their own permission-checked database, never in the app backup. */
(function (root) {
  'use strict';
  const statuses = Object.freeze({ planning: 'Planejamento', in_progress: 'Em andamento', waiting: 'Aguardando cliente', completed: 'Concluído' });
  const processStatuses = Object.freeze({ planning: 'Não iniciado', in_progress: 'Em andamento', waiting: 'Aguardando', completed: 'Concluído' });
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
  const canEdit = () => isOwner() || collaborationAvailable || ['editor', 'projects'].includes(role());
  const canEditDetails = () => isOwner() || collaborationAvailable;
  const canReveal = row => isOwner() || ['editor','projects'].includes(role()) && row.responsible_email === workspace()?.email?.()?.toLowerCase();
  const today = () => {
    if (root.ZamaTime?.today) return root.ZamaTime.today();
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(item => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : 'Sem prazo';
  let container = null, activeDialog = null, rows = [], loaded = false, loading = false;
  let generation = 0, requestSequence = 0, activeOwner = null, activeAccount = null, activeRole = null;
  let errorMessage = '', notice = '', secretSequence = 0, secretTimer = null, planningAvailable = false;
  let collaborationAvailable = false, phoneAvailable = false, processesAvailable = false;
  const pendingChanges = new Map(), expandedLists = new Map(), expandedProjects = new Map();
  const filters = { search: '', status: '', priority: 'all', order: 'priority' };
  const summary = row => root.ZamaProjectPlanning.summarize(row, today());
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${({ all: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z', overdue: 'M12 3 2 21h20L12 3ZM12 9v5m0 3v.1', upcoming: 'M5 5h14v15H5zM8 3v4m8-4v4M5 10h14m-10 4h2m2 0h2', waiting: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v5l3 2' })[name]}"></path></svg>`;

  function productionLists(source) {
    const lists = Array.isArray(source.production_lists) ? source.production_lists : [
      { id: 'catalog', title: 'Catálogo', steps: source.catalog_steps },
      { id: 'onboarding', title: 'Estruturação', steps: source.onboarding_steps }
    ].filter(list => Array.isArray(list.steps) && list.steps.length);
    return lists.map(list => ({ id: text(list.id), title: text(list.title),
      ...Object.fromEntries(['description', 'responsible_name', 'due_date', 'status'].filter(key => Object.hasOwn(list, key)).map(key => [key, key === 'due_date' && list[key] === null ? null : text(list[key])])),
      ...(Array.isArray(list.links) ? { links: list.links.map(link => ({ label: text(link.label), url: text(link.url) })) } : {}),
      steps: Array.isArray(list.steps) ? list.steps.map(step => ({ id: text(step.id), label: text(step.label), done: step.done === true, ...(step.due_date ? { due_date: text(step.due_date) } : {}) })) : [] }));
  }

  // The allowlist makes it impossible for an accidental RPC password property to
  // enter the metadata cache, exports, the general app state, or local storage.
  function metadata(source) {
    if (!source || typeof source !== 'object' || !source.id) throw new Error('PROJECT_INVALID_RESPONSE');
    const record = {};
    ['id', 'title', 'client_name', 'company_name', 'client_email', 'client_phone', 'access_url', 'responsible_email', 'responsible_name', 'status', 'due_date', 'notes', 'created_at', 'updated_at'].forEach(key => { record[key] = text(source[key]); });
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
    if (/PROJECT_INVALID_PHONE|PROJECT_INVALID_FIELD: client_phone/.test(value)) return 'Confira o WhatsApp do cliente. Informe o DDD e o número; para outro país, use + e o código do país.';
    if (/PROJECT_INVALID_PROCESS_LINKS/.test(value)) return 'Confira os links de arquivos dos processos. Use até 20 links por processo, começando com https:// ou http://.';
    if (/PROJECT_INVALID_PROCESS/.test(value)) return 'Confira a descrição, o responsável e o andamento de cada processo antes de salvar.';
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
    container = null; expandedLists.clear(); expandedProjects.clear();
    // Module navigation must not discard checks that are waiting for an RPC.
    if (!pendingChanges.size) { rows = []; loaded = false; }
  }
  function reset() {
    const previous = container;
    leave(); pendingChanges.clear(); rows = []; loaded = false; activeOwner = activeAccount = activeRole = null;
    filters.search = filters.status = ''; filters.priority = 'all'; filters.order = 'priority'; planningAvailable = collaborationAvailable = phoneAvailable = processesAvailable = false; errorMessage = notice = '';
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
  function stepControl(row, list, step, detail = false) {
    return `<label class="${detail ? 'ceo-project-step' : 'ceo-project-quick-step'} ${step.done ? 'is-done' : ''}"><input type="checkbox" data-quick-step="${esc(step.id)}" data-project="${esc(row.id)}" data-list="${esc(list.id)}" ${step.done ? 'checked' : ''} ${!canEdit() ? 'disabled' : ''} aria-label="Concluir etapa: ${esc(step.label)}"><span class="ceo-project-step-copy">${esc(step.label)}${step.due_date ? `<small class="${!step.done && step.due_date < today() ? 'is-late' : ''}">${dateLabel(step.due_date)}</small>` : ''}</span></label>`;
  }
  function processInfo(list) {
    if (!processesAvailable && !['description', 'responsible_name', 'due_date', 'status', 'links'].some(key => Object.hasOwn(list, key))) return '';
    const status = processStatuses[list.status] ? list.status : 'planning';
    const links = (list.links || []).filter(link => safeUrl(link.url));
    return `<div class="ceo-project-process-summary"><span class="ceo-project-process-status is-${status}">${processStatuses[status]}</span><dl class="ceo-project-process-meta"><div><dt>Responsável</dt><dd>${esc(list.responsible_name || 'Não definido')}</dd></div><div><dt>Prazo do processo</dt><dd class="${status !== 'completed' && list.due_date && list.due_date < today() ? 'is-late' : ''}">${dateLabel(list.due_date)}</dd></div></dl>${list.description ? `<div class="ceo-project-process-description"><h4>Descrição e instruções</h4><p>${esc(list.description)}</p></div>` : ''}${links.length ? `<ul class="ceo-project-process-links" aria-label="Links de arquivos">${links.map(link => `<li><a href="${esc(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">${esc(link.label || link.url)} ↗</a></li>`).join('')}</ul>` : ''}</div>`;
  }
  function card(row) {
    const completion = summary(row), person = row.responsible_name || row.responsible_email;
    const expanded = expandedProjects.get(row.id) === true, panelId = `ceo-project-details-${row.id}`;
    return `<article class="ceo-project-card ${completion.overdue ? 'is-overdue' : ''}" data-project-id="${esc(row.id)}" data-project-status="${row.status}" aria-busy="${pendingChanges.has(row.id)}">
      <div class="ceo-project-card-meta"><span class="ceo-project-status is-${row.status}"><i></i>${statuses[row.status]}</span><span class="ceo-project-total">${completion.done}/${completion.total} etapas</span></div>
      <h3><button type="button" data-project-open="${esc(row.id)}" aria-label="Abrir projeto ${esc(row.title)}">${esc(row.title)}</button></h3><p class="ceo-project-company">${esc(row.company_name || row.client_name)}</p>
      ${meter('Progresso', row.production_lists.flatMap(list => list.steps))}
      <button type="button" class="ceo-project-toggle" data-project-toggle="${esc(row.id)}" aria-expanded="${expanded}" aria-controls="${esc(panelId)}" aria-label="${expanded ? 'Recolher' : 'Mostrar'} informações de ${esc(row.title)}"><span>${expanded ? 'Recolher informações' : 'Ver informações'}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></button>
      <div class="ceo-project-card-details" id="${esc(panelId)}" data-project-details="${esc(row.id)}" ${expanded ? '' : 'hidden'}>
      <section class="ceo-project-access-preview"><h4>Acessos do cliente</h4><dl><div><dt>E-mail de acesso</dt><dd>${esc(row.client_email || 'Não informado')}</dd></div><div><dt>Senha</dt><dd>${row.has_password ? 'Cadastrada' : 'Não cadastrada'}</dd></div></dl><button type="button" class="ceo-button" data-project-open="${esc(row.id)}" data-project-access>Ver dados de acesso</button></section>
      <div class="ceo-project-quick-lists">${row.production_lists.length ? row.production_lists.map((list,index) => {
        const key = `${row.id}:${list.id}`, open = expandedLists.has(key) ? expandedLists.get(key) : index === 0;
        return `<details class="ceo-project-quick-list" data-list-preview="${esc(key)}" ${open ? 'open' : ''}><summary><span>${esc(list.title)}</span><small>${list.steps.filter(step=>step.done).length}/${list.steps.length}</small></summary><div class="ceo-project-quick-steps">${processInfo(list)}${list.steps.length ? list.steps.map(step=>stepControl(row,list,step)).join('') : '<p class="ceo-project-no-stages">Nenhuma etapa ainda.</p>'}</div></details>`;
      }).join('') : '<p class="ceo-project-no-stages">Adicione uma lista para organizar as etapas.</p>'}</div>
      ${canEdit() ? `<button type="button" class="ceo-button ceo-project-add-steps" data-project-edit-inline="${esc(row.id)}">+ Editar listas e etapas</button>` : ''}
      <div class="ceo-project-card-footer"><span class="ceo-project-person"><span class="ceo-project-avatar" aria-hidden="true">${esc((person || '?').slice(0,1).toUpperCase())}</span><span>${esc(person || 'Sem responsável')}</span></span><span class="ceo-project-due ${completion.overdue ? 'is-late' : ''}">${completion.overdue ? 'Atrasado · ' : ''}${dateLabel(row.due_date)}</span></div>
      <label class="ceo-project-quick-status">Mover para<select data-quick-status="${esc(row.id)}" aria-label="Situação de ${esc(row.title)}" ${canEdit() ? '' : 'disabled'}>${options(row.status)}</select></label>
      ${whatsappLink(row)}</div>
      <p class="ceo-project-save-state" role="status">${pendingChanges.has(row.id) ? 'Salvando alterações…' : ''}</p>
    </article>`;
  }
  function rememberBoard() {
    container?.querySelectorAll('[data-list-preview]').forEach(node=>expandedLists.set(node.dataset.listPreview,node.open));
  }
  function renderBoard() {
    const board = container?.querySelector('[data-project-board]'); if (!board) return;
    rememberBoard();
    const query = fold(filters.search).trim();
    const visible = rows.filter(row => (!filters.status || row.status === filters.status) && (filters.priority === 'all' || filters.priority === 'waiting' && row.status === 'waiting' || summary(row)[filters.priority] === true) && (!query || fold(`${row.title} ${row.client_name} ${row.company_name} ${row.client_email} ${row.responsible_name} ${row.responsible_email}`).includes(query))).sort((a,b)=>root.ZamaProjectPlanning.compare(a,b,filters.order,today()));
    container.querySelectorAll('[data-priority]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.priority===filters.priority)));
    container.querySelector('[data-project-count]').textContent = `${visible.length} ${visible.length===1 ? 'projeto encontrado' : 'projetos encontrados'}`;
    const filtered = Boolean(filters.search || filters.status || filters.priority !== 'all');
    board.innerHTML = `${!visible.length && filtered ? '<div class="ceo-project-empty"><h3>Nenhum projeto com estes filtros</h3><button type="button" class="ceo-button" data-clear-project-filters>Limpar filtros</button></div>' : ''}${Object.entries(statuses).map(([status,label])=>{
      const items = visible.filter(row=>row.status===status);
      return `<section class="ceo-project-column" data-project-column="${status}" aria-label="${label}"><header class="ceo-project-column-heading"><h3>${label}</h3><span>${items.length}</span></header><div class="ceo-project-column-cards">${items.map(card).join('') || '<p class="ceo-project-column-empty">Nenhum projeto nesta coluna.</p>'}</div>${canEditDetails() ? `<button type="button" class="ceo-project-column-add" data-column-add="${status}" aria-label="Adicionar projeto em ${label}">+ Adicionar projeto</button>` : ''}</section>`;
    }).join('')}`;
  }
  function updateSummary() {
    const summaries = rows.map(summary);
    const values = {all:rows.length, overdue:summaries.filter(item=>item.overdue).length, upcoming:summaries.filter(item=>item.upcoming).length, waiting:rows.filter(row=>row.status==='waiting').length};
    container?.querySelectorAll('[data-priority]').forEach(button=>{button.querySelector('strong').textContent=values[button.dataset.priority];});
    const refresh = container?.querySelector('[data-project-refresh]'); if(refresh) refresh.disabled=loading || pendingChanges.size>0;
    const message = container?.querySelector('[data-project-feedback]'); if(message) {message.textContent=notice;message.hidden=!notice;}
  }
  function paint() {
    if (!container?.isConnected) return;
    rememberBoard();
    const priorities = [['all','Todos os projetos'],['overdue','Em atraso'],['upcoming','Próximos 7 dias'],['waiting','Aguardando cliente']];
    container.innerHTML = `<section class="ceo-projects"><div class="ceo-project-hero"><div class="ceo-project-heading"><div class="ceo-project-hero-copy"><span class="ceo-project-eyebrow">ZAMA / QUADRO DA EQUIPE</span><h2>Projetos de clientes</h2><p>Registre os processos internos de cada projeto. Use a seta para consultar as informações e acompanhar as etapas da equipe.</p></div></div><div class="ceo-project-heading-actions"><span class="ceo-project-shared-label">${icon('all')} Quadro compartilhado</span><button type="button" class="ceo-button" data-project-refresh ${loading || pendingChanges.size ? 'disabled' : ''}>${loading ? 'Atualizando…' : 'Atualizar'}</button>${isOwner() ? `<button type="button" class="ceo-button" data-project-team ${!loaded || loading || errorMessage ? 'disabled' : ''}>Criar acesso</button>` : ''}${canEditDetails() ? `<button type="button" class="ceo-button primary" data-project-new ${!loaded || loading || errorMessage ? 'disabled' : ''}>+ Novo projeto</button>` : ''}</div></div>
      <div class="ceo-project-priorities" aria-label="Prioridades dos projetos">${priorities.map(([key,label])=>`<button type="button" class="ceo-project-priority is-${key}" data-priority="${key}" aria-pressed="${filters.priority===key}" ${!loaded || loading ? 'disabled' : ''}><span class="ceo-project-priority-icon">${icon(key)}</span><strong>0</strong><span>${label}</span></button>`).join('')}</div>
      <p class="ceo-project-notice" data-project-feedback role="status" ${notice ? '' : 'hidden'}>${esc(notice)}</p>
      ${errorMessage ? `<div class="ceo-project-error" role="alert"><strong>Não foi possível carregar os projetos</strong><p>${esc(errorMessage)}</p><button class="ceo-button" type="button" data-project-retry>Tentar novamente</button></div>` : ''}
      ${loading && !loaded ? '<div class="ceo-project-empty" role="status"><h3>Carregando seus projetos…</h3></div>' : !errorMessage && loaded ? `<div class="ceo-project-board-heading"><h3>Produção da equipe</h3><p class="ceo-project-results" data-project-count aria-live="polite"></p></div><div class="ceo-project-filters"><label class="ceo-field ceo-project-search">Pesquisar projetos<input type="search" data-project-search value="${esc(filters.search)}" placeholder="Cliente, projeto ou responsável"></label><label class="ceo-field">Situação<select data-project-status><option value="">Todas as situações</option>${options(filters.status)}</select></label><label class="ceo-field">Ordenar por<select data-project-order><option value="priority" ${filters.order==='priority' ? 'selected' : ''}>Prioridade e prazo</option><option value="updated" ${filters.order==='updated' ? 'selected' : ''}>Atualizados recentemente</option><option value="name" ${filters.order==='name' ? 'selected' : ''}>Nome do projeto</option></select></label></div><div class="ceo-project-board" data-project-board></div>` : ''}
    </section>`;
    container.querySelector('[data-project-new]')?.addEventListener('click',()=>openEditor());
    container.querySelector('[data-project-team]')?.addEventListener('click',()=>openTeamAccess());
    container.querySelector('[data-project-refresh]')?.addEventListener('click',()=>void load());
    container.querySelector('[data-project-retry]')?.addEventListener('click',()=>void load());
    container.querySelector('[data-project-search]')?.addEventListener('input',event=>{filters.search=event.target.value;renderBoard();});
    container.querySelector('[data-project-status]')?.addEventListener('change',event=>{filters.status=event.target.value;renderBoard();});
    container.querySelector('[data-project-order]')?.addEventListener('change',event=>{filters.order=event.target.value;renderBoard();});
    container.querySelectorAll('[data-priority]').forEach(button=>button.addEventListener('click',()=>{filters.priority=button.dataset.priority;renderBoard();}));
    const board = container.querySelector('[data-project-board]');
    board?.addEventListener('click',event=>{
      const toggle = event.target.closest('[data-project-toggle]');
      if (toggle) {
        const row = rows.find(item => item.id === toggle.dataset.projectToggle);
        const panel = document.getElementById(toggle.getAttribute('aria-controls'));
        if (!row || !panel) return;
        const expanded = toggle.getAttribute('aria-expanded') !== 'true';
        expandedProjects.set(row.id, expanded);
        panel.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', `${expanded ? 'Recolher' : 'Mostrar'} informações de ${row.title}`);
        toggle.querySelector('span').textContent = expanded ? 'Recolher informações' : 'Ver informações';
        return;
      }
      const open=event.target.closest('[data-project-open]'), edit=event.target.closest('[data-project-edit-inline]'), add=event.target.closest('[data-column-add]');
      if(open) openDetail(open.dataset.projectOpen, open.hasAttribute('data-project-access'));
      if(edit) openEditor(edit.dataset.projectEditInline);
      if(add) openEditor(null,add.dataset.columnAdd);
      if(event.target.closest('[data-clear-project-filters]')) {filters.search=filters.status='';filters.priority='all';paint();}
    });
    board?.addEventListener('change',quickChange);
    renderBoard(); updateSummary();
  }
  function quickChange(event) {
    const input=event.target.closest('[data-quick-step]'), status=event.target.closest('[data-quick-status]');
    if(input) queueChange(input.dataset.project,{type:'step',list:input.dataset.list,step:input.dataset.quickStep,done:input.checked});
    if(status) queueChange(status.dataset.quickStatus,{type:'status',status:status.value});
  }
  function applyChange(row, change) {
    if(change.type==='status') row.status=change.status;
    else { const step=row.production_lists.find(list=>list.id===change.list)?.steps.find(step=>step.id===change.step); if(step) step.done=change.done; }
  }
  function refreshQuickUI() {
    const focused=document.activeElement, focusData=focused?.matches('[data-quick-step],[data-quick-status],[data-project-toggle]') ? {...focused.dataset} : null;
    const inDialog=Boolean(activeDialog?.contains(focused));
    const details=activeDialog?.querySelector('[data-detail-tracks]'), detailId=details?.dataset.detailTracks;
    const detailScroll=activeDialog?.scrollTop;
    renderBoard(); updateSummary();
    if(details) {
      const row=rows.find(item=>item.id===detailId);
      if(row) details.innerHTML=row.production_lists.map(list=>checklist(row,list)).join('');
      const edit=activeDialog.querySelector('[data-project-edit]'); if(edit) edit.disabled=pendingChanges.has(detailId);
      const message=activeDialog.querySelector('[data-quick-feedback]'); if(message) message.textContent=pendingChanges.has(detailId)?'Salvando alterações…':notice;
      activeDialog.scrollTop=detailScroll;
    }
    if(focusData) {
      const scope=inDialog?activeDialog:container;
      const control=[...(scope?.querySelectorAll('[data-quick-step],[data-quick-status],[data-project-toggle]')||[])].find(node=>focusData.projectToggle ? node.dataset.projectToggle===focusData.projectToggle : focusData.quickStatus ? node.dataset.quickStatus===focusData.quickStatus : node.dataset.project===focusData.project&&node.dataset.list===focusData.list&&node.dataset.quickStep===focusData.quickStep);
      control?.focus({preventScroll:true});
    }
  }
  function queueChange(id, change) {
    if(!canEdit() || loading) {refreshQuickUI();return;}
    const row=rows.find(item=>item.id===id); if(!row) return;
    let entry=pendingChanges.get(id);
    if(!entry) {entry={base:structuredClone(row),queue:[],running:false,ticket:capture()};pendingChanges.set(id,entry);}
    entry.queue.push(change); applyChange(row,change); notice=''; refreshQuickUI();
    if(!entry.running) void flushChanges(id,entry);
  }
  function writeCurrent(id,entry) {
    const ticket=entry.ticket;
    // A write belongs to its account/company, independently of the open module.
    // reset() removes the entry, so logout and context changes still cancel it.
    return pendingChanges.get(id)===entry && ticket.owner===activeOwner && ticket.owner===ownerId()
      && ticket.account===activeAccount && ticket.account===accountId() && ticket.role===activeRole && ticket.role===role();
  }
  function finishQuickUI() {
    if(!container?.isConnected && !pendingChanges.size) { rows=[]; loaded=false; }
    refreshQuickUI();
  }
  async function flushChanges(id,entry) {
    entry.running=true;
    try {
      while(entry.queue.length && writeCurrent(id,entry)) {
        const change=entry.queue[0], project={id,revision:entry.base.revision};
        let result;
        if(change.type==='step' && collaborationAvailable) result=await rpc('zama_project_step_set',{p_owner:entry.ticket.owner,p_id:id,p_list_id:change.list,p_step_id:change.step,p_done:change.done,p_revision:entry.base.revision});
        else {
          if(change.type==='status') project.status=change.status;
          else {const draft=structuredClone(entry.base);applyChange(draft,change);project.production_lists=draft.production_lists;}
          result=await rpc('zama_project_save',{p_owner:entry.ticket.owner,p_project:project});
        }
        if(!writeCurrent(id,entry)) return;
        entry.base=metadata(result);entry.queue.shift();
        const projected=structuredClone(entry.base);entry.queue.forEach(change=>applyChange(projected,change));
        rows=rows.map(row=>row.id===id?projected:row);
      }
      if(writeCurrent(id,entry)) {pendingChanges.delete(id);notice='Alterações salvas para a equipe.';finishQuickUI();}
    } catch(error) {
      if(!writeCurrent(id,entry)) return;
      rows=rows.map(row=>row.id===id?entry.base:row);pendingChanges.delete(id);
      notice=/40001|PROJECT_CONFLICT/.test(`${error.code} ${error.message}`)?'Não foi possível salvar: este projeto mudou em outra sessão. Clique em Atualizar e confira as etapas.':'Alterações não salvas. '+friendly(error);
      if(!container?.isConnected && typeof showToast==='function') showToast('Alterações de projetos não salvas','Volte ao quadro de Projetos e confira as etapas antes de tentar novamente.','error');
      finishQuickUI();
    }
  }

  async function load() {
    if (!container || loading || pendingChanges.size) return;
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
      let capability;
      try { capability = await rpc('zama_project_collaboration_capabilities', { p_owner: ticket.owner }); }
      catch (error) { if (!['PGRST202','42883'].includes(error?.code)) throw error; }
      if (!current(ticket) || sequence !== requestSequence) return;
      collaborationAvailable = capability?.can_edit === true && capability?.shared_creation === true;
      let phoneCapability;
      try { phoneCapability = await rpc('zama_project_phone_capabilities', { p_owner: ticket.owner }); }
      catch (error) { if (!['PGRST202','42883'].includes(error?.code)) throw error; }
      if (!current(ticket) || sequence !== requestSequence) return;
      phoneAvailable = phoneCapability?.client_phone === true;
      let processCapability;
      try { processCapability = await rpc('zama_project_process_capabilities', { p_owner: ticket.owner }); }
      catch (error) { if (!['PGRST202','42883'].includes(error?.code)) throw error; }
      if (!current(ticket) || sequence !== requestSequence) return;
      processesAvailable = processCapability?.process_details === true;
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
  function storedPhone(value) {
    const phone = text(value);
    return /^[1-9]\d{7,14}$/.test(phone) ? phone : '';
  }
  function normalizePhone(value) {
    const raw = text(value).trim();
    if (!raw) return '';
    const invalid = () => { throw new Error('Informe o WhatsApp com DDD, como (11) 99999-9999. Para outro país, use + e o código do país.'); };
    if (raw.length > 40 || !/^\+?[\d\s().-]+$/.test(raw)) invalid();
    let digits = raw.replace(/\D/g, '');
    if (!raw.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
    else if (!raw.startsWith('+')) {
      if (/^\d{10,11}$/.test(digits)) digits = `55${digits}`;
      else if (!/^55\d{10,11}$/.test(digits)) invalid();
    }
    if (!storedPhone(digits) || digits.startsWith('55') && !/^55[1-9]{2}[2-9]\d{7,8}$/.test(digits)) invalid();
    return digits;
  }
  function phoneLabel(value) {
    const phone = storedPhone(value);
    if (!phone) return '';
    const brazil = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
    return brazil ? `+55 (${brazil[1]}) ${brazil[2]}-${brazil[3]}` : `+${phone}`;
  }
  function whatsappLink(row) {
    const phone = storedPhone(row.client_phone);
    return phone ? `<a class="ceo-button ceo-project-whatsapp" href="https://wa.me/${phone}" target="_blank" rel="noopener noreferrer" aria-label="Abrir WhatsApp de ${esc(row.client_name || row.title)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.8-5.5a9 9 0 0 1-.8-4A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8.5 7.5c0 4 3 7 7 7l1-2-2-1-1 1-2-2 1-1-1-2h-3Z"/></svg><span>Abrir WhatsApp</span><span aria-hidden="true">↗</span></a>` : '';
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
      rosterBox.innerHTML = members.map(member => `<article class="ceo-project-team-entry" data-team-entry><div><strong>${esc(member.email)}</strong><span class="ceo-project-team-badge">Acesso ativo · ${member.role === 'viewer' ? 'Projetos · Ideias em leitura' : 'Equipe ZAMA'}</span>${assignmentList(normalize(member.email))}</div><div data-team-actions><button type="button" class="ceo-button danger" data-team-revoke="${esc(member.user_id)}">Remover acesso</button></div></article>`).join('')
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
      const member = roster.members.find(item => item.user_id === button.dataset.teamConfirm);
      const invite = roster.invites.find(item => item.id === button.dataset.teamCancel);
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
  function checklist(row, list) {
    return `<section class="ceo-project-detail-track"><h3>${esc(list.title)}</h3>${processInfo(list)}${meter('Etapas concluídas',list.steps)}<ul class="ceo-project-checklist">${list.steps.length ? list.steps.map(step=>`<li class="${step.done ? 'is-done' : ''}">${stepControl(row,list,step,true)}</li>`).join('') : '<li>Nenhuma etapa cadastrada.</li>'}</ul></section>`;
  }
  function openDetail(id, focusAccess = false) {
    const row = rows.find(item => item.id === id); if (!row) return;
    const ticket = capture(), url = safeUrl(row.access_url);
    const dialog = newDialog(row.title, `<div class="ceo-project-detail-meta"><span class="ceo-project-status is-${row.status}"><i></i>${statuses[row.status]}</span><span>Prazo: ${dateLabel(row.due_date)}</span></div>
      <dl class="ceo-project-info"><div><dt>Cliente</dt><dd>${esc(row.client_name || 'Não informado')}</dd></div><div><dt>Empresa</dt><dd>${esc(row.company_name || 'Não informada')}</dd></div><div><dt>Responsável</dt><dd>${esc(row.responsible_name || 'Não definido')}${row.responsible_email ? `<small>${esc(row.responsible_email)}</small>` : ''}</dd></div></dl>
      ${storedPhone(row.client_phone) ? `<section class="ceo-project-contact"><div><h3>Contato do cliente</h3><p>${esc(phoneLabel(row.client_phone))}</p></div>${whatsappLink(row)}</section>` : ''}
      <section class="ceo-project-credentials"><div><h3>Acessos do cliente</h3><p>Dados usados para trabalhar neste projeto.</p></div><dl class="ceo-project-info"><div><dt>E-mail de acesso</dt><dd>${esc(row.client_email || 'Não informado')}</dd></div><div><dt>Página de acesso</dt><dd>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Abrir página de acesso ↗</a>` : esc(row.access_url || 'Não informada')}</dd></div></dl>
      <div class="ceo-project-secret"><label class="ceo-field">Senha<input type="password" readonly data-private-value aria-label="Senha do cliente" placeholder="${row.has_password ? '••••••••••••' : 'Não cadastrada'}" autocomplete="off"></label>${row.has_password && canReveal(row) ? '<button class="ceo-button" type="button" data-reveal aria-pressed="false">Mostrar senha</button>' : ''}</div><p class="ceo-project-secret-note">A senha é reservada ao administrador e ao responsável atribuído, e é ocultada ao sair desta janela.</p></section>
      <div class="ceo-project-detail-tracks" data-detail-tracks="${esc(row.id)}">${row.production_lists.length ? row.production_lists.map(list => checklist(row, list)).join('') : '<p class="ceo-project-no-stages">Nenhuma lista de produção cadastrada.</p>'}</div>
      <section class="ceo-project-notes"><h3>Notas e próximos passos</h3><p>${esc(row.notes || 'Nenhuma observação por enquanto.')}</p></section>
      ${isOwner() && row.responsible_email ? `<section class="ceo-project-invite"><h3>Acesso do responsável</h3><p>Crie ou gerencie o acesso de <strong>${esc(row.responsible_email)}</strong> aos projetos desta empresa.</p><button type="button" class="ceo-button" data-project-invite>Gerenciar acesso do responsável</button></section>` : ''}
      <p class="ceo-form-error" data-dialog-error role="alert" hidden></p><footer class="ceo-project-dialog-footer">${isOwner() ? '<button type="button" class="ceo-button danger" data-project-delete>Excluir projeto</button>' : ''}<div><button type="button" class="ceo-button" data-close>Fechar</button>${canEdit() ? `<button type="button" class="ceo-button primary" data-project-edit ${pendingChanges.has(row.id) ? 'disabled' : ''}>${canEditDetails() ? 'Editar projeto' : 'Atualizar andamento'}</button>` : ''}</div></footer>`);
    dialog.querySelector('[data-detail-tracks]').insertAdjacentHTML('afterend','<p class="ceo-project-save-state" data-quick-feedback role="status"></p>');
    dialog.querySelector('[data-detail-tracks]').addEventListener('change',quickChange);
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
    if (focusAccess) {
      const access = dialog.querySelector('.ceo-project-credentials');
      access.tabIndex = -1;
      access.focus({ preventScroll: true });
      access.scrollIntoView({ block: 'center' });
    }
  }
  function stepEditor(step) {
    return `<div class="ceo-project-step-editor" data-step-id="${esc(step.id)}"><input type="checkbox" data-step-done ${step.done ? 'checked' : ''} aria-label="Concluir etapa: ${esc(step.label || 'Nova etapa')}"><input type="text" data-step-label value="${esc(step.label)}" required maxlength="254" aria-label="Nome da etapa" placeholder="O que precisa ser feito?">${planningAvailable ? `<label class="ceo-project-step-date">Prazo<input type="date" data-step-due value="${esc(step.due_date || '')}" aria-label="Prazo da etapa: ${esc(step.label || 'Nova etapa')}"></label>` : ''}<div class="ceo-project-step-actions"><button type="button" class="ceo-button" data-step-up aria-label="Mover etapa para cima: ${esc(step.label || 'Nova etapa')}">↑</button><button type="button" class="ceo-button" data-step-down aria-label="Mover etapa para baixo: ${esc(step.label || 'Nova etapa')}">↓</button><button type="button" class="ceo-button" data-step-remove aria-label="Remover etapa: ${esc(step.label || 'Nova etapa')}">×</button></div></div>`;
  }
  function processLinkEditor(link = {}) {
    return `<div class="ceo-project-process-link" data-process-link><label class="ceo-field">Nome do arquivo<input type="text" data-process-link-label maxlength="254" value="${esc(link.label || '')}" aria-label="Nome do arquivo" placeholder="Ex.: Briefing aprovado"></label><label class="ceo-field">Link do arquivo<input type="url" data-process-link-url required maxlength="2048" value="${esc(link.url || '')}" aria-label="Link do arquivo" placeholder="https://"></label><button type="button" class="ceo-button" data-process-link-remove>Remover link</button></div>`;
  }
  function processEditor(list) {
    if (!processesAvailable) return '';
    const status = processStatuses[list.status] ? list.status : 'planning';
    return `<details class="ceo-project-process-editor" open><summary>Informações do processo</summary><div class="ceo-project-process-fields"><label class="ceo-field ceo-project-wide">Descrição e instruções do processo<textarea data-process-description rows="3" maxlength="10000" aria-label="Descrição e instruções do processo" placeholder="Registre como executar este processo e as informações que a equipe precisa consultar.">${esc(list.description || '')}</textarea></label><label class="ceo-field">Responsável pelo processo<input type="text" data-process-responsible maxlength="254" value="${esc(list.responsible_name || '')}" aria-label="Responsável pelo processo" placeholder="Nome da pessoa ou equipe"></label><label class="ceo-field">Prazo do processo<input type="date" data-process-due min="0001-01-01" max="9999-12-31" value="${esc(list.due_date || '')}" aria-label="Prazo do processo"></label><label class="ceo-field">Andamento do processo<select data-process-status aria-label="Andamento do processo">${Object.entries(processStatuses).map(([value, label]) => `<option value="${value}" ${value === status ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="ceo-project-wide"><h4>Links de arquivos</h4><div data-process-links>${(list.links || []).map(processLinkEditor).join('')}</div><button type="button" class="ceo-button" data-process-link-add>+ Adicionar link</button></div></div></details>`;
  }
  function listEditor(list) {
    return `<fieldset class="ceo-project-track-editor" data-production-list data-list-id="${esc(list.id)}"><legend>Lista de produção</legend><div class="ceo-project-list-heading"><label class="ceo-field">Nome da lista<input type="text" data-list-title value="${esc(list.title)}" required maxlength="254" aria-label="Nome da lista" placeholder="Ex.: Design, Gravação, Entrega"></label><button type="button" class="ceo-button" data-list-remove aria-label="Excluir lista: ${esc(list.title || 'Nova lista')}">Excluir lista</button></div>${processEditor(list)}<p data-steps-empty ${list.steps.length ? 'hidden' : ''}>Comece adicionando uma etapa. Você define o que precisa ser feito.</p><div data-list-steps>${list.steps.map(stepEditor).join('')}</div><button type="button" class="ceo-button" data-step-add>+ Adicionar etapa</button></fieldset>`;
  }
  function syncListControls(form) {
    const lists = [...form.querySelectorAll('[data-production-list]')];
    form.querySelector('[data-lists-empty]').hidden = lists.length > 0;
    form.querySelector('[data-list-add]').disabled = lists.length >= 20;
    lists.forEach(list => {
      const title = list.querySelector('[data-list-title]').value.trim() || 'Nova lista';
      list.querySelector('[data-list-remove]').setAttribute('aria-label', `Excluir lista: ${title}`);
      const linkAdd = list.querySelector('[data-process-link-add]');
      if (linkAdd) linkAdd.disabled = list.querySelectorAll('[data-process-link]').length >= 20;
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
  function openEditor(id = null, initialStatus = 'planning') {
    if (!canEdit() || (!id && !canEditDetails())) return;
    if (pendingChanges.has(id)) { notice = 'Aguarde a conclusão do salvamento das etapas.'; updateSummary(); return; }
    const row = id ? rows.find(item => item.id === id) : { title: '', client_name: '', company_name: '', client_email: '', client_phone: '', access_url: '', responsible_name: '', responsible_email: '', due_date: '', status: statuses[initialStatus] ? initialStatus : 'planning', notes: '', production_lists: [{ id: makeId(), title: 'Lista de produção', steps: [] }] };
    if (!row) return;
    const ticket = capture();
    const dialog = newDialog(id ? canEditDetails() ? 'Editar projeto' : 'Atualizar andamento' : 'Novo projeto', `<form class="ceo-project-form" autocomplete="off">
      ${canEditDetails() ? `<section><h3>Cliente e projeto</h3><div class="ceo-project-form-grid"><label class="ceo-field ceo-project-wide">Nome do projeto<input name="title" required maxlength="180" value="${esc(row.title)}" placeholder="Dê um nome ao seu projeto"></label><label class="ceo-field">Nome do cliente<input name="client_name" required maxlength="180" value="${esc(row.client_name)}" placeholder="Nome do contato"></label><label class="ceo-field">Nome da empresa<input name="company_name" maxlength="180" value="${esc(row.company_name)}" placeholder="Empresa do cliente"></label><label class="ceo-field ceo-project-wide">WhatsApp do cliente<input name="client_phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" value="${esc(phoneLabel(row.client_phone))}" placeholder="(11) 99999-9999" aria-describedby="projectPhoneHelp" ${phoneAvailable ? '' : 'disabled'}></label></div><p id="projectPhoneHelp">${phoneAvailable ? 'Opcional. No Brasil, informe DDD e número. Para outro país, use + e o código do país.' : 'O cadastro de WhatsApp ainda não está disponível. Os demais campos podem ser salvos.'}</p></section>
      <section><h3>Acessos do cliente</h3><div class="ceo-project-form-grid"><label class="ceo-field">E-mail de acesso<input name="client_email" type="email" maxlength="254" value="${esc(row.client_email)}" placeholder="cliente@empresa.com" autocomplete="off"></label><label class="ceo-field">Página de acesso<input name="access_url" type="url" maxlength="2000" value="${esc(row.access_url)}" placeholder="https://" autocomplete="off"></label>${isOwner() ? `<label class="ceo-field ceo-project-wide">${row.has_password ? 'Nova senha (opcional)' : 'Senha do cliente'}<input name="password" type="password" data-private-value maxlength="2000" autocomplete="new-password" placeholder="${row.has_password ? 'Deixe vazio para manter a senha atual' : 'Informe a senha de acesso do cliente'}"></label>${row.has_password ? '<label class="ceo-project-remove-secret ceo-project-wide"><input type="checkbox" name="remove_password"> Remover a senha cadastrada</label>' : ''}` : '<p class="ceo-project-wide">As senhas do cliente são gerenciadas pelo administrador.</p>'}</div><p>A senha não aparece nas listagens ou nos backups da central.</p></section>
      <section><h3>Responsável pela entrega</h3><div class="ceo-project-form-grid"><label class="ceo-field">Nome do responsável<input name="responsible_name" maxlength="180" value="${esc(row.responsible_name)}" placeholder="Quem cuidará do projeto?"></label><label class="ceo-field">E-mail do responsável<input name="responsible_email" ${!isOwner() && row.has_password ? 'disabled title="O administrador altera o responsável quando o projeto possui uma senha cadastrada."' : ''} type="email" maxlength="254" value="${esc(row.responsible_email)}" placeholder="responsavel@empresa.com"></label><label class="ceo-field">Prazo da entrega<input name="due_date" type="date" value="${esc(row.due_date)}"></label></div><p>Todos da equipe podem criar e editar projetos. A agenda permanece privada. ${!isOwner() && row.has_password ? 'Neste projeto, o administrador altera o e-mail responsável porque há uma senha de cliente vinculada.' : ''}</p></section>` : `<p class="ceo-project-edit-summary">${esc(row.title)} · ${esc(row.client_name)}</p>`}
      <label class="ceo-field">Situação do projeto<select name="status">${options(row.status)}</select></label>
      <section class="ceo-project-production"><h3>Processos e etapas</h3><p>Cada lista organiza um processo interno. Registre suas instruções, responsável, prazo e arquivos; use as etapas para acompanhar a execução. O andamento do processo é definido separadamente das etapas.</p>${processesAvailable ? '' : '<p class="ceo-project-notice" data-process-unavailable>As fichas de processos ainda não estão disponíveis nesta instalação. As listas e etapas continuam disponíveis.</p>'}<div data-production-lists>${row.production_lists.map(listEditor).join('')}</div><p data-lists-empty ${row.production_lists.length ? 'hidden' : ''}>Nenhuma lista criada. Você pode adicionar uma agora ou depois.</p><button type="button" class="ceo-button" data-list-add>+ Adicionar lista</button></section>
      <label class="ceo-field">Notas e próximos passos<textarea name="notes" rows="4" maxlength="10000" placeholder="Registre decisões, contexto e próximos passos da equipe.">${esc(row.notes)}</textarea></label>
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
      const linkAdd = event.target.closest('[data-process-link-add]'), linkRemove = event.target.closest('[data-process-link-remove]');
      if (linkAdd) {
        const links = linkAdd.closest('[data-production-list]').querySelector('[data-process-links]');
        if (links.children.length >= 20) return;
        links.insertAdjacentHTML('beforeend', processLinkEditor());
        links.lastElementChild.querySelector('[data-process-link-label]').focus();
      }
      if (linkRemove) {
        const list = linkRemove.closest('[data-production-list]');
        linkRemove.closest('[data-process-link]').remove(); list.querySelector('[data-process-link-add]').focus();
      }
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
      if (listAdd || listRemove || add || remove || move || linkAdd || linkRemove) syncListControls(form);
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
        ...(processesAvailable ? {
          description: list.querySelector('[data-process-description]').value.trim(),
          responsible_name: list.querySelector('[data-process-responsible]').value.trim(),
          due_date: list.querySelector('[data-process-due]').value || null,
          status: list.querySelector('[data-process-status]').value,
          links: [...list.querySelectorAll('[data-process-link]')].map(link => ({ label: link.querySelector('[data-process-link-label]').value.trim(), url: link.querySelector('[data-process-link-url]').value.trim() }))
        } : {}),
        steps: [...list.querySelector('[data-list-steps]').children].map(item => ({ id: item.dataset.stepId, label: item.querySelector('[data-step-label]').value.trim(), done: item.querySelector('[data-step-done]').checked, ...(planningAvailable ? { due_date: item.querySelector('[data-step-due]').value || null } : {}) }))
      }));
      if (processesAvailable) {
        for (const list of form.querySelectorAll('[data-production-list]')) {
          const due = list.querySelector('[data-process-due]');
          if (due.value && !root.ZamaProjectPlanning.validDate(due.value)) {
            output.textContent = 'Informe uma data válida para o processo.'; output.hidden = false; due.focus(); return;
          }
          for (const input of list.querySelectorAll('[data-process-link-url]')) {
            if (!/^https?:\/\/[^\s]+$/i.test(input.value.trim()) || !safeUrl(input.value.trim())) {
              output.textContent = 'Use um link de arquivo válido, começando com https:// ou http://.';
              output.hidden = false; input.focus(); return;
            }
          }
        }
      }
      if (project.production_lists.some(list => !list.title || list.steps.some(step => !step.label))) {
        output.textContent = 'Preencha o nome de cada lista e de cada etapa antes de salvar.'; output.hidden = false; return;
      }
      if (canEditDetails()) {
        ['title', 'client_name', 'company_name', 'client_email', 'access_url', 'responsible_name', 'responsible_email', 'due_date'].forEach(key => { project[key] = form.elements[key].value.trim(); });
        if (phoneAvailable) {
          try { project.client_phone = normalizePhone(form.elements.client_phone.value); }
          catch (error) { output.textContent = error.message; output.hidden = false; form.elements.client_phone.focus(); return; }
        }
        if (form.elements.remove_password?.checked) project.password = '';
        else if (isOwner() && form.elements.password?.value) project.password = form.elements.password.value;
      }
      const oldLabel = submit.textContent; submit.disabled = true; submit.textContent = 'Salvando…'; output.hidden = true;
      try {
        const result = await rpc('zama_project_save', { p_owner: ticket.owner, p_project: project });
        delete project.password;
        if (!current(ticket)) return;
        const saved = metadata(result); rows = [saved, ...rows.filter(item => item.id !== saved.id)];
        notice = id ? 'Projeto atualizado.' : 'Projeto criado e compartilhado com a equipe.';
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
    section.insertAdjacentHTML('afterbegin', `<details class="ceo-project-templates"><summary>Modelos de produção <span>Reaproveite suas listas</span></summary><p>Use um modelo para começar mais rápido. Somente nomes de listas e etapas são copiados. Instruções, responsáveis, links, datas e andamento ficam no projeto original.</p><div class="ceo-project-template-row"><label class="ceo-field">Modelo de produção<select data-template-select disabled><option value="">Carregando modelos…</option></select></label><button type="button" class="ceo-button" data-template-apply disabled>Adicionar modelo</button><button type="button" class="ceo-button" data-template-delete disabled>Excluir modelo</button></div><div class="ceo-project-template-confirm" hidden data-template-confirm><span>Excluir este modelo? Os projetos já criados serão mantidos.</span><button type="button" class="ceo-button danger" data-template-confirm-delete>Confirmar exclusão</button><button type="button" class="ceo-button" data-template-cancel>Cancelar</button></div><div class="ceo-project-template-row"><label class="ceo-field">Nome do modelo<input data-template-name maxlength="180" placeholder="Ex.: Produção de vídeo"></label><button type="button" class="ceo-button" data-template-save disabled>Salvar como modelo</button></div><p data-template-message role="status"></p></details>`);
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
      const hasProcessDraft = [...lists.querySelectorAll('[data-process-description],[data-process-responsible],[data-process-due]')].some(input => input.value.trim()) || [...lists.querySelectorAll('[data-process-status]')].some(input => input.value !== 'planning') || lists.querySelector('[data-process-link]');
      const blank = lists.children.length === 1 && !lists.querySelector('[data-step-id]') && lists.querySelector('[data-list-title]').value === 'Lista de produção' && !hasProcessDraft;
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
