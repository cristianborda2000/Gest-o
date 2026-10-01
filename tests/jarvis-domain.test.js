'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registry, definitions, validateTool, resolveDate, resolvePeriod, daySummary } = require('../services/jarvis/tools');
const Agenda = require('../app/assets/js/ceo-agenda');
const Finance = require('../app/assets/js/ceo-finance');

const context = { now: new Date('2026-09-30T15:00:00Z'), operationId: 'action-test', userId: 'user-a' };
const task = extra => ({ id: 'task-1', nome: 'Proposta', prazo: '2026-09-30', hora: '09:00', duracao: 30, prioridade: 'Média', status: 'Pendente', observacoes: '', recorrencia: 'none', reminderMinutes: null, ...extra });
const execute = (name, state, input, ctx = context) => {
  const { tool, args } = validateTool(name, input, ctx);
  return tool.execute(state, args, ctx);
};

test('datas relativas e períodos respeitam São Paulo na virada do dia e PT/ES', () => {
  const midnight = { ...context, now: new Date('2026-10-01T02:30:00Z') };
  assert.equal(resolveDate('hoje', midnight), '2026-09-30');
  assert.equal(resolveDate('amanhã', midnight), '2026-10-01');
  assert.equal(resolveDate('mañana', midnight), '2026-10-01');
  assert.equal(resolveDate('sexta-feira', midnight), '2026-10-02');
  assert.equal(resolveDate('sexta feira', midnight), '2026-10-02');
  assert.equal(resolveDate('el viernes', midnight), '2026-10-02');
  assert.equal(resolveDate('el próximo viernes', midnight), '2026-10-02');
  assert.equal(resolveDate('semana que vem', midnight), '2026-10-05');
  assert.equal(resolveDate('01/10/2026', midnight), '2026-10-01');
  assert.deepEqual(resolvePeriod({ period: 'current_week' }, midnight), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(resolvePeriod({ period: 'current_month' }, midnight), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(resolvePeriod({ period: 'last_month' }, midnight), { from: '2026-08-01', to: '2026-08-31' });
  assert.throws(() => resolveDate('31/02/2026', midnight), /inválida/);
});

test('intervalos custom exigem ambos extremos válidos e no máximo 366 dias inclusivos', () => {
  assert.throws(() => execute('get_financial_summary', {}, { period: 'custom', from: '2026-01-01' }), /início e fim/);
  assert.throws(() => resolvePeriod({ period: 'custom' }, context), /início e fim/);
  assert.throws(() => execute('list_tasks', {}, { from: '2026-01-02', to: '2026-01-01' }), /366/);
  assert.throws(() => execute('list_tasks', {}, { from: '2026-01-01', to: '2027-01-02' }), /366/);
  assert.equal(execute('list_tasks', {}, { from: '2026-01-01', to: '2027-01-01' }).total, 0);
});

test('consultas normalizam dados legados em cópia e reutilizam busca de ideias', () => {
  const state = {
    agenda: [{ id: 'old-task', nome: 'Legado', data: '2026-09-30', status: 'Pendente', custom: true }],
    ideias: [{ id: 'old-idea', nome: 'Programa de indicação', description: 'Clientes podem indicar amigos', category: 'Marketing', stage: 'Em avaliação', data: '2026-09-30' }],
    clientes: [{ id: 'old-client', nome: 'Preservado' }]
  };
  const before = structuredClone(state);
  assert.equal(execute('list_tasks', state, {}).tasks[0].id, 'old-task');
  assert.equal(execute('search_ideas', state, { query: 'marketing' }).ideas[0].id, 'old-idea');
  assert.equal(execute('search_ideas', state, { stage: 'avaliacao', category: 'marketing' }).total, 1);
  assert.equal(daySummary(state, context).tasks.total, 1);
  assert.deepEqual(state, before);
});

test('resumo financeiro usa caixa real, centavos e categorias que coincidem com propriedades de objetos', () => {
  const state = { financeiro: [
    { id: 'in', tipo: 'Entrada', valor: 500, status: 'Pago', pagoEm: '2026-09-30' },
    { id: 'out', tipo: 'Saída', valor: -350, categoria: '__proto__', status: 'Pago', pagoEm: '2026-09-30' },
    { id: 'out2', tipo: 'Saída', valor: -0.1, categoria: 'constructor', status: 'Pago', pagoEm: '2026-09-30' },
    { id: 'cancel', tipo: 'Saída', valor: -10000, status: 'Cancelado', pagoEm: '2026-09-30' },
    { id: 'pending', tipo: 'Saída', valor: -200, status: 'Pendente', prazo: '2026-09-30' }
  ] };
  const result = execute('get_financial_summary', state, {});
  assert.equal(result.expenses_cents, 35010);
  assert.equal(result.balance_cents, 14990);
  assert.equal(result.payable_cents, 20000);
  assert.deepEqual(result.expense_categories.map(r => [r.category, r.cents]), [['__proto__', 35000], ['constructor', 10]]);
  assert.equal(JSON.parse(JSON.stringify(result)).expenses_cents, 35010);
});

test('valores e totais fora da precisão segura são rejeitados sem números fictícios', () => {
  const row = { tipo: 'Entrada', status: 'Pago', pagoEm: '2026-09-30' };
  assert.throws(() => execute('get_financial_summary', { financeiro: [{ ...row, valor: 1e20 }] }, {}), /precisão/);
  assert.throws(() => execute('get_financial_summary', { financeiro: [{ ...row, valorCentavos: Number.MAX_SAFE_INTEGER + 1 }] }, {}), /centavos/);
  assert.throws(() => execute('get_financial_summary', { financeiro: [{ ...row, valor: 'inválido' }] }, {}), /inválido/);
  assert.throws(() => execute('get_financial_summary', { financeiro: [{ ...row, valorCentavos: Number.MAX_SAFE_INTEGER }, { ...row, valorCentavos: 1 }] }, {}), /precisão/);
});

test('investimento vinculado aparece nas saídas apenas uma vez', () => {
  const state = {};
  Finance.saveInvestment(state, { nome: 'Equipamento', categoria: 'Equipamentos', valorCentavos: 80000, data: '2026-09-30', objetivo: 'Produzir', status: 'Realizado', geraSaida: true, movementId: '' });
  const summary = execute('get_financial_summary', state, {});
  assert.equal(summary.investments_cents, 80000);
  assert.equal(summary.expenses_cents, 80000);
  assert.equal(summary.balance_cents, -80000);
});

test('cria tarefa e compromisso nos registros reais da agenda com vínculo de auditoria', () => {
  const state = { agenda: [] };
  const created = execute('create_task', state, { title: 'Finalizar proposta', date: 'amanhã', time: '09:00' });
  assert.equal(state.agenda.length, 1);
  assert.equal(created.date, '2026-10-01');
  assert.equal(created.time, '09:00');
  assert.equal(state.agenda[0].jarvisActionId, context.operationId);
  const event = execute('create_agenda_event', state, { title: 'Reunião', date: 'amanhã', time: '10:00' });
  assert.equal(event.type, 'Compromisso');
  assert.equal(state.agenda.length, 2);
});

test('alteração pontual retorna a data efetivamente salva e não aceita IDs inexistentes', () => {
  const state = { agenda: [task()] };
  const updated = execute('update_task', state, { id: 'task-1', date: 'amanhã', time: '14:00' });
  assert.equal(state.agenda[0].prazo, '2026-10-01');
  assert.equal(updated.date, '2026-10-01');
  assert.equal(updated.occurrence_date, '2026-10-01');
  assert.equal(execute('complete_task', state, { id: 'task-1' }).status, 'Concluída');
  assert.throws(() => execute('update_task', state, { id: 'not-found', title: 'Teste' }), /não encontrada/);
});

test('conclusão recorrente exige ocorrência e não afeta dias seguintes', () => {
  const state = { agenda: [task({ recorrencia: 'daily', recurrenceEnd: '2026-10-02' })] };
  assert.throws(() => execute('complete_task', state, { id: 'task-1' }), /ocorrência/);
  const done = execute('complete_task', state, { id: 'task-1', occurrence_date: '2026-10-01' });
  assert.equal(done.status, 'Concluída');
  assert.equal(Agenda.todayTasks(state, '2026-10-02')[0].status, 'Pendente');
  assert.equal(state.agenda[0].exceptions['2026-10-01'].jarvisActionId, context.operationId);
});

test('ocorrência movida além do término da série preserva identidade e não duplica tarefas', () => {
  const state = { agenda: [task({ recorrencia: 'daily', recurrenceEnd: '2026-10-01' })] };
  const moved = execute('update_task', state, { id: 'task-1', occurrence_date: '2026-10-01', date: '2026-10-03', time: '11:00' });
  assert.equal(moved.date, '2026-10-03');
  assert.equal(moved.occurrence_date, '2026-10-01');
  assert.equal(Agenda.todayTasks(state, '2026-10-01').length, 0);
  assert.equal(Agenda.todayTasks(state, '2026-10-03').length, 1);
  const done = execute('complete_task', state, { id: 'task-1', occurrence_date: '2026-10-01' });
  assert.equal(done.date, '2026-10-03');
  assert.equal(done.status, 'Concluída');
});

test('edição e conclusão não reativam ocorrência excluída', () => {
  const state = Agenda.normalize({ agenda: [task({ recorrencia: 'daily', exceptions: { '2026-10-01': { deleted: true } } })] });
  const before = structuredClone(state);
  assert.throws(() => execute('complete_task', state, { id: 'task-1', occurrence_date: '2026-10-01' }), /ocorrência válida/);
  assert.throws(() => execute('update_task', state, { id: 'task-1', occurrence_date: '2026-10-01', title: 'Outra' }), /ocorrência válida/);
  assert.deepEqual(state, before);
  assert.equal(Agenda.todayTasks(state, '2026-10-01').length, 0);
});

test('resumo acha próximo compromisso mesmo além de 50 tarefas anteriores', () => {
  const state = { agenda: Array.from({ length: 51 }, (_, i) => task({ id: `late-${i}` })).concat(task({ id: 'next', hora: '14:00' })) };
  const summary = daySummary(state, context);
  assert.equal(summary.tasks.total, 52);
  assert.equal(summary.tasks.tasks.length, 50);
  assert.equal(summary.tasks.truncated, true);
  assert.equal(summary.nextAppointment.id, 'next');
  assert.equal(summary.overdue.total, 51);
  assert.equal(summary.overdue.tasks.length, 10);
});

test('ideia é gravada no módulo existente sem criar projetos removidos', () => {
  const state = { projetos: [{ id: 'preserved' }] };
  const created = execute('save_idea', state, { title: 'Programa de indicação', category: 'Marketing' });
  assert.equal(state.ideias[0].id, created.id);
  assert.equal(state.ideias[0].jarvisActionId, context.operationId);
  assert.equal(execute('search_ideas', state, { query: 'indicação' }).total, 1);
  assert.deepEqual(state.projetos, [{ id: 'preserved' }]);
});

test('tools financeiras são sensíveis e congelam datas da proposta de confirmação', () => {
  const { tool, args } = validateTool('register_expense', { amount: 350, category: 'Marketing', description: 'Anúncios', date: 'amanhã' }, context);
  assert.equal(tool.risk, 'sensitive');
  assert.equal(args.date, '2026-10-01');
  assert.equal(args.due_date, '2026-10-01');
  const state = {};
  tool.execute(state, args, { ...context, now: new Date('2026-10-10T12:00:00Z') });
  assert.equal(state.financeiro[0].data, '2026-10-01');
  assert.equal(state.financeiro[0].valorCentavos, 35000);
  assert.equal(state.financeiro[0].jarvisActionId, context.operationId);
  assert.throws(() => execute('register_expense', {}, { amount: 350.001, category: 'Marketing', description: 'Anúncios' }), /casas decimais/);
});

test('schemas bloqueiam payloads inválidos, propriedades extras e módulos removidos', () => {
  assert.throws(() => validateTool('create_task', { title: 'Teste', date: 'amanhã', user_id: 'user-b' }, context), /Argumentos inválidos/);
  assert.throws(() => validateTool('list_tasks', { limit: 51 }, context), /Argumentos inválidos/);
  assert.throws(() => validateTool('create_task', { title: 'Teste', date: 'amanhã', time: '25:00' }, context), /Argumentos inválidos/);
  assert.throws(() => validateTool('register_expense', { amount: -1, category: 'Marketing', description: 'Teste' }, context), /Argumentos inválidos/);
  for (const name of ['list_clients', 'get_client', 'create_client_followup', 'list_projects', 'get_project', '__proto__', 'constructor']) assert.throws(() => validateTool(name, {}, context), /não autorizada/);
  assert.ok(definitions().every(def => def.parameters.additionalProperties === false));
});
