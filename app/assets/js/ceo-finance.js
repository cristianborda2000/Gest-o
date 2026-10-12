/* Financial ledger and investment register. Integer cents are the accounting unit.
   Existing JSON fields and linked monthly subscriptions remain compatible. */
(function (global) {
  "use strict";
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const settings = { finance: null, investments: null, fixedMonth: "" };
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
  const category = row => row.categoria || row.responsavel || "Outro";

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
    const record = { ...existing, ...input, id: existing?.id || uid(), nome: input.nome.trim(), dia: Number(input.dia), categoria: text(input.categoria).trim() || "Outro", responsavel: text(input.categoria).trim() || "Outro", tipo: "Saída", valor: -input.valorCentavos / 100, updatedAt: new Date().toISOString() };
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
    const record = { ...existing, ...input, id: existing?.id || uid(), nome: input.nome.trim(), categoria: text(input.categoria).trim() || "Outro", responsavel: text(input.categoria).trim() || "Outro", valor: input.valorCentavos / 100 * (input.tipo === "Saída" ? -1 : 1), status: isSettled(input) ? "Pago" : input.status, pagoEm: isSettled(input) ? input.pagoEm : "", updatedAt: new Date().toISOString() };
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
    const record = { ...existing, ...input, id: existing?.id || uid(), nome: input.nome.trim(), categoria: text(input.categoria).trim() || "Outro", valor: input.valorCentavos / 100, updatedAt: new Date().toISOString() };
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
    const categories = [...new Set(rows.map(category))].sort((a, b) => a.localeCompare(b, "pt-BR"));
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
      if (filters.category && category(row) !== filters.category) return false;
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
      if (filters.from && filters.to && filters.from > filters.to) { control.setCustomValidity("O início do período deve ser anterior ao fim."); control.reportValidity(); return; }
      container.querySelectorAll("[data-filter]").forEach(element => element.setCustomValidity(""));
      renderFn(container);
    }));
    container.querySelector("[data-clear]").onclick = () => { Object.assign(filters, { from: "", to: "", query: "", category: "", type: "", status: "" }); renderFn(container); };
  }
  function renderFinance(container) {
    const target = current(); normalize(target);
    const filters = settings.finance ||= defaultFilters();
    const sum = totals(target, filters), rows = financeRows(target, filters);
    const older = filters.from ? overdueBefore(target, filters.from) : [];
    container.innerHTML = `<div class="ceo-toolbar"><div><h2>Movimentações financeiras</h2><p>Entradas, saídas e compromissos da ZAMA.</p></div><div class="ceo-row-actions"><button class="ceo-button" data-fixed>Gastos fixos</button><button class="ceo-button primary" data-new>＋ Nova movimentação</button></div></div>
      <div class="ceo-grid ceo-finance-summary">${metric("Entradas recebidas", sum.incomeCents, "money-positive")}${metric("Saídas pagas", sum.expenseCents, "money-negative")}${metric("Saldo do período", sum.balanceCents)}${metric("A receber", sum.receivableCents)}${metric("A pagar", sum.payableCents)}</div>
      ${older.length ? `<section class="ceo-card ceo-toolbar"><div><strong>${older.length} ${older.length === 1 ? "pendência vencida anterior" : "pendências vencidas anteriores"} ao período</strong><p>${formatMoney(older.filter(row => direction(row) === "Saída").reduce((sum, row) => sum + amountCents(row), 0))} a pagar · ${formatMoney(older.filter(row => direction(row) === "Entrada").reduce((sum, row) => sum + amountCents(row), 0))} a receber</p></div><button class="ceo-button" data-overdue>Ver todas as vencidas</button></section>` : ""}
      <section class="ceo-card"><div class="ceo-toolbar"><button class="ceo-button" data-account="all" aria-pressed="${!filters.type && !filters.status}">Todas as movimentações</button><button class="ceo-button" data-account="payable" aria-pressed="${filters.type === "Saída" && filters.status === "Pendente"}">Contas a pagar</button><button class="ceo-button" data-account="receivable" aria-pressed="${filters.type === "Entrada" && filters.status === "Pendente"}">Contas a receber</button></div>
      ${filterMarkup(filters, target.financeiro, false)}<p class="ceo-muted">Os indicadores acompanham todos os filtros abaixo. Valores liquidados usam a data do pagamento ou recebimento; pendências usam o vencimento. ${rows.length} ${rows.length === 1 ? "movimentação encontrada" : "movimentações encontradas"}.</p>
      ${rows.length ? `<div class="ceo-table-wrap ceo-table-scroll"><table class="ceo-table"><thead><tr><th>Descrição / categoria</th><th>Tipo</th><th>Data / vencimento</th><th>Situação</th><th>Valor</th><th>Ações</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${safe(row.nome || "Sem descrição")}</strong><br><small>${safe(category(row))}${row.investmentId ? " · Investimento vinculado" : row.monthlyId ? " \u00b7 Mensalidade vinculada" : row.fixedExpenseId ? ` \u00b7 Gasto fixo \u00b7 ${monthLabel(row.competencia)}` : ""}</small></td><td>${safe(direction(row))}</td><td>${dateLabel(row.data || row.prazo)}<br><small>Vence ${dateLabel(row.prazo)}${isSettled(row) ? `<br>Liquidado ${dateLabel(effectiveDate(row))}` : ""}</small></td><td>${badge(row)}</td><td class="${direction(row) === "Entrada" ? "money-positive" : "money-negative"}">${direction(row) === "Entrada" ? "+" : "−"} ${formatMoney(amountCents(row))}</td><td><div class="ceo-row-actions">${!isSettled(row) && !isCancelled(row) && !row.investmentId && !row.monthlyId ? `<button class="ceo-button" data-settle="${safe(row.id)}" aria-label="Registrar baixa de ${safe(row.nome)}">Registrar baixa</button>` : ""}<button class="ceo-button" data-edit="${safe(row.id)}" aria-label="Editar ${safe(row.nome)}">Editar</button><button class="ceo-button" data-delete="${safe(row.id)}" aria-label="${row.fixedExpenseId ? "Cancelar parcela de" : "Excluir"} ${safe(row.nome)}">${row.fixedExpenseId ? "Cancelar parcela" : "Excluir"}</button></div></td></tr>`).join("")}</tbody></table></div>` : '<div class="ceo-empty"><strong>Nenhuma movimentação neste período</strong><p>Cadastre uma entrada ou saída, ou ajuste os filtros.</p></div>'}</section>`;
    prepareMobileTable(container);
    wireFilters(container, filters, renderFinance);
    container.querySelector("[data-new]").onclick = () => openMovement();
    container.querySelector("[data-fixed]").onclick = () => goToModule("financeiro", { financeView: "fixos" });
    container.querySelector("[data-overdue]")?.addEventListener("click", () => { Object.assign(filters, { from: "", to: "", type: "", category: "", query: "", status: "Atrasado" }); renderFinance(container); });
    container.querySelectorAll("[data-account]").forEach(button => button.onclick = () => { filters.type = button.dataset.account === "payable" ? "Saída" : button.dataset.account === "receivable" ? "Entrada" : ""; filters.status = button.dataset.account === "all" ? "" : "Pendente"; renderFinance(container); });
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
      ${field("Categoria", input("categoria", row ? category(row) : data.categoria, 'required maxlength="80"'))}${field("Dia do vencimento", input("dia", data.dia, 'type="number" min="1" max="31" step="1" required') + '<small>Dias 29, 30 e 31 são ajustados ao último dia do mês.</small>')}
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
    const rows = target.investimentos.filter(row => inPeriod(row.data || "", filters) && (!filters.category || category(row) === filters.category) && (!filters.status || row.status === filters.status) && (!filters.query || word(`${row.nome} ${row.objetivo || ""} ${row.observacoes || ""}`).includes(word(filters.query)))).sort((a, b) => text(b.data).localeCompare(text(a.data)));
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
    const element = dialog(row ? "Editar movimentação" : "Nova movimentação", `<div class="ceo-form-grid">
      ${field("Descrição", input("nome", data.nome || "", 'required maxlength="180"'))}
      ${field("Valor (R$)", amountInput(row ? amountCents(row) : 0))}
      ${field("Tipo", `<select name="tipo">${options(["Entrada", "Saída"], data.tipo)}</select>`)}
      ${field("Categoria", input("categoria", data.categoria, 'list="ceo-finance-categories" required maxlength="80"') + '<datalist id="ceo-finance-categories"><option>Receita</option><option>Despesa</option><option>Marketing</option><option>Produto</option><option>Equipamentos</option><option>Imposto</option><option>Folha</option><option>Fornecedor</option><option>Sistema</option><option>Outro</option></datalist>')}
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
      ${field("Categoria", input("categoria", data.categoria, 'list="ceo-investment-categories" required maxlength="80"') + '<datalist id="ceo-investment-categories"><option>Marketing</option><option>Produto</option><option>Equipamentos</option><option>Capacitação</option><option>Outro</option></datalist>')}
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
      if (!movement || movement.investmentId === id) return;
      element.querySelector('[name="amount"]').value = (amountCents(movement) / 100).toFixed(2).replace(".", ",");
      element.querySelector('[name="data"]').value = effectiveDate(movement) || today();
      element.querySelector('[name="status"]').value = isCancelled(movement) ? "Cancelado" : isSettled(movement) ? "Realizado" : "Planejado";
    });
    return element;
  }

  function reset() { settings.finance = null; settings.investments = null; settings.fixedMonth = ""; }
  function reportMonth() { return (settings.finance?.from || settings.finance?.to || today()).slice(0, 7); }
  global.ZamaFinance = { normalize, totals, cents, amountCents, direction, isSettled, isCancelled, isRealized, effectiveDate, formatMoney, validDate, saveMovement, removeMovement, saveInvestment, removeInvestment, syncInvestment, financeRows, renderFinance, renderInvestments, openMovement, openInvestment, saveFixedExpense, generateFixedExpenses, fixedDueDate, fixedMovement, settleMovement, overdueBefore, renderFixedExpenses, openFixedExpense, reset, reportMonth };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ZamaFinance;
})(typeof window !== "undefined" ? window : globalThis);
