'use strict';

// This is an authorization gate, not a second NLP agent. Only user messages can
// open a write scope; tool output, memories and ordinary assistant text cannot.
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const writeNames = ['create_task', 'create_agenda_event', 'save_idea', 'register_expense', 'register_income', 'update_task', 'complete_task'];
function requestText(value) {
  let text = fold(value).replace(/^(?:(?:oi|ola|bom dia|boa tarde|boa noite|jarvis|por favor|por gentileza)[,!:.\s]*)+/, '');
  if (/^(?:como|quando|onde|por que|porque|o que|que significa|qual|quais|cuanto|como se|se eu|si yo|e se|y si)\b/.test(text)) return '';
  text = text.replace(/^(?:(?:voce |tu )?(?:pode|poderia|consegue|podes|puedes|podrias)\s+(?:por favor\s+)?|(?:eu )?(?:quero|preciso|gostaria|desejo|queria|quiero|necesito)\s+(?:(?:que (?:voce |tu )?)|(?:de ))?)/, '');
  if (/^(?:nao|nunca|no |jamais|evite|cancele|cancelar|esqueca|deixa pra la|deixe para la)\b/.test(text)) return '';
  return text;
}
function allowedWrites(value) {
  const text = requestText(value);
  if (!text) return [];
  const create = /^(?:cri[ae]|criar|crea|crear|agend[ae]|agendar|adicion[ae]|adicionar|anot[ae]|anotar|registr[ae]|registrar|program[ae]|programar|colo(?:ca|que|car)|bota|bote|botar|pon|poner|apunta|apuntar|agrega|agregar)\b/.test(text);
  const rememberTask = /^(?:me (?:lembra|lembre|avisa|avise)|lembre-me|lembra-me|recuerdame|recordame)\b/.test(text) && !/\b(?:memoria|lembra que|lembre que)\b/.test(text);
  const mark = /^(?:marc[ae]|marqu[ae]|marcar)\b/.test(text);
  const completed = /\b(?:concluid[ao]|finalizad[ao]|complet[ao]|completad[ao]|terminad[ao]|feit[ao])\b/.test(text);
  const names = [];
  if ((create || rememberTask || mark) && !(mark && completed)) names.push('create_task', 'create_agenda_event');
  if (/^(?:salv[ae]|salvar|guard[ae]|guardar|anot[ae]|anotar|registr[ae]|registrar|cri[ae]|criar|crea|crear|guarda)\b/.test(text)) names.push('save_idea');
  if (/^(?:registr[ae]|registrar|anot[ae]|anotar|lanc[ae]|lancar|adicion[ae]|adicionar|cadastre|cadastra|cadastrar|cri[ae]|criar|crea|crear)\b/.test(text)) names.push('register_expense', 'register_income');
  if (/^(?:alter[ae]|alterar|mude|muda|mudar|atualiz[ae]|atualizar|editar|edit[ae]|reagend[ae]|reagendar|remarqu[ae]|remarcar|mova|mover|cambia|cambiar|cambie|modifica|modificar|actualiza|actualizar)\b/.test(text)) names.push('update_task');
  if (/^(?:conclu[ai]|concluir|finaliz[ae]|finalizar|complet[ae]|completar|termin[ae]|terminar)\b/.test(text) || (mark && completed)) names.push('complete_task');
  return names;
}
function isClarificationAnswer(value) {
  const text = fold(value);
  return text.length > 0 && text.length <= 500 && !/[?？]/.test(text)
    && !/^(?:sim|si|ok|okay|certo|claro|confirmo|pode|nao|no|cancela|cancele|esqueca|pare|obrigad[oa]|valeu)[.!\s]*$/.test(text)
    && !/^(?:nao|no |cancela|cancele|esqueca|pare|como|quanto|qual|quais|mostr[ae]|liste|consulte|busque|procure|pesquise|leia|me (?:mostre|diga|fale))\b/.test(text);
}
function authorization(history, text, now) {
  const names = allowedWrites(text);
  if (names.length) return { names, source: String(text).slice(0, 4000), turns: 0, created_at: new Date(now).toISOString() };
  const previous = history.at(-2);
  const pending = previous?.role === 'assistant' ? previous.metadata?.pending_write : null;
  if (!pending || !isClarificationAnswer(text) || !Array.isArray(pending.names) || pending.turns >= 4
    || !Number.isFinite(Date.parse(pending.created_at)) || +new Date(now) - Date.parse(pending.created_at) > 30 * 60000) return { names: [] };
  // Validate persisted scope again instead of trusting metadata to name a tool.
  const permitted = allowedWrites(pending.source);
  return { ...pending, names: pending.names.filter(name => writeNames.includes(name) && permitted.includes(name)), turns: pending.turns + 1, inherited: true };
}
function pendingClarification(scope, answer, performed) {
  if (!scope.names.length || performed.some(a => ['executed', 'pending'].includes(a.status) && writeNames.includes(a.tool_name))) return undefined;
  // A follow-up is only permitted directly after a request for missing fields.
  if (!/[?？]/.test(answer) || !/\b(?:qual|que|quando|informe|diga|falta|preciso|pode|poderia|confirmar|defina|titulo|nome|dia|data|hora|horario|valor|categoria|descricao)\b/.test(fold(answer))) return undefined;
  return { names: scope.names, source: scope.source, turns: scope.turns, created_at: scope.created_at };
}
function singleWriteRequest(text) {
  const value = fold(text);
  return !/[;\n]/.test(value) && !/\b(?:e|y|tambem|tambien|depois|apos|alem|entao|quanto|quais|mostre|liste|consulte|resuma|busque|pesquise)\b/.test(value);
}
module.exports = { allowedWrites, authorization, pendingClarification, singleWriteRequest, fold };
