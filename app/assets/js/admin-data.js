/* Full backups and monthly management reports. Reports can never restore state. */
(function (global) {
  "use strict";
  const VERSION = 1, MAX_BYTES = 10 * 1024 * 1024;
  const legacyCollections = ["projetos", "marketing", "clientes", "mensalidades", "agenda", "rh", "financeiro", "gastosFixos"];
  const modernCollections = ["investimentos", "ideias", "contractHistory"];
  const collections = [...legacyCollections, ...modernCollections];
  const optionalCollections = ["financeCategories"];
  const labels = { projetos: "Projetos", marketing: "Marketing", clientes: "Clientes", mensalidades: "Mensalidades", agenda: "Agenda", rh: "Equipe / RH", financeiro: "Movimentações", gastosFixos: "Gastos fixos", investimentos: "Investimentos", ideias: "Ideias", contractHistory: "Contratos", financeCategories: "Categorias financeiras" };
  const text = value => String(value == null ? "" : value);
  const esc = value => text(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const clone = value => JSON.parse(JSON.stringify(value));
  const finance = () => global.ZamaFinance || (typeof module !== "undefined" && module.exports ? require("./ceo-finance.js") : null);

  function inspectJson(value, path = "arquivo", depth = 0) {
    if (depth > 48) throw new Error("O arquivo contém uma estrutura muito profunda.");
    if (value === null || ["string", "boolean"].includes(typeof value)) return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !plain(value)) throw new Error(`Formato inválido em ${path}.`);
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("O arquivo contém propriedades não permitidas.");
      inspectJson(item, `${path}.${key}`, depth + 1);
    }
  }

  function validateCollection(rows, key) {
    if (!Array.isArray(rows)) throw new Error(`A coleção ${labels[key] || key} precisa ser uma lista.`);
    const ids = new Set();
    const stringFields = ["id", "nome", "titulo", "descricao", "observacoes", "tipo", "categoria", "responsavel", "status", "prazo", "data", "pagoEm", "inicio", "hora", "createdAt", "updatedAt", "recorrencia", "recurrenceStart", "recurrenceEnd", "prioridade", "etapa", "competencia", "investmentId", "fixedExpenseId", "monthlyId", "movementId", "taskId", "ideaId"];
    const numberFields = ["valor", "valorCentavos", "implantacao", "dia", "duracao", "reminderMinutes"];
    for (const [index, row] of rows.entries()) {
      if (!plain(row)) throw new Error(`Registro ${index + 1} de ${labels[key] || key} inválido.`);
      for (const field of stringFields) {
        if (row[field] != null && typeof row[field] !== "string" && !(field === "prioridade" && typeof row[field] === "number")) throw new Error(`Campo ${field} inválido em ${labels[key] || key}.`);
      }
      for (const field of numberFields) {
        if (row[field] == null || row[field] === "") continue;
        // Older forms saved some numeric inputs as strings; finite numeric strings remain compatible.
        if (!["number", "string"].includes(typeof row[field]) || !/^[-+]?\d+(?:\.\d+)?$/.test(text(row[field])) || !Number.isFinite(Number(row[field]))) throw new Error(`Campo ${field} inválido em ${labels[key] || key}.`);
        if (field === "valorCentavos" && (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0)) throw new Error("Um valor em centavos é inválido.");
      }
      for (const field of ["geraSaida", "investmentGenerated", "arquivada", "archived"]) {
        if (own(row, field) && typeof row[field] !== "boolean") throw new Error(`Campo ${field} inválido em ${labels[key] || key}.`);
      }
      if (key === "gastosFixos") {
        if (row.dia != null && row.dia !== "" && (!Number.isInteger(Number(row.dia)) || Number(row.dia) < 1 || Number(row.dia) > 31)) throw new Error("Dia de vencimento inválido em Gastos fixos.");
        if (row.recurrenceStart && (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(row.recurrenceStart) || Number(row.recurrenceStart.slice(0, 4)) < 1900)) throw new Error("Competência inicial inválida em Gastos fixos.");
      }
      if (row.exceptions != null && !plain(row.exceptions)) throw new Error("Exceções da agenda inválidas.");
      if (row.id) {
        if (ids.has(row.id)) throw new Error(`Há identificadores repetidos em ${labels[key] || key}.`);
        ids.add(row.id);
      }
    }
  }

  function validateState(data, legacy = false) {
    if (!plain(data)) throw new Error("O backup não contém um conjunto completo de dados.");
    inspectJson(data);
    for (const key of legacy ? legacyCollections : collections) {
      if (!own(data, key)) throw new Error(`Backup incompleto: falta ${labels[key]}. Use “Baixar backup completo”.`);
    }
    for (const key of [...collections, "dashboard"]) if (own(data, key)) validateCollection(data[key], key);
    if (own(data, "financeCategories")) {
      validateCollection(data.financeCategories, "financeCategories");
      const names = new Set();
      for (const row of data.financeCategories) {
        const name = text(row.nome).trim().replace(/\s+/g, " ");
        if (!text(row.id).trim() || !name || name.length > 80 || !["Entrada", "Saída"].includes(row.tipo)) throw new Error("Categoria financeira inválida: informe identificador, nome de até 80 caracteres e tipo Entrada ou Saída.");
        const key = `${row.tipo}:${name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()}`;
        if (names.has(key)) throw new Error("Há categorias financeiras repetidas para o mesmo tipo.");
        names.add(key);
      }
    }
    for (const key of ["companyProfile", "agendaSettings", "backups", "reminderReceipts"]) {
      if (own(data, key) && !plain(data[key])) throw new Error(`Configuração ${key} inválida.`);
    }
    if (data.companyProfile) for (const value of Object.values(data.companyProfile)) if (typeof value !== "string") throw new Error("Os dados da empresa devem conter apenas texto.");
    if (own(data, "setupDone") && typeof data.setupDone !== "boolean") throw new Error("Configuração inicial inválida.");
    if (data.agendaSettings) {
      for (const key of ["enabled", "dailyEnabled", "taskEnabled"]) if (own(data.agendaSettings, key) && typeof data.agendaSettings[key] !== "boolean") throw new Error("Preferências de lembretes inválidas.");
      if (own(data.agendaSettings, "dailyTime") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.agendaSettings.dailyTime)) throw new Error("Horário do resumo diário inválido.");
      if (own(data.agendaSettings, "leadMinutes") && (!Number.isInteger(data.agendaSettings.leadMinutes) || data.agendaSettings.leadMinutes < 0 || data.agendaSettings.leadMinutes > 1440)) throw new Error("Antecedência dos lembretes inválida.");
    }
    return data;
  }

  function makeBackup(data, generatedAt = new Date().toISOString()) {
    validateState(data, true);
    const copy = clone(data);
    // An older complete state may predate these modules. Never fill missing legacy collections.
    for (const key of modernCollections) if (!own(copy, key)) copy[key] = [];
    validateState(copy);
    return { type: "zama-backup", version: VERSION, generatedAt, data: copy };
  }

  function parseBackup(input) {
    let document = input;
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).length > MAX_BYTES) throw new Error("O arquivo excede o limite de 10 MB.");
      try { document = JSON.parse(input.replace(/^\uFEFF/, "")); } catch { throw new Error("Não foi possível ler o JSON. Escolha um backup completo exportado pela ZAMA."); }
    }
    inspectJson(document);
    if (!plain(document)) throw new Error("Selecione um backup completo da ZAMA.");
    if (document.type === "zama-monthly-report" || own(document, "mes") && (own(document, "totais") || own(document, "geradoEm"))) throw new Error("Este arquivo é um relatório mensal, não um backup completo. Ele não pode substituir os dados da conta.");
    if (own(document, "type")) {
      if (document.type !== "zama-backup" || document.version !== VERSION) throw new Error("Formato ou versão de backup não suportado.");
      if (typeof document.generatedAt !== "string" || !Number.isFinite(Date.parse(document.generatedAt))) throw new Error("Data de geração do backup inválida.");
      validateState(document.data);
      return { data: clone(document.data), legacy: false, generatedAt: document.generatedAt, preserved: optionalCollections.filter(key => !own(document.data, key)) };
    }
    validateState(document, true);
    return { data: clone(document), legacy: true, generatedAt: "", preserved: [...modernCollections, ...optionalCollections].filter(key => !own(document, key)) };
  }

  function restoredState(backup, current) {
    const result = clone(backup.data);
    if (backup.legacy) {
      // Historical exports predate some modules. Do not erase modules or settings absent in that format.
      for (const [key, value] of Object.entries(current)) if (!own(result, key)) result[key] = clone(value);
    }
    // Version-1 backups exported before the category catalog must not erase it.
    for (const key of optionalCollections) if (!own(result, key) && own(current, key)) result[key] = clone(current[key]);
    validateState(result);
    return result;
  }

  function monthRange(month) {
    if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(text(month))) throw new Error("Escolha um mês válido para o relatório.");
    return { from: `${month}-01`, to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) };
  }

  function monthlyReport(target, month, generatedAt = new Date().toISOString()) {
    const F = finance(), range = monthRange(month);
    const rows = F.financeRows(target, range).map(clone);
    const investmentRows = (target.investimentos || []).filter(row => (row.data || row.prazo || "") >= range.from && (row.data || row.prazo || "") <= range.to).map(clone);
    const sum = F.totals({ financeiro: rows, investimentos: investmentRows }, range);
    const categories = new Map();
    for (const row of rows) {
      if (F.isCancelled(row)) continue;
      const key = row.categoria || row.responsavel || "Outro";
      if (!categories.has(key)) categories.set(key, { categoria: key, incomeCents: 0, expenseCents: 0, receivableCents: 0, payableCents: 0 });
      const metric = F.isSettled(row) ? F.direction(row) === "Entrada" ? "incomeCents" : "expenseCents" : F.direction(row) === "Entrada" ? "receivableCents" : "payableCents";
      categories.get(key)[metric] += F.amountCents(row);
    }
    const { rows: ignored, ...totals } = sum;
    return { type: "zama-monthly-report", version: VERSION, generatedAt, mes: month, periodo: range, empresa: clone(target.companyProfile || {}), criterio: "Caixa: liquidações pela data do pagamento/recebimento; pendências pelo vencimento. Registros antigos sem liquidação usam a data disponível. Cancelados não compõem os totais. Investimentos vinculados já integram as saídas, sem segunda dedução.", totais: totals, categorias: [...categories.values()].sort((a, b) => a.categoria.localeCompare(b.categoria, "pt-BR")), financeiro: rows, investimentos: investmentRows, registrosSemData: (target.financeiro || []).filter(row => !F.effectiveDate(row)).length };
  }

  function csvCell(value) {
    // Values created as numbers cannot contain spreadsheet formulas. Every external string is guarded.
    if (typeof value === "number") return Number.isFinite(value) ? String(value).replace(".", ",") : "";
    let content = text(value);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(content) || /^[\t\r\n]/.test(content)) content = "'" + content;
    return `"${content.replace(/"/g, '""')}"`;
  }

  function csvReport(report) {
    const F = finance();
    const rows = [["Mês", "ID", "Descrição", "Categoria", "Tipo", "Situação", "Data do lançamento", "Vencimento", "Liquidação", "Data no relatório", "Valor (R$)", "Valor em centavos", "Pagamento", "Origem", "Observações"]];
    for (const row of report.financeiro) rows.push([report.mes, row.id, row.nome, row.categoria || row.responsavel || "Outro", F.direction(row), row.status, row.data, row.prazo, row.pagoEm, F.effectiveDate(row), F.amountCents(row) / 100, F.amountCents(row), row.formaPagamento, row.fixedExpenseId ? "Gasto fixo" : row.investmentId ? "Investimento" : row.monthlyId ? "Mensalidade" : "Manual", row.observacoes]);
    return "\uFEFF" + rows.map(row => row.map(csvCell).join(";")).join("\r\n") + "\r\n";
  }

  const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? value.split("-").reverse().join("/") : "—";
  const monthLabel = month => new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
  function printReport(report) {
    const F = finance(), p = report.empresa, t = report.totais;
    const amount = cents => esc(F.formatMoney(cents));
    const metrics = [["Entradas recebidas", t.incomeCents], ["Saídas pagas", t.expenseCents], ["Saldo do mês", t.balanceCents], ["A receber", t.receivableCents], ["A pagar", t.payableCents], ["Investimentos realizados", t.investmentCents]];
    const generated = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(report.generatedAt));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relatório financeiro · ${esc(report.mes)} · ${esc(p.nome || "ZAMA")}</title><style>
      @page{size:A4 landscape;margin:14mm}*{box-sizing:border-box}body{font:11px/1.5 Arial,sans-serif;color:#172c30;margin:0;background:#fff}header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #185b52;padding-bottom:18px}h1{font-size:25px;margin:2px 0 3px}h2{font-size:15px;margin:22px 0 8px}p{margin:3px 0}.eyebrow{text-transform:uppercase;letter-spacing:2px;color:#397267;font-weight:700}.muted{color:#536766}.right{text-align:right}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:20px 0}.metric{background:#f1f6f4;border:1px solid #dbe7e1;border-radius:6px;padding:12px}.metric strong{font-size:18px;display:block;margin-top:4px}table{border-collapse:collapse;width:100%;table-layout:fixed}th{background:#eaf2ee;text-align:left;font-size:10px}td,th{padding:8px 7px;border-bottom:1px solid #dce6e0;overflow-wrap:anywhere;vertical-align:top}thead{display:table-header-group}tr{break-inside:avoid}small{color:#536766;font-size:10px}.num{text-align:right;white-space:nowrap}footer{border-top:1px solid #cdded5;margin-top:22px;padding-top:9px;color:#536766}.note{padding:10px 12px;background:#f8faf9;border-left:3px solid #397267}.screen{margin:20px 0;padding:10px;background:#f1f6f4}@media screen{body{max-width:1280px;margin:24px auto;padding:24px}}@media print{.screen{display:none}.metric,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}h2{break-after:avoid}}
      </style></head><body><p class="screen">Relatório pronto para impressão. Escolha “Salvar como PDF” na janela de impressão do navegador. Se ela não abrir, use Ctrl+P.</p><header><div><p class="eyebrow">Relatório gerencial financeiro</p><h1>${esc(p.nome || "ZAMA")}</h1><p>${esc(monthLabel(report.mes))} · ${dateLabel(report.periodo.from)} a ${dateLabel(report.periodo.to)}</p></div><div class="right muted"><p>${esc(p.documento || "")}</p><p>${esc(p.email || "")}</p><p>${esc(p.cidade || "")}</p><p>Emitido em ${esc(generated)} · São Paulo</p></div></header><div class="metrics">${metrics.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${amount(value)}</strong></div>`).join("")}</div><p class="note">${esc(report.criterio)}${report.registrosSemData ? ` Há ${report.registrosSemData} registro(s) sem data fora deste relatório; revise o cadastro para incluí-los no período correto.` : ""}</p><h2>Resumo por categoria</h2><table><thead><tr><th>Categoria</th><th class="num">Recebido</th><th class="num">Pago</th><th class="num">A receber</th><th class="num">A pagar</th></tr></thead><tbody>${report.categorias.map(row => `<tr><td>${esc(row.categoria)}</td><td class="num">${amount(row.incomeCents)}</td><td class="num">${amount(row.expenseCents)}</td><td class="num">${amount(row.receivableCents)}</td><td class="num">${amount(row.payableCents)}</td></tr>`).join("") || '<tr><td colspan="5">Nenhuma movimentação contabilizada neste mês.</td></tr>'}</tbody></table><h2>Movimentações · ${report.financeiro.length} registro(s)</h2><table><colgroup><col style="width:24%"><col style="width:15%"><col style="width:9%"><col style="width:11%"><col style="width:11%"><col style="width:11%"><col style="width:8%"><col style="width:11%"></colgroup><thead><tr><th>Descrição</th><th>Categoria / origem</th><th>Tipo</th><th>Vencimento</th><th>Liquidação</th><th>Situação</th><th>Pagamento</th><th class="num">Valor</th></tr></thead><tbody>${report.financeiro.map(row => `<tr><td><strong>${esc(row.nome || "Sem descrição")}</strong>${row.observacoes ? `<br><small>${esc(row.observacoes)}</small>` : ""}</td><td>${esc(row.categoria || row.responsavel || "Outro")}${row.fixedExpenseId ? "<br><small>Gasto fixo</small>" : row.investmentId ? "<br><small>Investimento vinculado</small>" : ""}</td><td>${esc(F.direction(row))}</td><td>${dateLabel(row.prazo)}</td><td>${F.isSettled(row) ? dateLabel(F.effectiveDate(row)) : "—"}</td><td>${esc(row.status || "Pendente")}</td><td>${esc(row.formaPagamento || "—")}</td><td class="num">${amount(F.amountCents(row))}</td></tr>`).join("") || '<tr><td colspan="8">Nenhuma movimentação neste mês.</td></tr>'}</tbody></table>${report.investimentos.length ? `<h2>Investimentos do mês</h2><table><thead><tr><th>Nome</th><th>Categoria</th><th>Data</th><th>Situação</th><th>Vínculo financeiro</th><th class="num">Valor</th></tr></thead><tbody>${report.investimentos.map(row => `<tr><td>${esc(row.nome)}</td><td>${esc(row.categoria || row.responsavel || "Outro")}</td><td>${dateLabel(row.data || row.prazo)}</td><td>${esc(row.status)}</td><td>${row.geraSaida === false ? "Sem saída de caixa" : "Incluído nas movimentações"}</td><td class="num">${amount(F.amountCents(row))}</td></tr>`).join("")}</tbody></table>` : ""}<footer>Documento gerencial para conferência. Valores em reais (BRL). Este relatório mensal não substitui um backup completo.</footer></body></html>`;
  }

  function download(filename, content, type = "application/json;charset=utf-8") {
    const url = global.URL.createObjectURL(new Blob([typeof content === "string" ? content : JSON.stringify(content, null, 2)], { type }));
    const link = global.document.createElement("a"); link.href = url; link.download = filename;
    global.document.body.appendChild(link); link.click(); link.remove();
    global.setTimeout(() => global.URL.revokeObjectURL(url), 30000);
  }

  function dialog(title, content) {
    const element = global.document.createElement("dialog"), titleId = `admin-dialog-${Date.now()}`;
    element.className = "ceo-dialog"; element.setAttribute("aria-labelledby", titleId);
    element.innerHTML = `<div class="ceo-toolbar"><h2 id="${titleId}">${esc(title)}</h2><button class="ceo-button" type="button" data-close aria-label="Fechar">✕</button></div>${content}`;
    const previous = global.document.activeElement;
    element.querySelectorAll("[data-close]").forEach(button => button.onclick = () => element.close());
    element.addEventListener("close", () => { element.remove(); if (previous?.isConnected) previous.focus(); });
    global.document.body.appendChild(element); element.showModal(); return element;
  }

  function openReports(getState, defaultMonth) {
    monthRange(defaultMonth);
    const element = dialog("Relatórios mensais", `<form><label class="ceo-field">Mês do relatório<input type="month" name="month" value="${esc(defaultMonth)}" min="1000-01" max="9999-12" required></label><p class="ceo-muted">Inclui todas as movimentações do mês escolhido, independentemente dos filtros da tela. Liquidações pela data do pagamento; pendências pelo vencimento.</p><div class="ceo-card" data-summary aria-live="polite"></div><p class="ceo-muted">CSV abre no Excel e em outras planilhas. Para PDF, use “Salvar como PDF” na impressão do navegador. Relatórios não restauram os dados da conta.</p><p class="ceo-form-error" role="alert" hidden></p><div class="ceo-toolbar ceo-dialog-actions"><button class="ceo-button" type="submit" value="csv">Baixar CSV (Excel)</button><button class="ceo-button" type="submit" value="json">Baixar JSON</button><button class="ceo-button primary" type="submit" value="print">Imprimir / PDF</button></div></form>`);
    const form = element.querySelector("form"), input = form.elements.month, output = element.querySelector("[data-summary]"), error = element.querySelector("[role=alert]");
    const preview = () => {
      try { const report = monthlyReport(getState(), input.value); output.innerHTML = `<strong>${esc(monthLabel(report.mes))}</strong><p>${report.financeiro.length} movimentações · Saldo: ${esc(finance().formatMoney(report.totais.balanceCents))}</p>${report.registrosSemData ? `<p>${report.registrosSemData} registro(s) sem data não entram no relatório.</p>` : ""}`; error.hidden = true; }
      catch (failure) { output.textContent = "Escolha um mês para visualizar os totais."; error.textContent = failure.message; error.hidden = false; }
    };
    input.addEventListener("change", preview); preview();
    form.onsubmit = event => {
      event.preventDefault(); error.hidden = true;
      try {
        const report = monthlyReport(getState(), input.value), name = `relatorio-zama-${report.mes}`;
        if (event.submitter?.value === "print") {
          const popup = global.open("", "_blank");
          if (!popup) throw new Error("Permita a abertura de janelas para imprimir ou salvar o PDF.");
          popup.opener = null; popup.document.open(); popup.document.write(printReport(report)); popup.document.close();
          global.setTimeout(() => { if (!popup.closed) { popup.focus(); popup.print(); } }, 300);
        } else if (event.submitter?.value === "json") download(`${name}.json`, report);
        else download(`${name}.csv`, csvReport(report), "text/csv;charset=utf-8");
      } catch (failure) { error.textContent = failure.message || "Não foi possível gerar o relatório."; error.hidden = false; }
    };
    return element;
  }

  function openRestore(backup, filename, getState, onRestore) {
    const existing = getState();
    const rows = [...collections, ...optionalCollections].map(key => `<tr><td>${esc(labels[key])}</td><td>${existing[key]?.length || 0}</td><td>${backup.preserved.includes(key) ? "Preservado" : backup.data[key]?.length || 0}</td></tr>`).join("");
    const element = dialog("Revisar restauração", `<form><p>Arquivo: <strong>${esc(filename)}</strong></p><p class="ceo-muted">${backup.legacy ? "Backup completo do formato anterior. Coleções e configurações ausentes serão preservadas." : `Backup completo · versão ${VERSION}`}</p><p>A restauração substitui os registros desta conta pelos registros do arquivo. Uma cópia completa dos dados atuais será baixada automaticamente antes de salvar.</p><div class="ceo-table-scroll" style="max-height:260px;overflow:auto"><table class="ceo-table"><thead><tr><th>Dados</th><th>Atuais</th><th>Após restaurar</th></tr></thead><tbody>${rows}</tbody></table></div><label class="ceo-field">Digite RESTAURAR para confirmar<input name="confirmation" autocomplete="off" required pattern="RESTAURAR" placeholder="RESTAURAR"></label><p class="ceo-form-error" role="alert" hidden></p><div class="ceo-toolbar ceo-dialog-actions"><button class="ceo-button" type="button" data-close>Cancelar</button><button class="ceo-button primary" type="submit" disabled>Restaurar dados</button></div></form>`);
    const form = element.querySelector("form"), submit = form.querySelector('[type="submit"]'), error = form.querySelector("[role=alert]");
    let busy = false;
    form.elements.confirmation.addEventListener("input", () => { submit.disabled = form.elements.confirmation.value !== "RESTAURAR"; });
    element.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || form.elements.confirmation.value !== "RESTAURAR") return;
      busy = true; error.hidden = true; element.querySelectorAll("button,input").forEach(button => button.disabled = true); submit.textContent = "Restaurando…";
      try {
        if (await onRestore(backup) === false) throw new Error("A restauração não foi salva. Os dados atuais foram preservados. Verifique a conexão e tente novamente.");
        element.close();
      } catch (failure) { error.textContent = failure.message || "Não foi possível restaurar. Seus dados atuais foram preservados."; error.hidden = false; }
      finally { busy = false; element.querySelectorAll("button,input").forEach(button => button.disabled = false); submit.textContent = "Restaurar dados"; }
    };
    return element;
  }

  global.ZamaAdminData = { VERSION, MAX_BYTES, collections, labels, validateState, makeBackup, parseBackup, restoredState, monthlyReport, monthRange, csvCell, csvReport, printReport, download, openReports, openRestore };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ZamaAdminData;
})(typeof window !== "undefined" ? window : globalThis);
