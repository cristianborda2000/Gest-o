const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../app/assets/js/finance-categories.js");
const F = require("../app/assets/js/ceo-finance.js");

test("categories combine defaults, saved types and legacy sources without changing history", () => {
  const state = {
    financeCategories: [{ id: "custom", nome: "Café da equipe", tipo: "Saída" }, { id: "sale", nome: "Consultoria", tipo: "Entrada" }],
    financeiro: [
      { id: "legacy", valor: -4, responsavel: "ALIMENTAÇÃO" },
      { id: "income", valor: 100, responsavel: "Receita" },
      { id: "custom-label", tipo: "Saída", categoria: "  cafe da   equipe  " }
    ],
    gastosFixos: [{ categoria: "Coworking" }],
    investimentos: [{ categoria: "Câmeras" }]
  };
  const before = structuredClone(state);
  const outgoing = C.list(state, "Saída", F);
  assert.ok(outgoing.includes("ALIMENTAÇÃO"));
  assert.equal(outgoing.filter(name => /alimenta/i.test(name)).length, 1);
  assert.equal(outgoing.filter(name => /caf/i.test(name)).length, 1);
  assert.ok(outgoing.includes("Café da equipe"));
  assert.ok(outgoing.includes("Aluguel"));
  assert.ok(outgoing.includes("Coworking"));
  assert.ok(outgoing.includes("Câmeras"));
  assert.ok(!outgoing.includes("Consultoria"));
  assert.deepEqual(outgoing, [...outgoing].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })));
  assert.ok(C.list(state, "Entrada", F).includes("Consultoria"));
  assert.equal(C.list(state, "", F).filter(name => name === "Outro").length, 1);
  assert.deepEqual(state, before);
});

test("saving categories persists normalized names and treats equivalent spellings as duplicates per type", () => {
  const state = {};
  assert.equal(C.saveCategory(state, { nome: "  Café   da equipe  ", tipo: "Saída" }, F), "Café da equipe");
  assert.equal(state.financeCategories.length, 1);
  assert.ok(state.financeCategories[0].id);
  const before = structuredClone(state);
  assert.equal(C.saveCategory(state, { nome: "CAFE DA EQUIPE", tipo: "Saída" }, F), "Café da equipe");
  assert.deepEqual(state, before);
  assert.equal(C.saveCategory(state, { nome: "Café da equipe", tipo: "Entrada" }, F), "Café da equipe");
  assert.equal(state.financeCategories.length, 2);
  assert.notEqual(state.financeCategories[0].id, state.financeCategories[1].id);
});

test("saving a default or legacy category retains it after the last associated record is removed", () => {
  const state = { financeiro: [{ tipo: "Saída", categoria: "PRODUÇÃO", valor: -1 }] };
  assert.equal(C.saveCategory(state, { nome: "producao", tipo: "Saída" }, F), "PRODUÇÃO");
  assert.equal(C.saveCategory(state, { nome: "alimentacao", tipo: "Saída" }, F), "Alimentação");
  state.financeiro = [];
  assert.ok(C.list(state, "Saída", F).includes("PRODUÇÃO"));
  assert.deepEqual(state.financeCategories.map(row => row.nome), ["PRODUÇÃO", "Alimentação"]);
});

test("invalid category names and directions are rejected before catalog mutation", () => {
  const state = {};
  for (const input of [{ nome: "  ", tipo: "Saída" }, { nome: "a".repeat(81), tipo: "Entrada" }, { nome: "Conta", tipo: "Outro" }]) {
    assert.throws(() => C.saveCategory(state, input, F));
    assert.deepEqual(state, {});
  }
  assert.equal(C.saveCategory(state, { nome: "a".repeat(80), tipo: "Saída" }, F).length, 80);
});

test("imported long category labels remain editable without invalidating the backup catalog", () => {
  const A = require("../app/assets/js/admin-data.js");
  const label = "Categoria antiga de despesas com produção e transporte para projetos em outras cidades";
  assert.ok(label.length > 80);
  const state = Object.fromEntries(A.collections.map(key => [key, []]));
  state.financeiro.push({ id: "legacy", nome: "Despesa antiga", responsavel: label, tipo: "Saída", valor: -10, prazo: "2026-10-01", status: "Pendente" });
  state.gastosFixos.push({ id: "fixed", nome: "Recorrência antiga", categoria: label, dia: 5, valor: -10, status: "Ativo", recurrenceStart: "2026-10" });
  state.investimentos.push({ id: "investment", nome: "Investimento antigo", categoria: label, valor: 10, data: "2026-10-01", status: "Planejado", geraSaida: false });

  F.saveMovement(state, { ...state.financeiro[0], categoria: label, valorCentavos: 1200, data: "2026-10-01" }, "legacy");
  F.saveFixedExpense(state, { ...state.gastosFixos[0], valorCentavos: 1300 }, "fixed");
  F.saveInvestment(state, { ...state.investimentos[0], valorCentavos: 1400 }, "investment");
  for (const collection of ["financeiro", "gastosFixos", "investimentos"]) assert.equal(state[collection][0].categoria, label);
  assert.equal(state.financeiro[0].valor, -12);
  assert.equal(state.gastosFixos[0].valor, -13);
  assert.equal(state.investimentos[0].valor, 14);
  assert.deepEqual(state.financeCategories || [], []);
  assert.doesNotThrow(() => A.parseBackup(A.makeBackup(state)));

  const before = structuredClone(state);
  assert.throws(() => F.saveMovement(state, { ...state.financeiro[0], categoria: "Nova categoria ".repeat(8), valorCentavos: 1500, data: "2026-10-01" }, "legacy"), /até 80 caracteres/);
  assert.deepEqual(state, before);
});

test("realized charts use exact ledger cents and group accent, case and space variants", () => {
  const rows = [
    { tipo: "Saída", categoria: "Alimentação", valor: -0.1, status: "Pago" },
    { tipo: "Saída", categoria: "  ALIMENTACAO  ", valor: -0.2, status: "Pago" },
    { tipo: "Saída", categoria: "Aluguel", valor: -0.15, status: "Pago" },
    { tipo: "Entrada", responsavel: "Receita", valorCentavos: "99", status: "Recebido" },
    { tipo: "Saída", categoria: "Alimentação", valor: -100, status: "Cancelado" },
    { tipo: "Entrada", categoria: "Receita", valor: 500, status: "Cancelado" },
    { tipo: "Saída", categoria: "Aluguel", valor: -200, status: "Pendente" }
  ];
  const before = structuredClone(rows), result = C.summarize(rows, F);
  assert.equal(result.expense.totalCents, 45);
  assert.equal(result.income.totalCents, 99);
  assert.deepEqual(result.expense.categories.map(row => [row.name, row.totalCents, row.count]), [["Alimentação", 30, 2], ["Aluguel", 15, 1]]);
  assert.equal(result.expense.categories[0].percentage, 30 / 45 * 100);
  assert.equal(result.income.categories[0].percentage, 100);
  assert.deepEqual(rows, before);
});

test("chart categories drill into legacy rows with blank categories using the same fallback", () => {
  const state = { financeiro: [
    { id: "legacy-rent", tipo: "Saída", categoria: " \t ", responsavel: "  Aluguel   da sala  ", valor: -10, status: "Pago" },
    { id: "rent-variant", tipo: "Saída", responsavel: "ALUGUEL DA SALA", valor: -5, status: "Pago" },
    { id: "unlabelled", tipo: "Saída", categoria: " ", responsavel: "\t", valor: -2, status: "Pago" }
  ] };
  const before = structuredClone(state), groups = C.summarize(state.financeiro, F).expense.categories;
  assert.deepEqual(groups.map(group => [group.name, group.totalCents]), [["Aluguel da sala", 1500], ["Outro", 200]]);
  for (const group of groups) {
    const rows = F.financeRows(state, { category: group.name, type: "Saída", status: "Liquidado" });
    assert.equal(rows.length, group.count);
    assert.equal(rows.reduce((sum, row) => sum + F.amountCents(row), 0), group.totalCents);
  }
  assert.deepEqual(state, before);
});

test("pending charts isolate future commitments and match ledger totals for the same filtered rows", () => {
  const state = { financeiro: [
    { tipo: "Entrada", categoria: "Serviços", valor: 10.01, status: "Pendente", prazo: "2026-10-03" },
    { tipo: "Entrada", categoria: "Vendas", valor: 5, status: "Recebido", pagoEm: "2026-10-02" },
    { tipo: "Saída", categoria: "Aluguel", valor: -4.25, status: "Agendado", prazo: "2026-10-04" },
    { tipo: "Saída", categoria: "Alimentação", valor: -3, status: "Atrasado", prazo: "2026-10-01" },
    { tipo: "Saída", categoria: "Aluguel", valor: -1, status: "Cancelado", prazo: "2026-10-02" },
    { tipo: "Saída", categoria: "Aluguel", valor: -1000, status: "Pendente", prazo: "2026-11-01" }
  ] };
  const filters = { from: "2026-10-01", to: "2026-10-31" };
  const result = C.summarize(F.financeRows(state, filters), F, "pending");
  const totals = F.totals(state, filters);
  assert.equal(result.income.totalCents, totals.receivableCents);
  assert.equal(result.expense.totalCents, totals.payableCents);
  assert.equal(result.income.totalCents, 1001);
  assert.equal(result.expense.totalCents, 725);
  assert.equal(result.expense.categories.length, 2);
});

test("investment-linked rows count once from the ledger and never add the investment register", () => {
  const state = { financeiro: [], investimentos: [], gastosFixos: [] };
  F.saveInvestment(state, { nome: "Câmera", categoria: "Equipamentos", valorCentavos: 120099, data: "2026-10-01", status: "Realizado", geraSaida: true, movementId: "" });
  assert.equal(state.financeiro.length, 1);
  assert.equal(state.investimentos.length, 1);
  assert.equal(C.summarize(state.financeiro, F).expense.totalCents, 120099);
});

test("empty and zero-value charts have finite totals and unusual names remain ordinary categories", () => {
  const empty = { income: { totalCents: 0, categories: [] }, expense: { totalCents: 0, categories: [] } };
  assert.deepEqual(C.summarize([], F), empty);
  assert.deepEqual(C.summarize([{ valor: 0, status: "Pago" }], F), empty);
  const result = C.summarize([{ tipo: "Saída", categoria: "__proto__", valor: -1, status: "Pago" }], F);
  assert.equal(result.expense.categories[0].name, "__proto__");
  assert.equal(result.expense.categories[0].percentage, 100);
  assert.throws(() => C.summarize([], F, "all"));
});

test("chart aggregation refuses unsafe cent totals instead of showing imprecise money", () => {
  const adapter = { ...F, amountCents: row => row.amount };
  assert.throws(() => C.summarize([{ tipo: "Entrada", status: "Pago", amount: Number.MAX_SAFE_INTEGER }, { tipo: "Entrada", status: "Pago", amount: 1 }], adapter), /limite/);
  assert.throws(() => C.summarize([{ tipo: "Entrada", status: "Pago", amount: 1.5 }], adapter), /inválido/);
});
