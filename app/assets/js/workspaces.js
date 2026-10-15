/* Shared company access. The database enforces membership and every permission. */
(function (global) {
  'use strict';
  let account = null, selected = null, spaces = [], available = false, generation = 0;
  let roster = { members: [], invites: [] }, inviteUrl = '', inviteId = null, notice = '', timer = null;
  let rosterSequence = 0;
  const labels = { owner: 'Administrador', editor: 'Equipe ZAMA', viewer: 'Equipe · leitura', projects: 'Equipe ZAMA' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tokenKey = 'zama-pending-invite';
  // Capture a fragment token before Auth handles its own fragments. Never send it as a URL query.
  const fragment = new URLSearchParams(global.location.hash.slice(1));
  if (/^[a-f0-9]{64}$/.test(fragment.get('invite') || '')) {
    try { sessionStorage.setItem(tokenKey, fragment.get('invite')); } catch {}
    fragment.delete('invite');
    global.history.replaceState(null, '', global.location.pathname + global.location.search + (fragment.size ? '#' + fragment : ''));
  }
  const active = () => spaces.find(item => item.owner_id === selected);
  const ownerId = fallback => selected || account?.id || fallback;
  const canEdit = () => !account || !selected || selected === account.id || active()?.role === 'editor';
  const isOwner = () => Boolean(account && (!selected || selected === account.id));
  const role = () => active()?.role || 'owner';
  const isTeamSpace = () => Boolean(account && selected && selected !== account.id);
  const isProjectsOnly = isTeamSpace; // Compatibility for restricted admin/backup guards.
  const hasPendingInvite = () => { try { return Boolean(sessionStorage.getItem(tokenKey)); } catch { return false; } };
  const capture = () => ({ generation, owner: selected });
  const current = ticket => ticket.generation === generation && ticket.owner === selected;
  function openTeam() {
    if (!isOwner()) return;
    openSettings();
    const section = document.getElementById('workspaceSection');
    section?.scrollIntoView({ block: 'start' });
    section?.querySelector('[data-invite-form] input[name="email"]')?.focus({ preventScroll: true });
  }
  function applyVisibility() {
    const restricted = isProjectsOnly();
    document.querySelectorAll('.nav [data-module]').forEach(el => {
      el.hidden = restricted ? !['agenda','projetos','ideias'].includes(el.dataset.module) : el.dataset.module === 'jarvis' && !jarvisVisible;
    });
    document.querySelectorAll('#companyForm, #exportBtn, #importBtn, #monthlyBackupBtn, #resetBtn, #projectBackupNote').forEach(el => { el.hidden = restricted; });
    const legacy = document.getElementById('legacyBackupBtn');
    if (restricted && legacy) legacy.hidden = true;
    const launcher = document.getElementById('jarvisLauncher');
    if (launcher) launcher.hidden = restricted || !jarvisVisible;
  }
  async function rpc(name, params = {}) {
    const { data, error } = await supabaseClient.rpc(name, params);
    if (error) throw new Error(error.message || 'Não foi possível atualizar o acesso. Tente novamente.');
    return data;
  }
  function reset() {
    generation++; account = selected = null; spaces = []; available = false; inviteUrl = notice = ''; inviteId = null;
    roster = { members: [], invites: [] };
    if (timer) clearInterval(timer); timer = null;
    const section = document.getElementById('workspaceSection'); if (section) section.replaceChildren();
    const badge = document.getElementById('workspaceBadge'); if (badge) badge.hidden = true;
    delete document.body.dataset.access;
    applyVisibility();
  }
  async function init(user) {
    const gen = ++generation;
    account = user; selected = user.id;
    spaces = [{ owner_id: user.id, role: 'owner', name: 'Minha empresa' }];
    if (appConfig.workspaceEnabled === false || !supabaseClient?.rpc) { render(); return; }
    try {
      const list = await rpc('zama_workspace_list');
      if (gen !== generation) return;
      spaces = list; available = true;
      let saved;
      try { saved = sessionStorage.getItem(`zama-workspace:${user.id}`); } catch {}
      const teamSpaces = spaces.filter(item => item.owner_id !== user.id);
      if (teamSpaces.length) selected = (teamSpaces.find(item => item.owner_id === saved) || teamSpaces[0]).owner_id;
      timer = global.setInterval(refreshAccess, 60000);
    } catch { if (gen === generation) notice = 'O compartilhamento de equipe ainda não está disponível nesta instalação.'; }
    if (gen === generation) render();
  }
  async function switchTo(id, { revoked = false, reload = false } = {}) {
    if (!spaces.some(item => item.owner_id === id) || (id === selected && !reload)) return;
    if (!revoked && cloudWritePending) { showToast('Aguarde o salvamento', 'Tente trocar de empresa em alguns instantes.', 'error'); return; }
    if (!revoked && (document.querySelector('dialog[open]') || formPanelOpen)) {
      const confirmed = await requestConfirmation({ title:'Trocar de empresa?', message:'Edições ainda não salvas serão descartadas.' });
      if (!confirmed) return;
    }
    const gen = generation, userId = account?.id;
    const { data } = await supabaseClient.auth.getSession();
    if (gen !== generation || data.session?.user?.id !== userId) return;
    if (typeof ZamaPushReminders !== 'undefined') await ZamaPushReminders.disconnect();
    if (gen !== generation) return;
    generation++;
    selected = id; inviteUrl = ''; inviteId = null; notice = '';
    try { sessionStorage.setItem(`zama-workspace:${userId}`, id); } catch {}
    await showApp(data.session, { force:true, keepWorkspace:true });
  }
  async function refreshAccess() {
    if (!account || !available || document.hidden) return;
    const gen = generation;
    try {
      const list = await rpc('zama_workspace_list');
      if (gen !== generation) return;
      const previousRole = role();
      const changed = JSON.stringify(spaces) !== JSON.stringify(list);
      spaces = list;
      if (!spaces.some(item => item.owner_id === selected)) {
        try { localStorage.removeItem(userStorageKey()); } catch {}
        await switchTo(account.id, { revoked:true });
        showToast('Acesso atualizado', 'Seu acesso à empresa compartilhada foi removido.');
      } else if (role() !== previousRole) {
        try { localStorage.removeItem(userStorageKey()); } catch {}
        const { data } = await supabaseClient.auth.getSession();
        if (gen !== generation || data.session?.user?.id !== account?.id) return;
        generation++;
        await showApp(data.session, { force:true, keepWorkspace:true });
      } else if (changed) render();
    } catch { /* Keep the current view on network failure; RLS still gates requests. */ }
  }
  async function updateRoster() {
    if (!available || !isOwner()) return;
    const ticket = capture(), sequence = ++rosterSequence;
    try {
      const data = await rpc('zama_workspace_roster');
      if (!current(ticket) || sequence !== rosterSequence) return;
      roster = data;
      if (inviteId && !roster.invites.some(invite => invite.id === inviteId)) { inviteUrl = ''; inviteId = null; }
      render(false);
    } catch { if (current(ticket) && sequence === rosterSequence) { notice = 'Não foi possível carregar a equipe. Tente novamente.'; render(false); } }
  }
  async function acceptInvite() {
    let token; try { token = sessionStorage.getItem(tokenKey); } catch {}
    if (!token || !account || !available) return;
    const gen = generation;
    try {
      const id = await rpc('zama_workspace_accept', { p_token:token });
      if (gen !== generation) return;
      sessionStorage.removeItem(tokenKey);
      const list = await rpc('zama_workspace_list');
      if (gen !== generation) return;
      spaces = list;
      await switchTo(id, { revoked:true, reload:true });
      showToast('Convite aceito', 'Você já pode acessar a empresa compartilhada.');
    } catch (error) { if (gen === generation) { notice = error.message; render(false); } }
  }
  async function inviteProjects(email) {
    if (!isOwner()) throw new Error('Somente o proprietário pode convidar responsáveis.');
    const gen = generation, id = selected;
    const result = await rpc('zama_workspace_invite', { p_email:email.trim().toLowerCase(), p_role:'projects' });
    if (gen !== generation || id !== selected) throw new Error('A sessão mudou. Abra o projeto novamente.');
    const url = new URL(global.location.pathname, global.location.origin);
    url.hash = `invite=${result.token}`;
    await updateRoster();
    if (gen !== generation || id !== selected) throw new Error('A sessão mudou. Abra o projeto novamente.');
    return url.href;
  }
  function render(loadRoster = true) {
    const section = document.getElementById('workspaceSection');
    if (!section || !account) return;
    const role = active()?.role || 'owner';
    const previousForm = section.querySelector('[data-invite-form]');
    const formDraft = previousForm ? { email:previousForm.elements.email.value, role:previousForm.elements.role.value } : null;
    const focused = previousForm?.contains(document.activeElement) ? document.activeElement : null;
    const focusDraft = focused?.name ? { name:focused.name, start:focused.selectionStart, end:focused.selectionEnd } : null;
    document.body.dataset.access = role;
    applyVisibility();
    const badge = document.getElementById('workspaceBadge');
    if (badge) { badge.hidden = false; badge.textContent = `${active()?.name || 'Minha empresa'} · ${labels[role]}`; }
    const readonly = isTeamSpace();
    document.querySelectorAll('#companyForm input, #companyForm button, #importBtn, #loadExamplesBtn').forEach(el => { el.disabled = readonly; });
    const resetButton = document.getElementById('resetBtn'); if (resetButton) resetButton.disabled = !isOwner();
    let pending = false; try { pending = Boolean(sessionStorage.getItem(tokenKey)); } catch {}
    section.innerHTML = `<span class="settings-label">Empresa e equipe</span>
      <label class="workspace-field">Empresa em uso<select data-company aria-label="Empresa em uso">${spaces.filter(item => !isTeamSpace() || item.owner_id !== account.id).map(item => `<option value="${esc(item.owner_id)}" ${item.owner_id === selected ? 'selected' : ''}>${esc(item.name)} · ${labels[item.role]}</option>`).join('')}</select></label>
      <p class="settings-note">${role === 'owner' ? 'Você gerencia os dados e os acessos desta empresa.' : 'Projetos e ideias são compartilhados com a equipe. Sua agenda é pessoal e só aparece para você.'}</p>
      ${pending ? `<div class="workspace-invite"><strong>Você recebeu um convite</strong><p>Entre com o e-mail destinatário e confirme para acessar a empresa.</p><button type="button" class="button primary" data-accept ${available ? '' : 'disabled'}>Aceitar convite</button><button type="button" class="button" data-dismiss>Descartar convite</button></div>` : ''}
      ${!available ? `<p class="settings-note">${esc(notice || 'O compartilhamento de equipe ainda não está disponível nesta instalação.')}</p>` : isOwner() ? `<form data-invite-form class="workspace-invite">
        <label class="workspace-field">E-mail do convidado<input name="email" type="email" required maxlength="254" placeholder="pessoa@empresa.com" autocomplete="off"></label>
        <label class="workspace-field">Permissão<select name="role"><option value="projects">Equipe ZAMA</option><option value="viewer">Somente leitura</option><option value="editor">Pode editar</option></select></label>
        <p class="settings-note">O convite vale por 7 dias e só pode ser aceito pela conta com este e-mail confirmado.</p>
        <button class="button primary" type="submit">Gerar link de convite</button></form>
        ${inviteUrl ? `<label class="workspace-field">Link para compartilhar<input value="${esc(inviteUrl)}" readonly aria-label="Link do convite"></label><button class="button" type="button" data-copy>Copiar link</button>` : ''}
        <div class="workspace-roster"><strong>Pessoas com acesso</strong>${roster.members.length ? roster.members.map(member => `<div class="workspace-person"><span>${esc(member.email)}</span><select aria-label="Permissão de ${esc(member.email)}" data-role="${esc(member.user_id)}"><option value="projects" ${member.role === 'projects' ? 'selected' : ''}>Equipe ZAMA</option><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Somente leitura</option><option value="editor" ${member.role === 'editor' ? 'selected' : ''}>Pode editar</option></select><button type="button" class="button" data-revoke="${esc(member.user_id)}">Remover</button></div>`).join('') : '<p class="settings-note">Somente você tem acesso no momento.</p>'}
        ${roster.invites.length ? '<strong>Convites pendentes</strong>' + roster.invites.map(invite => `<div class="workspace-person"><span>${esc(invite.email)} · ${labels[invite.role]}</span><button type="button" class="button" data-cancel="${esc(invite.id)}">Revogar convite</button></div>`).join('') : ''}</div>` : '<p class="settings-note">Os acessos são gerenciados pelo proprietário desta empresa.</p>'}
      ${available && notice ? `<p role="status" class="settings-note">${esc(notice)}</p>` : ''}`;
    section.querySelector('[data-company]').onchange = event => { void switchTo(event.target.value); };
    const inviteForm = section.querySelector('[data-invite-form]');
    if (formDraft && inviteForm) { inviteForm.elements.email.value = formDraft.email; inviteForm.elements.role.value = formDraft.role; }
    if (focusDraft && inviteForm) {
      const control = inviteForm.elements[focusDraft.name];
      control?.focus({ preventScroll: true });
      if (typeof focusDraft.start === 'number') control.setSelectionRange?.(focusDraft.start, focusDraft.end);
    }
    section.querySelector('[data-accept]')?.addEventListener('click', acceptInvite);
    section.querySelector('[data-dismiss]')?.addEventListener('click', () => { sessionStorage.removeItem(tokenKey); notice = ''; render(false); });
    section.querySelector('[data-invite-form]')?.addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button');
      const ticket = capture(); button.disabled = true;
      try {
        const result = await rpc('zama_workspace_invite', { p_email:form.elements.email.value.trim(), p_role:form.elements.role.value });
        if (!current(ticket)) return;
        const url = new URL(global.location.pathname, global.location.origin); url.hash = `invite=${result.token}`;
        inviteUrl = url.href; inviteId = result.id; notice = 'Convite gerado. Copie o link e compartilhe com o destinatário.';
        await updateRoster();
      } catch (error) { if (current(ticket)) { notice = error.message; render(false); } }
    });
    section.querySelector('[data-copy]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(inviteUrl); showToast('Link copiado'); }
      catch { section.querySelector('[aria-label="Link do convite"]')?.select(); }
    });
    section.querySelectorAll('[data-role]').forEach(el => el.onchange = async () => {
      const ticket = capture(); el.disabled = true;
      try {
        await rpc('zama_workspace_set_role', { p_user:el.dataset.role, p_role:el.value });
        if (!current(ticket)) return;
        notice = 'Permissão atualizada. Convites pendentes desta pessoa foram cancelados.';
        await updateRoster();
      } catch (error) { if (current(ticket)) { notice = error.message; render(false); } }
    });
    section.querySelectorAll('[data-revoke], [data-cancel]').forEach(el => el.onclick = async () => {
      const ticket = capture();
      if (!await requestConfirmation({ title:el.dataset.revoke ? 'Remover acesso?' : 'Revogar convite?', message:'A pessoa precisará de um novo convite para acessar esta empresa.' })) return;
      if (!current(ticket)) return;
      el.disabled = true;
      try {
        await rpc(el.dataset.revoke ? 'zama_workspace_revoke' : 'zama_workspace_cancel_invite', el.dataset.revoke ? { p_user:el.dataset.revoke } : { p_id:el.dataset.cancel });
        if (!current(ticket)) return;
        notice = el.dataset.revoke ? 'Acesso removido. Convites pendentes desta pessoa foram cancelados.' : 'Convite revogado.';
        await updateRoster();
      } catch (error) { if (current(ticket)) { notice = error.message; render(false); } }
    });
    if (loadRoster && available && isOwner()) void updateRoster();
  }
  global.addEventListener('focus', refreshAccess);
  global.ZamaWorkspace = { init, reset, render, ownerId, canEdit, isOwner, role, isProjectsOnly, isTeamSpace, email: () => account?.email, hasPendingInvite, inviteProjects, refreshAccess, openTeam };
})(window);
