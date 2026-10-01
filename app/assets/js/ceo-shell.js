/* CEO workspace: adapters reuse the existing account, state and legacy modules. */
modules.dashboard.title = 'Visão geral';
modules.dashboard.subtitle = 'Finanças, agenda e ideias. Tudo no seu ritmo.';
modules.financeiro.title = 'Financeiro';
modules.financeiro.subtitle = 'Clareza sobre cada entrada, saída e próximo compromisso.';
modules.agenda.title = 'Agenda';
modules.agenda.subtitle = 'Organize seu dia e dê espaço ao que importa.';
modules.investimentos = { title: 'Investimentos', subtitle: 'Acompanhe o que faz a ZAMA crescer.', fields: [], rows: [] };
modules.ideias = { title: 'Banco de ideias', subtitle: 'Da primeira anotação ao próximo grande projeto.', fields: [], rows: [] };
modules.jarvis = { title: 'JARVIS', subtitle: 'Seu assistente pessoal. Conectado à sua rotina.', fields: [], rows: [] };
let overviewMonth = ZamaTime.today().slice(0, 7);

function ceoIcon(name) {
  const paths = {
    up: 'M12 20V4m-6 6 6-6 6 6', down: 'M12 4v16m-6-6 6 6 6-6',
    chart: 'M5 20v-7m7 7V4m7 16V9', coins: 'M4 6c0-4 16-4 16 0s-16 4-16 0Zm0 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',
    bulb: 'M9 18h6m-6 3h6m-7-8a6 6 0 1 1 8 0l-1 3H9l-1-3',
    bell: 'M5 17h14l-2-4V9a5 5 0 0 0-10 0v4l-2 4Zm5 3h4', plus: 'M12 5v14M5 12h14'
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name] || paths.chart}"></path></svg>`;
}

function renderCeoModule() {
  ZamaJarvis.navigation();
  const isCeo = ['dashboard', 'investimentos', 'agenda', 'ideias', 'jarvis'].includes(activeModule)
    || activeModule === 'financeiro' && financeView !== 'fixos';
  const container = document.getElementById('ceoWorkspace');
  container.hidden = !isCeo;
  workspace.hidden = isCeo;
  document.querySelector('.stats').hidden = isCeo;
  quickAddBtn.hidden = isCeo;
  document.body.dataset.module = activeModule;
  if (!isCeo) return false;
  moduleTitle.textContent = modules[activeModule].title;
  moduleSubtitle.textContent = modules[activeModule].subtitle;
  if (activeModule === 'jarvis') ZamaJarvis.render(container);
  if (activeModule === 'dashboard') renderCeoOverview(container);
  if (activeModule === 'financeiro') ZamaFinance.renderFinance(container);
  if (activeModule === 'investimentos') ZamaFinance.renderInvestments(container);
  if (activeModule === 'agenda') ZamaAgenda.render(container);
  if (activeModule === 'ideias') ZamaIdeas.render(container);
  return true;
}

function renderCeoOverview(container) {
  const period = ZamaTime.monthRange(overviewMonth);
  const total = ZamaFinance.totals(state, period);
  const money = ZamaFinance.formatMoney;
  const tasks = ZamaAgenda.todayTasks(state);
  const ideas = ZamaIdeas.recent(state, 4);
  const settled = total.rows.filter(ZamaFinance.isSettled);
  const latest = [...total.rows].sort((a,b) => ZamaFinance.effectiveDate(b).localeCompare(ZamaFinance.effectiveDate(a))).slice(0, 5);
  const groups = {};
  (state.investimentos || []).filter(row => row.status === 'Realizado' && (row.data || row.prazo) >= period.from && (row.data || row.prazo) <= period.to)
    .forEach(row => { const key = row.categoria || 'Outros'; groups[key] = (groups[key] || 0) + ZamaFinance.amountCents(row); });
  const categories = Object.entries(groups).sort((a,b) => b[1]-a[1]);
  const metrics = [
    ['Entradas recebidas', total.incomeCents, 'up', 'income', 'Recebidas no período'],
    ['Saídas pagas', total.expenseCents, 'down', 'expense', 'Pagas no período'],
    ['Saldo do mês', total.balanceCents, 'chart', 'neutral', 'Entradas menos saídas'],
    ['Investimentos', total.investmentCents, 'coins', 'sand', 'Realizados · saídas vinculadas']
  ];
  const next = ZamaAgenda.nextReminder(state);
  container.innerHTML = `
    <div class="ceo-overview-toolbar"><span class="ceo-eyebrow">SEU NEGÓCIO EM PERSPECTIVA</span><div class="ceo-toolbar">
      <label class="ceo-period">Período <input type="month" id="overviewMonth" value="${overviewMonth}" aria-label="Período da visão geral"></label>
      <button class="ceo-button primary" data-overview-new="financeiro">${ceoIcon('plus')} Nova movimentação</button>
    </div></div>
    <div class="ceo-metrics">${metrics.map(([label,value,icon,tone,note]) => `<article class="ceo-card ceo-metric"><span class="ceo-metric-icon ${tone}">${ceoIcon(icon)}</span><span>${label}</span><strong>${money(value)}</strong><small>${note}</small></article>`).join('')}</div>
    <div class="ceo-overview-grid">
      <section class="ceo-card ceo-financial-overview"><div class="ceo-card-head"><div><h2>Movimentações</h2><p>O movimento da sua empresa</p></div><button class="ceo-button" data-overview-go="financeiro">Ver todas ↗</button></div>
        ${renderCeoChart(settled, period)}
        ${latest.length ? `<div class="ceo-table-scroll"><table class="ceo-table"><thead><tr><th>Descrição</th><th>Situação</th><th class="ceo-number">Valor</th></tr></thead><tbody>${latest.map(row => `<tr><td><strong>${escapeHtml(row.nome)}</strong><small>${escapeHtml(row.responsavel || row.categoria || 'Sem categoria')} · ${ZamaTime.label(ZamaFinance.effectiveDate(row))}</small></td><td><span class="ceo-badge ${ZamaFinance.isSettled(row) ? 'green' : 'amber'}">${escapeHtml(row.status)}</span></td><td class="ceo-number ${ZamaFinance.direction(row) === 'Entrada' ? 'ceo-positive' : 'ceo-negative'}">${ZamaFinance.direction(row) === 'Entrada' ? '+' : '−'} ${money(ZamaFinance.amountCents(row))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ceo-empty">Ainda não há movimentações neste período.<small>Registre uma entrada ou saída para começar.</small></div>'}
      </section>
      <section class="ceo-card ceo-today-overview"><div class="ceo-card-head"><div><h2>Agenda de hoje</h2><p>${ZamaTime.label(ZamaTime.today(), { day: 'numeric', month: 'long' })}</p></div><button class="ceo-button" data-overview-new="agenda">+ Tarefa</button></div>
        <div class="ceo-today-list">${tasks.length ? tasks.slice(0,5).map((row,index) => `<div class="ceo-today-row"><time>${escapeHtml(row.hora || 'Dia todo')}</time><input type="checkbox" class="ceo-task-dot" data-overview-complete="${index}" aria-label="${/conclu/i.test(row.status) ? 'Reabrir' : 'Concluir'} ${escapeHtml(row.nome)}" ${/conclu/i.test(row.status) ? 'checked' : ''} ${/cancel/i.test(row.status) ? 'disabled' : ''}><button class="ceo-task-open" data-overview-task="${index}"><strong>${escapeHtml(row.nome)}</strong><small>${escapeHtml(row.prioridade || 'Média')} · ${escapeHtml(ZamaAgenda.helpers.taskStatus(row))}</small></button></div>`).join('') : '<div class="ceo-empty">Seu dia está livre.<small>Adicione sua próxima tarefa.</small></div>'}</div>
        <button class="ceo-next-reminder" data-overview-go="agenda">${ceoIcon('bell')}<span><small>Próximo lembrete</small><strong>${next ? `${ZamaTime.label(ZamaTime.nowParts(next.dueAt).date)} · ${ZamaTime.nowParts(next.dueAt).time} — ${escapeHtml(next.title)}` : 'Nenhum lembrete agendado'}</strong></span><span>↗</span></button>
      </section>
      <section class="ceo-card ceo-invest-overview"><div class="ceo-card-head"><div><h2>Investimentos</h2><p>Crescimento da ZAMA</p></div><button class="ceo-icon-button" data-overview-go="investimentos" aria-label="Ver investimentos">↗</button></div>
        ${categories.length ? categories.map(([category, cents]) => `<div class="ceo-invest-category"><div><strong>${escapeHtml(category)}</strong><span>${money(cents)}</span></div><progress max="${Math.max(total.investmentCents, cents, 1)}" value="${cents}" aria-label="${escapeHtml(category)}"></progress></div>`).join('') : '<div class="ceo-empty">Um espaço para seu próximo passo.<small>Organize seus investimentos planejados e realizados.</small></div>'}
        <button class="ceo-button ceo-full" data-overview-new="investimentos">+ Novo investimento</button>
      </section>
      <section class="ceo-card ceo-ideas-overview"><div class="ceo-card-head"><div><h2>Banco de ideias</h2><p>Boas ideias merecem um lugar</p></div><button class="ceo-button primary" data-overview-new="ideias">+ Nova ideia</button></div>
        <div class="ceo-recent-ideas">${ideas.length ? ideas.map(row => `<button class="ceo-idea-preview" data-overview-idea="${escapeHtml(row.id)}"><span class="ceo-idea-stage">${ceoIcon('bulb')} ${escapeHtml(ZamaIdeas.stageLabels[row.etapa] || row.etapa)}</span><strong>${escapeHtml(row.titulo)}</strong><p>${escapeHtml(row.descricao || 'Uma ideia esperando seu próximo passo.')}</p><span class="ceo-badge">${escapeHtml(row.categoria || 'Geral')}</span></button>`).join('') : '<div class="ceo-empty">O que você quer colocar em prática?<small>Capture uma ideia e acompanhe sua evolução.</small></div>'}</div>
      </section>
    </div><p class="ceo-footnote">${ceoIcon('chart')} Dados da sua conta · Horário de Brasília</p>`;
  container.querySelector('#overviewMonth').addEventListener('change', event => {
    if (/^\d{4}-\d{2}$/.test(event.target.value)) overviewMonth = event.target.value;
    render();
  });
  container.querySelectorAll('[data-overview-go]').forEach(el => el.onclick = () => goToModule(el.dataset.overviewGo, { financeView:'movimentacoes' }));
  container.querySelectorAll('[data-overview-new]').forEach(el => el.onclick = () => {
    if (el.dataset.overviewNew === 'financeiro') ZamaFinance.openMovement();
    if (el.dataset.overviewNew === 'investimentos') ZamaFinance.openInvestment();
    if (el.dataset.overviewNew === 'agenda') ZamaAgenda.openTask({ date: ZamaTime.today() });
    if (el.dataset.overviewNew === 'ideias') ZamaIdeas.openEditor();
  });
  container.querySelectorAll('[data-overview-task]').forEach(el => el.onclick = () => ZamaAgenda.openTask({ row: tasks[Number(el.dataset.overviewTask)] }));
  container.querySelectorAll('[data-overview-complete]').forEach(el => el.onchange = () => ZamaAgenda.toggle(tasks[Number(el.dataset.overviewComplete)]));
  container.querySelectorAll('[data-overview-idea]').forEach(el => el.onclick = () => ZamaIdeas.openEditor(el.dataset.overviewIdea));
}

function renderCeoChart(rows, period) {
  const days = [];
  for (let date = period.from; date <= period.to; date = ZamaTime.addDays(date, 1)) {
    const values = rows.filter(row => ZamaFinance.effectiveDate(row) === date);
    days.push({ date, income: values.filter(row => ZamaFinance.direction(row) === 'Entrada').reduce((n,row) => n + ZamaFinance.amountCents(row),0), expense: values.filter(row => ZamaFinance.direction(row) === 'Saída').reduce((n,row) => n + ZamaFinance.amountCents(row),0) });
  }
  const max = Math.max(1, ...days.flatMap(day => [day.income,day.expense]));
  return `<div class="ceo-chart-legend"><span><i class="income"></i> Entradas recebidas</span><span><i class="expense"></i> Saídas pagas</span></div><div class="ceo-cash-chart" role="img" aria-label="Movimentações realizadas por dia no mês selecionado">${days.map(day => `<div title="${ZamaTime.label(day.date)}: entradas ${ZamaFinance.formatMoney(day.income)}, saídas ${ZamaFinance.formatMoney(day.expense)}"><i style="height:${Math.max(day.income ? 5 : 2,day.income/max*100)}%" class="income ${day.income ? '' : 'zero'}"></i><i style="height:${Math.max(day.expense ? 5 : 2,day.expense/max*100)}%" class="expense ${day.expense ? '' : 'zero'}"></i></div>`).join('')}</div><div class="ceo-chart-axis"><span>01</span><span>15</span><span>${period.to.slice(-2)}</span></div>`;
}

document.getElementById('ceoMenuBtn').addEventListener('click', event => {
  const open = document.body.classList.toggle('menu-open');
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); goToModule('dashboard'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', event => {
  if (event.data?.type !== 'zama-open-agenda' || !state) return;
  goToModule('agenda');
  ZamaAgenda.selectDay(event.data.day || ZamaTime.today());
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./notification-worker.js', { updateViaCache: 'none' }).catch(() => {});
