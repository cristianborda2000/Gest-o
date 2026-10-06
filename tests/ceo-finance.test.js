const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../app/assets/js/ceo-finance.js");

const september = { from: "2026-09-01", to: "2026-09-30" };
const blank = () => ({ financeiro: [], investimentos: [], clientes: [{ id: "client-1", nome: "Cliente existente" }] });
const movement = overrides => ({ nome: "Serviço", categoria: "Receita", tipo: "Entrada", valorCentavos: 10001, data: "2026-09-20", prazo: "2026-09-25", status: "Pago", pagoEm: "2026-09-26", ...overrides });
const investment = overrides => ({ nome: "Equipamento", categoria: "Equipamentos", valorCentavos: 120099, data: "2026-09-10", objetivo: "Melhorar produção", status: "Realizado", geraSaida: true, observacoes: "Registro de teste", movementId: "", ...overrides });

test("legacy entries keep identity, signed value, dates, unrelated fields and client records", () => {
  const target = blank();
  const legacy = { id: "old", nome: "Histórico", valor: -10.01, tipo: "Saída", prazo: "2026-08-22", status: "Pago", formaPagamento: "Pix", custom: { a: 1 } };
  target.financeiro.push({ ...legacy });
  F.normalize(target);
  assert.equal(target.financeiro[0].valorCentavos, 1001);
  for (const key of Object.keys(legacy)) assert.deepEqual(target.financeiro[0][key], legacy[key]);
  assert.equal(F.effectiveDate(target.financeiro[0]), "2026-08-22");
  assert.equal(target.clientes[0].nome, "Cliente existente");
  const snapshot = JSON.stringify(target);
  F.normalize(target);
  assert.equal(JSON.stringify(target), snapshot);
});

test("calculations use integer cents, explicit direction, settlement date and exclude cancelled", () => {
  const target = blank();
  target.financeiro = [
    { valor: 0.1, tipo: "Entrada", status: "Recebido", pagoEm: "2026-09-01" },
    { valor: 0.2, tipo: "Entrada", status: "Pago", pagoEm: "2026-09-02" },
    { valor: 0.15, tipo: "Saída", status: "Pago", prazo: "2026-08-30", pagoEm: "2026-09-03" },
    { valor: 1000, tipo: "Entrada", status: "Cancelado", prazo: "2026-09-05" },
    { valor: -500, tipo: "Saída", status: "Cancelado", prazo: "2026-09-05" },
    { valor: 90.22, tipo: "Entrada", status: "Pendente", prazo: "2026-09-05" },
    { valor: -8.18, tipo: "Saída", status: "Agendado", prazo: "2026-09-20" },
    { valor: 9999, tipo: "Entrada", status: "Pago", prazo: "2026-09-01", pagoEm: "2026-10-01" }
  ];
  const summary = F.totals(target, september);
  assert.equal(summary.incomeCents, 30);
  assert.equal(summary.expenseCents, 15);
  assert.equal(summary.balanceCents, 15);
  assert.equal(summary.receivableCents, 9022);
  assert.equal(summary.payableCents, 818);
  assert.equal(summary.rows.length, 5);
});

test("money parsing handles Brazilian amounts and legacy writes invalidate stale cents", () => {
  assert.equal(F.cents("R$ 1.234,56"), 123456);
  assert.equal(F.cents("1.01"), 101);
  assert.equal(F.cents(1.005), 101);
  assert.equal(F.cents(-20.29), -2029);
  assert.equal(F.cents("invalid"), 0);
  const old = { valor: 300.11, valorCentavos: 10000 };
  assert.equal(F.amountCents(old), 30011);
});

test("numeric cents from compatible backups survive normalization and reporting", () => {
  const target = blank();
  target.financeiro = [{ id: "cents-only", nome: "Backup", tipo: "Saída", valorCentavos: "12345", status: "Pago", pagoEm: "2026-09-03" }];
  assert.equal(F.totals(target, september).expenseCents, 12345);
  F.normalize(target);
  assert.equal(target.financeiro[0].valorCentavos, 12345);
  assert.equal(F.totals(target, september).expenseCents, 12345);
  assert.equal(F.amountCents({ valorCentavos: "9007199254740992" }), 0);
  assert.equal(F.amountCents({ valorCentavos: true }), 0);
  assert.equal(F.amountCents({ valor: 0, valorCentavos: "12345" }), 0);
});

test("movement CRUD validates dates, positive cents, and retains additional legacy fields", () => {
  const target = blank();
  const created = F.saveMovement(target, movement());
  assert.equal(created.valor, 100.01);
  created.formaPagamento = "Pix";
  F.saveMovement(target, movement({ valorCentavos: 20199, tipo: "Saída", status: "Pendente" }), created.id);
  assert.equal(target.financeiro[0].valor, -201.99);
  assert.equal(target.financeiro[0].pagoEm, "");
  assert.equal(target.financeiro[0].formaPagamento, "Pix");
  assert.throws(() => F.saveMovement(target, movement({ prazo: "2026-02-30" })), /datas válidas/);
  assert.throws(() => F.saveMovement(target, movement({ valorCentavos: 0 })), /valor maior/);
  assert.throws(() => F.saveMovement(target, movement({ pagoEm: "" })), /recebido ou pago/);
  F.removeMovement(target, created.id);
  assert.equal(target.financeiro.length, 0);
});

test("realized investment is represented exactly once in ledger across edits and reloads", () => {
  const target = blank();
  F.saveMovement(target, movement({ valorCentavos: 200000 }));
  const created = F.saveInvestment(target, investment());
  const movementId = created.movementId;
  for (let i = 0; i < 5; i++) F.syncInvestment(target, created);
  assert.equal(target.financeiro.length, 2);
  assert.equal(F.totals(target, september).expenseCents, 120099);
  assert.equal(F.totals(target, september).investmentCents, 120099);
  assert.equal(F.totals(target, september).balanceCents, 79901);
  const reloaded = JSON.parse(JSON.stringify(target));
  F.normalize(reloaded);
  F.saveInvestment(reloaded, investment({ valorCentavos: 100000, movementId }), created.id);
  assert.equal(reloaded.financeiro.length, 2);
  assert.equal(reloaded.investimentos[0].movementId, movementId);
  assert.equal(F.totals(reloaded, september).balanceCents, 100000);
  assert.throws(() => F.saveMovement(reloaded, movement(), movementId), /investimento vinculado/);
  assert.throws(() => F.removeMovement(reloaded, movementId), /origem/);
});

test("planned, realized and cancelled investment transitions update the same movement", () => {
  const target = blank();
  let record = F.saveInvestment(target, investment({ status: "Planejado" }));
  const movementId = record.movementId;
  assert.equal(F.totals(target, september).payableCents, 120099);
  assert.equal(F.totals(target, september).balanceCents, 0);
  assert.equal(F.totals(target, september).investmentCents, 0);
  record = F.saveInvestment(target, investment({ movementId }), record.id);
  assert.equal(F.totals(target, september).expenseCents, 120099);
  record = F.saveInvestment(target, investment({ movementId, status: "Cancelado" }), record.id);
  assert.equal(F.totals(target, september).expenseCents, 0);
  assert.equal(F.totals(target, september).payableCents, 0);
  assert.equal(target.financeiro.length, 1);
  F.removeInvestment(target, record.id);
  assert.equal(target.financeiro.length, 0);
  assert.equal(target.investimentos.length, 0);
});

test("linking an existing outgoing movement reuses it and prevents competing links", () => {
  const target = blank();
  const outgoing = F.saveMovement(target, movement({ tipo: "Saída", valorCentavos: 120099 }));
  const linked = F.saveInvestment(target, investment({ movementId: outgoing.id }));
  assert.equal(target.financeiro.length, 1);
  assert.equal(F.totals(target, september).expenseCents, 120099);
  assert.throws(() => F.saveInvestment(target, investment({ movementId: outgoing.id })), /disponível/);
  F.saveInvestment(target, investment({ geraSaida: false, movementId: outgoing.id }), linked.id);
  assert.equal(target.financeiro.length, 1, "An explicitly unlinked pre-existing movement is preserved.");
  assert.equal(target.financeiro[0].investmentId, undefined);
  assert.equal(target.investimentos[0].movementId, "");
});

test("investments with no cash outflow are shown in investment totals but not subtracted", () => {
  const target = blank();
  F.saveInvestment(target, investment({ geraSaida: false }));
  assert.equal(target.financeiro.length, 0);
  assert.equal(F.totals(target, september).investmentCents, 120099);
  assert.equal(F.totals(target, september).balanceCents, 0);
});

test("linked monthly records cannot be overwritten or removed independently", () => {
  const target = blank();
  const created = F.saveMovement(target, movement());
  created.monthlyId = "monthly-1";
  assert.throws(() => F.saveMovement(target, movement(), created.id), /mensalidades/i);
  assert.throws(() => F.removeMovement(target, created.id), /origem/);
});

test("generated duplicate investment rows are repaired without deleting unrelated manual rows", () => {
  const target = blank();
  const record = F.saveInvestment(target, investment());
  target.financeiro.push({ ...target.financeiro[0], id: "generated-duplicate" });
  target.financeiro.push({ ...target.financeiro[0], id: "manual-duplicate", investmentGenerated: false });
  F.syncInvestment(target, record);
  assert.equal(target.financeiro.filter(row => row.investmentId === record.id).length, 1);
  assert.equal(target.financeiro.some(row => row.id === "generated-duplicate"), false);
  assert.equal(target.financeiro.some(row => row.id === "manual-duplicate" && !row.investmentId), true);
});

test("new received movements preserve legacy paid status compatibility", () => {
  const target = blank();
  const created = F.saveMovement(target, movement({ status: "Recebido" }));
  assert.equal(created.status, "Pago");
  assert.equal(F.isSettled(created), true);
});

test("filters select accounts payable and receivable without cancelled or settled rows", () => {
  const target = blank();
  F.saveMovement(target, movement({ nome: "Serviço A", status: "Pendente", tipo: "Entrada" }));
  F.saveMovement(target, movement({ nome: "Marketing", status: "Agendado", tipo: "Saída", categoria: "Marketing" }));
  F.saveMovement(target, movement({ nome: "Cancelada", status: "Cancelado", tipo: "Saída" }));
  F.saveMovement(target, movement({ nome: "Liquidada", tipo: "Saída" }));
  const payable = F.financeRows(target, { ...september, type: "Saída", status: "Pendente" });
  assert.equal(payable.length, 1);
  assert.equal(payable[0].nome, "Marketing");
  const received = F.financeRows(target, { ...september, status: "Liquidado", query: "liquidada" });
  assert.equal(received.length, 1);
});

const fixedExpense = overrides => ({ nome: "Internet", categoria: "Sistema", dia: 31, valorCentavos: 19999, status: "Ativo", recurrenceStart: "2026-01", ...overrides });

test("fixed expenses generate one immutable installment per month, including leap years and short months", () => {
  const target = blank();
  const fixed = F.saveFixedExpense(target, fixedExpense());
  assert.equal(target.financeiro.length, 0, "Saving a template without the explicit checkbox creates no payable.");
  F.generateFixedExpenses(target, "2026-02");
  const original = structuredClone(target.financeiro[0]);
  assert.equal(original.prazo, "2026-02-28");
  assert.equal(original.id, `fixed:${fixed.id}:2026-02`);
  F.generateFixedExpenses(target, "2026-02");
  F.normalize(target);
  assert.deepEqual(target.financeiro, [original]);
  F.settleMovement(target, original.id, "2026-03-02");
  F.saveFixedExpense(target, fixedExpense({ valorCentavos: 25000, dia: 15 }), fixed.id);
  F.generateFixedExpenses(target, "2026-02");
  F.generateFixedExpenses(target, "2026-03");
  assert.equal(target.financeiro.length, 2);
  assert.equal(target.financeiro[0].valorCentavos, 19999);
  assert.equal(target.financeiro[0].pagoEm, "2026-03-02");
  assert.equal(target.financeiro[1].prazo, "2026-03-15");
  assert.equal(target.financeiro[1].valorCentavos, 25000);
  assert.equal(F.fixedDueDate({ dia: 31 }, "2028-02"), "2028-02-29");
  assert.equal(F.fixedDueDate({ dia: 31 }, "2026-04"), "2026-04-30");
  assert.throws(() => F.fixedDueDate({ dia: 32 }, "2026-04"), /válidos/);
});

test("legacy fixed templates require explicit review and can reuse an already paid outgoing record", () => {
  const target = blank();
  target.gastosFixos = [{ id: "old-fixed", nome: "Internet", dia: 10, valor: -199.99, status: "Ativo", custom: "keep" }];
  const paid = F.saveMovement(target, movement({ nome: "Internet já paga", tipo: "Saída", valorCentavos: 18000 }));
  const before = structuredClone(paid);
  F.normalize(target);
  assert.equal(target.financeiro.length, 1);
  F.generateFixedExpenses(target, "2026-09", { links: { "old-fixed": paid.id } });
  assert.equal(target.financeiro.length, 1);
  assert.equal(paid.fixedExpenseId, "old-fixed");
  assert.equal(paid.competencia, "2026-09");
  for (const key of ["valor", "valorCentavos", "pagoEm", "status", "nome", "prazo"]) assert.equal(paid[key], before[key]);
  assert.equal(target.gastosFixos[0].custom, "keep");
  assert.equal(target.gastosFixos[0].recurrenceStart, "2026-09");
  assert.throws(() => F.saveInvestment(target, investment({ movementId: paid.id })), /disponível/);
  assert.throws(() => F.removeMovement(target, paid.id), /competência/);
  assert.throws(() => F.saveMovement(target, movement(), paid.id), /saída financeira/);
});

test("fixed generation rejects conflicting links before creating partial installments", () => {
  const target = blank();
  const first = F.saveFixedExpense(target, fixedExpense());
  const second = F.saveFixedExpense(target, fixedExpense({ nome: "Aluguel" }));
  const available = F.saveMovement(target, movement({ tipo: "Saída" }));
  assert.throws(() => F.generateFixedExpenses(target, "2026-09", { links: { [first.id]: available.id, [second.id]: available.id } }), /diferente/);
  assert.equal(target.financeiro.length, 1);
  assert.equal(available.fixedExpenseId, undefined);
  available.investmentId = "investment";
  assert.throws(() => F.generateFixedExpenses(target, "2026-09", { links: { [first.id]: available.id } }), /disponível/);
  assert.equal(target.financeiro.length, 1);
});

test("fixed generation rejects cancelled links and ID conflicts before changing any installment", () => {
  const target = blank();
  const first = F.saveFixedExpense(target, fixedExpense());
  const second = F.saveFixedExpense(target, fixedExpense({ nome: "Aluguel" }));
  const cancelled = F.saveMovement(target, movement({ tipo: "Saída", status: "Cancelado" }));
  let before = structuredClone(target);
  assert.throws(() => F.generateFixedExpenses(target, "2026-09", { links: { [first.id]: cancelled.id } }), /disponível/);
  assert.deepEqual(target, before);
  cancelled.id = `fixed:${second.id}:2026-09`;
  before = structuredClone(target);
  assert.throws(() => F.generateFixedExpenses(target, "2026-09"), /identificador conflitante/);
  assert.deepEqual(target, before, "A late conflict must not leave an earlier expense generated.");
});

test("paused, cancelled and not-yet-started templates are not generated and cancelled installments are not recreated", () => {
  const target = blank();
  F.saveFixedExpense(target, fixedExpense({ status: "Pausado" }));
  F.saveFixedExpense(target, fixedExpense({ status: "Cancelado" }));
  F.saveFixedExpense(target, fixedExpense({ recurrenceStart: "2026-10" }));
  const active = F.saveFixedExpense(target, fixedExpense());
  F.generateFixedExpenses(target, "2026-09");
  assert.equal(target.financeiro.length, 1);
  assert.equal(target.financeiro[0].fixedExpenseId, active.id);
  target.financeiro[0].status = "Cancelado";
  F.generateFixedExpenses(target, "2026-09");
  assert.equal(target.financeiro.length, 1);
  assert.equal(F.totals(target, september).payableCents, 0);
});

test("summaries use the same category, direction, search, date and status filters as the visible ledger", () => {
  const target = blank();
  F.saveMovement(target, movement({ nome: "Servidor", tipo: "Saída", status: "Pendente", categoria: "Sistema", valorCentavos: 5010 }));
  F.saveMovement(target, movement({ nome: "Servidor pago", tipo: "Saída", categoria: "Sistema", valorCentavos: 1234 }));
  F.saveMovement(target, movement({ nome: "Anúncio", tipo: "Saída", status: "Pendente", categoria: "Marketing", valorCentavos: 90000 }));
  F.saveMovement(target, movement({ nome: "Receita", tipo: "Entrada", categoria: "Sistema", valorCentavos: 40000 }));
  const filters = { ...september, category: "Sistema", type: "Saída", query: "servidor", status: "Pendente" };
  assert.deepEqual(F.totals(target, filters).rows, F.financeRows(target, filters));
  assert.equal(F.totals(target, filters).payableCents, 5010);
  assert.equal(F.totals(target, filters).expenseCents, 0);
  assert.equal(F.totals(target, filters).incomeCents, 0);
  filters.status = "Liquidado";
  assert.equal(F.totals(target, filters).expenseCents, 1234);
  assert.equal(F.totals(target, filters).payableCents, 0);
});

test("settlement uses its real payment month and repeated requests preserve the first confirmed payment", () => {
  const target = blank();
  const row = F.saveMovement(target, movement({ tipo: "Saída", status: "Pendente" }));
  F.settleMovement(target, row.id, "2026-10-03");
  F.settleMovement(target, row.id, "2026-10-04");
  assert.equal(row.pagoEm, "2026-10-03");
  assert.equal(F.totals(target, september).expenseCents, 0);
  assert.equal(F.totals(target, { from: "2026-10-01", to: "2026-10-31" }).expenseCents, 10001);
  assert.throws(() => F.settleMovement(target, row.id, "2026-02-30"), /data/);
  row.status = "Cancelado";
  assert.throws(() => F.settleMovement(target, row.id, "2026-10-03"), /cancelado/);
  row.monthlyId = "historical";
  assert.throws(() => F.settleMovement(target, row.id, "2026-10-03"), /origem/);
});

test("older overdue liabilities remain discoverable outside the selected period", () => {
  const target = blank();
  F.saveMovement(target, movement({ nome: "Pendente anterior", tipo: "Saída", status: "Pendente", prazo: "2020-08-12", data: "2020-08-01" }));
  F.saveMovement(target, movement({ status: "Cancelado", prazo: "2020-08-12" }));
  F.saveMovement(target, movement({ status: "Pago", prazo: "2020-08-12" }));
  assert.equal(F.financeRows(target, september).some(row => row.nome === "Pendente anterior"), false);
  assert.equal(F.overdueBefore(target, "2026-09-01").length, 1);
});
