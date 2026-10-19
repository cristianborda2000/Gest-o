/* Financial ledger and investment register. Integer cents are the accounting unit.
   Existing JSON fields and linked monthly subscriptions remain compatible. */
(function (global) {
  "use strict";
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const settings = { finance: null, investments: null, fixedMonth: "", chartMode: "realized", chartStyle: "bars" };
  const categoryTools = () => global.ZamaFinanceCategories || require("./finance-categories.js");
  const categoryAdapter = () => ({ direction, amountCents, isSettled, isCancelled });
  const categoryKey = value => word(value).trim().replace(/\s+/g, " ");
  function rememberCategory(target, nome, tipo) {
    const name = text(nome).trim().replace(/\s+/g, " ") || "Outro";
    // Imported labels can exceed the catalog limit. Keep them usable without
    // creating an invalid catalog entry or truncating the financial history.
    if (name.length > 80) {
      const legacy = categoryTools().list(target, tipo, categoryAdapter()).find(value => categoryKey(value) === categoryKey(name));
      if (legacy) return legacy;
    }
    return categoryTools().saveCategory(target, { nome: name, tipo }, categoryAdapter());
  }
  const text = value => String(value == null ? "" : value);
  const safe = value => text(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
  const word = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const uid = () => global.crypto?.randomUUID?.() || `finance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const today = () => typeof ZamaTime !== "undefined" ? ZamaTime.today() : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const current = () => state;
  const formatMoney = cents => money.format(Number(cents || 0) / 100);
  const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? value.split("-").reverse().join("/") : "Sem data";

  function cents(value) {
    if (typeof value === "number" && !Number.isFinite(value)) return 0;
    let raw = text(value).trim().replace(/\s|R\$/g, "");
    if (raw.includes(",")) raw = raw.replace(/\./g, "").replace(",", ".");
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return 0;
    const sign = raw.startsWith("-") ? -1 : 1;
    const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
    const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2)) + (Number(fraction[2] || 0) >= 5 ? 1 : 0);
    return Number.isSafeInteger(result) ? sign * result : 0;
  }

  function amountCents(row) {
    // Legacy screens still write `valor`, so it is authoritative when available.
    const storedCents = typeof row.valorCentavos === "number" || typeof row.valorCentavos === "string" ? Number(row.valorCentavos) : NaN;
    return Math.abs(row.valor !== undefined && row.valor !== null ? cents(row.valor) : Number.isSafeInteger(storedCents) ? storedCents : 0);
  }
  function direction(row) {
    if (word(row.tipo).startsWith("entrada")) return "Entrada";
    if (word(row.tipo).startsWith("sa")) return "Saída";
    return Number(row.valor || 0) < 0 || (row.responsavel && word(row.responsavel) !== "receita") ? "Saída" : "Entrada";
  }
  const isCancelled = row => word(row.status).startsWith("cancel");
  const isSettled = row => !isCancelled(row) && /^(pago|paga|recebido|recebida|realizado|realizada)$/.test(word(row.status));
  const isRealized = row => /^(realizado|realizada)$/.test(word(row.status));
  const effectiveDate = row => text(isSettled(row) ? row.pagoEm || row.data || row.prazo : row.prazo || row.data).slice(0, 10);
  const inPeriod = (date, range = {}) => (!range.from || date >= range.from) && (!range.to || date <= range.to) && (date || (!range.from && !range.to));
  const category = row => categoryTools().category(row);

  function normalize(target) {
    if (!Array.isArray(target.financeiro)) target.financeiro = [];
    if (!Array.isArray(target.investimentos)) target.investimentos = [];
    if (!Array.isArray(target.gastosFixos)) target.gastosFixos = [];
    target.financeiro.forEach(row => {
      if (!row.id) row.id = uid();
      row.valorCentavos = amountCents(row);
    });
    target.investimentos.forEach(row => {
      if (!row.id) row.id = uid();
      row.valorCentavos = amountCents(row);
    });
    target.gastosFixos.forEach(row => {
      if (!row.id) row.id = uid();
      row.valorCentavos = amountCents(row);
    });
    return target;
  }

  function totals(target, range = {}) {
    const result = { incomeCents: 0, expenseCents: 0, balanceCents: 0, investmentCents: 0, receivableCents: 0, payableCents: 0, rows: [] };
    financeRows(target, range).forEach(row => {
      if (isCancelled(row)) return;
      result.rows.push(row);
      const incoming = direction(row) === "Entrada";
      result[isSettled(row) ? (incoming ? "incomeCents" : "expenseCents") : (incoming ? "receivableCents" : "payableCents")] += amountCents(row);
    });
    result.balanceCents = result.incomeCents - result.expenseCents;
    result.investmentCents = (target.investimentos || []).filter(row => isRealized(row) && inPeriod(row.data || row.prazo || "", range)).reduce((sum, row) => sum + amountCents(row), 0);
    return result;
  }

  function validateMovement(data) {
    if (!text(data.nome).trim()) throw new Error("Informe a descrição da movimentação.");
    if (!Number.isSafeInteger(data.valorCentavos) || data.valorCentavos <= 0 || data.valorCentavos > 999999999999) throw new Error("Informe um valor maior que zero, com no máximo dois centavos decimais.");
    if (!["Entrada", "Saída"].includes(data.tipo)) throw new Error("Selecione o tipo da movimentação.");
    if (!["Pendente", "Pago", "Recebido", "Agendado", "Atrasado", "Cancelado"].includes(data.status)) throw new Error("Selecione uma situação válida.");
    if (!validDate(data.data) || !validDate(data.prazo)) throw new Error("Informe datas válidas para o lançamento e o vencimento.");
    if (isSettled(data) && !validDate(data.pagoEm)) throw new Error("Informe a data em que o valor foi recebido ou pago.");
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(text(value)) && Number(value.slice(0, 4)) >= 1900;
  const activeFixed = row => !["pausado", "cancelado"].includes(word(row.status));
  const monthLabel = month => validMonth(month) ? `${month.slice(5)}/${month.slice(0, 4)}` : "Sem competência";
  function fixedDueDate(row, month) {
    if (!validMonth(month) || !Number.isInteger(Number(row.dia)) || Number(row.dia) < 1 || Number(row.dia) > 31) throw new Error("Informe uma competência e um dia de vencimento válidos.");
    const [year, value] = month.split("-").map(Number);
    return `${month}-${String(Math.min(Number(row.dia), new Date(Date.UTC(year, value, 0)).getUTCDate())).padStart(2, "0")}`;
  }
  function fixedMovement(target, id, month) {
    return (target.financeiro || []).find(row => row.fixedExpenseId === id && row.competencia === month);
  }
  function createFixedMovement(target, fixed, month) {
    const existing = fixedMovement(target, fixed.id, month);
    if (existing) return existing;
    const date = fixedDueDate(fixed, month), stamp = new Date().toISOString();
    const record = { id: `fixed:${fixed.id}:${month}`, fixedExpenseId: fixed.id, competencia: month, source: "gasto-fixo", nome: fixed.nome, categoria: category(fixed), responsavel: category(fixed), tipo: "Saída", valorCentavos: amountCents(fixed), valor: -amountCents(fixed) / 100, data: date, prazo: date, status: "Pendente", pagoEm: "", observacoes: fixed.observacoes || "", createdAt: stamp, updatedAt: stamp };
    if (target.financeiro.some(row => row.id === record.id)) throw new Error("Há um lançamento com identificador conflitante. Revise o backup antes de gerar a competência.");
    target.financeiro.push(record);
    return record;
  }
  function saveFixedExpense(target, input, id) {
    normalize(target);
    const existing = target.gastosFixos.find(row => row.id === id);
    if (id && !existing) throw new Error("Este gasto fixo não está mais disponível.");
    if (!text(input.nome).trim()) throw new Error("Informe a descrição do gasto fixo.");
    if (!Number.isSafeInteger(input.valorCentavos) || input.valorCentavos <= 0 || input.valorCentavos > 999999999999) throw new Error("Informe um valor mensal maior que zero.");
    if (!Number.isInteger(Number(input.dia)) || Number(input.dia) < 1 || Number(input.dia) > 31) throw new Error("O vencimento deve ser um dia entre 1 e 31.");
    if (!["Ativo", "Pausado", "Cancelado"].includes(input.status)) throw new Error("Selecione uma situação válida.");
    if (!validMonth(input.recurrenceStart)) throw new Error("Informe a competência inicial da recorrência.");
    if (existing?.recurrenceStart && input.recurrenceStart !== existing.recurrenceStart) throw new Error("A competência inicial de uma recorrência já ativada deve ser preservada.");
    const categoryName = rememberCategory(target, input.categoria, "Saída");
    const record = { ...existing, ...input, id: existing?.id || uid(), nome: input.nome.trim(), dia: Number(input.dia), categoria: categoryName, responsavel: categoryName, tipo: "Saída", valor: -input.valorCentavos / 100, updatedAt: new Date().toISOString() };
    delete record.generateCurrent;
    if (!existing) record.createdAt = record.updatedAt;
    const index = target.gastosFixos.findIndex(row => row.id === record.id);
    if (index < 0) target.gastosFixos.push(record); else target.gastosFixos[index] = record;
    const month = today().slice(0, 7);
    if (input.generateCurrent && activeFixed(record) && record.recurrenceStart <= month) createFixedMovement(target, record, month);
    return record;
  }
  function generateFixedExpenses(target, month, { links = {} } = {}) {
    if (!validMonth(month)) throw new Error("Selecione a competência das contas a pagar.");
    normalize(target);
    const eligible = target.gastosFixos.filter(row => activeFixed(row) && (!row.recurrenceStart || row.recurrenceStart <= month) && !fixedMovement(target, row.id, month));
    const claimed = new Set();
    // Validate the entire review before mutating any financial record.
    eligible.forEach(row => {
      fixedDueDate(row, month);
      if (amountCents(row) <= 0) throw new Error(`Informe o valor mensal de ${row.nome}.`);
      const link = links[row.id];
      if (!link) {
        if (target.financeiro.some(item => item.id === `fixed:${row.id}:${month}`)) throw new Error("Há um lançamento com identificador conflitante. Revise o backup antes de gerar a competência.");
        return;
      }
      const movement = target.financeiro.find(item => item.id === link);
      if (!movement || direction(movement) !== "Saída" || isCancelled(movement) || movement.monthlyId || movement.investmentId || movement.fixedExpenseId || claimed.has(link)) throw new Error("Cada gasto fixo deve usar uma saída disponível e diferente.");
      claimed.add(link);
    });
    eligible.forEach(row => {
      const movement = links[row.id] && target.financeiro.find(item => item.id === links[row.id]);
      if (movement) Object.assign(movement, { fixedExpenseId: row.id, competencia: month, source: "gasto-fixo", updatedAt: new Date().toISOString() });
      else createFixedMovement(target, row, month);
      row.recurrenceStart ||= month;
    });
    return eligible.length;
  }
  function settleMovement(target, id, paidOn) {
    if (!validDate(paidOn)) throw new Error("Informe a data do recebimento ou pagamento.");
    const row = (target.financeiro || []).find(item => item.id === id);
    if (!row) throw new Error("Esta movimentação não está mais disponível.");
    if (row.investmentId || row.monthlyId) throw new Error("Registre a liquidação no módulo de origem.");
    if (isCancelled(row)) throw new Error("Reabra o lançamento cancelado antes de registrar a baixa.");
    if (isSettled(row)) return row;
    Object.assign(row, { status: "Pago", pagoEm: paidOn, updatedAt: new Date().toISOString() });
    return row;
  }

  function saveMovement(target, input, id) {
    normalize(target);
    validateMovement(input);
    const existing = target.financeiro.find(row => row.id === id);
    if (id && !existing) throw new Error("Esta movimentação não está mais disponível. Atualize a página.");
    if (existing?.investmentId) throw new Error("Edite esta saída no investimento vinculado.");
    if (existing?.monthlyId) throw new Error("Este recebimento pertence ao histórico de mensalidades, módulo desativado. O vínculo foi preservado.");
    if (existing?.fixedExpenseId && input.tipo !== "Saída") throw new Error("Uma parcela de gasto fixo deve permanecer como saída financeira.");
    const categoryName = rememberCategory(target, input.categoria, input.tipo);
    const record = { ...existing, ...input, id: existing?.id || uid(), nome: input.nome.trim(), categoria: categoryName, responsavel: categoryName, valor: input.valorCentavos / 100 * (input.tipo === "Saída" ? -1 : 1), status: isSettled(input) ? "Pago" : input.status, pagoEm: isSettled(input) ? input.pagoEm : "", updatedAt: new Date().toISOString() };
    if (!existing) record.createdAt = record.updatedAt;
    const index = target.financeiro.findIndex(row => row.id === record.id);
    if (index < 0) target.financeiro.push(record); else target.financeiro[index] = record;
    return record;
  }

  function detachInvestment(target, investment) {
    target.financeiro = target.financeiro.filter(row => {
      if (row.investmentId !== investment.id) return true;
      if (row.investmentGenerated) return false;
      delete row.investmentId;
      delete row.investmentGenerated;
      if (row.source === "investimento") delete row.source;
      return true;
    });
    investment.movementId = "";
  }

  function syncInvestment(target, investment) {
    normalize(target);
    if (investment.geraSaida === false) { detachInvestment(target, investment); return investment; }
    const linked = target.financeiro.filter(row => row.investmentId === investment.id);
    let movement = target.financeiro.find(row => row.id === investment.movementId) || linked[0];
    if (movement && (direction(movement) !== "Saída" || movement.monthlyId || movement.fixedExpenseId || (movement.investmentId && movement.investmentId !== investment.id))) throw new Error("A saída escolhida já possui outro vínculo ou não é uma saída financeira.");
    if (!movement) {
      movement = { id: uid(), createdAt: new Date().toISOString(), investmentGenerated: true };
      target.financeiro.push(movement);
    }
    // One investment owns exactly one ledger row. Generated duplicates are safe to remove;
    // externally created rows are detached and kept in the ledger.
    target.financeiro = target.financeiro.filter(row => {
      if (row.investmentId !== investment.id || row.id === movement.id) return true;
      if (row.investmentGenerated) return false;
      delete row.investmentId;
      delete row.investmentGenerated;
      if (row.source === "investimento") delete row.source;
      return true;
    });
    const realized = isRealized(investment);
    Object.assign(movement, {
      investmentId: investment.id, source: "investimento", nome: investment.nome,
      tipo: "Saída", categoria: investment.categoria, responsavel: investment.categoria,
      valorCentavos: amountCents(investment), valor: -amountCents(investment) / 100,
      data: investment.data, prazo: investment.data, pagoEm: realized ? investment.data : "",
      status: isCancelled(investment) ? "Cancelado" : realized ? "Pago" : "Pendente",
      observacoes: investment.observacoes || "", updatedAt: new Date().toISOString()
    });
    investment.movementId = movement.id;
    return investment;
  }

  function saveInvestment(target, input, id) {
    normalize(target);
    if (!text(input.nome).trim()) throw new Error("Informe o nome do investimento.");
    if (!Number.isSafeInteger(input.valorCentavos) || input.valorCentavos <= 0 || input.valorCentavos > 999999999999) throw new Error("Informe um valor maior que zero com até duas casas decimais.");
    if (!validDate(input.data)) throw new Error("Informe uma data válida.");
    if (!["Planejado", "Realizado", "Cancelado"].includes(input.status)) throw new Error("Selecione a situação do investimento.");
    const existing = target.investimentos.find(row => row.id === id);
    if (id && !existing) throw new Error("Este investimento não está mais disponível. Atualize a página.");
    const selected = input.movementId && target.financeiro.find(row => row.id === input.movementId);
    if (input.geraSaida !== false && input.movementId && (!selected || direction(selected) !== "Saída" || selected.monthlyId || selected.fixedExpenseId || selected.investmentId && selected.investmentId !== id)) throw new Error("A saída escolhida não está disponível para este investimento.");
    const categoryName = rememberCategory(target, input.categoria, "Saída");
    const record = { ...existing, ...input, id: existing?.id || uid(), nome: input.nome.trim(), categoria: categoryName, valor: input.valorCentavos / 100, updatedAt: new Date().toISOString() };
    if (!existing) record.createdAt = record.updatedAt;
    if (existing && (existing.movementId !== record.movementId || record.geraSaida === false)) detachInvestment(target, existing);
    const index = target.investimentos.findIndex(row => row.id === record.id);
    if (index < 0) target.investimentos.push(record); else target.investimentos[index] = record;
    syncInvestment(target, record);
    return record;
  }

  function removeMovement(target, id) {
    const record = target.financeiro.find(row => row.id === id);
    if (record?.investmentId || record?.monthlyId) throw new Error("Exclua o registro na origem para manter os vínculos do sistema.");
    if (record?.fixedExpenseId) throw new Error("Cancele esta parcela para preservar a competência e impedir a geração em duplicidade.");
    target.financeiro = target.financeiro.filter(row => row.id !== id);
  }

  function removeInvestment(target, id) {
    // Explicit deletion includes the linked ledger movement, as stated in the confirmation.
    target.financeiro = target.financeiro.filter(row => row.investmentId !== id);
    target.investimentos = target.investimentos.filter(row => row.id !== id);
  }

  function defaultFilters() {
    const date = today();
    const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
    return { from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`, query: "", category: "", type: "", status: "" };
  }
  function options(values, selected, first) {
    return (first !== undefined ? `<option value="">${safe(first)}</option>` : "") + values.map(value => `<option value="${safe(value)}" ${value === selected ? "selected" : ""}>${safe(value)}</option>`).join("");
  }
  function field(label, body, extra = "") {
    const labelled = body.replace(/<(input|select|textarea)(?=[\s>])/, `<$1 aria-label="${safe(label)}"`);
    return `<label class="ceo-field ${extra} ${extra.includes("ceo-field-wide") ? "wide" : ""}"><span>${safe(label)}</span>${labelled}</label>`;
  }
  function dateInput(name, value) { return `<input type="date" name="${name}" value="${safe(value)}" required>`; }
  function input(name, value, extra = "") { return `<input name="${name}" value="${safe(value)}" ${extra}>`; }
  function amountInput(value) { return input("amount", value ? (value / 100).toFixed(2).replace(".", ",") : "", 'inputmode="decimal" placeholder="0,00" required pattern="[0-9]+([,.][0-9]{1,2})?" title="Valor em reais, com até duas casas decimais; por exemplo, 1250,50."'); }
  function badge(row) {
    const overdue = !isSettled(row) && !isCancelled(row) && row.prazo && row.prazo < today();
    return `<span class="ceo-badge ${isSettled(row) ? "green" : isCancelled(row) ? "muted" : overdue ? "red" : "amber"}">${safe(isSettled(row) ? direction(row) === "Entrada" ? "Recebido" : "Pago" : overdue ? "Atrasado" : row.status || "Pendente")}</span>`;
  }
  function filterMarkup(filters, rows, investment) {
    const names = new Map();
    rows.forEach(row => { if (!names.has(categoryKey(category(row)))) names.set(categoryKey(category(row)), category(row)); });
    const categories = [...names.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (filters.category) {
      if (names.has(categoryKey(filters.category))) filters.category = names.get(categoryKey(filters.category));
      else categories.push(filters.category);
    }
    return `<div class="ceo-toolbar ceo-finance-filters">
      ${field("De", `<input type="date" data-filter="from" value="${safe(filters.from)}">`)}
      ${field("Até", `<input type="date" data-filter="to" value="${safe(filters.to)}">`)}
      ${field("Categoria", `<select data-filter="category">${options(categories, filters.category, "Todas")}</select>`)}
      ${!investment ? field("Tipo", `<select data-filter="type">${options(["Entrada", "Saída"], filters.type, "Todos")}</select>`) : ""}
      ${field("Situação", `<select data-filter="status">${options(investment ? ["Planejado", "Realizado", "Cancelado"] : ["Pendente", "Liquidado", "Agendado", "Atrasado", "Cancelado"], filters.status, "Todas")}</select>`)}
      ${field("Pesquisar", `<input type="search" data-filter="query" value="${safe(filters.query)}" placeholder="Descrição ou observação">`)}
      <button class="ceo-button" type="button" data-clear>Limpar filtros</button>
    </div>`;
  }
  function prepareMobileTable(container) {
    const table = container.querySelector('.ceo-table');
    if (!table) return;
    const headings = [...table.querySelectorAll('th')];
    table.classList.add('ceo-finance-table');
    table.classList.toggle('ceo-fixed-table', headings.length === 5);
    table.setAttribute('role', 'table');
    table.querySelectorAll('thead, tbody').forEach(group => group.setAttribute('role', 'rowgroup'));
    table.querySelectorAll('tr').forEach(row => row.setAttribute('role', 'row'));
    headings.forEach(heading => heading.setAttribute('role', 'columnheader'));
    table.querySelectorAll('tbody tr').forEach(row => [...row.cells].forEach((cell, index) => {
      cell.dataset.label = headings[index].textContent;
      cell.setAttribute('role', 'cell');
    }));
  }
  function financeRows(target, filters) {
    return (target.financeiro || []).filter(row => {
      if (!inPeriod(effectiveDate(row), filters)) return false;
      if (filters.category && categoryKey(category(row)) !== categoryKey(filters.category)) return false;
      if (filters.type && direction(row) !== filters.type) return false;
      if (filters.query && !word(`${row.nome} ${row.observacoes || ""}`).includes(word(filters.query))) return false;
      if (filters.status === "Liquidado" && !isSettled(row)) return false;
      if (filters.status === "Pendente" && (isSettled(row) || isCancelled(row))) return false;
      if (filters.status === "Atrasado" && (isSettled(row) || isCancelled(row) || !row.prazo || row.prazo >= today())) return false;
      if (filters.status && !["Liquidado", "Pendente", "Atrasado"].includes(filters.status) && row.status !== filters.status) return false;
      return true;
    }).sort((a, b) => effectiveDate(b).localeCompare(effectiveDate(a)) || text(b.createdAt).localeCompare(text(a.createdAt)));
  }
  function overdueBefore(target, before) {
    return (target.financeiro || []).filter(row => !isSettled(row) && !isCancelled(row) && row.prazo && row.prazo < today() && (!before || row.prazo < before));
  }
  function metric(label, value, tone = "") { return `<article class="ceo-card ceo-finance-metric"><span>${label}</span><strong class="${tone}">${formatMoney(value)}</strong></article>`; }
  function wireFilters(container, filters, renderFn) {
    container.querySelectorAll("[data-filter]").forEach(control => control.addEventListener("change", () => {
      filters[control.dataset.filter] = control.value;
      if (renderFn === renderFinance && control.dataset.filter === "status") {
        if (["Pendente", "Agendado", "Atrasado"].includes(control.value)) settings.chartMode = "pending";
        if (control.value === "Liquidado") settings.chartMode = "realized";
      }
      if (filters.from && filters.to && filters.from > filters.to) { control.setCustomValidity("O início do período deve ser anterior ao fim."); control.reportValidity(); return; }
      container.querySelectorAll("[data-filter]").forEach(element => element.setCustomValidity(""));
      renderFn(container);
    }));
    container.querySelector("[data-clear]").onclick = () => { Object.assign(filters, { from: "", to: "", query: "", category: "", type: "", status: "" }); renderFn(container); };
  }
  function categoryField(value, type, listId) {
    const names = categoryTools().list(current(), type, categoryAdapter());
    const selected = names.find(name => categoryKey(name) === categoryKey(value)) || value;
    if (selected && !names.includes(selected)) names.push(selected);
    return `<div class="ceo-field ceo-category-picker" data-category-picker data-category-type="${safe(type)}">
      <div class="ceo-category-picker-head"><label for="${listId}">Categoria</label><button class="ceo-button" type="button" data-new-category aria-controls="${listId}-new" aria-expanded="false">＋ Nova categoria</button></div>
      <select id="${listId}" name="categoria" data-category-select required aria-describedby="${listId}-hint">${options(names, selected)}</select>
      <small id="${listId}-hint" data-category-hint></small>
      <div id="${listId}-new" class="ceo-category-new" hidden>
        <label for="${listId}-name">Nome da nova categoria</label>
        ${input("categoria", "", `id="${listId}-name" data-category-name required disabled maxlength="80" pattern=".*\\S.*" title="Digite um nome para a categoria." autocomplete="off" aria-describedby="${listId}-new-hint"`)}
        <small id="${listId}-new-hint" data-new-category-hint></small>
      </div>
    </div>`;
  }
  function wireCategoryFields(element) {
    element.querySelectorAll("[data-category-picker]").forEach(picker => {
      const select = picker.querySelector("[data-category-select]"), name = picker.querySelector("[data-category-name]");
      const button = picker.querySelector("[data-new-category]"), panel = picker.querySelector(".ceo-category-new");
      const type = element.querySelector('[name="tipo"]');
      let previousType = picker.dataset.categoryType;
      const selectedByType = new Map([[previousType, select.value]]);
      function updateType() {
        const direction = type?.value || picker.dataset.categoryType, outgoing = direction === "Saída";
        if (direction !== previousType) {
          selectedByType.set(previousType, select.value);
          const names = categoryTools().list(current(), direction, categoryAdapter());
          const preferred = selectedByType.get(direction) || select.value;
          const fallback = outgoing ? "Outro" : "Receita";
          const selected = names.find(name => categoryKey(name) === categoryKey(preferred)) || names.find(name => categoryKey(name) === categoryKey(fallback));
          select.innerHTML = options(names, selected);
          previousType = direction;
        }
        picker.querySelector("[data-category-hint]").textContent = `Escolha uma categoria para suas ${outgoing ? "saídas" : "entradas"} ou cadastre uma nova.`;
        picker.querySelector("[data-new-category-hint]").textContent = `Será cadastrada para ${outgoing ? "saídas" : "entradas"} ao salvar e ficará disponível nos próximos lançamentos.`;
        name.placeholder = outgoing ? "Ex.: Alimentação da equipe" : "Ex.: Consultoria";
      }
      button.onclick = () => {
        const creating = panel.hidden;
        panel.hidden = !creating; select.disabled = creating; name.disabled = !creating;
        select.hidden = creating; picker.querySelector("[data-category-hint]").hidden = creating;
        button.setAttribute("aria-expanded", String(creating));
        button.textContent = creating ? "Cancelar nova categoria" : "＋ Nova categoria";
        (creating ? name : select).focus();
      };
      type?.addEventListener("change", updateType);
      updateType();
    });
  }
  function openCategories() {
    const element = dialog("Categorias financeiras", `<p>Organize suas entradas e saídas com categorias que fazem sentido para a ZAMA.</p><div class="ceo-form-grid">
      ${field("Usar em", `<select name="tipo">${options(["Saída", "Entrada"], "Saída")}</select>`)}
      ${field("Nome da categoria", input("nome", "", 'required maxlength="80" autocomplete="off" placeholder="Ex.: Alimentação, Aluguel, Consultoria"'))}
      <section class="ceo-field-wide ceo-category-catalog"><h3>Categorias disponíveis</h3><p>Você já pode usá-las nos seus lançamentos.</p><div data-category-list class="ceo-category-chips"></div></section></div>`, "Cadastrar categoria", values => {
      // Validate before committing so a helpful field error stays in the dialog.
      categoryTools().saveCategory(structuredClone(current()), values, categoryAdapter());
      return ceoCommit(draft => categoryTools().saveCategory(draft, values, categoryAdapter()), "Categoria cadastrada.");
    });
    const type = element.querySelector('[name="tipo"]');
    function updateList() {
      element.querySelector("[data-category-list]").innerHTML = categoryTools().list(current(), type.value, categoryAdapter()).map(name => `<span>${safe(name)}</span>`).join("");
    }
    type.addEventListener("change", updateList); updateList();
    return element;
  }
  function categoryChart(group, type, mode) {
    const outgoing = type === "Saída", pending = mode === "pending", circular = settings.chartStyle === "circle";
    const title = outgoing ? "Para onde vai o dinheiro" : "De onde vem o dinheiro";
    const label = outgoing ? pending ? "Total a pagar" : "Total pago" : pending ? "Total a receber" : "Total recebido";
    const percent = value => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;
    const colors = ["#171717", "#777777", "#b6b6b6", "#424242", "#959595", "#d2d2d2", "#606060", "#a6a6a6"];
    let offset = 0;
    const donut = circular ? `<div class="ceo-category-donut-wrap"><svg class="ceo-category-donut" viewBox="0 0 200 200" role="img" aria-label="${group.categories.length ? `Distribuição de ${outgoing ? "saídas" : "entradas"} em ${group.categories.length} ${group.categories.length === 1 ? "categoria" : "categorias"}. Valores na legenda.` : "Nenhum valor para distribuir"}"><circle class="ceo-category-donut-base" cx="100" cy="100" r="78" fill="none" stroke-width="28"></circle>${group.categories.map((item, index) => {
      const share = Math.max(0, Math.min(100, item.percentage)), start = offset;
      offset += share;
      return `<circle data-chart-segment="${safe(item.name)}" cx="100" cy="100" r="78" fill="none" stroke="${colors[index % colors.length]}" stroke-width="28" pathLength="100" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-start}" transform="rotate(-90 100 100)"><title>${safe(item.name)}: ${formatMoney(item.totalCents)} · ${percent(item.percentage)}</title></circle>`;
    }).join("")}</svg><div class="ceo-category-donut-center" aria-hidden="true"><strong>${group.categories.length}</strong><span>${group.categories.length === 1 ? "categoria" : "categorias"}</span></div></div>` : "";
    return `<article class="ceo-card ceo-category-chart" data-category-chart="${outgoing ? "expense" : "income"}" data-chart-view="${circular ? "circle" : "bars"}" aria-label="${title}">
      <div class="ceo-category-chart-head"><span class="ceo-category-icon ${outgoing ? "" : "income"}" aria-hidden="true">${outgoing ? "↗" : "↙"}</span><div><span class="ceo-category-eyebrow">${outgoing ? "Saídas" : "Entradas"} por categoria</span><h3>${title}</h3></div></div>
      <div class="ceo-category-total"><strong>${formatMoney(group.totalCents)}</strong><span>${label} no período filtrado</span></div>
      ${donut}
      ${group.categories.length ? `<ol class="ceo-category-bars${circular ? " ceo-category-legend" : ""}">${group.categories.map((item, index) => `<li><button type="button" class="ceo-category-bar-button" data-chart-category="${safe(item.name)}" data-chart-type="${type}" aria-label="Ver lançamentos de ${safe(item.name)} (${type})" aria-describedby="chart-${outgoing ? "expense" : "income"}-${index}"><span class="ceo-category-bar-label"><span${circular ? ' class="ceo-category-legend-name"' : ""}>${circular ? `<i class="ceo-category-swatch" style="background:${colors[index % colors.length]}" aria-hidden="true"></i><span>${safe(item.name)}</span>` : safe(item.name)}</span><span id="chart-${outgoing ? "expense" : "income"}-${index}" class="ceo-category-bar-numbers"><strong>${formatMoney(item.totalCents)}</strong><small>${percent(item.percentage)}</small></span></span>${circular ? "" : `<span class="ceo-category-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, item.percentage))}%"></span></span>`}</button></li>`).join("")}</ol><p class="ceo-category-footnote">Clique em uma categoria para ver seus lançamentos.</p>` : `<div class="ceo-category-empty">${circular ? "" : `<span aria-hidden="true">${outgoing ? "↗" : "↙"}</span>`}<strong>Nenhuma ${outgoing ? "saída" : "entrada"} ${pending ? "pendente" : outgoing ? "paga" : "recebida"}</strong><p>Cadastre uma movimentação ou ajuste os filtros para visualizar a distribuição.</p></div>`}
    </article>`;
  }
  function categoryCharts(rows) {
    const mode = settings.chartMode, groups = categoryTools().summarize(rows, categoryAdapter(), mode);
    return `<section class="ceo-category-analysis" aria-label="Gráficos por categoria"><div class="ceo-category-analysis-head"><div><h2>Seu dinheiro, por categoria</h2><p>Valores e percentuais conforme os filtros selecionados. Cancelados ficam fora dos gráficos.</p></div><div class="ceo-chart-controls"><div class="ceo-chart-modes" role="group" aria-label="Valores dos gráficos"><button type="button" data-chart-mode="realized" aria-pressed="${mode === "realized"}">Pagos e recebidos</button><button type="button" data-chart-mode="pending" aria-pressed="${mode === "pending"}">A pagar e receber</button></div><div class="ceo-chart-modes ceo-chart-styles" role="group" aria-label="Formato dos gráficos"><button type="button" data-chart-style="bars" aria-pressed="${settings.chartStyle === "bars"}">Barras</button><button type="button" data-chart-style="circle" aria-pressed="${settings.chartStyle === "circle"}">Círculo</button></div></div></div><div class="ceo-category-chart-grid">${categoryChart(groups.expense, "Saída", mode)}${categoryChart(groups.income, "Entrada", mode)}</div></section>`;
  }
  function renderFinance(container) {
    const target = current(); normalize(target);
    const filters = settings.finance ||= defaultFilters();
    const sum = totals(target, filters), rows = financeRows(target, filters);
    const older = filters.from ? overdueBefore(target, filters.from) : [];
    container.innerHTML = `<div class="ceo-toolbar"><div><h2>Movimentações financeiras</h2><p>Entradas, saídas e compromissos da ZAMA.</p></div><div class="ceo-row-actions"><button class="ceo-button" data-categories>Categorias</button><button class="ceo-button" data-fixed>Gastos fixos</button><button class="ceo-button primary" data-new>＋ Nova movimentação</button></div></div>
      <div class="ceo-grid ceo-finance-summary">${metric("Entradas recebidas", sum.incomeCents, "money-positive")}${metric("Saídas pagas", sum.expenseCents, "money-negative")}${metric("Saldo do período", sum.balanceCents)}${metric("A receber", sum.receivableCents)}${metric("A pagar", sum.payableCents)}</div>
      ${older.length ? `<section class="ceo-card ceo-toolbar"><div><strong>${older.length} ${older.length === 1 ? "pendência vencida anterior" : "pendências vencidas anteriores"} ao período</strong><p>${formatMoney(older.filter(row => direction(row) === "Saída").reduce((sum, row) => sum + amountCents(row), 0))} a pagar · ${formatMoney(older.filter(row => direction(row) === "Entrada").reduce((sum, row) => sum + amountCents(row), 0))} a receber</p></div><button class="ceo-button" data-overdue>Ver todas as vencidas</button></section>` : ""}
      <section class="ceo-card"><div class="ceo-toolbar"><button class="ceo-button" data-account="all" aria-pressed="${!filters.type && !filters.status}">Todas as movimentações</button><button class="ceo-button" data-account="payable" aria-pressed="${filters.type === "Saída" && filters.status === "Pendente"}">Contas a pagar</button><button class="ceo-button" data-account="receivable" aria-pressed="${filters.type === "Entrada" && filters.status === "Pendente"}">Contas a receber</button></div>
      ${filterMarkup(filters, target.financeiro, false)}<p class="ceo-muted">Os indicadores e gráficos acompanham estes filtros. Valores pagos ou recebidos usam a data da baixa; pendências usam o vencimento.</p></section>
      ${categoryCharts(rows)}
      <section class="ceo-card" data-finance-ledger><div class="ceo-toolbar"><div><h2>Lançamentos</h2><p>${rows.length} ${rows.length === 1 ? "movimentação encontrada" : "movimentações encontradas"}.</p></div></div>
      ${rows.length ? `<div class="ceo-table-wrap ceo-table-scroll"><table class="ceo-table"><thead><tr><th>Descrição / categoria</th><th>Tipo</th><th>Data / vencimento</th><th>Situação</th><th>Valor</th><th>Ações</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${safe(row.nome || "Sem descrição")}</strong><br><small>${safe(category(row))}${row.investmentId ? " · Investimento vinculado" : row.monthlyId ? " \u00b7 Mensalidade vinculada" : row.fixedExpenseId ? ` \u00b7 Gasto fixo \u00b7 ${monthLabel(row.competencia)}` : ""}</small></td><td>${safe(direction(row))}</td><td>${dateLabel(row.data || row.prazo)}<br><small>Vence ${dateLabel(row.prazo)}${isSettled(row) ? `<br>Liquidado ${dateLabel(effectiveDate(row))}` : ""}</small></td><td>${badge(row)}</td><td class="${direction(row) === "Entrada" ? "money-positive" : "money-negative"}">${direction(row) === "Entrada" ? "+" : "−"} ${formatMoney(amountCents(row))}</td><td><div class="ceo-row-actions">${!isSettled(row) && !isCancelled(row) && !row.investmentId && !row.monthlyId ? `<button class="ceo-button" data-settle="${safe(row.id)}" aria-label="Registrar baixa de ${safe(row.nome)}">Registrar baixa</button>` : ""}<button class="ceo-button" data-edit="${safe(row.id)}" aria-label="Editar ${safe(row.nome)}">Editar</button><button class="ceo-button" data-delete="${safe(row.id)}" aria-label="${row.fixedExpenseId ? "Cancelar parcela de" : "Excluir"} ${safe(row.nome)}">${row.fixedExpenseId ? "Cancelar parcela" : "Excluir"}</button></div></td></tr>`).join("")}</tbody></table></div>` : '<div class="ceo-empty"><strong>Nenhuma movimentação neste período</strong><p>Cadastre uma entrada ou saída, ou ajuste os filtros.</p></div>'}</section>`;
    prepareMobileTable(container);
    wireFilters(container, filters, renderFinance);
    container.querySelector("[data-new]").onclick = () => openMovement();
    container.querySelector("[data-categories]").onclick = () => openCategories();
    container.querySelectorAll("[data-chart-mode]").forEach(button => button.onclick = () => {
      settings.chartMode = button.dataset.chartMode;
      if (settings.chartMode === "pending" && filters.status === "Liquidado" || settings.chartMode === "realized" && ["Pendente", "Agendado", "Atrasado"].includes(filters.status)) filters.status = "";
      renderFinance(container);
    });
    container.querySelectorAll("[data-chart-style]").forEach(button => button.onclick = () => {
      settings.chartStyle = button.dataset.chartStyle;
      renderFinance(container);
    });
    container.querySelectorAll("[data-chart-category]").forEach(button => button.onclick = () => {
      const status = settings.chartMode === "pending" ? ["Pendente", "Agendado", "Atrasado"].includes(filters.status) ? filters.status : "Pendente" : "Liquidado";
      Object.assign(filters, { category: button.dataset.chartCategory, type: button.dataset.chartType, status });
      renderFinance(container);
      container.querySelector("[data-finance-ledger]").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    container.querySelector("[data-fixed]").onclick = () => goToModule("financeiro", { financeView: "fixos" });
    container.querySelector("[data-overdue]")?.addEventListener("click", () => { Object.assign(filters, { from: "", to: "", type: "", category: "", query: "", status: "Atrasado" }); settings.chartMode = "pending"; renderFinance(container); });
    container.querySelectorAll("[data-account]").forEach(button => button.onclick = () => { filters.type = button.dataset.account === "payable" ? "Saída" : button.dataset.account === "receivable" ? "Entrada" : ""; filters.status = button.dataset.account === "all" ? "" : "Pendente"; settings.chartMode = button.dataset.account === "all" ? "realized" : "pending"; renderFinance(container); });
    container.querySelectorAll("[data-edit]").forEach(button => button.onclick = () => openMovement(button.dataset.edit));
    container.querySelectorAll("[data-delete]").forEach(button => button.onclick = () => deleteMovementUI(button.dataset.delete));
    container.querySelectorAll("[data-settle]").forEach(button => button.onclick = () => openSettlement(button.dataset.settle));
  }

  function renderFixedExpenses(container) {
    const target = current(); normalize(target);
    const month = settings.fixedMonth ||= today().slice(0, 7);
    const rows = target.gastosFixos;
    const eligible = rows.filter(row => activeFixed(row) && (!row.recurrenceStart || row.recurrenceStart <= month));
    const pending = eligible.filter(row => !fixedMovement(target, row.id, month));
    const generated = target.financeiro.filter(row => row.fixedExpenseId && row.competencia === month);
    container.innerHTML = `<div class="ceo-toolbar"><div><h2>Gastos fixos</h2><p>Organize as despesas recorrentes e gere as contas de cada mês.</p></div><div class="ceo-row-actions"><button class="ceo-button" data-back>Voltar ao financeiro</button><button class="ceo-button primary" data-new-fixed>＋ Novo gasto fixo</button></div></div>
      <div class="ceo-grid ceo-finance-summary">${metric("Total mensal ativo", rows.filter(activeFixed).reduce((sum, row) => sum + amountCents(row), 0))}${metric("A pagar na competência", generated.filter(row => !isSettled(row) && !isCancelled(row)).reduce((sum, row) => sum + amountCents(row), 0))}${metric("Pago na competência", generated.filter(isSettled).reduce((sum, row) => sum + amountCents(row), 0))}</div>
      <section class="ceo-card"><div class="ceo-toolbar">${field("Competência", `<input type="month" data-fixed-month value="${safe(month)}" required>`)}<button class="ceo-button primary" data-generate ${pending.length ? "" : "disabled"}>Gerar contas do mês (${pending.length})</button></div><p class="ceo-muted">Revise os lançamentos existentes antes de gerar. Cada gasto tem uma única parcela por competência. Pagamentos são registrados no financeiro. Alterar um cadastro afeta apenas as próximas parcelas.</p>
      ${rows.length ? `<div class="ceo-table-scroll"><table class="ceo-table"><thead><tr><th>Despesa / categoria</th><th>Vencimento</th><th>Valor mensal</th><th>Cadastro / competência</th><th>Ações</th></tr></thead><tbody>${rows.map(row => { const movement = fixedMovement(target, row.id, month); return `<tr><td><strong>${safe(row.nome)}</strong><br><small>${safe(category(row))}</small></td><td>Dia ${safe(row.dia)}<br><small>${dateLabel(fixedDueDate(row, month))}</small></td><td>${formatMoney(amountCents(row))}</td><td><span class="ceo-badge ${activeFixed(row) ? "green" : "muted"}">${safe(row.status || "Ativo")}</span><br><small>${movement ? isSettled(movement) ? "Parcela paga" : isCancelled(movement) ? "Parcela cancelada" : "Conta a pagar gerada" : row.recurrenceStart > month ? `Início em ${monthLabel(row.recurrenceStart)}` : activeFixed(row) ? "Aguardando geração" : "Geração suspensa"}</small></td><td><div class="ceo-row-actions"><button class="ceo-button" data-edit-fixed="${safe(row.id)}" aria-label="Editar gasto fixo ${safe(row.nome)}">Editar cadastro</button>${movement ? `<button class="ceo-button" data-open-fixed="${safe(movement.id)}">Ver parcela</button>` : ""}</div></td></tr>`; }).join("")}</tbody></table></div>` : '<div class="ceo-empty"><strong>Nenhum gasto fixo cadastrado</strong><p>Cadastre aluguel, ferramentas, assinaturas e outras despesas mensais.</p></div>'}</section>`;
    prepareMobileTable(container);
    container.querySelector("[data-back]").onclick = () => goToModule("financeiro", { financeView: "movimentacoes" });
    container.querySelector("[data-new-fixed]").onclick = () => openFixedExpense();
    container.querySelector("[data-fixed-month]").onchange = event => { if (validMonth(event.target.value)) { settings.fixedMonth = event.target.value; renderFixedExpenses(container); } };
    container.querySelector("[data-generate]").onclick = () => openFixedGeneration(month);
    container.querySelectorAll("[data-edit-fixed]").forEach(button => button.onclick = () => openFixedExpense(button.dataset.editFixed));
    container.querySelectorAll("[data-open-fixed]").forEach(button => button.onclick = () => openMovement(button.dataset.openFixed));
  }

  function openFixedExpense(id) {
    const row = current().gastosFixos.find(item => item.id === id);
    const data = { nome: "", categoria: "Outro", dia: 5, status: "Ativo", recurrenceStart: today().slice(0, 7), ...row };
    return dialog(row ? "Editar gasto fixo" : "Novo gasto fixo", `<p>Gere as parcelas mensais na competência desejada. Pausar ou cancelar o cadastro suspende novas parcelas e preserva o histórico.</p><div class="ceo-form-grid">
      ${field("Descrição", input("nome", data.nome, 'required maxlength="180"'))}${field("Valor mensal (R$)", amountInput(row ? amountCents(row) : 0))}
      ${categoryField(row ? category(row) : data.categoria, "Saída", "ceo-fixed-categories")}${field("Dia do vencimento", input("dia", data.dia, 'type="number" min="1" max="31" step="1" required') + '<small>Dias 29, 30 e 31 são ajustados ao último dia do mês.</small>')}
      ${field("Situação", `<select name="status">${options(["Ativo", "Pausado", "Cancelado"], data.status)}</select>`)}${field("Competência inicial", `<input type="month" name="recurrenceStart" value="${safe(data.recurrenceStart)}" ${row?.recurrenceStart ? "readonly" : ""} required>`)}
      ${field("Observações", `<textarea name="observacoes" rows="3" maxlength="5000">${safe(data.observacoes || "")}</textarea>`, "ceo-field-wide")}
      ${!row ? `<label class="ceo-field ceo-field-wide ceo-checkbox"><input type="checkbox" name="generateCurrent" checked><span>Gerar a conta do mês atual ao salvar, se a competência inicial já tiver começado.</span></label>` : '<p class="ceo-field-wide ceo-muted">As parcelas já geradas mantêm o valor, o vencimento e a situação originais. Para ajustar uma parcela, use “Ver parcela”.</p>'}</div>`, "Salvar gasto fixo", values => {
        const record = { ...values, dia: Number(values.dia), valorCentavos: cents(values.amount), generateCurrent: values.generateCurrent === "on" }; delete record.amount;
        return ceoCommit(draft => saveFixedExpense(draft, record, id), "Gasto fixo salvo.");
      });
  }

  function openFixedGeneration(month) {
    const target = current();
    const rows = target.gastosFixos.filter(row => activeFixed(row) && (!row.recurrenceStart || row.recurrenceStart <= month) && !fixedMovement(target, row.id, month));
    const available = target.financeiro.filter(row => direction(row) === "Saída" && !row.fixedExpenseId && !row.investmentId && !row.monthlyId && !isCancelled(row));
    return dialog(`Gerar contas de ${monthLabel(month)}`, `<p>Se a despesa já foi lançada, vincule o registro existente para evitar duplicidade. O valor e o pagamento desse registro serão preservados.</p><div class="ceo-form-grid">${rows.map((row, index) => field(`${row.nome} · ${formatMoney(amountCents(row))}`, `<select name="link-${index}"><option value="">Criar nova conta a pagar · ${dateLabel(fixedDueDate(row, month))}</option>${available.map(item => `<option value="${safe(item.id)}">Vincular: ${safe(item.nome)} · ${formatMoney(amountCents(item))} · ${dateLabel(item.prazo || item.data)} · ${safe(item.status)}</option>`).join("")}</select>`, "ceo-field-wide")).join("")}</div>`, "Confirmar geração", values => {
      const links = Object.fromEntries(rows.map((row, index) => [row.id, values[`link-${index}`] || ""]));
      return ceoCommit(draft => generateFixedExpenses(draft, month, { links }), "Contas do mês geradas.");
    });
  }

  function openSettlement(id) {
    const row = current().financeiro.find(item => item.id === id);
    if (!row) return;
    return dialog(direction(row) === "Entrada" ? "Registrar recebimento" : "Registrar pagamento", `<p><strong>${safe(row.nome)}</strong> · ${formatMoney(amountCents(row))}</p>${field("Data do recebimento / pagamento", dateInput("pagoEm", today()))}`, "Confirmar baixa", values => ceoCommit(draft => settleMovement(draft, id, values.pagoEm), "Baixa registrada."));
  }

  function renderInvestments(container) {
    const target = current(); normalize(target);
    const filters = settings.investments ||= defaultFilters();
    const rows = target.investimentos.filter(row => inPeriod(row.data || "", filters) && (!filters.category || categoryKey(category(row)) === categoryKey(filters.category)) && (!filters.status || row.status === filters.status) && (!filters.query || word(`${row.nome} ${row.objetivo || ""} ${row.observacoes || ""}`).includes(word(filters.query)))).sort((a, b) => text(b.data).localeCompare(text(a.data)));
    const realized = rows.filter(isRealized).reduce((sum, row) => sum + amountCents(row), 0), planned = rows.filter(row => row.status === "Planejado").reduce((sum, row) => sum + amountCents(row), 0);
    container.innerHTML = `<div class="ceo-toolbar"><div><h2>Crescimento da ZAMA</h2><p>Invista com clareza de propósito e acompanhe a execução.</p></div><button class="ceo-button primary" data-new>＋ Novo investimento</button></div>
      <div class="ceo-grid ceo-finance-summary">${metric("Investimentos realizados", realized)}${metric("Investimentos planejados", planned)}<article class="ceo-card ceo-finance-metric"><span>Contabilização</span><p>Saídas vinculadas entram uma única vez no saldo financeiro.</p></article></div>
      <section class="ceo-card">${filterMarkup(filters, target.investimentos, true)}${rows.length ? `<div class="ceo-grid ceo-investment-grid">${rows.map(row => `<article class="ceo-card ceo-investment-card"><div class="ceo-toolbar"><span class="ceo-badge">${safe(row.categoria || "Outro")}</span><span class="ceo-badge ${isRealized(row) ? "green" : isCancelled(row) ? "muted" : "amber"}">${safe(row.status)}</span></div><h3>${safe(row.nome)}</h3><strong class="ceo-investment-value">${formatMoney(amountCents(row))}</strong><p>${safe(row.objetivo || "Objetivo ainda não informado.")}</p><small>${dateLabel(row.data)} · ${row.movementId ? isRealized(row) ? "Incluído nas saídas pagas" : isCancelled(row) ? "Saída cancelada" : "Incluído nas contas a pagar" : "Sem saída financeira vinculada"}</small>${row.observacoes ? `<p class="ceo-muted">${safe(row.observacoes)}</p>` : ""}<div class="ceo-row-actions"><button class="ceo-button" data-edit="${safe(row.id)}" aria-label="Editar ${safe(row.nome)}">Editar</button><button class="ceo-button" data-delete="${safe(row.id)}" aria-label="Excluir ${safe(row.nome)}">Excluir</button></div></article>`).join("")}</div>` : '<div class="ceo-empty"><strong>Nenhum investimento neste período</strong><p>Registre seu próximo investimento em marketing, produto ou equipamentos.</p></div>'}</section>`;
    wireFilters(container, filters, renderInvestments);
    container.querySelector("[data-new]").onclick = () => openInvestment();
    container.querySelectorAll("[data-edit]").forEach(button => button.onclick = () => openInvestment(button.dataset.edit));
    container.querySelectorAll("[data-delete]").forEach(button => button.onclick = () => confirmAction("Excluir investimento?", "O investimento e sua saída financeira vinculada serão excluídos. O saldo será recalculado.", draft => removeInvestment(draft, button.dataset.delete), "Investimento excluído."));
  }

  function dialog(title, content, submitLabel, onSubmit) {
    const element = document.createElement("dialog"); element.className = "ceo-dialog";
    const titleId = uid(); element.setAttribute("aria-labelledby", titleId);
    element.innerHTML = `<form class="ceo-finance-form"><div class="ceo-toolbar"><h2 id="${safe(titleId)}">${safe(title)}</h2><button type="button" class="ceo-button" data-close aria-label="Fechar">✕</button></div>${content}<p class="ceo-form-error" role="alert" hidden></p><div class="ceo-toolbar ceo-dialog-actions"><button class="ceo-button" type="button" data-close>Cancelar</button><button class="ceo-button primary" type="submit">${safe(submitLabel)}</button></div></form>`;
    const previousFocus = document.activeElement;
    global.ZamaMobileForms?.prepare(element);
    document.body.appendChild(element);
    element.querySelectorAll("[data-close]").forEach(button => button.onclick = () => element.close());
    element.addEventListener("close", () => { element.remove(); if (previousFocus?.isConnected) previousFocus.focus(); });
    element.querySelector("form").onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget, error = form.querySelector("[role=alert]"); error.hidden = true;
      const buttons = form.querySelectorAll("button"); buttons.forEach(button => button.disabled = true);
      try {
        const result = await onSubmit(Object.fromEntries(new FormData(form)), form);
        if (result === false) throw new Error("Não foi possível salvar. Confira a conexão e tente novamente.");
        element.close();
      } catch (failure) { error.textContent = failure.message || "Não foi possível concluir a ação."; error.hidden = false; buttons.forEach(button => button.disabled = false); }
    };
    wireCategoryFields(element);
    element.showModal(); return element;
  }
  function confirmAction(title, message, mutate, success) { return dialog(title, `<p>${safe(message)}</p>`, "Confirmar exclusão", () => ceoCommit(mutate, success)); }
  function monthlyDialog() {
    return dialog("Recebimento histórico", "<p>Este recebimento pertence ao histórico de mensalidades. O módulo foi desativado e o valor original foi preservado. O backup permite exportar este registro.</p>", "Entendi", () => true);
  }
  function deleteMovementUI(id) {
    const row = current().financeiro.find(item => item.id === id);
    if (!row) return;
    if (row.investmentId) return openInvestment(row.investmentId);
    if (row.monthlyId) return monthlyDialog();
    if (row.fixedExpenseId) return dialog("Cancelar parcela?", `<p>A parcela de ${safe(monthLabel(row.competencia))} será cancelada e mantida no histórico. Ela não será gerada novamente. As próximas competências continuam conforme o cadastro.</p>`, "Confirmar cancelamento", () => ceoCommit(draft => {
      const movement = draft.financeiro.find(item => item.id === id);
      if (!movement) throw new Error("Esta parcela não está mais disponível.");
      movement.status = "Cancelado"; movement.pagoEm = ""; movement.updatedAt = new Date().toISOString();
    }, "Parcela cancelada."));
    confirmAction("Excluir movimentação?", `“${row.nome}” será excluída e os indicadores serão recalculados.`, draft => removeMovement(draft, id), "Movimentação excluída.");
  }
  function openMovement(id) {
    const row = current().financeiro.find(item => item.id === id);
    if (row?.investmentId) return openInvestment(row.investmentId);
    if (row?.monthlyId) return monthlyDialog();
    const data = { tipo: "Entrada", categoria: "Receita", data: row?.data || row?.prazo || today(), prazo: today(), status: "Pendente", ...row };
    data.tipo = direction(data); data.categoria = row ? category(row) : data.categoria;
    // Older records use equivalent labels that are not options in this form.
    // Keep their settlement state when editing unrelated fields.
    if (isSettled(data)) data.status = "Pago";
    else if (isCancelled(data)) data.status = "Cancelado";
    const element = dialog(row ? "Editar movimentação" : "Nova movimentação", `<div class="ceo-form-grid">
      ${field("Descrição", input("nome", data.nome || "", 'required maxlength="180"'))}
      ${field("Valor (R$)", amountInput(row ? amountCents(row) : 0))}
      ${field("Tipo", `<select name="tipo">${options(["Entrada", "Saída"], data.tipo)}</select>`)}
      ${categoryField(data.categoria, data.tipo, "ceo-finance-categories")}
      ${field("Data do lançamento", dateInput("data", data.data || data.prazo || today()))}
      ${field("Vencimento", dateInput("prazo", data.prazo || data.data || today()))}
      ${field("Situação", `<select name="status">${options(["Pendente", "Pago", "Recebido", "Agendado", "Atrasado", "Cancelado"], data.status)}</select>`)}
      ${field("Data do recebimento / pagamento", `<input type="date" name="pagoEm" value="${safe(data.pagoEm || (isSettled(data) ? data.data || data.prazo || today() : today()))}">`)}
      ${field("Observações", `<textarea name="observacoes" rows="3" maxlength="5000">${safe(data.observacoes || "")}</textarea>`, "ceo-field-wide")}</div>`, "Salvar movimentação", values => {
      const record = { ...values, valorCentavos: cents(values.amount) }; delete record.amount;
      validateMovement(record);
      return ceoCommit(draft => saveMovement(draft, record, id), "Movimentação salva.");
    });
    const status = element.querySelector('[name="status"]'), paid = element.querySelector('[name="pagoEm"]');
    function updatePaid() { paid.disabled = !isSettled({ status: status.value }); paid.required = !paid.disabled; }
    status.addEventListener("change", updatePaid); updatePaid();
    return element;
  }

  function openInvestment(id) {
    const target = current(); normalize(target);
    const row = target.investimentos.find(item => item.id === id);
    const data = { data: today(), status: "Planejado", categoria: "Marketing", geraSaida: true, ...row };
    const available = target.financeiro.filter(item => direction(item) === "Saída" && !item.monthlyId && !item.fixedExpenseId && (!item.investmentId || item.investmentId === id));
    const element = dialog(row ? "Editar investimento" : "Novo investimento", `<div class="ceo-form-grid">
      ${field("Nome", input("nome", data.nome || "", 'required maxlength="180"'))}
      ${field("Valor (R$)", amountInput(row ? amountCents(row) : 0))}
      ${categoryField(data.categoria, "Saída", "ceo-investment-categories")}
      ${field("Data prevista / realizada", dateInput("data", data.data))}
      ${field("Situação", `<select name="status">${options(["Planejado", "Realizado", "Cancelado"], data.status)}</select>`)}
      ${field("Objetivo", input("objetivo", data.objetivo || "", 'maxlength="500"'))}
      ${field("Observações", `<textarea name="observacoes" rows="3" maxlength="5000">${safe(data.observacoes || "")}</textarea>`, "ceo-field-wide")}
      <label class="ceo-field ceo-field-wide wide ceo-checkbox"><input type="checkbox" name="geraSaida" ${data.geraSaida !== false ? "checked" : ""}><span>Vincular ao financeiro: a pagar quando planejado e pago quando realizado.</span></label>
      ${field("Saída financeira vinculada", `<select name="movementId"><option value="">Criar saída automaticamente</option>${available.map(item => `<option value="${safe(item.id)}" ${data.movementId === item.id ? "selected" : ""}>${safe(item.nome)} · ${formatMoney(amountCents(item))}</option>`).join("")}</select><small>O valor, a data e a situação da saída escolhida acompanharão este investimento. Selecione uma saída existente para evitar duplicidade.</small>`, "ceo-field-wide")}
      </div>`, "Salvar investimento", values => {
      const record = { ...values, geraSaida: values.geraSaida === "on", valorCentavos: cents(values.amount) }; delete record.amount;
      return ceoCommit(draft => saveInvestment(draft, record, id), "Investimento salvo.");
    });
    const linked = element.querySelector('[name="movementId"]'), enabled = element.querySelector('[name="geraSaida"]');
    const updateLinked = () => { linked.disabled = !enabled.checked; };
    enabled.addEventListener("change", updateLinked); updateLinked();
    linked.addEventListener("change", () => {
      const movement = available.find(item => item.id === linked.value);
      if (!movement || (id && movement.investmentId === id)) return;
      element.querySelector('[name="amount"]').value = (amountCents(movement) / 100).toFixed(2).replace(".", ",");
      element.querySelector('[name="data"]').value = effectiveDate(movement) || today();
      element.querySelector('[name="status"]').value = isCancelled(movement) ? "Cancelado" : isSettled(movement) ? "Realizado" : "Planejado";
    });
    return element;
  }

  function reset() { settings.finance = null; settings.investments = null; settings.fixedMonth = ""; settings.chartMode = "realized"; settings.chartStyle = "bars"; }
  function reportMonth() { return (settings.finance?.from || settings.finance?.to || today()).slice(0, 7); }
  global.ZamaFinance = { normalize, totals, cents, amountCents, direction, isSettled, isCancelled, isRealized, effectiveDate, formatMoney, validDate, saveMovement, removeMovement, saveInvestment, removeInvestment, syncInvestment, financeRows, renderFinance, renderInvestments, openMovement, openInvestment, saveFixedExpense, generateFixedExpenses, fixedDueDate, fixedMovement, settleMovement, overdueBefore, renderFixedExpenses, openFixedExpense, reset, reportMonth };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ZamaFinance;
})(typeof window !== "undefined" ? window : globalThis);
