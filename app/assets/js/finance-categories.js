/* Reusable financial categories and ledger-only chart summaries. */
(function (global) {
  "use strict";
  const defaults = {
    Entrada: ["Receita", "Serviços", "Vendas", "Mensalidades", "Outro"],
    "Saída": ["Alimentação", "Aluguel", "Transporte", "Marketing", "Equipamentos", "Impostos", "Equipe", "Fornecedor", "Sistema", "Outro"]
  };
  const text = value => String(value == null ? "" : value);
  const clean = value => text(value).trim().replace(/\s+/g, " ");
  const key = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const category = row => clean(row.categoria) || clean(row.responsavel) || "Outro";
  const records = value => Array.isArray(value) ? value.filter(row => row && typeof row === "object" && !Array.isArray(row)) : [];
  const compareNames = (left, right) => left.localeCompare(right, "pt-BR", { sensitivity: "base" });
  const uid = () => global.crypto?.randomUUID?.() || `finance-category-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function type(value, optional = false) {
    if (optional && (value == null || value === "")) return "";
    if (value !== "Entrada" && value !== "Saída") throw new Error("Selecione Entrada ou Saída para a categoria.");
    return value;
  }

  function api(adapter, methods) {
    const resolved = adapter || global.ZamaFinance;
    if (!resolved || methods.some(method => typeof resolved[method] !== "function")) throw new Error("Os cálculos financeiros não estão disponíveis.");
    return resolved;
  }

  function list(state, tipo, financeAdapter) {
    const requested = type(tipo, true), target = state || {}, names = new Map();
    const add = (name, direction) => {
      const label = clean(name);
      if (label && (!requested || requested === direction) && !names.has(key(label))) names.set(key(label), label);
    };
    // Saved labels are stable; otherwise keep the spelling already used in the ledger.
    records(target.financeCategories).forEach(row => {
      if (row.tipo === "Entrada" || row.tipo === "Saída") add(row.nome, row.tipo);
    });
    const ledger = records(target.financeiro);
    if (ledger.length) {
      const finance = api(financeAdapter, ["direction"]);
      ledger.forEach(row => add(category(row), finance.direction(row)));
    }
    records(target.gastosFixos).forEach(row => add(category(row), "Saída"));
    records(target.investimentos).forEach(row => add(category(row), "Saída"));
    Object.entries(defaults).forEach(([direction, values]) => values.forEach(name => add(name, direction)));
    return Array.from(names.values()).sort(compareNames);
  }

  function saveCategory(state, input, financeAdapter) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Os dados financeiros não estão disponíveis.");
    const name = clean(input?.nome), direction = type(input?.tipo);
    if (!name || name.length > 80) throw new Error("Informe um nome de categoria com até 80 caracteres.");
    const existing = records(state.financeCategories).find(row => row.tipo === direction && key(row.nome) === key(name));
    if (existing) return clean(existing.nome);
    const canonical = list(state, direction, financeAdapter).find(value => key(value) === key(name)) || name;
    if (!Array.isArray(state.financeCategories)) state.financeCategories = [];
    state.financeCategories.push({ id: uid(), nome: canonical, tipo: direction });
    return canonical;
  }

  function summarize(rows, financeAdapter, mode = "realized") {
    if (mode !== "realized" && mode !== "pending") throw new Error("Selecione valores realizados ou pendentes para o gráfico.");
    const finance = api(financeAdapter, ["amountCents", "direction", "isSettled", "isCancelled"]);
    const buckets = { income: new Map(), expense: new Map() };
    records(rows).forEach(row => {
      if (finance.isCancelled(row) || finance.isSettled(row) !== (mode === "realized")) return;
      const amount = finance.amountCents(row);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Há um valor inválido no resumo financeiro.");
      if (!amount) return;
      const name = category(row), bucket = buckets[finance.direction(row) === "Entrada" ? "income" : "expense"];
      const entry = bucket.get(key(name)) || { name, totalCents: 0, count: 0 };
      entry.totalCents += amount;
      if (!Number.isSafeInteger(entry.totalCents)) throw new Error("O total da categoria ultrapassa o limite de cálculo.");
      entry.count += 1;
      bucket.set(key(name), entry);
    });
    return Object.fromEntries(Object.entries(buckets).map(([direction, bucket]) => {
      const categories = Array.from(bucket.values()).sort((left, right) => right.totalCents - left.totalCents || compareNames(left.name, right.name));
      const totalCents = categories.reduce((sum, entry) => sum + entry.totalCents, 0);
      if (!Number.isSafeInteger(totalCents)) throw new Error("O total financeiro ultrapassa o limite de cálculo.");
      return [direction, { totalCents, categories: categories.map(entry => ({ ...entry, percentage: totalCents ? entry.totalCents / totalCents * 100 : 0 })) }];
    }));
  }

  global.ZamaFinanceCategories = { category, list, saveCategory, summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ZamaFinanceCategories;
})(typeof window !== "undefined" ? window : globalThis);
