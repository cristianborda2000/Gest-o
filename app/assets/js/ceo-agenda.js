/* Agenda da central ZAMA. Mantém os registros legados e armazena apenas as
   exceções das recorrências; não materializa centenas de cópias no banco. */
(function (global) {
  "use strict";
  const recurrenceLabels = { none: "Não repetir", daily: "Todos os dias", weekdays: "Dias úteis", weekly: "Toda semana", monthly: "Todo mês" };
  const defaults = { enabled: false, dailyEnabled: true, dailyTime: "08:00", taskEnabled: true, leadMinutes: 15 };
  const dayMs = 86400000;
  let selectedDay = "", visibleMonth = "", timer = null, checking = false, currentContainer = null;
  let activeDialog = null, reminderGeneration = 0;
  const text = value => String(value == null ? "" : value);
  const esc = value => text(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const fold = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const isDone = row => fold(row.status).startsWith("conclu");
  const isCancelled = row => fold(row.status).startsWith("cancel");
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(text(value));
  function parts(epoch = Date.now()) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
  }
  const timeUtils = () => typeof ZamaTime !== "undefined" ? ZamaTime : global.ZamaTime;
  const today = () => timeUtils() ? timeUtils().today() : parts().date;
  function addDays(date, amount) { return new Date(Date.parse(`${date}T12:00:00Z`) + amount * dayMs).toISOString().slice(0, 10); }
  function toEpoch(date, time = "00:00") {
    if (!validDate(date) || !validTime(time)) return NaN;
    if (timeUtils()) return timeUtils().toEpoch(date, time);
    // Resolve the IANA zone rather than the device timezone (including historic DST).
    const target = Date.parse(`${date}T${time}:00Z`);
    let result = target;
    for (let i = 0; i < 3; i++) {
      const observed = parts(result);
      result += target - Date.parse(`${observed.date}T${observed.time}:00Z`);
    }
    return result;
  }
  function formatDay(date, full = false) {
    if (!validDate(date)) return "Data não informada";
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...(full ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { day: "2-digit", month: "2-digit", year: "numeric" }) }).format(new Date(`${date}T12:00:00Z`));
  }
  function settings(targetState) { return { ...defaults, ...(targetState.agendaSettings || {}) }; }
  function normalize(targetState) {
    if (!Array.isArray(targetState.agenda)) targetState.agenda = [];
    targetState.agendaSettings = settings(targetState);
    targetState.agenda.forEach((row, index) => {
      row.id = row.id || `agenda-legado-${index}`;
      row.nome = row.nome || row.titulo || "Tarefa sem título";
      row.prazo = text(row.prazo || row.data || row.date).slice(0, 10);
      row.hora = row.hora || "";
      row.status = row.status || "Pendente";
      row.prioridade = row.prioridade || (Number(row.valor) >= 4 ? "Alta" : Number(row.valor) >= 2 ? "Média" : "Baixa");
      row.duracao = Number.isFinite(Number(row.duracao)) && Number(row.duracao) >= 0 ? Number(row.duracao) : 30;
      row.recorrencia = recurrenceLabels[row.recorrencia] ? row.recorrencia : "none";
      if (!row.exceptions || typeof row.exceptions !== "object" || Array.isArray(row.exceptions)) row.exceptions = {};
      if (!(row.reminderMinutes === -1 || (Number.isFinite(row.reminderMinutes) && row.reminderMinutes >= 0))) row.reminderMinutes = null;
    });
    return targetState;
  }
  function occursOn(row, date) {
    const start = row.prazo;
    if (!validDate(start) || !validDate(date) || date < start || (validDate(row.recurrenceEnd) && date > row.recurrenceEnd)) return false;
    const delta = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / dayMs);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    switch (row.recorrencia) {
      case "daily": return true;
      case "weekdays": return weekday > 0 && weekday < 6;
      case "weekly": return delta % 7 === 0;
      case "monthly": {
        const last = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
        return Number(date.slice(8, 10)) === Math.min(Number(start.slice(8, 10)), last);
      }
      default: return date === start;
    }
  }
  function occurrence(row, originalDay) {
    const patch = row.exceptions?.[originalDay] || {};
    if (patch.deleted) return null;
    return { ...row, prazo: originalDay, ...patch, seriesId: row.id, occurrenceDate: originalDay, occurrenceKey: `${row.id}:${originalDay}` };
  }
  function todayTasks(targetState, date = today()) {
    const result = [];
    (targetState.agenda || []).forEach(row => {
      if (occursOn(row, date)) {
        const task = occurrence(row, date);
        if (task && task.prazo === date) result.push(task);
      }
      Object.keys(row.exceptions || {}).forEach(originalDay => {
        const patch = row.exceptions[originalDay];
        if (originalDay !== date && patch.prazo === date && occursOn(row, originalDay)) {
          const task = occurrence(row, originalDay);
          if (task) result.push(task);
        }
      });
    });
    return result.sort((a, b) => (a.hora || "99:99").localeCompare(b.hora || "99:99") || text(a.nome).localeCompare(text(b.nome), "pt-BR"));
  }
  function taskStatus(row, now = Date.now()) {
    if (isDone(row)) return "Concluída";
    if (isCancelled(row)) return "Cancelada";
    const deadline = toEpoch(row.prazo, row.hora || "23:59") + (row.hora ? Number(row.duracao || 0) * 60000 : 60000);
    return deadline <= now ? "Atrasada" : row.status === "Adiado" ? "Adiada" : "Pendente";
  }
  function reminderFor(row, preferences) {
    if (!preferences.taskEnabled || isDone(row) || isCancelled(row) || !validTime(row.hora) || row.reminderMinutes === -1) return null;
    const lead = row.reminderMinutes == null ? Number(preferences.leadMinutes) : Number(row.reminderMinutes);
    const dueAt = toEpoch(row.prazo, row.hora) - lead * 60000;
    if (!Number.isFinite(dueAt)) return null;
    return { key: `task:${row.occurrenceKey}:${row.prazo}:${row.hora}:${lead}`, dueAt, at: dueAt, title: row.nome, body: `${row.hora} · ${formatDay(row.prazo)}${row.observacoes ? `\n${row.observacoes}` : ""}`, task: row, kind: "task" };
  }
  function remindersBetween(targetState, from, until) {
    const preferences = settings(targetState);
    if (!preferences.enabled) return [];
    const result = [], first = parts(from).date, last = addDays(parts(until).date, Math.ceil(Math.max(Number(preferences.leadMinutes || 0), ...((targetState.agenda || []).map(row => Number(row.reminderMinutes || 0)))) / 1440) + 1);
    for (let date = first, i = 0; date <= last && i < 400; date = addDays(date, 1), i++) {
      const tasks = todayTasks(targetState, date);
      tasks.forEach(task => {
        const reminder = reminderFor(task, preferences);
        if (reminder && reminder.dueAt >= from && reminder.dueAt <= until) result.push(reminder);
      });
      if (preferences.dailyEnabled && validTime(preferences.dailyTime)) {
        const dueAt = toEpoch(date, preferences.dailyTime);
        const pending = tasks.filter(task => !isDone(task) && !isCancelled(task));
        if (dueAt >= from && dueAt <= until && pending.length) result.push({ key: `daily:${date}:${preferences.dailyTime}`, dueAt, at: dueAt, title: "Sua agenda de hoje", body: `${pending.length} tarefa(s) pendente(s). ${pending.slice(0, 3).map(task => `${task.hora || "Sem horário"} ${task.nome}`).join(" · ")}`, kind: "daily" });
      }
    }
    return result.sort((a, b) => a.dueAt - b.dueAt);
  }
  function nextReminder(targetState, now = Date.now()) { return remindersBetween(targetState, now, now + 32 * dayMs)[0] || null; }
  function claimReminder(ledger, key, now) {
    Object.keys(ledger).forEach(item => { if (now - ledger[item] > 35 * dayMs) delete ledger[item]; });
    if (ledger[key]) return false;
    ledger[key] = now;
    return true;
  }
  async function checkReminders() {
    if (checking || typeof state === "undefined" || !state || !global.Notification || global.Notification.permission !== "granted" || !settings(state).enabled) return;
    checking = true;
    const generation = reminderGeneration;
    try {
      const user = typeof getCurrentUser === "function" ? await getCurrentUser() : null;
      if (generation !== reminderGeneration || !state) return;
      const storageName = `zama-reminders-v1:${user?.id || "local"}`;
      const deliver = async () => {
        if (generation !== reminderGeneration || !state || !settings(state).enabled) return;
        let ledger;
        try { ledger = JSON.parse(global.localStorage.getItem(storageName) || "{}"); } catch (_) { return; }
        const now = Date.now();
        // Catch up only the last minute; never flood users with reminders missed while closed.
        for (const reminder of remindersBetween(state, now - 60000, now)) {
          if (ledger[reminder.key]) continue;
          const delivery = typeof claimCloudReminder === "function" ? await claimCloudReminder(reminder.key, now) : reminder;
          if (!delivery) continue;
          if (generation !== reminderGeneration || !state || !settings(state).enabled) return;
          if (!claimReminder(ledger, reminder.key, now)) continue;
          try {
            global.localStorage.setItem(storageName, JSON.stringify(ledger));
            const notification = new global.Notification(delivery.title, { body: delivery.body, tag: reminder.key, icon: "zama-logo.png" });
            notification.onclick = () => { global.focus(); notification.close(); selectDay(delivery.task?.prazo || today()); if (typeof goToModule === "function") goToModule("agenda"); };
          } catch (_) {
            // Mobile browsers may require persistent notifications via a worker.
            try {
              if (!global.navigator?.serviceWorker) throw new Error();
              await global.navigator.serviceWorker.register(new URL('notification-worker.js', global.location.href));
              const registration = await global.navigator.serviceWorker.ready;
              await registration.showNotification(delivery.title, { body: delivery.body, tag: reminder.key, icon: 'zama-logo.png', data: { day: delivery.task?.prazo || today() } });
            } catch {
              if (typeof showToast === 'function') showToast(delivery.title, delivery.body);
            }
          }
        }
      };
      if (global.navigator?.locks) await global.navigator.locks.request(storageName, { mode: "exclusive" }, deliver);
      else await deliver();
    } finally { checking = false; }
  }
  function startReminders() { stopReminders(); timer = global.setInterval(checkReminders, 20000); checkReminders(); }
  function stopReminders() { reminderGeneration++; if (timer) global.clearInterval(timer); timer = null; }
  function uid() { return global.crypto?.randomUUID ? global.crypto.randomUUID() : `task-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function getState() { return typeof state === "undefined" ? { agenda: [] } : state; }
  function patchTask(targetState, id, originalDay, changes, scope = "occurrence") {
    const row = targetState.agenda.find(item => item.id === id);
    if (!row) throw new Error("Esta tarefa não está mais disponível. Atualize a página.");
    if (row.recorrencia !== "none" && row.recorrencia && scope === "occurrence") row.exceptions = { ...(row.exceptions || {}), [originalDay]: { ...(row.exceptions?.[originalDay] || {}), ...changes } };
    else Object.assign(row, changes);
    return row;
  }
  // Shared by the editor and authenticated server tools. Never accesses persistence.
  function saveTask(targetState, input, id = null, originalDay = null, scope = "occurrence") {
    normalize(targetState);
    const base = id ? targetState.agenda.find(row => row.id === id) : null;
    if (id && !base) throw new Error("Tarefa não encontrada.");
    const recurring = base && base.recorrencia && base.recorrencia !== "none";
    if (recurring && scope === "occurrence" && (!validDate(originalDay) || !occursOn(base, originalDay) || base.exceptions?.[originalDay]?.deleted)) throw new Error("Selecione uma ocorrência válida da tarefa.");
    const previous = recurring && scope === "occurrence" ? { ...base, prazo: originalDay, ...(base.exceptions?.[originalDay] || {}) } : base;
    const value = { nome: "", prazo: "", hora: "", duracao: 30, prioridade: "Média", status: "Pendente", observacoes: "", reminderMinutes: null, recorrencia: "none", recurrenceEnd: "", ...previous, ...input };
    if (!value.nome.trim() || value.nome.length > 180 || value.observacoes.length > 5000) throw new Error("Revise o título e a descrição da tarefa.");
    if (!validDate(value.prazo) || (value.hora && !validTime(value.hora))) throw new Error("Informe data e horário válidos.");
    if (!Number.isInteger(value.duracao) || value.duracao < 0 || value.duracao > 1440) throw new Error("Duração inválida.");
    if (!["Baixa", "Média", "Alta"].includes(value.prioridade) || !["Pendente", "Concluído", "Adiado", "Cancelado"].includes(value.status)) throw new Error("Prioridade ou situação inválida.");
    const seriesStart = recurring && scope === "occurrence" ? base.prazo : value.prazo;
    if (!Object.hasOwn(recurrenceLabels, value.recorrencia) || (value.recurrenceEnd && (!validDate(value.recurrenceEnd) || value.recurrenceEnd < seriesStart))) throw new Error("Repetição inválida.");
    if (value.reminderMinutes !== null && (!Number.isInteger(value.reminderMinutes) || value.reminderMinutes < -1 || value.reminderMinutes > 1440)) throw new Error("Lembrete inválido.");
    if (base) return patchTask(targetState, id, originalDay, { ...input, updatedAt: new Date().toISOString() }, scope);
    const row = { ...value, id: uid(), createdAt: new Date().toISOString(), tipo: value.tipo || "Tarefa", valor: value.prioridade === "Alta" ? 5 : value.prioridade === "Média" ? 3 : 1, exceptions: {} };
    targetState.agenda.push(row);
    return row;
  }
  function removeTask(targetState, id, originalDay, scope = "occurrence") {
    const row = targetState.agenda.find(item => item.id === id);
    if (!row) return;
    if (row.recorrencia !== "none" && row.recorrencia && scope === "occurrence") patchTask(targetState, id, originalDay, { deleted: true });
    else {
      targetState.agenda = targetState.agenda.filter(item => item.id !== id);
      (targetState.ideias || []).forEach(idea => { if (idea.taskId === id) { delete idea.taskId; delete idea.convertedAt; } });
    }
  }
  function closeDialog() { if (activeDialog) { activeDialog.close(); activeDialog.remove(); activeDialog = null; } }
  function dialog(title, body) {
    closeDialog();
    const element = document.createElement("dialog");
    element.className = "ceo-dialog za-dialog";
    element.innerHTML = `<div class="za-dialog-head"><h2>${esc(title)}</h2><button type="button" class="ceo-button" data-close aria-label="Fechar">×</button></div>${body}`;
    element.querySelector("[data-close]").onclick = closeDialog;
    element.addEventListener("click", event => { if (event.target === element) closeDialog(); });
    element.addEventListener("close", () => { element.remove(); if (activeDialog === element) activeDialog = null; });
    document.body.appendChild(element); activeDialog = element; element.showModal();
    return element;
  }
  async function submitMutation(form, mutate, message) {
    const error = form.querySelector("[data-error]");
    const button = form.querySelector('[type="submit"]');
    error.textContent = ""; button.disabled = true;
    try {
      const saved = await ceoCommit(mutate, message);
      if (saved === false) throw new Error("Não foi possível salvar. Confira sua conexão e tente novamente.");
      closeDialog();
    } catch (failure) { error.textContent = failure.message || "Não foi possível salvar a alteração."; }
    finally { button.disabled = false; }
  }
  function options(values, current) { return values.map(([value, label]) => `<option value="${esc(value)}" ${text(current) === text(value) ? "selected" : ""}>${esc(label)}</option>`).join(""); }
  const field = (label, input, wide = false) => `<label class="ceo-field ${wide ? "za-wide" : ""}"><span>${label}</span>${input.replace(/<(input|select|textarea)(?=[\s>])/, `<$1 aria-label="${esc(label)}"`)}</label>`;
  function openTask({ date = selectedDay || today(), row = null, occurrenceDate = null, scope = "occurrence", ideaId = null } = {}) {
    const base = row ? getState().agenda.find(item => item.id === (row.seriesId || row.id)) || row : null;
    const originalDay = occurrenceDate || row?.occurrenceDate || row?.prazo || date;
    const recurring = Boolean(base && base.recorrencia && base.recorrencia !== "none");
    const value = row ? (recurring && scope === "series" ? base : row) : { nome: "", prazo: date, hora: "09:00", duracao: 30, prioridade: "Média", recorrencia: "none", status: "Pendente", reminderMinutes: null, observacoes: "" };
    const reminderOptions = [["", "Usar configuração geral"], ["-1", "Sem lembrete"], ["0", "Na hora"], ["5", "5 minutos antes"], ["15", "15 minutos antes"], ["30", "30 minutos antes"], ["60", "1 hora antes"], ["1440", "1 dia antes"]];
    if (Number.isInteger(value.reminderMinutes) && value.reminderMinutes >= 0 && !reminderOptions.some(([minutes]) => text(minutes) === text(value.reminderMinutes))) reminderOptions.push([value.reminderMinutes, `${value.reminderMinutes} minutos antes`]);
    const element = dialog(row ? "Editar tarefa" : "Nova tarefa", `<form class="ceo-form-grid za-task-form">
      ${recurring ? field("Aplicar alteração", `<select name="scope">${options([["occurrence", "Somente esta ocorrência"], ["series", "Toda a série (preserva exceções)"]], scope)}</select>`, true) : ""}
      ${field("Título", `<input name="nome" value="${esc(value.nome)}" required maxlength="180" autofocus>`, true)}
      ${field(scope === "series" && recurring ? "Início da série" : "Data", `<input type="date" name="prazo" value="${esc(value.prazo)}" required>`)}
      ${field("Horário (São Paulo)", `<input type="time" name="hora" value="${esc(value.hora)}">`)}
      ${field("Duração em minutos", `<input type="number" name="duracao" min="0" max="1440" step="5" value="${esc(value.duracao || 0)}" required>`)}
      ${field("Prioridade", `<select name="prioridade">${options(["Baixa", "Média", "Alta"].map(item => [item, item]), value.prioridade)}</select>`)}
      ${field("Situação", `<select name="status">${options([["Pendente", "Pendente"], ["Concluído", "Concluída"], ["Adiado", "Adiada"], ["Cancelado", "Cancelada"]], isDone(value) ? "Concluído" : value.status)}</select>`)}
      ${field("Repetição", `<select name="recorrencia" ${recurring && scope === "occurrence" ? "disabled" : ""}>${options(Object.entries(recurrenceLabels), value.recorrencia || "none")}</select>`)}
      ${field("Repetir até (opcional)", `<input type="date" name="recurrenceEnd" value="${esc(value.recurrenceEnd || "")}" ${recurring && scope === "occurrence" ? "disabled" : ""}>`)}
      ${field("Lembrete", `<select name="reminderMinutes">${options(reminderOptions, value.reminderMinutes == null ? "" : value.reminderMinutes)}</select>`)}
      ${field("Descrição", `<textarea name="observacoes" rows="3" maxlength="5000">${esc(value.observacoes || value.descricao || "")}</textarea>`, true)}
      <p class="za-help za-wide">Recorrências usam o horário de São Paulo. Em meses mais curtos, tarefas do dia 29, 30 ou 31 acontecem no último dia do mês. Concluir uma tarefa recorrente afeta apenas o dia escolhido.</p>
      <p class="za-error za-wide" data-error role="alert"></p><div class="za-form-actions za-wide"><button class="ceo-button" type="button" data-cancel>Cancelar</button><button class="ceo-button primary" type="submit">Salvar tarefa</button></div>
    </form>`);
    const form = element.querySelector("form");
    form.querySelector("[data-cancel]").onclick = closeDialog;
    if (recurring) form.elements.scope.onchange = event => openTask({ date, row, occurrenceDate: originalDay, scope: event.target.value, ideaId });
    form.onsubmit = event => {
      event.preventDefault();
      const input = Object.fromEntries(new FormData(form));
      const patch = { nome: input.nome.trim(), prazo: input.prazo, hora: input.hora, duracao: Number(input.duracao), prioridade: input.prioridade, status: input.status, observacoes: input.observacoes.trim(), reminderMinutes: input.reminderMinutes === "" ? null : Number(input.reminderMinutes) };
      let error = "";
      if (!patch.nome) error = "Informe um título para a tarefa.";
      else if (!validDate(patch.prazo) || (patch.hora && !validTime(patch.hora))) error = "Informe uma data e horário válidos.";
      else if (!Number.isInteger(patch.duracao) || patch.duracao < 0 || patch.duracao > 1440) error = "A duração deve ser entre 0 e 1.440 minutos.";
      else if (input.recurrenceEnd && (!validDate(input.recurrenceEnd) || input.recurrenceEnd < patch.prazo)) error = "O fim da repetição deve ser igual ou posterior ao início.";
      if (error) { form.querySelector("[data-error]").textContent = error; return; }
      if (!recurring || scope === "series") { patch.recorrencia = input.recorrencia; patch.recurrenceEnd = input.recurrenceEnd || ""; }
      submitMutation(form, draft => {
        saveTask(draft, { ...patch, ...(ideaId ? { ideaId } : {}) }, base?.id, originalDay, scope);
        selectedDay = patch.prazo; visibleMonth = patch.prazo.slice(0, 7);
      }, "Tarefa salva.");
    };
  }
  function confirmDelete(task) {
    const recurring = task.recorrencia && task.recorrencia !== "none";
    const element = dialog("Excluir tarefa", `<form><p>Excluir <strong>${esc(task.nome)}</strong> de ${formatDay(task.prazo)}?</p>${recurring ? field("O que excluir", `<select name="scope">${options([["occurrence", "Somente esta ocorrência"], ["series", "Toda a série, incluindo o histórico"]], "occurrence")}</select>`) : ""}<p class="za-error" data-error role="alert"></p><div class="za-form-actions"><button type="button" class="ceo-button" data-cancel>Cancelar</button><button type="submit" class="ceo-button danger">Excluir</button></div></form>`);
    const form = element.querySelector("form");
    form.querySelector("[data-cancel]").onclick = closeDialog;
    form.onsubmit = event => { event.preventDefault(); submitMutation(form, draft => removeTask(draft, task.seriesId || task.id, task.occurrenceDate, form.elements.scope?.value || "occurrence"), "Tarefa excluída."); };
  }
  async function toggle(task) {
    try { await ceoCommit(draft => patchTask(draft, task.seriesId || task.id, task.occurrenceDate, { status: isDone(task) ? "Pendente" : "Concluído" }), isDone(task) ? "Tarefa reaberta." : "Tarefa concluída."); } catch (_) { /* ceoCommit presents persistence errors. */ }
  }
  function permissionDescription() {
    if (!global.Notification) return "Este navegador não oferece notificações. Use outro navegador compatível.";
    return global.Notification.permission === "granted" ? "Notificações autorizadas neste navegador." : global.Notification.permission === "denied" ? "Notificações bloqueadas. Libere-as nas configurações do navegador para este site." : "Ao ativar, o navegador pedirá sua permissão para notificar.";
  }
  function openSettings() {
    const value = settings(getState());
    const element = dialog("Configurar lembretes", `<form class="za-settings-form"><label class="za-check"><input type="checkbox" name="enabled" ${value.enabled ? "checked" : ""}> Ativar lembretes neste sistema</label><p class="za-help">${permissionDescription()}</p><label class="za-check"><input type="checkbox" name="dailyEnabled" ${value.dailyEnabled ? "checked" : ""}> Resumo diário de tarefas pendentes</label>${field("Horário do resumo (São Paulo)", `<input type="time" name="dailyTime" value="${esc(value.dailyTime)}" required>`)}<label class="za-check"><input type="checkbox" name="taskEnabled" ${value.taskEnabled ? "checked" : ""}> Aviso antes de cada tarefa</label>${field("Antecedência em minutos", `<input type="number" name="leadMinutes" value="${esc(value.leadMinutes)}" min="0" max="1440" required>`)}<p class="za-help">Os lembretes são enviados por este navegador enquanto o aplicativo estiver aberto. Para receber com o aplicativo fechado ou por e-mail, é necessário configurar um serviço de envio no servidor. Cada dispositivo precisa da sua própria permissão.</p><p class="za-error" data-error role="alert"></p><div class="za-form-actions"><button type="button" class="ceo-button" data-cancel>Cancelar</button><button type="submit" class="ceo-button primary">Salvar preferências</button></div></form>`);
    const form = element.querySelector("form");
    form.querySelector("[data-cancel]").onclick = closeDialog;
    form.onsubmit = async event => {
      event.preventDefault();
      const preferences = { enabled: form.elements.enabled.checked, dailyEnabled: form.elements.dailyEnabled.checked, dailyTime: form.elements.dailyTime.value, taskEnabled: form.elements.taskEnabled.checked, leadMinutes: Number(form.elements.leadMinutes.value) };
      const error = form.querySelector("[data-error]");
      if (!validTime(preferences.dailyTime) || !Number.isInteger(preferences.leadMinutes) || preferences.leadMinutes < 0 || preferences.leadMinutes > 1440) { error.textContent = "Revise o horário e a antecedência dos lembretes."; return; }
      if (preferences.enabled) {
        if (!global.Notification) { error.textContent = permissionDescription(); return; }
        let permission = global.Notification.permission;
        if (permission === "default") permission = await global.Notification.requestPermission();
        if (permission !== "granted") { error.textContent = "A permissão não foi concedida. Libere as notificações no navegador ou desmarque a ativação."; return; }
      }
      await submitMutation(form, draft => { draft.agendaSettings = preferences; }, "Preferências dos lembretes salvas.");
    };
  }
  function reminderLabel(task, preferences) {
    const reminder = reminderFor(task, { ...preferences, taskEnabled: true });
    if (!reminder) return task.hora ? "Sem lembrete" : "Defina um horário para receber lembrete";
    const when = parts(reminder.dueAt);
    return `Lembrete ${when.date !== task.prazo ? `${formatDay(when.date)} ` : "às "}${when.time}${preferences.enabled && preferences.taskEnabled ? "" : " (desativado)"}`;
  }
  function financialDues(targetState, date) {
    const pending = row => !/^(pago|recebido|cancelado)$/i.test(fold(row.status));
    const values = (targetState.financeiro || []).filter(row => row.prazo === date && pending(row)).map(row => ({ ...row, dueKind: row.tipo === "Entrada" ? "A receber" : "A pagar" }));
    const end = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
    (targetState.gastosFixos || []).filter(row => !/^(pausado|cancelado)$/i.test(fold(row.status))).forEach(row => {
      if (Math.min(end, Math.max(1, Number(row.dia || 1))) === Number(date.slice(8))) values.push({ ...row, dueKind: "Gasto fixo previsto" });
    });
    return values;
  }
  function selectDay(date) {
    if (!validDate(date)) return;
    selectedDay = date; visibleMonth = date.slice(0, 7);
    if (currentContainer?.isConnected) render(currentContainer);
  }
  function render(container) {
    currentContainer = container;
    const targetState = getState(), preferences = settings(targetState);
    if (!selectedDay) selectedDay = today();
    if (!visibleMonth) visibleMonth = selectedDay.slice(0, 7);
    const [year, month] = visibleMonth.split("-").map(Number);
    const start = `${visibleMonth}-01`, first = addDays(start, -new Date(`${start}T12:00:00Z`).getUTCDay());
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cells = Math.ceil((new Date(`${start}T12:00:00Z`).getUTCDay() + length) / 7) * 7;
    const monthLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${start}T12:00:00Z`));
    const tasks = todayTasks(targetState, selectedDay), done = tasks.filter(isDone).length;
    const active = tasks.filter(task => !isCancelled(task)), percent = active.length ? Math.round(done / active.length * 100) : 0;
    const upcoming = tasks.map(task => reminderFor(task, preferences)).filter(item => item && item.dueAt >= Date.now()).sort((a, b) => a.dueAt - b.dueAt)[0];
    const undated = (targetState.agenda || []).filter(row => !validDate(row.prazo));
    const dues = financialDues(targetState, selectedDay);
    container.innerHTML = `<div class="za-header ceo-toolbar"><p class="za-zone">Horários de São Paulo · UTC−3</p><button class="ceo-button primary" data-action="new">＋ Nova tarefa</button></div><div class="za-layout"><div class="za-main"><section class="ceo-card za-calendar" aria-label="Calendário mensal"><div class="za-calendar-toolbar"><div class="za-month-switch"><button class="ceo-button" data-action="prev" aria-label="Mês anterior">‹</button><button class="ceo-button" data-action="next" aria-label="Próximo mês">›</button><h2>${esc(monthLabel)}</h2></div><button class="ceo-button" data-action="today">Hoje</button></div><div class="za-weekdays" aria-hidden="true">${["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"].map(day => `<span>${day}</span>`).join("")}</div><div class="za-days">${Array.from({ length: cells }, (_, index) => {
      const date = addDays(first, index), rows = todayTasks(targetState, date).filter(task => !isCancelled(task)), completed = rows.filter(isDone).length;
      return `<button class="za-day ${date.slice(0, 7) !== visibleMonth ? "outside" : ""} ${date === selectedDay ? "selected" : ""} ${date === today() ? "is-today" : ""}" data-date="${date}" aria-pressed="${date === selectedDay}" aria-label="${esc(formatDay(date, true))}, ${rows.length} tarefa(s), ${completed} concluída(s)"><span class="za-day-number">${Number(date.slice(8))}</span>${rows.slice(0, 2).map(task => `<span class="za-day-task ${isDone(task) ? "done" : task.prioridade === "Alta" ? "high" : ""}">${esc(task.nome)}</span>`).join("")}${rows.length ? `<span class="za-day-count">${rows.length} tarefa${rows.length !== 1 ? "s" : ""}</span>` : ""}</button>`;
    }).join("")}</div></section><section class="ceo-card za-reminders"><div class="ceo-toolbar"><div><h2>Lembretes do dia</h2><p class="za-help">${preferences.enabled ? "Ativados" : "Desativados"} · aplicativo aberto</p></div><button class="ceo-button" data-action="settings">Configurar</button></div><div class="za-reminder-options"><div><strong>Resumo diário</strong><p>${preferences.dailyEnabled ? `Todos os dias às ${esc(preferences.dailyTime)}` : "Desativado"}</p></div><div><strong>Antes de cada tarefa</strong><p>${preferences.taskEnabled ? `${preferences.leadMinutes} minutos antes` : "Desativado"}</p></div></div><p class="za-help">${permissionDescription()}</p></section>${undated.length ? `<section class="ceo-card za-undated"><h2>Sem data definida</h2><p class="za-help">${undated.length} registro(s) antigo(s) aguardando uma data.</p>${undated.map(row => `<button class="ceo-button" data-undated="${esc(row.id)}">${esc(row.nome)} · Definir data</button>`).join("")}</section>` : ""}</div><section class="ceo-card za-day-panel" aria-label="Tarefas do dia selecionado" tabindex="-1"><span class="ceo-badge">Dia selecionado</span><h2 class="za-selected-title">${esc(formatDay(selectedDay, true))}</h2><div class="za-progress"><span>${tasks.length} tarefa${tasks.length !== 1 ? "s" : ""} · ${done} concluída${done !== 1 ? "s" : ""}</span><progress value="${percent}" max="100" aria-label="Progresso das tarefas"></progress><span>${percent}%</span></div>${upcoming && preferences.enabled ? `<div class="za-next-reminder"><span>Próximo lembrete</span><strong>${esc(parts(upcoming.dueAt).time)} · ${esc(upcoming.title)}</strong><small>${formatDay(parts(upcoming.dueAt).date)}</small></div>` : ""}<button class="ceo-button primary za-add-day" data-action="new">＋ Adicionar tarefa</button><div class="za-tasks">${tasks.length ? tasks.map((task, index) => {
      const status = taskStatus(task);
      return `<article class="za-task ${isDone(task) ? "done" : ""} ${task.prioridade === "Alta" && !isDone(task) ? "high" : ""}"><span class="za-task-hour">${esc(task.hora || "Sem hora")}</span><div class="za-task-body"><div class="za-task-title"><input type="checkbox" data-toggle="${index}" ${isDone(task) ? "checked" : ""} ${isCancelled(task) ? "disabled" : ""} aria-label="${isDone(task) ? "Reabrir" : "Concluir"} ${esc(task.nome)}"><strong>${esc(task.nome)}</strong></div>${task.observacoes || task.descricao ? `<p class="za-task-description">${esc(task.observacoes || task.descricao)}</p>` : ""}<div class="za-task-meta"><span class="ceo-badge ${status === "Concluída" ? "success" : status === "Atrasada" ? "danger" : ""}">${status}</span><span class="ceo-badge ${task.prioridade === "Alta" ? "danger" : ""}">${esc(task.prioridade || "Baixa")}</span><span>${Number(task.duracao || 0)} min</span>${task.recorrencia !== "none" && task.recorrencia ? `<span>↻ ${esc(recurrenceLabels[task.recorrencia])}</span>` : ""}${task.ideaId ? "<span>Vinculada a uma ideia</span>" : ""}</div><small class="za-task-reminder">♧ ${esc(reminderLabel(task, preferences))}</small><div class="za-task-actions"><button class="ceo-button" data-edit="${index}">Editar</button><button class="ceo-button" data-delete="${index}">Excluir</button></div></div></article>`;
    }).join("") : '<div class="ceo-empty za-empty"><span>✓</span><h3>Seu dia está livre</h3><p>Adicione uma tarefa para organizar este dia.</p></div>'}</div>${dues.length ? `<section class="za-financial-dues"><h3>Vencimentos financeiros</h3><p class="za-help">Contas e previsões do dia, separadas das tarefas.</p>${dues.map(row => `<div><span>${esc(row.nome)}<small>${esc(row.dueKind)}</small></span><strong>${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Math.abs(Number(row.valor || 0)))}</strong></div>`).join("")}<button class="ceo-button" data-action="finance">Abrir financeiro</button></section>` : ""}</section></div>`;
    container.querySelectorAll("[data-action]").forEach(button => button.onclick = () => {
      const action = button.dataset.action;
      if (action === "new") return openTask({ date: selectedDay });
      if (action === "settings") return openSettings();
      if (action === "finance") { if (typeof goToModule === "function") goToModule("financeiro"); return; }
      if (action === "today") { selectedDay = today(); visibleMonth = selectedDay.slice(0, 7); }
      else { const shifted = new Date(Date.UTC(year, month - 1 + (action === "prev" ? -1 : 1), 1)); visibleMonth = shifted.toISOString().slice(0, 7); }
      render(container);
    });
    container.querySelectorAll("[data-date]").forEach(button => button.onclick = () => {
      selectedDay = button.dataset.date; visibleMonth = selectedDay.slice(0, 7); render(container);
      if (global.matchMedia?.("(max-width: 760px)").matches) container.querySelector(".za-day-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    container.querySelectorAll("[data-toggle]").forEach(input => input.onchange = () => toggle(tasks[Number(input.dataset.toggle)]));
    container.querySelectorAll("[data-edit]").forEach(button => button.onclick = () => openTask({ row: tasks[Number(button.dataset.edit)] }));
    container.querySelectorAll("[data-delete]").forEach(button => button.onclick = () => confirmDelete(tasks[Number(button.dataset.delete)]));
    container.querySelectorAll("[data-undated]").forEach(button => button.onclick = () => openTask({ row: { ...undated.find(row => row.id === button.dataset.undated), prazo: selectedDay } }));
  }
  global.ZamaAgenda = { normalize, render, todayTasks, nextReminder, startReminders, stopReminders, openTask, openSettings, toggle, completeTask: toggle, selectDay, helpers: { validDate, validTime, parts, addDays, toEpoch, occursOn, occurrence, taskStatus, reminderFor, remindersBetween, claimReminder, patchTask, removeTask, isDone, isCancelled, settings, financialDues } };
  global.ZamaAgenda.saveTask = saveTask;
  if (typeof module !== "undefined" && module.exports) module.exports = global.ZamaAgenda;
})(typeof window !== "undefined" ? window : globalThis);
