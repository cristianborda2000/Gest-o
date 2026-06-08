/*
  table.js
  Renderiza tabelas, botoes de acao, links do dashboard e calendario mensal.
  Aqui ficam os eventos de editar, excluir, pagar, concluir agenda e gerar PDF.
*/

    function attachDashboardLinks() {
      tableArea.querySelectorAll("[data-go]").forEach((item) => {
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          const module = item.dataset.go;
          goToModule(module, {
            financeView: item.dataset.financeTarget,
            agendaView: item.dataset.agendaTarget
          });
        });
      });
    }

    function renderTable() {
      const module = getCurrentModuleConfig();
      const rowsKey = getCurrentRowsKey();
      const query = searchInput.value.trim().toLowerCase();
      const rows = state[rowsKey].filter((row) => {
        const matchesSearch = JSON.stringify(row).toLowerCase().includes(query);
        const matchesStatus = passesStatusFilter(row);
        const matchesMonth = activeModule !== "financeiro" || financeView !== "movimentacoes" || rowMatchesMonth(row, financeMonth);
        return matchesSearch && matchesStatus && matchesMonth;
      });

      if (activeModule === "agenda" && agendaView === "calendario") {
        renderCalendar();
        return;
      }

      const tablePrefix = `${renderFinanceTabs()}${renderAgendaTabs()}${renderFinanceSummary()}${renderContractHistory()}`;

      if (!rows.length) {
        tableArea.innerHTML = `${tablePrefix}<div class="empty">Nenhum registro encontrado.</div>`;
        attachFinanceTabEvents();
        attachAgendaTabEvents();
        return;
      }

      const optionalHeader = activeModule === "marketing" ? "Canal" : activeModule === "clientes" ? "E-mail" : activeModule === "mensalidades" ? "Plano" : activeModule === "agenda" ? "Tipo / Responsável" : activeModule === "financeiro" ? "Tipo / Categoria" : "Responsável";
      const optionalKey = activeModule === "marketing" ? "canal" : activeModule === "clientes" ? "email" : "responsavel";

      tableArea.innerHTML = listViewMode === "cards" ? `
        ${tablePrefix}
        <div class="record-cards">
          ${rows.map((row) => renderRecordCard(row, module, optionalKey)).join("")}
        </div>
      ` : `
        ${tablePrefix}
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>${optionalHeader}</th>
              <th>Status</th>
              <th>${activeModule === "agenda" ? "Data / Hora" : financeView === "fixos" && activeModule === "financeiro" ? "Vencimento" : "Data"}</th>
              <th>${module.moneyLabel}</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr data-detail="${row.id}">
                <td>
                  <strong>${escapeHtml(row.nome || "-")}</strong>
                  ${row.source === "projeto" ? '<br><span class="badge blue">Projeto vinculado</span>' : ""}
                  ${row.source === "mensalidade" ? '<br><span class="badge blue">Mensalidade vinculada</span>' : ""}
                </td>
                <td>${activeModule === "agenda" ? `${escapeHtml(row.tipo || "-")} / ${escapeHtml(row.responsavel || "-")}` : activeModule === "financeiro" ? `${financeView === "fixos" ? "Saída fixa" : escapeHtml(row.tipo || "-")} / ${escapeHtml(row.responsavel || "-")}` : escapeHtml(row[optionalKey] || "-")}</td>
                <td>${renderStatusBadge(row.status)}</td>
                <td>${activeModule === "agenda" ? `${formatDate(row.prazo)} ${escapeHtml(row.hora || "")}` : financeView === "fixos" && activeModule === "financeiro" ? `Dia ${escapeHtml(row.dia || "-")}` : formatDate(row.prazo)}</td>
                <td class="${activeModule === "agenda" ? "" : Number(row.valor || 0) >= 0 ? "money-positive" : "money-negative"}">${activeModule === "agenda" ? escapeHtml(row.valor || "-") : currency.format(Number(row.valor || 0))}</td>
                <td>
                  ${renderRowActions(row)}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;

      tableArea.querySelectorAll("[data-detail]").forEach((item) => {
        item.addEventListener("click", () => {
          const rowsKey = getCurrentRowsKey();
          const record = state[rowsKey].find((row) => row.id === item.dataset.detail);
          openDetailPanel(record, rowsKey);
        });
      });

      tableArea.querySelectorAll("[data-edit]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          editingId = button.dataset.edit;
          formPanelOpen = true;
          render();
        });
      });

      tableArea.querySelectorAll("[data-contract]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const client = state.clientes.find((row) => row.id === button.dataset.contract);
          printClientContract(client);
        });
      });

      attachFinanceTabEvents();
      attachAgendaTabEvents();

      tableArea.querySelectorAll("[data-paid]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          state.financeiro = state.financeiro.map((row) => row.id === button.dataset.paid ? { ...row, status: "Pago", pagoEm: todayIso() } : row);
          await persist();
          render();
        });
      });

      tableArea.querySelectorAll("[data-monthly-paid]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          state.mensalidades = state.mensalidades.map((row) => row.id === button.dataset.monthlyPaid ? { ...row, status: "Pago", pagoEm: todayIso() } : row);
          const monthly = state.mensalidades.find((row) => row.id === button.dataset.monthlyPaid);
          syncMonthlyFinance(monthly, state);
          await persist();
          render();
        });
      });

      tableArea.querySelectorAll("[data-done]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          state.agenda = state.agenda.map((row) => row.id === button.dataset.done ? { ...row, status: "Concluído" } : row);
          await persist();
          render();
        });
      });

      tableArea.querySelectorAll("[data-delete]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (activeModule === "projetos") {
            removeProjectFinance(button.dataset.delete);
          }
          if (activeModule === "mensalidades") {
            removeMonthlyFinance(button.dataset.delete);
          }
          if (activeModule === "clientes") {
            removeClientMonthly(button.dataset.delete);
          }
          const rowsKey = getCurrentRowsKey();
          state[rowsKey] = state[rowsKey].filter((row) => row.id !== button.dataset.delete);
          await persist();
          render();
        });
      });
    }

    function renderRecordCard(row, module, optionalKey) {
      const dateLabel = activeModule === "agenda"
        ? `${formatDate(row.prazo)} ${escapeHtml(row.hora || "")}`
        : financeView === "fixos" && activeModule === "financeiro"
          ? `Dia ${escapeHtml(row.dia || "-")}`
          : formatDate(row.prazo);
      const detail = activeModule === "agenda"
        ? `${escapeHtml(row.tipo || "-")} / ${escapeHtml(row.responsavel || "-")}`
        : activeModule === "financeiro"
          ? `${financeView === "fixos" ? "Saída fixa" : escapeHtml(row.tipo || "-")} / ${escapeHtml(row.responsavel || "-")}`
          : escapeHtml(row[optionalKey] || "-");

      return `
        <article class="record-card" data-detail="${row.id}">
          <div class="record-card-head">
            <div>
              <strong>${escapeHtml(row.nome || "-")}</strong>
              <span>${detail}</span>
            </div>
            ${renderStatusBadge(row.status)}
          </div>
          <div class="record-card-grid">
            <span>Data <strong>${dateLabel}</strong></span>
            <span>${module.moneyLabel} <strong class="${activeModule === "agenda" ? "" : Number(row.valor || 0) >= 0 ? "money-positive" : "money-negative"}">${activeModule === "agenda" ? escapeHtml(row.valor || "-") : currency.format(Number(row.valor || 0))}</strong></span>
          </div>
          ${row.observacoes ? `<p>${escapeHtml(row.observacoes)}</p>` : ""}
          ${renderRowActions(row)}
        </article>
      `;
    }

    function renderRowActions(row) {
      return `
        <div class="row-actions">
          ${activeModule === "financeiro" && financeView === "movimentacoes" && row.status !== "Pago" ? `<button class="icon-button" type="button" title="Marcar como pago" data-paid="${row.id}">$</button>` : ""}
          ${activeModule === "mensalidades" && row.status !== "Pago" && row.status !== "Cancelado" ? `<button class="icon-button" type="button" title="Marcar mensalidade como paga" data-monthly-paid="${row.id}">$</button>` : ""}
          ${activeModule === "agenda" && row.status !== "Concluído" && row.status !== "Cancelado" ? `<button class="icon-button" type="button" title="Marcar como concluído" data-done="${row.id}">✓</button>` : ""}
          ${activeModule === "clientes" ? `<button class="icon-button" type="button" title="Gerar contrato para PDF" data-contract="${row.id}">PDF</button>` : ""}
          <button class="icon-button" type="button" title="Editar" data-edit="${row.id}">✎</button>
          <button class="icon-button" type="button" title="Excluir" data-delete="${row.id}">×</button>
        </div>
      `;
    }

    function renderStatusBadge(status = "") {
      return `<span class="badge ${statusClass(status)}">${escapeHtml(status || "-")}</span>`;
    }

    function openDetailPanel(record, rowsKey) {
      if (!record) return;
      const module = modules[rowsKey] || modules[activeModule];
      detailEyebrow.textContent = module.title || "Detalhes";
      detailTitle.textContent = record.nome || "Registro";
      detailContent.innerHTML = `
        <div class="detail-status">${renderStatusBadge(record.status)}</div>
        <dl class="detail-list">
          ${Object.entries(record)
            .filter(([key, value]) => !["id", "source", "projectId", "monthlyId", "clientId", "installment"].includes(key) && value !== "")
            .map(([key, value]) => `<div><dt>${formatFieldLabel(key)}</dt><dd>${formatDetailValue(key, value)}</dd></div>`)
            .join("")}
        </dl>
      `;
      detailPanel.hidden = false;
      detailBackdrop.hidden = false;
    }

    function renderFinanceSummary() {
      if (activeModule !== "financeiro") return "";

      const totals = getFinancialTotalsForMonth(financeMonth);
      const fixedDue = getFixedExpensesForMonth(financeMonth).length;
      return `
        <div class="mini-dashboard">
          <div><span>Entradas pagas</span><strong class="money-positive">${currency.format(totals.entradas)}</strong></div>
          <div><span>Saídas pagas</span><strong class="money-negative">${currency.format(totals.saidas)}</strong></div>
          <div><span>Lucro do mês</span><strong class="${totals.lucro >= 0 ? "money-positive" : "money-negative"}">${currency.format(totals.lucro)}</strong></div>
          <div><span>Pendências</span><strong>${currency.format(totals.entradasPendentes + totals.saidasPendentes)}</strong></div>
          <div><span>Fixos vencendo</span><strong>${fixedDue} - ${currency.format(totals.gastosFixosVencendo)}</strong></div>
        </div>
      `;
    }

    function renderContractHistory() {
      if (activeModule !== "clientes" || !state.contractHistory.length) return "";

      return `
        <div class="history-strip">
          <strong>Contratos gerados</strong>
          ${state.contractHistory.slice(0, 5).map((item) => `
            <span>${escapeHtml(item.numero || "-")} - ${escapeHtml(item.cliente || "-")} - ${formatDate((item.data || "").slice(0, 10))}</span>
          `).join("")}
        </div>
      `;
    }

    function attachFinanceTabEvents() {
      tableArea.querySelectorAll("[data-finance-view]").forEach((button) => {
        button.addEventListener("click", () => {
          financeView = button.dataset.financeView;
          editingId = null;
          formPanelOpen = false;
          searchInput.value = "";
          render();
        });
      });
    }

    function attachAgendaTabEvents() {
      tableArea.querySelectorAll("[data-agenda-view]").forEach((button) => {
        button.addEventListener("click", () => {
          agendaView = button.dataset.agendaView;
          editingId = null;
          formPanelOpen = false;
          searchInput.value = "";
          render();
        });
      });
    }

    // Calendario mensal: combina eventos da agenda e vencimentos financeiros.
    function renderCalendar() {
      const [year, month] = calendarMonth.split("-").map(Number);
      const firstDay = new Date(year, month - 1, 1);
      const start = new Date(firstDay);
      start.setDate(firstDay.getDate() - firstDay.getDay());
      const monthLabel = firstDay.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
      const days = Array.from({ length: 42 }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        return date;
      });

      tableArea.innerHTML = `
        ${renderAgendaTabs()}
        <div class="calendar-toolbar">
          <div class="calendar-title">${escapeHtml(monthLabel)}</div>
          <div class="calendar-actions">
            <button class="button" type="button" data-calendar-action="prev">Mês anterior</button>
            <button class="button" type="button" data-calendar-action="today">Hoje</button>
            <button class="button" type="button" data-calendar-action="next">Próximo mês</button>
          </div>
        </div>
        <div class="table-wrap">
          <div class="calendar-grid">
            ${weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
            ${days.map((date) => {
              const dateKey = toIsoDate(date);
              const items = getAgendaForDate(dateKey, calendarMonth);
              const classes = [
                "calendar-day",
                date.getMonth() + 1 === month ? "" : "muted",
                dateKey === todayIso() ? "today" : ""
              ].filter(Boolean).join(" ");

              return `
                <div class="${classes}">
                  <div class="calendar-date">${date.getDate()}</div>
                  ${items.map((item) => `
                    <div class="calendar-item ${item.generatedType === "expense" ? "expense" : item.status === "Concluído" ? "completed" : ""}">
                      <strong>${escapeHtml(item.hora || "--:--")} ${escapeHtml(item.tipo || "Agenda")}</strong>
                      ${escapeHtml(item.nome || "-")}
                    </div>
                  `).join("")}
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;

      attachAgendaTabEvents();
      tableArea.querySelectorAll("[data-calendar-action]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.calendarAction === "today") {
            calendarMonth = todayIso().slice(0, 7);
          } else {
            calendarMonth = shiftMonth(calendarMonth, button.dataset.calendarAction === "next" ? 1 : -1);
          }
          render();
        });
      });
    }
