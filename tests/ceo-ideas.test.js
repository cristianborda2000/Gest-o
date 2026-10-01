const assert = require("node:assert/strict");
const ideas = require("../app/assets/js/ceo-ideas.js");

function baseState() { return { ideias: [], agenda: [], untouched: { clientId: "old-client" } }; }
function values(extra = {}) { return { titulo: "Automatizar cobrança", descricao: "Validar o fluxo com o financeiro", categoria: "Financeiro", prioridade: "Alta", data: "2026-09-29", etapa: "capturada", ...extra }; }

{
  const state = { ideias: [{ id: "legacy", nome: "Ideia antiga", description: "Contexto", stage: "Em avaliação", priority: 5, createdAt: "2026-09-01T13:00:00Z", custom: { keep: true } }], agenda: [] };
  ideas.normalize(state);
  assert.equal(state.ideias[0].titulo, "Ideia antiga");
  assert.equal(state.ideias[0].etapa, "avaliacao");
  assert.equal(state.ideias[0].prioridade, "Alta");
  assert.deepEqual(state.ideias[0].custom, { keep: true });
  const copy = JSON.stringify(state);
  ideas.normalize(state);
  assert.equal(JSON.stringify(state), copy, "Normalização deve preservar dados e ser idempotente");
}
{
  const state = baseState();
  const row = ideas.upsert(state, values());
  row.extra = "preservar";
  ideas.upsert(state, values({ titulo: "Cobrança automática", prioridade: "Média" }), row.id);
  assert.equal(state.ideias.length, 1);
  assert.equal(row.titulo, "Cobrança automática");
  assert.equal(row.extra, "preservar");
  ideas.move(state, row.id, "avaliacao");
  assert.equal(row.etapa, "avaliacao");
  assert.throws(() => ideas.move(state, row.id, "inexistente"), /etapa/);
  ideas.archive(state, row.id);
  assert.equal(ideas.recent(state).length, 0);
  assert.equal(ideas.filterIdeas(state, { archived: "archived" }).length, 1);
  ideas.archive(state, row.id, false);
  assert.equal(ideas.recent(state)[0].id, row.id);
  assert.deepEqual(state.untouched, { clientId: "old-client" });
}
{
  const state = baseState();
  const row = ideas.upsert(state, values());
  const task = ideas.convert(state, row.id, { prazo: "2026-10-02", hora: "14:30", duracao: 45 });
  assert.equal(task.ideaId, row.id);
  assert.equal(row.taskId, task.id);
  assert.equal(task.prazo, "2026-10-02");
  assert.equal(task.valor, 5);
  assert.equal(task.prioridade, "Alta");
  assert.equal(task.status, "Pendente");
  assert.equal(row.etapa, "execucao");
  assert.equal(ideas.convert(state, row.id, { prazo: "2026-10-03", hora: "10:00" }).id, task.id);
  assert.equal(state.agenda.length, 1, "Repetir a conversão não duplica tarefa");
  assert.equal(task.prazo, "2026-10-02", "Repetir a conversão não altera a tarefa existente");
  row.taskId = null;
  assert.equal(ideas.convert(state, row.id, {}).id, task.id, "Vínculo inverso deve recuperar taskId");
  assert.equal(row.taskId, task.id);
  ideas.archive(state, row.id);
  assert.equal(row.taskId, task.id, "Arquivamento deve preservar vínculo com tarefa");
  assert.equal(state.agenda[0].ideaId, row.id);
  ideas.archive(state, row.id, false);
  const reloaded = JSON.parse(JSON.stringify(state));
  ideas.normalize(reloaded);
  assert.equal(ideas.convert(reloaded, row.id, {}).id, task.id, "Vínculos sobrevivem ao recarregamento");
  state.agenda = [];
  assert.notEqual(ideas.convert(state, row.id, { prazo: "2026-10-05", hora: "11:00" }).id, task.id, "Tarefa excluída permite nova conversão");
}
{
  const state = baseState();
  const row = ideas.upsert(state, values());
  ideas.upsert(state, values({ titulo: "Lançar produto", categoria: "Produto", prioridade: "Baixa", etapa: "execucao" }));
  assert.equal(ideas.filterIdeas(state, { search: "cobranca" }).length, 1, "Pesquisa ignora acentos");
  assert.equal(ideas.filterIdeas(state, { category: "Produto", priority: "Baixa", stage: "execucao" }).length, 1);
  assert.equal(ideas.filterIdeas(state, { category: "Financeiro", priority: "Baixa" }).length, 0);
  assert.throws(() => ideas.upsert(state, values({ data: "2026-02-31" })), /data válida/);
  assert.throws(() => ideas.upsert(state, values({ titulo: "  " })), /título/);
  assert.throws(() => ideas.convert(state, row.id, { prazo: "2026-10-05", hora: "24:00" }), /horário/);
  assert.throws(() => ideas.convert(state, row.id, { prazo: "2026-10-05", hora: "11:00", duracao: 1 }), /duração/);
  assert.equal(state.agenda.length, 0, "Conversões inválidas não criam tarefas");
}
console.log("Banco de ideias: normalização, edição, etapas, arquivamento, pesquisa, validação e conversão idempotente OK.");
