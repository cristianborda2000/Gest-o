const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../app/assets/js/admin-data.js');

const blank = () => ({ ...Object.fromEntries(A.collections.map(key => [key, []])), dashboard: [], companyProfile: { nome: 'ZAMA', email: 'contato@example.invalid' }, setupDone: true });
const movement = overrides => ({ id: 'receipt', nome: 'Serviço', categoria: 'Receita', tipo: 'Entrada', valor: 0.1, status: 'Pago', prazo: '2026-09-01', pagoEm: '2026-10-02', ...overrides });

test('complete versioned backup roundtrips every collection and unrelated state without mutation', () => {
  const state = blank();
  state.financeiro.push(movement()); state.ideias.push({ id: 'idea', titulo: 'Planejamento', arquivada: false });
  state.agenda.push({ id: 'task', nome: 'Agenda', exceptions: { '2026-10-04': { deleted: true } } });
  state.custom = { nested: ['preserved', { number: 42 }] };
  const before = structuredClone(state), envelope = A.makeBackup(state);
  assert.equal(envelope.type, 'zama-backup'); assert.equal(envelope.version, 1);
  const restored = A.restoredState(A.parseBackup(JSON.stringify(envelope)), blank());
  assert.deepEqual(restored, state); assert.deepEqual(state, before);
  restored.agenda[0].nome = 'Changed'; assert.equal(state.agenda[0].nome, 'Agenda');
});

test('both historical and new monthly reports are rejected before any data can be replaced', () => {
  assert.throws(() => A.parseBackup({ mes: '2026-10', geradoEm: 'today', financeiro: [], gastosFixos: [], mensalidades: [], totais: {} }), /relatório mensal/);
  assert.throws(() => A.parseBackup(A.monthlyReport(blank(), '2026-10')), /relatório mensal/);
  assert.throws(() => A.parseBackup({ financeiro: [] }), /Backup incompleto/);
  const source = A.makeBackup(blank()); delete source.data.ideias;
  assert.throws(() => A.parseBackup(source), /falta Ideias/);
});

test('legacy complete backups preserve modern collections and settings absent in their original format', () => {
  const legacy = blank(); delete legacy.investimentos; delete legacy.ideias; delete legacy.contractHistory;
  delete legacy.setupDone;
  const current = blank(); current.investimentos = [{ id: 'inv', nome: 'Mantido', valor: 20 }];
  current.ideias = [{ id: 'idea', titulo: 'Não apagar' }]; current.agendaSettings = { enabled: false, leadMinutes: 15 };
  const parsed = A.parseBackup(JSON.stringify(legacy)), restored = A.restoredState(parsed, current);
  assert.equal(parsed.legacy, true); assert.deepEqual(parsed.preserved, ['investimentos', 'ideias', 'contractHistory']);
  assert.deepEqual(restored.ideias, current.ideias); assert.deepEqual(restored.investimentos, current.investimentos);
  assert.deepEqual(restored.agendaSettings, current.agendaSettings); assert.equal(restored.setupDone, true);
});

test('malformed collections, row types, numeric values, settings and duplicate IDs fail validation', () => {
  for (const key of A.collections) {
    const candidate = blank(); candidate[key] = {};
    assert.throws(() => A.makeBackup(candidate), /lista/);
    candidate[key] = [null]; assert.throws(() => A.makeBackup(candidate), /Registro/);
  }
  for (const invalid of [{ nome: {} }, { valor: 'NaN' }, { valor: Infinity }, { valorCentavos: 1.5 }, { valorCentavos: -10 }, { tipo: [] }, { geraSaida: 'false' }, { exceptions: [] }]) {
    const state = blank(); state.financeiro = [movement(invalid)];
    assert.throws(() => A.makeBackup(state), /inválid|Formato/);
  }
  const state = blank(); state.financeiro = [movement(), movement()];
  assert.throws(() => A.makeBackup(state), /repetidos/);
  state.financeiro = []; state.agendaSettings = { enabled: 'true' };
  assert.throws(() => A.makeBackup(state), /Preferências/);
  state.agendaSettings = { dailyTime: '25:90' };
  assert.throws(() => A.makeBackup(state), /Horário/);
});

test('JSON prototype pollution, unsupported versions and oversized files are rejected', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) assert.throws(() => A.parseBackup(`{"${key}": {"polluted": true}}`), /não permitidas/);
  const source = A.makeBackup(blank()); source.data.ideias = [{ id: 'safe', nested: JSON.parse('{"__proto__":{"polluted":true}}') }];
  assert.throws(() => A.parseBackup(source), /não permitidas/); assert.equal({}.polluted, undefined);
  const future = A.makeBackup(blank()); future.version = 99;
  assert.throws(() => A.parseBackup(future), /não suportado/);
  assert.throws(() => A.parseBackup(' '.repeat(A.MAX_BYTES + 1)), /10 MB/);
  assert.throws(() => A.parseBackup('{bad'), /ler o JSON/);
  assert.equal(A.parseBackup('\ufeff' + JSON.stringify(A.makeBackup(blank()))).legacy, false);
});

test('fixed expense backups reject invalid recurrence dates before replacing records', () => {
  for (const invalid of [{ dia: 1.5 }, { dia: 0 }, { dia: 32 }, { recurrenceStart: {} }, { recurrenceStart: '2026-13' }, { recurrenceStart: '2026-1' }, { recurrenceStart: '1899-12' }]) {
    const state = blank();
    state.gastosFixos = [{ id: 'fixed', nome: 'Aluguel', valor: -1000, dia: 5, ...invalid }];
    assert.throws(() => A.parseBackup(JSON.stringify(state)), /inválid/);
  }
  const state = blank();
  state.gastosFixos = [{ id: 'fixed', nome: 'Aluguel', valor: -1000, dia: '31', recurrenceStart: '2026-10' }];
  assert.deepEqual(A.parseBackup(A.makeBackup(state)).data.gastosFixos, state.gastosFixos);
});

test('accepted numeric-string cents retain their value in monthly report exports', () => {
  const state = blank();
  const row = movement({ valorCentavos: '12345' });
  delete row.valor;
  state.financeiro = [row];
  const restored = A.restoredState(A.parseBackup(A.makeBackup(state)), blank());
  const report = A.monthlyReport(restored, '2026-10');
  assert.equal(report.totais.incomeCents, 12345);
  assert.match(A.csvReport(report), /;123,45;12345;/);
});

test('reports use the chosen month, settlement dates and cent totals without subtracting investments twice', () => {
  const state = blank();
  state.financeiro = [movement(), movement({ id: 'two', valor: .2 }), movement({ id: 'expense', tipo: 'Saída', categoria: 'Sistema', valor: -.15, investmentId: 'inv' }), movement({ id: 'pending', tipo: 'Saída', categoria: 'Sistema', valor: -12.34, status: 'Pendente', prazo: '2026-10-06', pagoEm: '' }), movement({ id: 'cancel', status: 'Cancelado', prazo: '2026-10-01', valor: 1000 }), movement({ id: 'outside', pagoEm: '2026-09-01' }), movement({ id: 'undated', prazo: '', pagoEm: '' })];
  state.investimentos = [{ id: 'inv', nome: 'Software', valor: .15, data: '2026-10-02', status: 'Realizado', geraSaida: true }];
  const before = structuredClone(state), report = A.monthlyReport(state, '2026-10');
  assert.equal(report.totais.incomeCents, 30); assert.equal(report.totais.expenseCents, 15);
  assert.equal(report.totais.balanceCents, 15); assert.equal(report.totais.payableCents, 1234);
  assert.equal(report.totais.investmentCents, 15); assert.equal(report.financeiro.length, 5);
  assert.equal(report.registrosSemData, 1); assert.equal(report.categorias.find(row => row.categoria === 'Sistema').payableCents, 1234);
  assert.deepEqual(state, before);
  assert.equal(A.monthlyReport(state, '2026-09').totais.incomeCents, 10);
  assert.deepEqual(A.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  for (const invalid of ['2026-13', '2026-00', '', '00-10', '0000-01']) assert.throws(() => A.monthlyReport(state, invalid), /mês válido/);
});

test('CSV exports Excel-compatible UTF-8 data with formula and quoting protection', () => {
  const state = blank(); state.financeiro = [movement({ nome: '=HYPERLINK("evil")', observacoes: '\t=1+1', categoria: '  +SUM(A1)', formaPagamento: '@SUM(1;2)' })];
  const csv = A.csvReport(A.monthlyReport(state, '2026-10'));
  assert.equal(csv.charCodeAt(0), 0xfeff); assert.match(csv, /"Mês";"ID"/);
  assert.match(csv, /"'=HYPERLINK\(""evil""\)"/);
  assert.match(csv, /"'\t=1\+1"/); assert.match(csv, /"'  \+SUM\(A1\)"/);
  assert.match(csv, /;0,1;10;/);
  assert.equal(A.csvCell(-12.34), '-12,34'); assert.equal(A.csvCell('-12.34'), '"\'-12.34"');
});

test('printable reports escape all supplied content and provide clear accounting criteria', () => {
  const state = blank(); state.companyProfile.nome = '<script>alert(1)</script>';
  state.financeiro = [movement({ nome: '<img src=x onerror=alert(2)>', observacoes: '<b>nota</b>' })];
  const html = A.printReport(A.monthlyReport(state, '2026-10'));
  assert.doesNotMatch(html, /<script>|<img|<b>nota/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /@page\{size:A4 landscape/);
  assert.match(html, /outubro de 2026/); assert.match(html, /Resumo por categoria/);
  assert.match(html, /não substitui um backup completo/);
});
