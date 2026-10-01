'use strict';
const { z } = require('zod');
const Time = require('../../app/assets/js/ceo-time');
const Finance = require('../../app/assets/js/ceo-finance');
const Agenda = require('../../app/assets/js/ceo-agenda');
const Ideas = require('../../app/assets/js/ceo-ideas');
const { JarvisError } = require('./errors');
const fold = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const str = max => z.string().trim().min(1).max(max);
const opt = max => z.string().trim().max(max).optional();
const date = str(60);
const priority = z.enum(['low', 'medium', 'high']).optional();
const priorities = { low: 'Baixa', medium: 'Média', high: 'Alta' };
const now = (context = {}) => new Date(context.now ?? Date.now());
const today = context => Time.today(now(context));
function readState(state) {
  // Reuse the same compatibility rules as the administrative UI, on a private
  // snapshot. A read must never persist normalization or mutate its caller.
  const snapshot = structuredClone(state);
  // Finance's readers already understand legacy signed values; do not rewrite
  // monetary fields before the summary can validate their original precision.
  Agenda.normalize(snapshot); Ideas.normalize(snapshot);
  return snapshot;
}
function resolveDate(value, context = {}) {
  const key = fold(value || 'hoje').replace(/^(?:para |pro |pra |no dia |dia )/, ''), current = today(context);
  if (Finance.validDate(value)) return value;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(key);
  if (br) {
    const day = `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
    if (Finance.validDate(day)) return day;
  }
  const offsets = { hoje: 0, hoy: 0, today: 0, amanha: 1, manana: 1, tomorrow: 1, ontem: -1, ayer: -1, 'depois de amanha': 2, 'pasado manana': 2 };
  if (Object.hasOwn(offsets, key)) return Time.addDays(current, offsets[key]);
  const weekDay = new Date(`${current}T12:00:00Z`).getUTCDay();
  if (['semana que vem', 'proxima semana', 'la proxima semana'].includes(key)) return Time.addDays(current, (8 - weekDay) % 7 || 7);
  const relativeDays = /^(?:daqui a|em|en) (\d{1,3}) dias?$/.exec(key);
  if (relativeDays && Number(relativeDays[1]) <= 365) return Time.addDays(current, Number(relativeDays[1]));
  const days = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const esDays = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const nextWeek = /(?:da |de la )?(?:semana que vem|proxima semana)$/.test(key);
  const cleaned = key.replace(/^(na |no |el )/, '').replace(/^proxim[ao] /, '').replace(/\s+(?:(?:da |de la )?(?:semana que vem|proxima semana)|que vem)$/, '').replace(/[- ]feira$/, '');
  const idx = days.includes(cleaned) ? days.indexOf(cleaned) : esDays.indexOf(cleaned);
  if (idx >= 0 && nextWeek) {
    const nextMonday = Time.addDays(current, (8 - weekDay) % 7 || 7);
    return Time.addDays(nextMonday, (idx + 6) % 7);
  }
  if (idx >= 0) return Time.addDays(current, (idx - weekDay + 7) % 7 || 7);
  throw new JarvisError('Data ambígua ou inválida. Informe o dia no formato DD/MM/AAAA.', 400, 'INVALID_DATE');
}
function resolvePeriod(args, context) {
  const day = today(context), p = args.period || 'current_month';
  let range;
  if (p === 'today') range = { from: day, to: day };
  else if (p === 'current_week') {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const from = Time.addDays(day, -(dow + 6) % 7); range = { from, to: Time.addDays(from, 6) };
  } else if (p === 'last_month') range = Time.monthRange(Time.addDays(`${day.slice(0, 7)}-01`, -1).slice(0, 7));
  else if (p === 'custom') {
    if (!args.from || !args.to) throw new JarvisError('Informe início e fim do período.', 400, 'INVALID_PERIOD');
    range = { from: resolveDate(args.from, context), to: resolveDate(args.to, context) };
  }
  else range = Time.monthRange(day.slice(0, 7));
  checkRange(range); return range;
}
function checkRange({ from, to }) {
  if (!Finance.validDate(from) || !Finance.validDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 >= 366) throw new JarvisError('Escolha um período de até 366 dias.', 400, 'INVALID_PERIOD');
}
function taskView(task, context) {
  return { id: task.seriesId || task.id, occurrence_date: task.occurrenceDate || task.prazo, title: task.nome, date: task.prazo, time: task.hora || null, duration_minutes: task.duracao || 0, priority: task.prioridade, status: Agenda.helpers.taskStatus(task, +now(context)), description: String(task.observacoes || '').slice(0, 1000), type: task.tipo || 'Tarefa', recurrence: task.recorrencia || 'none', recurrence_end: task.recurrenceEnd || null };
}
function taskList(state, args, context) {
  const end = resolveDate(args.to || args.from || 'hoje', context);
  const start = resolveDate(args.from || (args.status === 'overdue' ? Time.addDays(today(context), -365) : 'hoje'), context);
  checkRange({ from: start, to: end });
  const rows = [];
  for (let day = start; day <= end; day = Time.addDays(day, 1)) {
    for (const task of Agenda.todayTasks(state, day)) {
      const status = Agenda.helpers.taskStatus(task, +now(context));
      if (Agenda.helpers.isCancelled(task)) continue;
      if (args.status === 'overdue' && status !== 'Atrasada') continue;
      if (args.status === 'completed' && !Agenda.helpers.isDone(task)) continue;
      if (args.status === 'pending' && Agenda.helpers.isDone(task)) continue;
      rows.push(taskView(task, context));
    }
  }
  return { from: start, to: end, total: rows.length, tasks: rows.slice(0, args.limit || 50), truncated: rows.length > (args.limit || 50), timezone: Time.zone };
}
function financialSummary(state, args, context) {
  const range = resolvePeriod(args, context), total = Finance.totals(state, range), groups = Object.create(null);
  const moneyRows = total.rows.concat((state.investimentos || []).filter(row => Finance.isRealized(row) && (row.data || row.prazo || '') >= range.from && (row.data || row.prazo || '') <= range.to));
  for (const row of moneyRows) {
    if (row.valor !== undefined && row.valor !== null) {
      let raw = String(row.valor).trim().replace(/\s|R\$/g, '');
      if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
      if (!/^-?\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > Number.MAX_SAFE_INTEGER / 100) throw new JarvisError('Um valor financeiro excede a precisão suportada ou é inválido. Revise os registros.', 422);
    } else if (row.valorCentavos !== undefined && !Number.isSafeInteger(row.valorCentavos)) throw new JarvisError('Um valor em centavos é inválido. Revise os registros.', 422);
  }
  for (const row of total.rows) if (Finance.isSettled(row) && Finance.direction(row) === 'Saída') {
    const category = String(row.categoria || row.responsavel || 'Outros');
    groups[category] = (groups[category] || 0) + Finance.amountCents(row);
  }
  for (const key of ['incomeCents', 'expenseCents', 'balanceCents', 'investmentCents', 'receivableCents', 'payableCents']) if (!Number.isSafeInteger(total[key])) throw new JarvisError('Totais excedem a precisão suportada. Revise os registros.', 422);
  return { ...range, currency: 'BRL', income_cents: total.incomeCents, expenses_cents: total.expenseCents, balance_cents: total.balanceCents, investments_cents: total.investmentCents, receivable_cents: total.receivableCents, payable_cents: total.payableCents,
    income: Finance.formatMoney(total.incomeCents), expenses: Finance.formatMoney(total.expenseCents), balance: Finance.formatMoney(total.balanceCents),
    expense_categories: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([category, cents]) => ({ category, cents, amount: Finance.formatMoney(cents) })), note: 'Caixa considera somente recebidos/pagos. Cancelados excluídos; investimentos vinculados já incluídos nas saídas.' };
}
function daySummary(state, context) {
  state = readState(state);
  const day = today(context), tasks = taskList(state, { from: day, to: day }, context), overdue = taskList(state, { status: 'overdue', limit: 10 }, context);
  // Find the next timed appointment before applying the conversation's list
  // limit. A busy morning must not hide an afternoon appointment.
  let upcoming = null;
  for (let date = day, last = Time.addDays(day, 30); date <= last && !upcoming; date = Time.addDays(date, 1)) {
    const task = Agenda.todayTasks(state, date).find(t => !Agenda.helpers.isDone(t) && !Agenda.helpers.isCancelled(t) && Agenda.helpers.validTime(t.hora) && Time.toEpoch(t.prazo, t.hora) >= +now(context));
    if (task) upcoming = taskView(task, context);
  }
  const reminder = Agenda.nextReminder(state, +now(context));
  return { date: day, timezone: Time.zone, tasks, overdue: { ...overdue, note: 'Ocorrências nos últimos 366 dias.' }, financial: financialSummary(state, { period: 'current_month' }, context), nextAppointment: upcoming || null, nextReminder: reminder ? { title: reminder.title, at: new Date(reminder.dueAt).toISOString() } : null,
    dues: Agenda.helpers.financialDues(state, day).slice(0, 30).map(row => ({ title: row.nome, kind: row.dueKind, amount: Finance.formatMoney(Finance.amountCents(row)) })) };
}
const registry = Object.create(null);
function define(name, risk, description, schema, execute, prepare) {
  registry[name] = { risk, description, schema, execute: risk === 'read' ? (state, args, context) => execute(readState(state), args, context) : execute, prepare };
}
const listSchema = z.object({ from: date.optional(), to: date.optional(), status: z.enum(['all', 'pending', 'completed', 'overdue']).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const periodSchema = z.object({ period: z.enum(['today', 'current_week', 'current_month', 'last_month', 'custom']).optional(), from: date.optional(), to: date.optional() }).strict();
const taskSchema = z.object({ title: str(180), date, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), description: opt(5000), priority, duration_minutes: z.number().int().min(0).max(1440).optional(), recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly', 'monthly']).optional(), recurrence_end: date.optional() }).strict();
const taskInput = (args, context) => ({ nome: args.title, prazo: resolveDate(args.date, context), hora: args.time || '', duracao: args.duration_minutes ?? 30, prioridade: priorities[args.priority || 'medium'], status: 'Pendente', observacoes: args.description || '', recorrencia: args.recurrence || 'none', recurrenceEnd: args.recurrence_end ? resolveDate(args.recurrence_end, context) : '', reminderMinutes: null, jarvisActionId: context.operationId });
define('get_today_summary', 'read', 'Resumo REAL de hoje: tarefas, compromissos, atrasos, contas e financeiro. Não contar compromissos duas vezes: são registros da agenda.', z.object({}).strict(), (s, a, c) => daySummary(s, c));
define('list_tasks', 'read', 'Consulte tarefas antes de escolher um ID para editar/concluir. Filtre hoje, próximas ou atrasadas. Nunca invente IDs.', listSchema, taskList);
define('get_agenda', 'read', 'Agenda real por intervalo de datas (máximo 366 dias), com horários de São Paulo.', listSchema, taskList);
define('get_financial_summary', 'read', 'Totais reais em centavos e BRL, contas pendentes e maiores categorias. Período custom exige from e to.', periodSchema, (s, a, c) => { if (a.period === 'custom' && (!a.from || !a.to)) throw new JarvisError('Informe início e fim do período.'); return financialSummary(s, a, c); });
define('create_task', 'write', 'Crie uma tarefa na agenda. Exige título claro e data; se faltar, pergunte. Data aceita amanhã/sexta/hoje e espanhol. Horário omitido significa sem hora definida.', taskSchema, (s, a, c) => taskView(Agenda.saveTask(s, taskInput(a, c)), c));
define('create_agenda_event', 'write', 'Crie compromisso na mesma agenda existente, sem duplicar tarefa. Exige título e data.', taskSchema, (s, a, c) => taskView(Agenda.saveTask(s, { ...taskInput(a, c), tipo: 'Compromisso' }), c));
const updateSchema = taskSchema.partial().extend({ id: str(160), occurrence_date: date.optional() }).strict();
define('update_task', 'write', 'Edite uma tarefa identificada por consulta anterior. Recorrentes exigem occurrence_date e alteram só aquela ocorrência. Não invente ID.', updateSchema, (s, a, c) => {
  const base = (s.agenda || []).find(t => t.id === a.id); if (!base) throw new JarvisError('Tarefa não encontrada.', 404);
  const recurring = base.recorrencia && base.recorrencia !== 'none';
  if (recurring && !a.occurrence_date) throw new JarvisError('Informe a ocorrência a alterar.');
  if (recurring && (a.recurrence || a.recurrence_end)) throw new JarvisError('Altere a série pelo editor da agenda.');
  const original = a.occurrence_date ? resolveDate(a.occurrence_date, c) : base.prazo;
  const changes = { jarvisActionId: c.operationId };
  const mapping = { title: 'nome', time: 'hora', description: 'observacoes', duration_minutes: 'duracao', recurrence: 'recorrencia' };
  for (const [key, field] of Object.entries(mapping)) if (a[key] !== undefined) changes[field] = a[key];
  if (a.date) changes.prazo = resolveDate(a.date, c);
  if (a.recurrence_end) changes.recurrenceEnd = resolveDate(a.recurrence_end, c);
  if (a.priority) changes.prioridade = priorities[a.priority];
  Agenda.saveTask(s, changes, a.id, original);
  const saved = s.agenda.find(t => t.id === a.id);
  return taskView(recurring ? Agenda.helpers.occurrence(saved, original) : saved, c);
});
define('complete_task', 'write', 'Conclua a tarefa real identificada por consulta; em recorrência exige a data original da ocorrência. Nunca adivinhe entre títulos parecidos.', z.object({ id: str(160), occurrence_date: date.optional() }).strict(), (s, a, c) => {
  const base = (s.agenda || []).find(t => t.id === a.id); if (!base) throw new JarvisError('Tarefa não encontrada.', 404);
  if (base.recorrencia && base.recorrencia !== 'none' && !a.occurrence_date) throw new JarvisError('Informe qual ocorrência deseja concluir.');
  const original = resolveDate(a.occurrence_date || base.prazo, c);
  Agenda.saveTask(s, { status: 'Concluído', jarvisActionId: c.operationId }, a.id, original);
  const saved = s.agenda.find(t => t.id === a.id);
  return taskView(base.recorrencia && base.recorrencia !== 'none' ? Agenda.helpers.occurrence(saved, original) : saved, c);
});
define('save_idea', 'write', 'Salve uma ideia no banco existente. Não existe módulo de projetos ativo; não crie vínculo fictício.', z.object({ title: str(180), description: opt(5000), category: opt(80), priority }).strict(), (s, a, c) => {
  const row = Ideas.upsert(s, { titulo: a.title, descricao: a.description, categoria: a.category || 'Geral', prioridade: priorities[a.priority || 'medium'], etapa: 'capturada', data: today(c) });
  row.jarvisActionId = c.operationId; return { id: row.id, title: row.titulo, stage: row.etapa };
});
define('search_ideas', 'read', 'Busque ideias reais ativas por título, descrição, categoria e etapa.', z.object({ query: opt(150), category: opt(80), stage: z.enum(['capturada', 'avaliacao', 'execucao', 'concluida']).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(), (s, a) => {
  const rows = Ideas.filterIdeas(s, { search: a.query, stage: a.stage }).filter(r => !a.category || fold(r.categoria) === fold(a.category));
  return { total: rows.length, ideas: rows.slice(0, a.limit || 20).map(r => ({ id: r.id, title: r.titulo, description: String(r.descricao || '').slice(0, 1500), category: r.categoria, stage: r.etapa, date: r.data })) };
});
const movementSchema = z.object({ amount: z.number().positive().max(9999999999.99), category: str(80), description: str(180), date: date.optional(), due_date: date.optional(), status: z.enum(['paid', 'pending']).optional(), notes: opt(2000) }).strict();
for (const [name, type] of [['register_expense', 'Saída'], ['register_income', 'Entrada']]) define(name, 'sensitive', `Prepare ${type === 'Saída' ? 'despesa' : 'entrada'} para confirmação explícita na interface. Nunca executa sem Confirmar. Valor em reais, até duas casas. Não diga que já foi registrada.`, movementSchema,
  (s, a, c) => {
    const cents = Finance.cents(a.amount);
    if (Math.abs(a.amount * 100 - cents) > 0.0001) throw new JarvisError('Informe um valor com no máximo duas casas decimais.');
    const day = resolveDate(a.date, c), pending = a.status === 'pending';
    const row = Finance.saveMovement(s, { nome: a.description, valorCentavos: cents, categoria: a.category, tipo: type, data: day, prazo: resolveDate(a.due_date || day, c), status: pending ? 'Pendente' : 'Pago', pagoEm: pending ? '' : day, observacoes: a.notes || '', jarvisActionId: c.operationId, source: 'jarvis' });
    return { id: row.id, title: row.nome, amount: Finance.formatMoney(cents), amount_cents: cents, type, status: row.status, date: day };
  }, (a, c) => ({ ...a, date: resolveDate(a.date, c), due_date: resolveDate(a.due_date || a.date, c), status: a.status || 'paid' }));
function definitions() {
  return Object.entries(registry).map(([name, tool]) => { const parameters = z.toJSONSchema(tool.schema); delete parameters.$schema; return { type: 'function', name, description: tool.description, parameters, strict: false }; });
}
function validateTool(name, args, context) {
  if (!Object.hasOwn(registry, name)) throw new JarvisError('Ferramenta não autorizada.', 403, 'TOOL_FORBIDDEN');
  const tool = registry[name], parsed = tool.schema.safeParse(args);
  if (!parsed.success) throw new JarvisError('Argumentos inválidos: ' + parsed.error.issues.map(i => i.path.join('.') || 'objeto').slice(0, 4).join(', '), 400, 'INVALID_TOOL_INPUT');
  return { tool, args: tool.prepare ? tool.prepare(parsed.data, context) : parsed.data };
}
module.exports = { registry, definitions, validateTool, daySummary, resolveDate, resolvePeriod, financialSummary, taskList };
