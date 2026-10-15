/* CEO workspace: adapters reuse the existing account, state and legacy modules. */
modules.dashboard.title = 'Visão geral';
modules.dashboard.subtitle = 'Finanças, agenda e ideias. Tudo no seu ritmo.';
modules.financeiro.title = 'Financeiro';
modules.financeiro.subtitle = 'Clareza sobre cada entrada, saída e próximo compromisso.';
modules.agenda.title = 'Agenda';
modules.agenda.subtitle = 'Sua rotina, seu espaço. Esta agenda é privada.';
modules.investimentos = { title: 'Investimentos', subtitle: 'Acompanhe o que faz a ZAMA crescer.', fields: [], rows: [] };
modules.ideias = { title: 'Banco de ideias', subtitle: 'Um espaço compartilhado para construir as próximas ideias da ZAMA.', fields: [], rows: [] };
modules.projetos = { title: 'Projetos', subtitle: 'Clientes, listas de produção e etapas criadas por você.', fields: [], rows: [] };
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
  if (activeModule !== 'projetos' && typeof ZamaProjects !== 'undefined') ZamaProjects.leave();
  const isCeo = ['dashboard', 'investimentos', 'agenda', 'ideias', 'jarvis', 'projetos'].includes(activeModule)
    || activeModule === 'financeiro';
  const container = document.getElementById('ceoWorkspace');
  container.hidden = !isCeo;
  workspace.hidden = isCeo;
  document.querySelector('.stats').hidden = isCeo;
  document.body.dataset.module = activeModule;
  if (!isCeo) return false;
  moduleTitle.textContent = modules[activeModule].title;
  moduleSubtitle.textContent = modules[activeModule].subtitle;
  if (activeModule === 'jarvis') ZamaJarvis.render(container);
  if (activeModule === 'dashboard') renderCeoOverview(container);
  if (activeModule === 'financeiro') {
    if (financeView === 'fixos') ZamaFinance.renderFixedExpenses(container);
    else ZamaFinance.renderFinance(container);
  }
  if (activeModule === 'investimentos') ZamaFinance.renderInvestments(container);
  if (activeModule === 'agenda') ZamaAgenda.render(container);
  if (activeModule === 'ideias') ZamaIdeas.render(container);
  if (activeModule === 'projetos') ZamaProjects.render(container);
  return true;
}

function ceoOverviewWeek(targetState, today = ZamaTime.today()) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const from = ZamaTime.addDays(today, -((weekday + 6) % 7));
  const tasks = [];
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = ZamaTime.addDays(from, offset);
    const rows = ZamaAgenda.todayTasks(targetState, date).map(row => {
      const index = tasks.length;
      tasks.push(row);
      return { row, index };
    });
    return { date, rows };
  });
  return { today, from, to: days[6].date, days, tasks };
}

function renderCeoWeek(week) {
  const { isDone, isCancelled, taskStatus } = ZamaAgenda.helpers;
  const done = week.tasks.filter(isDone).length;
  const cancelled = week.tasks.filter(isCancelled).length;
  const pending = week.tasks.length - done - cancelled;
  const summary = `${pending} ${pending === 1 ? 'pendente' : 'pendentes'} · ${done} ${done === 1 ? 'concluída' : 'concluídas'}${cancelled ? ` · ${cancelled} ${cancelled === 1 ? 'cancelada' : 'canceladas'}` : ''}`;
  const shortDate = date => ZamaTime.label(date, { year: undefined });
  return `<section class="ceo-card ceo-today-overview ceo-week-overview" aria-labelledby="overviewWeekTitle">
    <div class="ceo-card-head"><div><h2 id="overviewWeekTitle">Tarefas da semana</h2><p>${shortDate(week.from)} a ${shortDate(week.to)} · Seg a dom</p></div><button class="ceo-button primary" data-overview-new="agenda">+ Tarefa</button></div>
    <p class="ceo-week-summary" aria-live="polite">${summary}</p>
    ${!week.tasks.length ? '<div class="ceo-empty ceo-week-empty">Sua semana está livre.<small>Adicione sua próxima tarefa.</small></div>' : ''}
    <div class="ceo-week-days">${week.days.map(day => `<section class="ceo-week-day ${day.date === week.today ? 'is-today' : ''}" data-overview-date="${day.date}">
      <h3><span>${ZamaTime.label(day.date, { weekday: 'long', day: undefined, month: undefined, year: undefined })}</span><time datetime="${day.date}">${shortDate(day.date)}</time>${day.date === week.today ? '<span class="ceo-week-today">Hoje</span>' : ''}</h3>
      ${day.rows.length ? day.rows.map(({ row, index }) => `<div class="ceo-week-task ${isDone(row) ? 'is-done' : ''} ${isCancelled(row) ? 'is-cancelled' : ''}">
        <label class="ceo-week-check"><input type="checkbox" data-overview-complete="${index}" aria-label="${isDone(row) ? 'Reabrir' : 'Concluir'} ${escapeHtml(row.nome)}" ${isDone(row) ? 'checked' : ''} ${isCancelled(row) ? 'disabled' : ''}></label>
        <button class="ceo-week-task-open" data-overview-task="${index}" aria-label="Editar ${escapeHtml(row.nome)} em ${shortDate(day.date)}"><strong>${escapeHtml(row.nome)}</strong><span class="ceo-week-task-meta"><time>${escapeHtml(row.hora || 'Dia todo')}</time><span class="${isDone(row) ? 'is-complete' : taskStatus(row) === 'Atrasada' ? 'is-overdue' : ''}">${escapeHtml(taskStatus(row))}</span></span></button>
      </div>`).join('') : '<p class="ceo-week-day-empty">Sem tarefas</p>'}
    </section>`).join('')}</div>
    <button class="ceo-button ceo-full ceo-week-agenda" data-overview-go="agenda">Abrir agenda ↗</button>
  </section>`;
}

function renderCeoOverview(container) {
  const period = ZamaTime.monthRange(overviewMonth);
  const total = ZamaFinance.totals(state, period);
  const money = ZamaFinance.formatMoney;
  const week = ceoOverviewWeek(state);
  const tasks = week.tasks;
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
  container.innerHTML = `<div class="ceo-overview-layout">
    ${renderCeoWeek(week)}
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
      <section class="ceo-card ceo-invest-overview"><div class="ceo-card-head"><div><h2>Investimentos</h2><p>Crescimento da ZAMA</p></div><button class="ceo-icon-button" data-overview-go="investimentos" aria-label="Ver investimentos">↗</button></div>
        ${categories.length ? categories.map(([category, cents]) => `<div class="ceo-invest-category"><div><strong>${escapeHtml(category)}</strong><span>${money(cents)}</span></div><progress max="${Math.max(total.investmentCents, cents, 1)}" value="${cents}" aria-label="${escapeHtml(category)}"></progress></div>`).join('') : '<div class="ceo-empty">Um espaço para seu próximo passo.<small>Organize seus investimentos planejados e realizados.</small></div>'}
        <button class="ceo-button ceo-full" data-overview-new="investimentos">+ Novo investimento</button>
      </section>
      <section class="ceo-card ceo-ideas-overview"><div class="ceo-card-head"><div><h2>Banco de ideias</h2><p>Boas ideias merecem um lugar</p></div><button class="ceo-button primary" data-overview-new="ideias">+ Nova ideia</button></div>
        <div class="ceo-recent-ideas">${ideas.length ? ideas.map(row => `<button class="ceo-idea-preview" data-overview-idea="${escapeHtml(row.id)}"><span class="ceo-idea-stage">${ceoIcon('bulb')} ${escapeHtml(ZamaIdeas.stageLabels[row.etapa] || row.etapa)}</span><strong>${escapeHtml(row.titulo)}</strong><p>${escapeHtml(row.descricao || 'Uma ideia esperando seu próximo passo.')}</p><span class="ceo-badge">${escapeHtml(row.categoria || 'Geral')}</span></button>`).join('') : '<div class="ceo-empty">O que você quer colocar em prática?<small>Capture uma ideia e acompanhe sua evolução.</small></div>'}</div>
      </section>
    </div><p class="ceo-footnote">${ceoIcon('chart')} Dados da sua conta · Horário de Brasília</p></div>`;
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

function setCeoMenu(open, restoreFocus = true) {
  const sidebar = document.getElementById('ceoSidebar');
  const button = document.getElementById('ceoMenuBtn');
  open = Boolean(open && window.matchMedia('(max-width: 720px)').matches);
  document.body.classList.toggle('menu-open', open);
  document.getElementById('ceoMenuBackdrop').hidden = !open;
  document.querySelector('.main').inert = open;
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    document.getElementById('ceoMenuCloseBtn').focus();
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    if (restoreFocus && sidebar.contains(document.activeElement)) button.focus();
  }
}
document.getElementById('ceoMenuBtn').addEventListener('click', () => setCeoMenu(true));
document.getElementById('ceoMenuCloseBtn').addEventListener('click', () => setCeoMenu(false));
document.getElementById('ceoMenuBackdrop').addEventListener('click', () => setCeoMenu(false));
document.getElementById('ceoSidebar').addEventListener('keydown', event => {
  if (!document.body.classList.contains('menu-open')) return;
  if (event.key === 'Escape') { event.preventDefault(); setCeoMenu(false); return; }
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll('button:not([hidden]), a[href]')].filter(el => el.getClientRects().length);
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
window.matchMedia('(max-width: 720px)').addEventListener('change', () => setCeoMenu(false, false));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); goToModule('dashboard'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', event => {
  if (event.data?.type !== 'zama-open-agenda' || !state) return;
  goToModule('agenda');
  ZamaAgenda.selectDay(event.data.day || ZamaTime.today());
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./notification-worker.js', { updateViaCache: 'none' }).catch(() => {});
