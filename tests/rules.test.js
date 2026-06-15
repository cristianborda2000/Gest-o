const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = [
  "app/assets/js/env.js",
  "app/assets/js/config.js",
  "app/assets/js/records.js"
].map((file) => fs.readFileSync(file, "utf8")).join("\n");

const sandbox = {
  assert,
  console,
  Intl,
  Date,
  Math,
  window: {
    supabase: null,
    crypto: {
      randomUUID: (() => {
        let index = 0;
        return () => `id-${++index}`;
      })()
    }
  }
};

vm.createContext(sandbox);
vm.runInContext(`${source}

function resetState() {
  state = {
    projetos: [],
    marketing: [],
    clientes: [],
    mensalidades: [],
    agenda: [],
    rh: [],
    financeiro: [],
    gastosFixos: [],
    contractHistory: [],
    companyProfile: {},
    setupDone: true
  };
}

function testProjectFinance() {
  resetState();
  const project = { id: "project-1", nome: "Site novo", inicio: "2026-06-01", prazo: "2026-06-20", status: "Em andamento", valor: 1000 };
  syncProjectFinance(project, state);
  assert.strictEqual(state.financeiro.length, 2);
  assert.strictEqual(state.financeiro[0].valor, 500);
  assert.strictEqual(state.financeiro[1].installment, "final");
  assert.strictEqual(state.financeiro[1].status, "Agendado");
}

function testMonthlyFinance() {
  resetState();
  const monthly = { id: "monthly-1", nome: "Cliente A", responsavel: "Básico", prazo: "2026-06-10", status: "Pago", valor: 490 };
  syncMonthlyFinance(monthly, state);
  assert.strictEqual(state.financeiro.length, 1);
  assert.strictEqual(state.financeiro[0].status, "Pago");
  assert.strictEqual(state.financeiro[0].valor, 490);
  assert.ok(state.financeiro[0].pagoEm);
}

function testClientMonthly() {
  resetState();
  const client = { id: "client-1", nome: "Cliente B", responsavel: "Maria", plano: "Avançado", prazo: "2026-06-15", status: "Ativo", valor: 1200 };
  syncClientMonthly(client, state);
  assert.strictEqual(state.mensalidades.length, 1);
  assert.strictEqual(state.mensalidades[0].clientId, "client-1");
  assert.strictEqual(state.mensalidades[0].responsavel, "Avançado");
  assert.strictEqual(state.financeiro.length, 1);
}

function testFinancialTotals() {
  resetState();
  state.financeiro = [
    { nome: "Entrada", tipo: "Entrada", status: "Pago", valor: 1000, prazo: "2026-06-01" },
    { nome: "Saída", tipo: "Saída", status: "Pago", valor: -250, prazo: "2026-06-01" },
    { nome: "Pendente", tipo: "Entrada", status: "Pendente", valor: 300, prazo: "2026-06-01" }
  ];
  const totals = getFinancialTotals();
  assert.strictEqual(totals.paidIncome, 1000);
  assert.strictEqual(totals.paidOutcome, 250);
  assert.strictEqual(totals.balance, 750);
}

testProjectFinance();
testMonthlyFinance();
testClientMonthly();
testFinancialTotals();
`, sandbox);

console.log("Testes das regras financeiras passaram.");
