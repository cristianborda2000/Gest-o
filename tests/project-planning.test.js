const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarize,compare,addDays}=require('../app/assets/js/project-planning');
const project=(date,done=false,status='in_progress')=>({title:'Projeto',status,production_lists:[{steps:[{label:'Etapa',due_date:date,done}]}]});
test('priorities use unfinished steps, exclude completed projects and cross months correctly',()=>{
  assert.equal(addDays('2028-02-27',7),'2028-03-05');
  assert.equal(summarize(project('2026-10-14'),'2026-10-15').overdue,true);
  assert.equal(summarize(project('2026-10-14',true),'2026-10-15').overdue,false);
  assert.equal(summarize(project('2026-10-14',false,'completed'),'2026-10-15').attention,null);
  assert.equal(summarize(project('2026-10-22'),'2026-10-15').upcoming,true);
  assert.equal(summarize(project('2026-10-23'),'2026-10-15').upcoming,false);
  assert.equal(summarize(project('2026-02-30'),'2026-02-28').attention,null);
  assert.ok(compare(project('2026-10-14'),project('2026-10-16'),'priority','2026-10-15')<0);
});
test('process deadlines enter priorities without changing checklist progress',()=>{
  const row={title:'Projeto interno',status:'in_progress',production_lists:[{title:'Revisão',status:'waiting',due_date:'2026-10-14',steps:[{label:'Conferir',done:true}]}]};
  assert.deepEqual(summarize(row,'2026-10-15').attention,{date:'2026-10-14',label:'Revisão'});
  assert.equal(summarize(row,'2026-10-15').overdue,true);
  assert.equal(summarize(row,'2026-10-15').percent,100);
  row.production_lists[0].status='completed';
  assert.equal(summarize(row,'2026-10-15').attention,null);
  row.production_lists[0].status='planning';
  row.production_lists[0].due_date='2026-10-22';
  assert.equal(summarize(row,'2026-10-15').upcoming,true);
  row.status='completed';
  assert.equal(summarize(row,'2026-10-15').attention,null);
});
