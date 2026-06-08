/*
  dashboard.js
  Monta a tela inicial com resumo financeiro, agenda do dia, projetos,
  mensalidades e graficos simples.
*/

    function renderDashboard() {
      const totals = getFinancialTotals();
      const pendingReceivables = state.financeiro
        .filter((row) => isIncome(row) && row.status !== "Pago")
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const paidMonthly = state.mensalidades
        .filter((row) => row.status === "Pago" && isCurrentMonth(row.pagoEm || row.prazo))
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const openProjects = state.projetos.filter((row) => !/conclu/i.test(row.status || ""));
      const todayAgenda = getTodayAgenda();
      const upcomingMonthly = getUpcomingMonthlyDue(7);
      const upcomingFixed = getUpcomingFixedExpenses(7);
      const finalProjectPayments = getPendingProjectFinalPayments();
      const recentPaid = state.financeiro
        .filter((row) => row.status === "Pago")
        .slice(-5)
        .reverse();
      const maxFinance = Math.max(totals.paidIncome, totals.paidOutcome, totals.pendingOutcome, totals.fixedMonthlyExpenses, 1);
      const projectDone = state.projetos.filter((row) => /conclu/i.test(row.status || "")).length;
      const projectTotal = Math.max(state.projetos.length, 1);
      const projectDonePercent = Math.round((projectDone / projectTotal) * 100);
      const monthlyPaidCount = state.mensalidades.filter((row) => row.status === "Pago").length;
      const monthlyTotal = Math.max(state.mensalidades.filter((row) => row.status !== "Cancelado").length, 1);
      const monthlyPaidPercent = Math.round((monthlyPaidCount / monthlyTotal) * 100);
      const monthTotals = getFinancialTotalsForMonth(todayIso().slice(0, 7));

      tableArea.innerHTML = `
        <div class="metric-row">
          ${metricCard("Receita do mês", currency.format(monthTotals.entradas), "↗", "green", "financeiro")}
          ${metricCard("Despesas do mês", currency.format(monthTotals.saidas), "↘", "red", "financeiro")}
          ${metricCard("Lucro do mês", currency.format(monthTotals.lucro), "=", monthTotals.lucro >= 0 ? "green" : "red", "financeiro")}
          ${metricCard("Tarefas hoje", todayAgenda.length, "✓", "orange", "agenda")}
          ${metricCard("Clientes ativos", state.clientes.filter((row) => row.status === "Ativo").length, "◎", "blue", "clientes")}
        </div>
        <div class="dashboard-grid">
          <div class="dashboard-block dashboard-link" data-go="financeiro">
            <h3>ZAMA</h3>
            <div class="donut-wrap">
              <img src="zama-logo.png" alt="ZAMA" style="width: min(260px, 100%); height: auto;">
              <div class="donut-info">
                <span>Painel administrativo integrado</span>
                <strong>${currency.format(totals.balance)}</strong>
                <span>Saldo em caixa confirmado</span>
              </div>
            </div>
          </div>
          <div class="dashboard-block dashboard-link" data-go="financeiro">
            <h3>Financeiro</h3>
            <ul class="summary-list">
              <li data-go="financeiro"><span>Dinheiro em caixa</span><strong class="${totals.balance >= 0 ? "money-positive" : "money-negative"}">${currency.format(totals.balance)}</strong></li>
              <li data-go="financeiro"><span>Recebido</span><strong class="money-positive">${currency.format(totals.paidIncome)}</strong></li>
              <li data-go="financeiro"><span>Pago em saídas</span><strong class="money-negative">${currency.format(totals.paidOutcome)}</strong></li>
              <li data-go="financeiro"><span>A receber</span><strong>${currency.format(pendingReceivables)}</strong></li>
              <li data-go="mensalidades"><span>Mensalidades recebidas</span><strong class="money-positive">${currency.format(paidMonthly)}</strong></li>
            </ul>
          </div>
          <div class="dashboard-block alert-card">
            <h3>Alertas importantes</h3>
            <ul class="summary-list">
              <li data-go="mensalidades"><span>Mensalidades vencendo em 7 dias</span><strong>${upcomingMonthly.length}</strong></li>
              <li data-go="agenda"><span>Tarefas e reuniões de hoje</span><strong>${todayAgenda.length}</strong></li>
              <li data-go="financeiro"><span>Pagamentos finais de projetos</span><strong>${finalProjectPayments.length}</strong></li>
              <li data-go="financeiro" data-finance-target="fixos"><span>Gastos fixos vencendo</span><strong>${upcomingFixed.length}</strong></li>
            </ul>
          </div>
          <div class="dashboard-block chart-card dashboard-link" data-go="financeiro">
            <h3>Gráfico financeiro</h3>
            ${chartRow("Entradas pagas", totals.paidIncome, maxFinance, "green")}
            ${chartRow("Saídas pagas", totals.paidOutcome, maxFinance, "red")}
            ${chartRow("Saídas pendentes", totals.pendingOutcome, maxFinance, "")}
            ${chartRow("Gastos fixos", totals.fixedMonthlyExpenses, maxFinance, "red")}
          </div>
          <div class="dashboard-block dashboard-link" data-go="projetos">
            <h3>Projetos concluídos</h3>
            <div class="donut-wrap">
              <div class="donut" style="--p: ${projectDonePercent}%;"></div>
              <div class="donut-info">
                <strong>${projectDonePercent}%</strong>
                <span>${projectDone} de ${state.projetos.length} projetos concluídos</span>
              </div>
            </div>
          </div>
          <div class="dashboard-block dashboard-link" data-go="mensalidades">
            <h3>Mensalidades pagas</h3>
            <div class="donut-wrap">
              <div class="donut" style="--p: ${monthlyPaidPercent}%;"></div>
              <div class="donut-info">
                <strong>${monthlyPaidPercent}%</strong>
                <span>${monthlyPaidCount} mensalidade(s) paga(s)</span>
              </div>
            </div>
          </div>
          <div class="dashboard-block dashboard-link" data-go="financeiro" data-finance-target="fixos">
            <h3>Gastos mensais</h3>
            <ul class="summary-list">
              <li data-go="financeiro"><span>Gastos pagos no mês</span><strong class="money-negative">${currency.format(totals.monthlyExpenses)}</strong></li>
              <li data-go="financeiro" data-finance-target="fixos"><span>Gastos fixos ativos</span><strong class="money-negative">${currency.format(totals.fixedMonthlyExpenses)}</strong></li>
              <li data-go="financeiro"><span>Saídas pendentes</span><strong>${currency.format(totals.pendingOutcome)}</strong></li>
              <li data-go="financeiro"><span>Lançamentos financeiros</span><strong>${state.financeiro.length}</strong></li>
            </ul>
          </div>
          <div class="dashboard-block dashboard-link" data-go="agenda" data-agenda-target="lista">
            <h3>Tarefas de hoje</h3>
            ${todayAgenda.length ? `<ul class="summary-list">${todayAgenda.map((row) => `<li><span>${escapeHtml(row.hora || "--:--")} - ${escapeHtml(row.nome)}</span><strong>${escapeHtml(row.tipo || "Agenda")}</strong></li>`).join("")}</ul>` : '<div class="empty">Nenhuma tarefa, reunião ou vencimento para hoje.</div>'}
          </div>
          <div class="dashboard-block dashboard-link" data-go="projetos">
            <h3>Projetos</h3>
            <ul class="summary-list">
              <li><span>Projetos abertos</span><strong>${openProjects.length}</strong></li>
              <li><span>Projetos concluídos</span><strong>${state.projetos.filter((row) => /conclu/i.test(row.status || "")).length}</strong></li>
              <li><span>Orçamento em projetos</span><strong>${currency.format(state.projetos.reduce((sum, row) => sum + Number(row.valor || 0), 0))}</strong></li>
            </ul>
          </div>
          <div class="dashboard-block dashboard-link" data-go="financeiro">
            <h3>Últimos pagamentos</h3>
            ${recentPaid.length ? `<ul class="summary-list">${recentPaid.map((row) => `<li><span>${escapeHtml(row.nome)}</span><strong class="${isIncome(row) ? "money-positive" : "money-negative"}">${currency.format(Number(row.valor || 0))}</strong></li>`).join("")}</ul>` : '<div class="empty">Nenhum pagamento registrado.</div>'}
          </div>
        </div>
      `;

      attachDashboardLinks();
    }

    function chartRow(label, value, maxValue, colorClass) {
      const width = Math.max(4, Math.round((Math.abs(value) / maxValue) * 100));
      return `
        <div class="chart-row">
          <span>${escapeHtml(label)}</span>
          <div class="chart-track"><div class="chart-fill ${colorClass}" style="--w: ${width}%;"></div></div>
          <strong>${currency.format(Math.abs(value))}</strong>
        </div>
      `;
    }

    function metricCard(label, value, icon, colorClass, module) {
      return `
        <button class="metric-card ${colorClass}" type="button" data-go="${module}">
          <span>${icon}</span>
          <small>${escapeHtml(label)}</small>
          <strong>${value}</strong>
        </button>
      `;
    }
