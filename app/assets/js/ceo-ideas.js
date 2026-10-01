/* Banco de ideias. Reutiliza o estado autenticado e a transação de persistência do sistema. */
(function (root) {
  "use strict";
  const stageLabels = Object.freeze({ capturada: "Capturadas", avaliacao: "Em avaliação", execucao: "Em execução", concluida: "Concluídas" });
  const priorities = ["Baixa", "Média", "Alta"];
  const filters = { search: "", category: "", priority: "", stage: "", archived: "active" };
  let currentContainer = null;
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const plain = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const makeId = () => root.crypto?.randomUUID ? root.crypto.randomUUID() : `idea-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const today = () => typeof ZamaTime !== "undefined" ? ZamaTime.today() : root.ZamaTime?.today ? root.ZamaTime.today() : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const currentState = () => typeof state !== "undefined" ? state : root.state;
  const dateLabel = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("/") : "Sem data";
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  function stageKey(value) {
    if (stageLabels[value]) return value;
    const label = plain(value);
    if (/avali/.test(label)) return "avaliacao";
    if (/execu/.test(label)) return "execucao";
    if (/conclu/.test(label)) return "concluida";
    return "capturada";
  }
  function priorityLabel(value) {
    if (typeof value === "number") return value >= 4 ? "Alta" : value <= 2 ? "Baixa" : "Média";
    return priorities.find((item) => plain(item) === plain(value)) || "Média";
  }
  function normalize(targetState) {
    if (!Array.isArray(targetState.ideias)) {
      if (targetState.ideias != null) targetState.ideiasLegacy = targetState.ideias;
      targetState.ideias = [];
    }
    targetState.ideias.forEach((idea, index) => {
      if (!idea || typeof idea !== "object" || Array.isArray(idea)) {
        idea = targetState.ideias[index] = { titulo: String(idea || ""), legacyValue: idea };
      }
      idea.id = idea.id || makeId();
      idea.titulo = String(idea.titulo || idea.nome || idea.title || "Ideia sem título");
      idea.descricao = String(idea.descricao || idea.description || idea.observacoes || "");
      idea.categoria = String(idea.categoria || idea.category || "Geral");
      idea.prioridade = priorityLabel(idea.prioridade || idea.priority);
      idea.data = String(idea.data || idea.date || idea.createdAt || today()).slice(0, 10);
      idea.etapa = stageKey(idea.etapa || idea.stage);
      idea.arquivada = Boolean(idea.arquivada ?? idea.archived ?? false);
      idea.taskId = idea.taskId || null;
    });
    return targetState;
  }
  function filterIdeas(targetState, selection = {}) {
    const query = plain(selection.search).trim();
    return (targetState.ideias || []).filter((idea) => {
      if (selection.archived === "archived" ? !idea.arquivada : selection.archived !== "all" && idea.arquivada) return false;
      return (!query || plain(`${idea.titulo} ${idea.descricao} ${idea.categoria}`).includes(query))
        && (!selection.category || idea.categoria === selection.category)
        && (!selection.priority || idea.prioridade === selection.priority)
        && (!selection.stage || idea.etapa === selection.stage);
    }).sort((a, b) => String(b.createdAt || b.data).localeCompare(String(a.createdAt || a.data)) || String(a.id).localeCompare(String(b.id)));
  }
  const recent = (targetState, limit = 3) => filterIdeas(targetState).slice(0, limit);
  function findIdea(targetState, id) {
    const row = (targetState.ideias || []).find((idea) => idea.id === id);
    if (!row) throw new Error("Esta ideia não está mais disponível. Atualize a página.");
    return row;
  }
  function upsert(targetState, values, id = null) {
    const titulo = String(values.titulo || "").trim();
    if (!titulo || titulo.length > 180) throw new Error("Informe um título com até 180 caracteres.");
    if (!validDate(values.data)) throw new Error("Informe uma data válida para a ideia.");
    if (!Object.hasOwn(stageLabels, values.etapa)) throw new Error("Selecione uma etapa válida.");
    if (!priorities.includes(values.prioridade)) throw new Error("Selecione uma prioridade válida.");
    normalize(targetState);
    const idea = id ? findIdea(targetState, id) : { id: makeId(), createdAt: new Date().toISOString(), arquivada: false, taskId: null };
    Object.assign(idea, { titulo, descricao: String(values.descricao || "").trim(), categoria: String(values.categoria || "Geral").trim() || "Geral", prioridade: values.prioridade, data: values.data, etapa: values.etapa, updatedAt: new Date().toISOString() });
    if (!id) targetState.ideias.push(idea);
    return idea;
  }
  function move(targetState, id, stage) {
    if (!Object.hasOwn(stageLabels, stage)) throw new Error("Selecione uma etapa válida.");
    const idea = findIdea(targetState, id);
    idea.etapa = stage;
    idea.updatedAt = new Date().toISOString();
    return idea;
  }
  function archive(targetState, id, archived = true) {
    const idea = findIdea(targetState, id);
    idea.arquivada = Boolean(archived);
    idea.updatedAt = new Date().toISOString();
    return idea;
  }
  function convert(targetState, id, schedule) {
    const idea = findIdea(targetState, id);
    if (!Array.isArray(targetState.agenda)) targetState.agenda = [];
    const existing = targetState.agenda.find((task) => task.ideaId === id || (task.id === idea.taskId && !task.ideaId));
    if (existing) {
      existing.ideaId = id;
      idea.taskId = existing.id;
      return existing;
    }
    if (!validDate(schedule?.prazo)) throw new Error("Informe uma data válida para a tarefa.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule?.hora || "")) throw new Error("Informe um horário válido para a tarefa.");
    const duration = Number(schedule.duracao ?? 60);
    if (!Number.isInteger(duration) || duration < 5 || duration > 1440) throw new Error("A duração precisa ser de 5 a 1.440 minutos.");
    const stamp = new Date().toISOString();
    const task = { id: makeId(), nome: idea.titulo, tipo: "Tarefa", prazo: schedule.prazo, hora: schedule.hora, duracao: duration, status: "Pendente", observacoes: idea.descricao, prioridade: idea.prioridade, valor: idea.prioridade === "Alta" ? 5 : idea.prioridade === "Baixa" ? 1 : 3, ideaId: idea.id, createdAt: stamp, updatedAt: stamp };
    targetState.agenda.push(task);
    idea.taskId = task.id;
    idea.etapa = "execucao";
    idea.updatedAt = stamp;
    return task;
  }
  function options(values, selected, placeholder = "") {
    return `${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}${values.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("")}`;
  }
  function card(idea, targetState) {
    const task = (targetState.agenda || []).find((row) => row.ideaId === idea.id || row.id === idea.taskId);
    return `<article class="ceo-idea-card" data-idea-id="${esc(idea.id)}">
      <div class="ceo-idea-meta"><span class="ceo-badge">${esc(idea.categoria)}</span><span class="ceo-badge ceo-idea-priority-${plain(idea.prioridade)}">${esc(idea.prioridade)}</span></div>
      <h3>${esc(idea.titulo)}</h3>${idea.descricao ? `<p class="ceo-idea-description">${esc(idea.descricao)}</p>` : '<p class="ceo-idea-description ceo-muted">Adicione detalhes ao editar.</p>'}
      <p class="ceo-idea-date">${dateLabel(idea.data)}${idea.arquivada ? " · Arquivada" : ""}</p>
      ${task ? `<p class="ceo-idea-linked">Tarefa vinculada · ${dateLabel(task.prazo)}${task.hora ? ` às ${esc(task.hora)}` : ""}</p>` : ""}
      <label class="ceo-field ceo-idea-move">Etapa<select data-idea-move="${esc(idea.id)}" aria-label="Etapa de ${esc(idea.titulo)}">${options(Object.entries(stageLabels), idea.etapa)}</select></label>
      <div class="ceo-idea-actions"><button type="button" class="ceo-button" data-idea-action="edit">Editar</button><button type="button" class="ceo-button" data-idea-action="${idea.arquivada ? "restore" : "archive"}">${idea.arquivada ? "Restaurar" : "Arquivar"}</button>${!idea.arquivada && !task ? '<button type="button" class="ceo-button ceo-idea-convert" data-idea-action="convert">Criar tarefa</button>' : ""}</div>
    </article>`;
  }
  function renderBoard(container) {
    const targetState = currentState();
    const rows = filterIdeas(targetState, filters);
    const board = container.querySelector("[data-ideas-board]");
    board.innerHTML = Object.entries(stageLabels).filter(([key]) => !filters.stage || filters.stage === key).map(([key, label]) => {
      const items = rows.filter((idea) => idea.etapa === key);
      return `<section class="ceo-idea-column" aria-label="${label}"><header><h2>${label}</h2><span class="ceo-badge">${items.length}</span></header><div class="ceo-idea-stack">${items.length ? items.map((idea) => card(idea, targetState)).join("") : `<div class="ceo-empty">${filters.search || filters.category || filters.priority ? "Nenhuma ideia com estes filtros." : "Espaço para suas próximas ideias."}</div>`}</div></section>`;
    }).join("");
    container.querySelector("[data-ideas-count]").textContent = `${rows.length} ${rows.length === 1 ? "ideia encontrada" : "ideias encontradas"}`;
  }
  async function commit(action, message) {
    if (typeof ceoCommit !== "function" && typeof root.ceoCommit !== "function") throw new Error("O salvamento não está disponível. Atualize a página.");
    const result = await (typeof ceoCommit === "function" ? ceoCommit : root.ceoCommit)(action, message);
    if (result === false) throw new Error("Não foi possível salvar. Verifique sua conexão e tente novamente.");
    return result;
  }
  function report(error) {
    const message = error?.message || "Não foi possível realizar esta ação.";
    if (typeof showToast === "function") showToast("Banco de ideias", message, "error");
    else if (currentContainer) {
      const output = currentContainer.querySelector("[data-ideas-error]");
      if (output) { output.textContent = message; output.hidden = false; }
    }
  }
  function openDialog(title, markup, action, buttonLabel = "Salvar ideia") {
    const previous = document.getElementById("ceoIdeaDialog");
    if (previous) previous.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "ceoIdeaDialog";
    dialog.className = "ceo-dialog";
    dialog.setAttribute("aria-labelledby", "ceoIdeaDialogTitle");
    dialog.innerHTML = `<form class="ceo-idea-form"><header class="ceo-idea-dialog-header"><h2 id="ceoIdeaDialogTitle">${esc(title)}</h2><button class="ceo-button" type="button" data-close aria-label="Fechar">×</button></header>${markup}<p class="ceo-form-error" role="alert" hidden></p><footer class="ceo-idea-dialog-footer"><button type="button" class="ceo-button" data-close>Cancelar</button><button type="submit" class="ceo-button primary">${esc(buttonLabel)}</button></footer></form>`;
    dialog.querySelectorAll('label.ceo-field').forEach(label => {
      label.querySelector('input,select,textarea')?.setAttribute('aria-label', label.firstChild.textContent.trim());
    });
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]');
      const errorBox = form.querySelector('[role="alert"]');
      submit.disabled = true;
      submit.textContent = "Salvando…";
      errorBox.hidden = true;
      try { await action(Object.fromEntries(new FormData(form))); dialog.close(); }
      catch (error) { errorBox.textContent = error.message || "Não foi possível salvar. Tente novamente."; errorBox.hidden = false; }
      finally { submit.disabled = false; submit.textContent = buttonLabel; }
    });
    dialog.showModal();
    dialog.querySelector("input, textarea, select")?.focus();
  }
  function openEditor(id = null) {
    const targetState = currentState();
    const row = id ? findIdea(targetState, id) : { titulo: "", descricao: "", categoria: "Geral", prioridade: "Média", data: today(), etapa: "capturada" };
    const categories = [...new Set(["Geral", "Produto", "Marketing", "Financeiro", "Conteúdo", "Operações", ...(targetState.ideias || []).map((idea) => idea.categoria)])];
    openDialog(id ? "Editar ideia" : "Nova ideia", `<div class="ceo-form-grid">
      <label class="ceo-field ceo-span-2">Título<input name="titulo" required maxlength="180" value="${esc(row.titulo)}" placeholder="O que você quer colocar em prática?"></label>
      <label class="ceo-field ceo-span-2">Descrição<textarea name="descricao" rows="4" maxlength="10000" placeholder="Capture o contexto e os próximos passos.">${esc(row.descricao)}</textarea></label>
      <label class="ceo-field">Categoria<input name="categoria" maxlength="80" list="ceoIdeaCategories" value="${esc(row.categoria)}"><datalist id="ceoIdeaCategories">${categories.map((category) => `<option value="${esc(category)}"></option>`).join("")}</datalist></label>
      <label class="ceo-field">Prioridade<select name="prioridade" aria-label="Prioridade">${options(priorities.map((priority) => [priority, priority]), row.prioridade)}</select></label>
      <label class="ceo-field">Data<input name="data" type="date" value="${esc(row.data)}" required></label>
      <label class="ceo-field">Etapa<select name="etapa" aria-label="Etapa">${options(Object.entries(stageLabels), row.etapa)}</select></label>
    </div>`, (values) => commit((draft) => upsert(draft, values, id), id ? "Ideia atualizada." : "Ideia registrada."));
  }
  function openConvert(id) {
    const idea = findIdea(currentState(), id);
    openDialog("Transformar ideia em tarefa", `<p class="ceo-idea-conversion-summary">${esc(idea.titulo)}</p><p class="ceo-muted">A tarefa ficará vinculada a esta ideia, que passará para Em execução. Horários de Brasília.</p><div class="ceo-form-grid">
      <label class="ceo-field">Data da tarefa<input name="prazo" type="date" value="${today()}" required></label>
      <label class="ceo-field">Horário<input name="hora" type="time" value="09:00" required></label>
      <label class="ceo-field">Duração em minutos<input name="duracao" type="number" min="5" max="1440" step="1" value="60" required></label>
    </div>`, (schedule) => commit((draft) => convert(draft, id, schedule), "Tarefa criada e vinculada à ideia."), "Criar tarefa");
  }
  function render(container) {
    currentContainer = container;
    const targetState = currentState();
    normalize(targetState);
    const categories = [...new Set(targetState.ideias.map((idea) => idea.categoria))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (filters.category && !categories.includes(filters.category)) filters.category = "";
    container.innerHTML = `<section class="ceo-ideas"><div class="ceo-toolbar"><div><h2>Banco de ideias</h2><p class="ceo-muted">Capture agora. Transforme em próximos passos.</p></div><button type="button" class="ceo-button primary" data-idea-new>+ Nova ideia</button></div>
      <div class="ceo-card ceo-idea-filters"><label class="ceo-field ceo-idea-search">Pesquisar<input type="search" data-idea-filter="search" value="${esc(filters.search)}" placeholder="Título, descrição ou categoria"></label>
      <label class="ceo-field">Categoria<select data-idea-filter="category">${options(categories.map((item) => [item, item]), filters.category, "Todas")}</select></label>
      <label class="ceo-field">Prioridade<select data-idea-filter="priority">${options(priorities.map((item) => [item, item]), filters.priority, "Todas")}</select></label>
      <label class="ceo-field">Etapa<select data-idea-filter="stage">${options(Object.entries(stageLabels), filters.stage, "Todas")}</select></label>
      <label class="ceo-field">Exibir<select data-idea-filter="archived">${options([["active", "Ativas"], ["archived", "Arquivadas"], ["all", "Todas"]], filters.archived)}</select></label></div>
      <p class="ceo-idea-results" data-ideas-count aria-live="polite"></p><p class="ceo-form-error" data-ideas-error role="alert" hidden></p><div class="ceo-ideas-board" data-ideas-board></div></section>`;
    container.querySelector("[data-idea-new]").addEventListener("click", () => openEditor());
    container.querySelectorAll("[data-idea-filter]").forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", () => {
      filters[control.dataset.ideaFilter] = control.value;
      renderBoard(container);
    }));
    container.querySelector("[data-ideas-board]").addEventListener("change", async (event) => {
      const select = event.target.closest("[data-idea-move]");
      if (!select) return;
      select.disabled = true;
      try { await commit((draft) => move(draft, select.dataset.ideaMove, select.value), "Etapa da ideia atualizada."); }
      catch (error) { report(error); renderBoard(container); }
    });
    container.querySelector("[data-ideas-board]").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-idea-action]");
      if (!button) return;
      const id = button.closest("[data-idea-id]").dataset.ideaId;
      const action = button.dataset.ideaAction;
      try {
        if (action === "edit") return openEditor(id);
        if (action === "convert") return openConvert(id);
        button.disabled = true;
        await commit((draft) => archive(draft, id, action === "archive"), action === "archive" ? "Ideia arquivada. Você pode restaurá-la no filtro Arquivadas." : "Ideia restaurada.");
      } catch (error) { button.disabled = false; report(error); }
    });
    renderBoard(container);
  }
  const api = { normalize, render, recent, openEditor, stageLabels, filterIdeas, upsert, move, archive, convert, validDate, stageKey };
  root.ZamaIdeas = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
