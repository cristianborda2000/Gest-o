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
      const mascotMood = monthTotals.lucro >= 0 ? "positive" : "attention";
      const mascotMessage = monthTotals.lucro >= 0
        ? "Seu mês está no verde. Quer conferir os recebimentos?"
        : "Atenção nas saídas deste mês. Vamos revisar as pendências?";

      tableArea.innerHTML = `
        <section class="planner-hero dashboard-link" data-go="financeiro">
          <div class="planner-hero-copy">
            <span class="hero-kicker">Controle financeiro ZAMA</span>
            <h2>Visão geral do seu negócio</h2>
            <p>${escapeHtml(mascotMessage)}</p>
            <div class="hero-actions">
              <button class="hero-chip" type="button" data-go="financeiro">Ver financeiro</button>
              <button class="hero-chip" type="button" data-go="agenda">Ver agenda</button>
              <button class="hero-chip" type="button" data-go="mensalidades">Mensalidades</button>
            </div>
          </div>
          <div class="mascot-stage ${mascotMood}" role="button" tabindex="0" aria-label="Mascote ZAMA">
            <div class="mascot-bubble" id="mascotBubble">${escapeHtml(mascotMessage)}</div>
            ${renderChromaMascot()}
          </div>
          <div class="hero-balance">
            <span>Saldo em caixa</span>
            <strong class="${totals.balance >= 0 ? "money-positive" : "money-negative"}">${currency.format(totals.balance)}</strong>
            <small>${todayAgenda.length} tarefa(s) hoje</small>
          </div>
        </section>
        <div class="metric-row">
          ${metricCard("Receita do mês", currency.format(monthTotals.entradas), "↗", "green", "financeiro")}
          ${metricCard("Despesas do mês", currency.format(monthTotals.saidas), "↘", "red", "financeiro")}
          ${metricCard("Lucro do mês", currency.format(monthTotals.lucro), "=", monthTotals.lucro >= 0 ? "green" : "red", "financeiro")}
          ${metricCard("Tarefas hoje", todayAgenda.length, "✓", "orange", "agenda")}
          ${metricCard("Clientes ativos", state.clientes.filter((row) => row.status === "Ativo").length, "◎", "blue", "clientes")}
        </div>
        <div class="dashboard-grid">
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
      setupChromaMascots();
      attachMascotInteraction({
        balance: totals.balance,
        profit: monthTotals.lucro,
        tasks: todayAgenda.length,
        monthlyDue: upcomingMonthly.length
      });
    }

    function renderChromaMascot() {
      return `
        <div class="chroma-mascot" data-video-src="assets/gato-zama-green.mov?v=20260609-2">
          <canvas class="dashboard-mascot chroma-canvas" width="480" height="480" aria-label="Mascote ZAMA" hidden></canvas>
        </div>
      `;
    }

    // O video original tem fundo verde. Ele nao entra no HTML visivel:
    // criamos um video em memoria, removemos o verde frame a frame e exibimos so o canvas.
    function setupChromaMascots() {
      tableArea.querySelectorAll(".chroma-mascot").forEach((wrap) => {
        const canvas = wrap.querySelector(".chroma-canvas");
        const source = wrap.dataset.videoSrc;
        if (!source || !canvas || !canvas.getContext) return;

        const video = document.createElement("video");
        video.src = source;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = "auto";

        const ctx = canvas.getContext("2d");
        const buffer = document.createElement("canvas");
        buffer.width = canvas.width;
        buffer.height = canvas.height;
        const bufferCtx = buffer.getContext("2d");
        bufferCtx.imageSmoothingEnabled = true;
        bufferCtx.imageSmoothingQuality = "high";
        let active = true;
        let lastDraw = 0;

        const drawVideoContain = () => {
          const canvasRatio = buffer.width / buffer.height;
          const videoRatio = video.videoWidth / video.videoHeight;
          let width = buffer.width;
          let height = buffer.height;
          let x = 0;
          let y = 0;

          if (videoRatio > canvasRatio) {
            height = buffer.width / videoRatio;
            y = (buffer.height - height) / 2;
          } else {
            width = buffer.height * videoRatio;
            x = (buffer.width - width) / 2;
          }

          bufferCtx.clearRect(0, 0, buffer.width, buffer.height);
          bufferCtx.drawImage(video, x, y, width, height);
        };

        const draw = (time = 0) => {
          if (!active) return;
          if (time - lastDraw < 50) {
            requestAnimationFrame(draw);
            return;
          }
          lastDraw = time;

          if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
            canvas.hidden = false;
            drawVideoContain();
            const frame = bufferCtx.getImageData(0, 0, buffer.width, buffer.height);
            const data = frame.data;

            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              const greenDominance = g - Math.max(r, b);

              if (g > 62 && greenDominance > 16 && g > r * 1.08 && g > b * 1.08) {
                data[i + 3] = 0;
              } else if (g > 48 && greenDominance > 8) {
                data[i + 3] = Math.max(0, 255 - greenDominance * 14);
                data[i + 1] = Math.max(Math.max(r, b), g - greenDominance * 1.8);
              } else if (g > r && g > b) {
                data[i + 1] = Math.max(Math.max(r, b), g - Math.max(0, greenDominance * .42));
              }
            }

            ctx.putImageData(frame, 0, 0);
          }

          requestAnimationFrame(draw);
        };

        video.addEventListener("canplay", () => {
          canvas.hidden = false;
        });
        video.addEventListener("error", () => {
          active = false;
          canvas.hidden = true;
        });
        video.play().catch(() => {
          canvas.hidden = true;
        });
        draw();
      });
    }

    function attachMascotInteraction(context) {
      const stage = tableArea.querySelector(".mascot-stage");
      const bubble = tableArea.querySelector("#mascotBubble");
      if (!stage || !bubble) return;

      const messages = [
        context.profit >= 0 ? "Lucro positivo no mês. Bom sinal." : "O lucro está negativo. Vale revisar despesas.",
        context.balance >= 0 ? "Saldo em caixa confirmado." : "Caixa no vermelho. Hora de priorizar recebimentos.",
        context.tasks ? `Você tem ${context.tasks} tarefa(s) para hoje.` : "Agenda tranquila hoje.",
        context.monthlyDue ? `${context.monthlyDue} mensalidade(s) vencendo em breve.` : "Nenhuma mensalidade urgente nos próximos dias."
      ];
      let index = 0;

      const talk = () => {
        index = (index + 1) % messages.length;
        bubble.textContent = messages[index];
        stage.classList.remove("is-talking");
        stage.offsetHeight;
        stage.classList.add("is-talking");
      };

      stage.addEventListener("click", (event) => {
        event.stopPropagation();
        talk();
      });
      stage.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          talk();
        }
      });
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
