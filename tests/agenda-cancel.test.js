'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Agenda = require('../app/assets/js/ceo-agenda');
const { validateTool } = require('../services/jarvis/tools');
const context = { now: new Date('2026-11-12T12:00:00Z'), operationId: 'fixture-cancel-action' };
const event = extra => ({ id: 'event-1', nome: 'Reunião', tipo: 'Compromisso', prazo: '2026-11-12', hora: '10:00', duracao: 30, prioridade: 'Média', status: 'Pendente', observacoes: 'Descrição original', recorrencia: 'none', recurrenceEnd: '', reminderMinutes: 15, exceptions: {}, ...extra });
const fixture = rows => Agenda.normalize({ agenda: rows || [event()], agendaSettings: { enabled: true, taskEnabled: true, dailyEnabled: false, leadMinutes: 15 }, ideias: [{ id: 'idea-1', taskId: 'event-1' }], clientes: [{ id: 'client-1', nome: 'Preservado' }] });
function execute(name, state, input, current = context) {
  const { tool, args } = validateTool(name, input, current);
  return tool.execute(state, args, current);
}
const cancel = (state, input, current) => execute('cancel_agenda_event', state, input, current);

test('cancelamento preserva registro, vínculo, observações e auditoria sem alterar outros itens', () => {
  const state = fixture([event(), event({ id: 'event-2' })]);
  const before = structuredClone(state);
  const result = cancel(state, { id: 'event-1', reason: 'Cliente solicitou adiamento' });
  assert.equal(result.status, 'Cancelada');
  assert.equal(result.cancellation_scope, 'occurrence');
  assert.equal(result.already_cancelled, false);
  assert.equal(result.cancelled_at, context.now.toISOString());
  assert.equal(result.cancellation_reason, 'Cliente solicitou adiamento');
  assert.equal(result.reminder, null);
  assert.equal(state.agenda.length, 2);
  assert.equal(state.agenda[0].status, 'Cancelado');
  assert.equal(state.agenda[0].observacoes, 'Descrição original');
  assert.equal(state.agenda[0].jarvisActionId, context.operationId);
  assert.deepEqual(state.agenda[1], before.agenda[1]);
  assert.deepEqual(state.ideias, before.ideias);
  assert.deepEqual(state.clientes, before.clientes);
});

test('cancelamento atende tarefas e compromissos da mesma agenda e suprime seus lembretes', () => {
  const state = fixture([event(), event({ id: 'task-1', tipo: 'Tarefa', hora: '11:00' })]);
  const from = Agenda.helpers.toEpoch('2026-11-12', '09:00'), to = Agenda.helpers.toEpoch('2026-11-12', '12:00');
  assert.equal(Agenda.helpers.remindersBetween(state, from, to).length, 2);
  cancel(state, { id: 'event-1' });
  cancel(state, { id: 'task-1' });
  assert.equal(execute('get_agenda', state, { from: '2026-11-12' }).total, 0);
  assert.equal(Agenda.helpers.remindersBetween(state, from, to).length, 0);
  assert.equal(state.agenda.length, 2);
});

test('repetir cancelamento já aplicado conserva motivo e primeira auditoria', () => {
  const state = fixture();
  cancel(state, { id: 'event-1', reason: 'Motivo original' });
  const before = structuredClone(state);
  const result = cancel(state, { id: 'event-1', reason: 'Outro motivo' }, { ...context, now: new Date('2026-11-13T12:00:00Z'), operationId: 'other-action' });
  assert.equal(result.already_cancelled, true);
  assert.equal(result.cancellation_reason, 'Motivo original');
  assert.deepEqual(state, before);
});

test('ocorrência recorrente exige data original e não cancela a série', () => {
  const state = fixture([event({ recorrencia: 'daily', recurrenceEnd: '2026-11-15' })]);
  const before = structuredClone(state);
  assert.throws(() => cancel(state, { id: 'event-1' }), error => error.code === 'AGENDA_OCCURRENCE_REQUIRED');
  assert.deepEqual(state, before);
  const result = cancel(state, { id: 'event-1', occurrence_date: 'amanhã' });
  assert.equal(result.date, '2026-11-13');
  assert.equal(result.occurrence_date, '2026-11-13');
  assert.equal(result.status, 'Cancelada');
  assert.equal(state.agenda[0].status, 'Pendente');
  assert.equal(state.agenda[0].exceptions['2026-11-13'].status, 'Cancelado');
  assert.equal(Agenda.todayTasks(state, '2026-11-14')[0].status, 'Pendente');
  const due = Agenda.helpers.toEpoch('2026-11-13', '09:45');
  assert.equal(Agenda.helpers.remindersBetween(state, due, due).length, 0);
});

test('ocorrência remarcada é cancelada pela identidade original e preserva a nova data', () => {
  const state = fixture([event({ recorrencia: 'daily', recurrenceEnd: '2026-11-13', exceptions: { '2026-11-13': { prazo: '2026-11-16', hora: '15:00', custom: 'preserve' } } })]);
  const result = cancel(state, { id: 'event-1', occurrence_date: '2026-11-13' });
  assert.equal(result.date, '2026-11-16');
  assert.equal(result.occurrence_date, '2026-11-13');
  assert.equal(result.time, '15:00');
  assert.equal(state.agenda[0].exceptions['2026-11-13'].custom, 'preserve');
  assert.equal(Agenda.todayTasks(state, '2026-11-16')[0].status, 'Cancelado');
});

test('série explícita cancela exceções ativas, preservando concluídas, excluídas e seus detalhes', () => {
  const state = fixture([event({ recorrencia: 'daily', recurrenceEnd: '2026-11-20', exceptions: {
    '2026-11-12': { deleted: true, custom: 'deleted-history' },
    '2026-11-13': { status: 'Concluído', jarvisActionId: 'completed-action', custom: 'completed-history' },
    '2026-11-14': { status: 'Pendente', prazo: '2026-11-21', custom: 'moved' },
    '2026-11-15': { hora: '14:00' },
    '2026-11-16': { status: 'Cancelado', cancelledAt: '2026-11-11T12:00:00Z', cancellationReason: 'Anterior' }
  } })]);
  const before = structuredClone(state);
  const result = cancel(state, { id: 'event-1', scope: 'series', reason: 'Encerrada' });
  assert.equal(result.cancellation_scope, 'series');
  assert.equal(result.status, 'Cancelada');
  for (const date of ['2026-11-12', '2026-11-13', '2026-11-16']) assert.deepEqual(state.agenda[0].exceptions[date], before.agenda[0].exceptions[date]);
  assert.equal(Agenda.todayTasks(state, '2026-11-13')[0].status, 'Concluído');
  assert.equal(Agenda.todayTasks(state, '2026-11-15')[0].status, 'Cancelado');
  assert.equal(Agenda.todayTasks(state, '2026-11-17')[0].status, 'Cancelado');
  assert.equal(Agenda.todayTasks(state, '2026-11-21')[0].status, 'Cancelado');
  assert.equal(state.agenda[0].exceptions['2026-11-14'].prazo, '2026-11-21');
  assert.equal(state.agenda[0].exceptions['2026-11-14'].custom, 'moved');
  assert.equal(state.agenda[0].exceptions['2026-11-15'].hora, '14:00');
  assert.equal(state.agenda[0].recurrenceEnd, '2026-11-20');
  assert.equal(state.agenda.length, 1);
  const cancelled = structuredClone(state);
  assert.equal(cancel(state, { id: 'event-1', scope: 'series' }).already_cancelled, true);
  assert.deepEqual(state, cancelled);
});

test('IDs inexistentes, datas incompatíveis, ocorrências excluídas e concluídas falham sem mudança', () => {
  const state = fixture([event(), event({ id: 'series', recorrencia: 'weekly', recurrenceEnd: '2026-12-01', exceptions: { '2026-11-19': { deleted: true }, '2026-11-26': { status: 'Concluído' } } }), event({ id: 'done', status: 'Concluído' })]);
  const before = structuredClone(state);
  for (const input of [
    { id: 'missing' }, { id: 'event-1', occurrence_date: '2026-11-13' }, { id: 'event-1', scope: 'series' },
    { id: 'series', occurrence_date: '2026-11-13' }, { id: 'series', occurrence_date: '2026-11-19' },
    { id: 'series', occurrence_date: '2026-11-26' }, { id: 'done' }
  ]) {
    assert.throws(() => cancel(state, input));
    assert.deepEqual(state, before);
  }
});

test('schemas recusam identidade externa, cancelamento por título e escopo ambíguo', () => {
  const state = fixture();
  const before = structuredClone(state);
  for (const input of [{ title: 'Reunião' }, { id: 'event-1', owner_id: 'another-owner' }, { id: 'event-1', scope: 'future' }, { id: 'event-1', reason: 'x'.repeat(1001) }]) assert.throws(() => cancel(state, input), error => error.code === 'INVALID_TOOL_INPUT');
  assert.deepEqual(state, before);
});

test('registro legado pode ser cancelado pelo ID realmente retornado na consulta', () => {
  const state = { agenda: [{ titulo: 'Legado', data: '2026-11-12', status: 'Pendente' }, { id: 'other-legacy', titulo: 'Outro registro', date: '2026-11-13' }] };
  const unrelated = structuredClone(state.agenda[1]);
  const listed = execute('get_agenda', state, { from: '2026-11-12' });
  const result = cancel(state, { id: listed.tasks[0].id });
  assert.equal(result.status, 'Cancelada');
  assert.equal(state.agenda[0].titulo, 'Legado');
  assert.equal(state.agenda.length, 2);
  assert.deepEqual(state.agenda[1], unrelated);
  assert.equal(state.agendaSettings, undefined);
});
