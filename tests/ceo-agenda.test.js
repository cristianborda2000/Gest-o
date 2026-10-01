const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sandbox = { window: {}, Intl, Date, console, state: null };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("app/assets/js/ceo-agenda.js", "utf8"), sandbox);
const agenda = sandbox.window.ZamaAgenda;
const h = agenda.helpers;
const clone = value => JSON.parse(JSON.stringify(value));
const createState = (rows, config = {}) => agenda.normalize({ agenda: rows, agendaSettings: { enabled: true, dailyEnabled: false, dailyTime: "08:00", taskEnabled: true, leadMinutes: 15, ...config } });
const task = changes => ({ id: "t1", nome: "Planejar o dia", prazo: "2026-09-29", hora: "09:00", duracao: 30, recorrencia: "none", status: "Pendente", ...changes });
let count = 0;
function test(name, callback) {
  try { callback(); count++; console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}`); throw error; }
}

test("migração preserva dados e identificadores legados sem criar exemplos", () => {
  const original = { agenda: [{ id: "legado", nome: "Reunião antiga", data: "2026-09-29", valor: 5, responsavel: "CEO", observacoes: "Notas originais", customField: "preservado" }] };
  agenda.normalize(original);
  const row = original.agenda[0];
  assert.equal(row.id, "legado");
  assert.equal(row.prazo, "2026-09-29");
  assert.equal(row.recorrencia, "none");
  assert.equal(row.prioridade, "Alta");
  assert.equal(row.observacoes, "Notas originais");
  assert.equal(row.customField, "preservado");
  assert.equal(original.agendaSettings.enabled, false);
  assert.equal(original.agendaSettings.dailyTime, "08:00");
  assert.equal(original.agendaSettings.leadMinutes, 15);
  assert.equal(agenda.normalize({}).agenda.length, 0);
  const first = clone(original);
  agenda.normalize(original);
  assert.deepEqual(clone(original), first);
});

test("datas, horários e virada da meia-noite usam America/Sao_Paulo", () => {
  assert.deepEqual(clone(h.parts(Date.parse("2026-09-30T02:59:00Z"))), { date: "2026-09-29", time: "23:59" });
  assert.deepEqual(clone(h.parts(Date.parse("2026-09-30T03:00:00Z"))), { date: "2026-09-30", time: "00:00" });
  assert.equal(h.toEpoch("2026-09-30", "00:00"), Date.parse("2026-09-30T03:00:00Z"));
  assert.equal(h.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(h.addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(h.validDate("2026-02-30"), false);
  assert.equal(h.validDate("2028-02-29"), true);
  assert.equal(h.validTime("24:00"), false);
  assert.equal(h.validTime("23:59"), true);
});

test("recorrências diária, útil, semanal e mensal respeitam início/fim", () => {
  assert.equal(h.occursOn(task({ recorrencia: "daily" }), "2026-09-28"), false);
  assert.equal(h.occursOn(task({ recorrencia: "daily" }), "2026-10-01"), true);
  assert.equal(h.occursOn(task({ recorrencia: "daily", recurrenceEnd: "2026-09-30" }), "2026-10-01"), false);
  assert.equal(h.occursOn(task({ recorrencia: "weekdays" }), "2026-10-03"), false);
  assert.equal(h.occursOn(task({ recorrencia: "weekdays" }), "2026-10-05"), true);
  assert.equal(h.occursOn(task({ recorrencia: "weekly" }), "2026-10-06"), true);
  assert.equal(h.occursOn(task({ recorrencia: "weekly" }), "2026-10-07"), false);
  const monthly = task({ prazo: "2026-01-31", recorrencia: "monthly" });
  assert.equal(h.occursOn(monthly, "2026-02-28"), true);
  assert.equal(h.occursOn(monthly, "2026-03-31"), true);
  assert.equal(h.occursOn(monthly, "2026-03-28"), false);
  assert.equal(h.occursOn(monthly, "2028-02-29"), true);
});

test("concluir recorrência afeta somente o dia selecionado, inclusive após recarregar", () => {
  const data = createState([task({ recorrencia: "daily" })]);
  h.patchTask(data, "t1", "2026-09-30", { status: "Concluído" });
  assert.equal(data.agenda.length, 1);
  assert.equal(data.agenda[0].status, "Pendente");
  const reloaded = agenda.normalize(clone(data));
  assert.equal(agenda.todayTasks(reloaded, "2026-09-30")[0].status, "Concluído");
  assert.equal(agenda.todayTasks(reloaded, "2026-10-01")[0].status, "Pendente");
  assert.equal(agenda.todayTasks(reloaded, "2026-09-30")[0].occurrenceDate, "2026-09-30");
  assert.equal(agenda.todayTasks(reloaded, "2026-09-30")[0].id, "t1");
});

test("editar/mover uma ocorrência preserva a série e não duplica a tarefa", () => {
  const data = createState([task({ recorrencia: "weekly" })]);
  h.patchTask(data, "t1", "2026-10-06", { prazo: "2026-10-07", hora: "14:00", nome: "Excepcional" });
  assert.equal(agenda.todayTasks(data, "2026-10-06").length, 0);
  const moved = agenda.todayTasks(data, "2026-10-07");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].occurrenceDate, "2026-10-06");
  assert.equal(moved[0].hora, "14:00");
  assert.equal(agenda.todayTasks(data, "2026-10-13")[0].nome, "Planejar o dia");
  h.patchTask(data, "t1", "2026-10-06", { hora: "15:00" });
  assert.equal(agenda.todayTasks(data, "2026-10-07")[0].hora, "15:00");
});

test("excluir ocorrência é reversível no histórico da série; excluir série limpa vínculo da ideia", () => {
  const data = createState([task({ recorrencia: "weekly" })]);
  data.ideias = [{ id: "i1", taskId: "t1" }, { id: "i2", taskId: "outro" }];
  h.removeTask(data, "t1", "2026-10-06");
  assert.equal(agenda.todayTasks(data, "2026-10-06").length, 0);
  assert.equal(agenda.todayTasks(data, "2026-10-13").length, 1);
  assert.equal(data.ideias[0].taskId, "t1");
  h.removeTask(data, "t1", "2026-10-13", "series");
  assert.equal(data.agenda.length, 0);
  assert.equal(data.ideias[0].taskId, undefined);
  assert.equal(data.ideias[1].taskId, "outro");
});

test("editar a série preserva alterações particulares de outras ocorrências", () => {
  const data = createState([task({ recorrencia: "daily" })]);
  h.patchTask(data, "t1", "2026-09-30", { status: "Concluído", hora: "11:00" });
  h.patchTask(data, "t1", "2026-09-29", { nome: "Planejar a operação", hora: "10:00" }, "series");
  assert.equal(agenda.todayTasks(data, "2026-10-01")[0].hora, "10:00");
  assert.equal(agenda.todayTasks(data, "2026-09-30")[0].hora, "11:00");
  assert.equal(agenda.todayTasks(data, "2026-09-30")[0].status, "Concluído");
});

test("lista diária ordena horários, preserva sem horário e calcula atrasos", () => {
  const data = createState([task({ id: "a", hora: "15:00" }), task({ id: "b", hora: "" }), task({ id: "c", hora: "09:00" })]);
  assert.deepEqual(clone(agenda.todayTasks(data, "2026-09-29").map(row => row.id)), ["c", "a", "b"]);
  assert.equal(h.taskStatus(data.agenda[2], h.toEpoch("2026-09-29", "09:31")), "Atrasada");
  assert.equal(h.taskStatus({ ...data.agenda[2], status: "Concluído" }, h.toEpoch("2026-09-29", "09:31")), "Concluída");
  assert.equal(h.taskStatus(data.agenda[1], h.toEpoch("2026-09-29", "23:59")), "Pendente");
  assert.equal(h.taskStatus(data.agenda[1], h.toEpoch("2026-09-30", "00:00")), "Atrasada");
});

test("lembrete antecipado cruza meia-noite sem usar o fuso do dispositivo", () => {
  const data = createState([task({ prazo: "2026-09-30", hora: "00:05" })]);
  const from = h.toEpoch("2026-09-29", "23:40"), until = h.toEpoch("2026-09-29", "23:59");
  const reminders = h.remindersBetween(data, from, until);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].dueAt, h.toEpoch("2026-09-29", "23:50"));
  assert.equal(reminders[0].at, reminders[0].dueAt);
  assert.equal(reminders[0].task.prazo, "2026-09-30");
});

test("editar, concluir, cancelar e excluir eliminam lembretes anteriores", () => {
  const data = createState([task({ recorrencia: "daily" })]);
  const from = h.toEpoch("2026-09-30", "00:00"), until = h.toEpoch("2026-09-30", "23:59");
  const old = h.remindersBetween(data, from, until)[0];
  h.patchTask(data, "t1", "2026-09-30", { hora: "11:00" });
  const updated = h.remindersBetween(data, from, until);
  assert.equal(updated.length, 1);
  assert.notEqual(updated[0].key, old.key);
  assert.equal(updated[0].dueAt, h.toEpoch("2026-09-30", "10:45"));
  h.patchTask(data, "t1", "2026-09-30", { status: "Concluído" });
  assert.equal(h.remindersBetween(data, from, until).length, 0);
  h.patchTask(data, "t1", "2026-09-30", { status: "Cancelado" });
  assert.equal(h.remindersBetween(data, from, until).length, 0);
  h.patchTask(data, "t1", "2026-09-30", { status: "Pendente" });
  h.removeTask(data, "t1", "2026-09-30");
  assert.equal(h.remindersBetween(data, from, until).length, 0);
});

test("deduplicação persiste chave entre recargas, aceita remarcação e expira histórico antigo", () => {
  const now = h.toEpoch("2026-09-30", "08:45"), ledger = {};
  assert.equal(h.claimReminder(ledger, "task:t1:2026-09-30:09:00:15", now), true);
  const reloaded = clone(ledger);
  assert.equal(h.claimReminder(reloaded, "task:t1:2026-09-30:09:00:15", now + 20000), false);
  assert.equal(h.claimReminder(reloaded, "task:t1:2026-09-30:11:00:15", now + 7200000), true);
  reloaded.old = now - 36 * 86400000;
  h.claimReminder(reloaded, "today", now);
  assert.equal(reloaded.old, undefined);
});

test("resumo diário considera apenas pendências e respeita ativação e horário", () => {
  const data = createState([task(), task({ id: "done", status: "Concluído" }), task({ id: "cancel", status: "Cancelado" })], { dailyEnabled: true });
  const from = h.toEpoch("2026-09-29", "07:59"), until = h.toEpoch("2026-09-29", "08:01");
  const reminders = h.remindersBetween(data, from, until);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].kind, "daily");
  assert.ok(reminders[0].body.startsWith("1 tarefa(s)"));
  data.agendaSettings.dailyTime = "07:00";
  assert.equal(h.remindersBetween(data, from, until).length, 0);
  data.agendaSettings.enabled = false;
  assert.equal(h.remindersBetween(data, from, h.toEpoch("2026-09-30", "10:00")).length, 0);
});

test("lembrete individual pode usar antecedência própria ou ser desativado", () => {
  const data = createState([task({ reminderMinutes: 1440 })]);
  const from = h.toEpoch("2026-09-28", "08:59"), until = h.toEpoch("2026-09-28", "09:01");
  assert.equal(h.remindersBetween(data, from, until).length, 1);
  data.agenda[0].reminderMinutes = -1;
  assert.equal(h.remindersBetween(data, from, h.toEpoch("2026-09-29", "23:00")).length, 0);
});

test("vencimentos financeiros legados aparecem separados e excluem quitados/cancelados", () => {
  const data = { financeiro: [
    { id: "f1", prazo: "2026-09-30", status: "Pendente", tipo: "Entrada", valor: 100 },
    { id: "f2", prazo: "2026-09-30", status: "Pago", tipo: "Saída", valor: -100 },
    { id: "f3", prazo: "2026-09-30", status: "Cancelado", tipo: "Saída", valor: -100 }
  ], gastosFixos: [{ id: "fixed", dia: 31, status: "Ativo", valor: -50 }, { id: "paused", dia: 30, status: "Pausado", valor: -30 }] };
  const dues = h.financialDues(data, "2026-09-30");
  assert.equal(dues.length, 2);
  assert.equal(dues[0].dueKind, "A receber");
  assert.equal(dues[1].dueKind, "Gasto fixo previsto");
});

console.log(`${count} testes da agenda passaram.`);
