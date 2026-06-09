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
      const monthLabel = firstDay.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
      const daysInMonth = new Date(year, month, 0).getDate();
      const leadingBlanks = firstDay.getDay();
      const monthDates = Array.from({ length: daysInMonth }, (_, index) => new Date(year, month - 1, index + 1));
      const trailingBlanks = (7 - ((leadingBlanks + daysInMonth) % 7)) % 7;
      const days = [
        ...Array.from({ length: leadingBlanks }, () => null),
        ...monthDates,
        ...Array.from({ length: trailingBlanks }, () => null)
      ];
      if (!selectedCalendarDate || !selectedCalendarDate.startsWith(calendarMonth)) {
        selectedCalendarDate = todayIso().startsWith(calendarMonth) ? todayIso() : `${calendarMonth}-01`;
      }
      const monthDays = days
        .filter(Boolean)
        .map((date) => {
          const dateKey = toIsoDate(date);
          return {
            date,
            dateKey,
            items: getAgendaForDate(dateKey, calendarMonth)
          };
        })
        .filter((day) => day.items.length);
      const monthItems = monthDays.flatMap((day) => day.items);
      const agendaSummary = {
        total: monthItems.length,
        pending: monthItems.filter((item) => ["yellow", "blue"].includes(statusClass(item.status))).length,
        done: monthItems.filter((item) => statusClass(item.status) === "green").length,
        canceled: monthItems.filter((item) => item.generatedType === "expense" || statusClass(item.status) === "red").length
      };
      const selectedDate = new Date(`${selectedCalendarDate}T00:00:00`);
      const selectedItems = getAgendaForDate(selectedCalendarDate, calendarMonth);
      const upcomingDays = monthDays
        .filter((day) => day.dateKey !== selectedCalendarDate && day.dateKey >= selectedCalendarDate)
        .slice(0, 6);

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
        <div class="calendar-summary">
          <div class="calendar-summary-card orange"><span>Tarefas no mes</span><strong>${agendaSummary.total}</strong></div>
          <div class="calendar-summary-card orange"><span>Pendentes</span><strong>${agendaSummary.pending}</strong></div>
          <div class="calendar-summary-card green"><span>Concluidas</span><strong>${agendaSummary.done}</strong></div>
          <div class="calendar-summary-card red"><span>Canceladas / vencimentos</span><strong>${agendaSummary.canceled}</strong></div>
        </div>
        <div class="calendar-legend" aria-label="Legenda da agenda">
          <span><i class="orange"></i>Pendente</span>
          <span><i class="green"></i>Concluido</span>
          <span><i class="red"></i>Cancelado / vencimento</span>
        </div>
        <div class="table-wrap">
          <div class="calendar-grid">
            ${weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
            ${days.map((date) => {
              if (!date) return '<div class="calendar-day empty" aria-hidden="true"></div>';
              const dateKey = toIsoDate(date);
              const items = getAgendaForDate(dateKey, calendarMonth);
              const classes = [
                "calendar-day",
                dateKey === todayIso() ? "today" : "",
                dateKey === selectedCalendarDate ? "selected" : ""
              ].filter(Boolean).join(" ");

              return `
                <div class="${classes}" role="button" tabindex="0" data-calendar-date="${dateKey}">
                  <div class="calendar-date">${date.getDate()}</div>
                  ${items.map((item) => `
                    <div class="calendar-item ${item.generatedType === "expense" ? "expense" : statusClass(item.status)}">
                      <strong>${escapeHtml(item.hora || "--:--")} ${escapeHtml(item.tipo || "Agenda")}</strong>
                      <span class="calendar-item-status">${escapeHtml(item.status || "Pendente")}</span>
                      ${escapeHtml(item.nome || "-")}
                    </div>
                  `).join("")}
                </div>
              `;
            }).join("")}
          </div>
        </div>
        <div class="calendar-mobile-list" aria-label="Tarefas do mês">
          <h3>${selectedDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}</h3>
          <section class="calendar-mobile-day selected">
            <div class="calendar-mobile-date">
              <strong>${selectedDate.getDate()}</strong>
              <span>${selectedDate.toLocaleDateString("pt-BR", { weekday: "short" })}</span>
            </div>
            <div class="calendar-mobile-items">
              ${selectedItems.length ? selectedItems.map((item) => `
                <div class="calendar-mobile-item ${item.generatedType === "expense" ? "expense" : statusClass(item.status)}">
                  <div>
                    <strong>${escapeHtml(item.nome || "-")}</strong>
                    <span>${escapeHtml(item.hora || "--:--")} - ${escapeHtml(item.tipo || "Agenda")}</span>
                  </div>
                  <small>${escapeHtml(item.status || "Pendente")}</small>
                </div>
              `).join("") : '<div class="empty">Nenhuma tarefa neste dia.</div>'}
            </div>
          </section>
          ${upcomingDays.length ? "<h3>Próximos dias</h3>" : ""}
          ${upcomingDays.length ? upcomingDays.map((day) => `
            <section class="calendar-mobile-day">
              <div class="calendar-mobile-date">
                <strong>${day.date.getDate()}</strong>
                <span>${day.date.toLocaleDateString("pt-BR", { weekday: "short" })}</span>
              </div>
              <div class="calendar-mobile-items">
                ${day.items.map((item) => `
                  <div class="calendar-mobile-item ${item.generatedType === "expense" ? "expense" : statusClass(item.status)}">
                    <div>
                      <strong>${escapeHtml(item.nome || "-")}</strong>
                      <span>${escapeHtml(item.hora || "--:--")} - ${escapeHtml(item.tipo || "Agenda")}</span>
                    </div>
                    <small>${escapeHtml(item.status || "Pendente")}</small>
                  </div>
                `).join("")}
              </div>
            </section>
          `).join("") : ""}
        </div>
      `;

      attachAgendaTabEvents();
      tableArea.querySelectorAll("[data-calendar-action]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.calendarAction === "today") {
            calendarMonth = todayIso().slice(0, 7);
            selectedCalendarDate = todayIso();
          } else {
            calendarMonth = shiftMonth(calendarMonth, button.dataset.calendarAction === "next" ? 1 : -1);
            selectedCalendarDate = `${calendarMonth}-01`;
          }
          render();
        });
      });
      tableArea.querySelectorAll("[data-calendar-date]").forEach((day) => {
        day.addEventListener("click", () => {
          selectedCalendarDate = day.dataset.calendarDate;
          render();
        });
        day.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectedCalendarDate = day.dataset.calendarDate;
            render();
          }
        });
      });
    }
