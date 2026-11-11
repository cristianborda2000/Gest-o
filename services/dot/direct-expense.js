'use strict';
const { z } = require('zod');
const { createHash, randomUUID } = require('node:crypto');
const Finance = require('../../app/assets/js/ceo-finance');
const { resolveDate } = require('../jarvis/tools');
const { JarvisError } = require('../jarvis/errors');
const text = max => z.string().trim().min(1).max(max);
const schema = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/).max(32).describe('Valor em reais como decimal exato, por exemplo 123.45, sem separadores de milhar.'), category: text(80), description: text(180), date: text(60), due_date: text(60).optional(), status: z.enum(['paid','pending']).describe('Obrigatório. Se o usuário não disser claramente se pagou, pergunte; nunca presuma.'), notes: z.string().trim().max(2000).optional(), repeat_of: z.uuid().optional().describe('Somente quando o usuário pedir expressamente OUTRA despesa idêntica. Referência ao action_id anterior; nunca usar para retry.') }).strict();
const fail = (message, code) => { throw new JarvisError(message, 409, code); };
const fold = value => String(value || '').normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
function normalize(input, now) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new JarvisError('Informe valor, categoria, descrição, data e se está pago ou pendente. Pergunte quando o status não estiver claro.',400,'DOT_DIRECT_INVALID');
  const a = parsed.data, [whole,fraction=''] = a.amount.split('.');
  const big = BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  const cents = Number(big);
  // No business ceiling. Refuse amounts the existing numeric ledger cannot round-trip exactly.
  if (big <= 0n || big > BigInt(Number.MAX_SAFE_INTEGER) || Finance.cents(cents/100) !== cents) throw new JarvisError('Valor não representável com centavos exatos no financeiro atual.',400,'DOT_AMOUNT_PRECISION');
  const date = resolveDate(a.date,{now}), due_date = resolveDate(a.due_date || a.date,{now});
  return {...a,amount_cents:cents,date,due_date,notes:a.notes || ''};
}
function identity(a) { return createHash('sha256').update(JSON.stringify([a.amount_cents,fold(a.category),fold(a.description),a.date])).digest('hex'); }
function semantic(a) {
  return createHash('sha256').update(JSON.stringify([a.amount_cents,fold(a.category),fold(a.description),a.date,a.due_date,a.status,fold(a.notes)])).digest('hex');
}
function definition() {
  const inputSchema=z.toJSONSchema(schema);delete inputSchema.$schema;
  inputSchema.properties.request_id={type:'string',format:'uuid',description:'Reutilize o mesmo UUID e argumentos após timeout.'};inputSchema.required.push('request_id');
  return {name:'record_expense',description:'Registra uma despesa interna solicitada explicitamente pelo proprietário. Não paga nem transfere dinheiro. Status paid/pending obrigatório: pergunte se não estiver claro. Requer permissão específica. Sem limite comercial de valor; valida centavos exatos.',inputSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
}
function record({repository,ownerId,input,fingerprint,clock,receipt}) {
  const stamp=clock().toISOString();
  return repository.transact(snapshot=>{
    const prior=snapshot.jarvis.actions.find(a=>a.source==='dot' && a.request_id===input.request_id);
    if(prior){if(prior.fingerprint!==fingerprint)fail('request_id já usado com outros argumentos.','DOT_IDEMPOTENCY_CONFLICT');return {unchanged:true,result:receipt(prior)};}
    const a=normalize(input.arguments,stamp), key=semantic(a), identityKey=identity(a);
    const matching=snapshot.jarvis.actions.filter(action=>{
      if(action.source!=='dot'||action.owner_id!==ownerId||action.status==='cancelled')return false;
      if(action.expense_key)return action.expense_key===key;
      if(action.tool_name!=='register_expense')return false;
      try{return semantic(normalize({...action.input,amount:String(action.input.amount)},action.created_at))===key;}catch{return false;}
    });
    const changedExisting=snapshot.jarvis.actions.find(action=>{
      if(action.source!=='dot'||action.owner_id!==ownerId||!['executed','pending'].includes(action.status))return false;
      try {const old=action.tool_name==='record_expense'?action.input:action.tool_name==='register_expense'?normalize({...action.input,amount:String(action.input.amount)},action.created_at):null;return old && identity(old)===identityKey && semantic(old)!==key;}catch{return false;}
    });
    if(changedExisting)fail('Já existe despesa semelhante com status, vencimento ou observações diferentes. Revise o registro existente; não crie outro para corrigir.','DOT_POSSIBLE_DUPLICATE');
    if(a.repeat_of){
      const parent=matching.find(action=>action.id===a.repeat_of && action.status==='executed');
      if(!parent)fail('A referência deve identificar a despesa idêntica anterior.','DOT_REPEAT_INVALID');
      const repeated=matching.find(action=>action.repeat_of===a.repeat_of && action.status==='executed');
      if(repeated)return {unchanged:true,result:receipt(repeated)};
    }else{
      const existing=matching.find(action=>action.status==='executed');
      if(existing)return {unchanged:true,result:{...receipt(existing),duplicate_prevented:true}};
      if(matching.some(action=>action.status==='pending' && Date.parse(action.expires_at)>Date.parse(stamp)))fail('Já existe uma proposta pendente igual. Resolva essa proposta antes de criar outro lançamento.','DOT_PENDING_PROPOSAL');
    }
    const id=randomUUID();
    const row=Finance.saveMovement(snapshot.state,{nome:a.description,valorCentavos:a.amount_cents,categoria:a.category,tipo:'Saída',data:a.date,prazo:a.due_date,status:a.status==='paid'?'Pago':'Pendente',pagoEm:a.status==='paid'?a.date:'',observacoes:a.notes,jarvisActionId:id,source:'dot'});
    const action={id,source:'dot',actor_id:ownerId,owner_id:ownerId,channel:'mcp',request_id:input.request_id,fingerprint,expense_key:key,repeat_of:a.repeat_of || null,tool_name:'record_expense',input:a,result:{id:row.id,title:row.nome,amount:Finance.formatMoney(a.amount_cents),amount_cents:a.amount_cents,type:'Saída',status:row.status,date:a.date},status:'executed',requires_confirmation:false,authorization_mode:'explicit-user-request',required_permission:'record_expense',created_at:stamp,executed_at:stamp};
    snapshot.jarvis.actions.push(action);
    return {writeState:true,result:receipt(action)};
  });
}
module.exports={definition,record,normalize};
