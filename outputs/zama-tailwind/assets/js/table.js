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
      const rows = state[rowsKey].filter((row) => JSON.stringify(row).toLowerCase().includes(query));

      if (activeModule === "agenda" && agendaView === "calendario") {
        renderCalendar();
        return;
      }

      if (!rows.length) {
        tableArea.innerHTML = `${renderFinanceTabs()}${renderAgendaTabs()}<div class="empty">Nenhum registro encontrado.</div>`;
        attachFinanceTabEvents();
        attachAgendaTabEvents();
        return;
      }

      const optionalHeader = activeModule === "marketing" ? "Canal" : activeModule === "clientes" ? "E-mail" : activeModule === "mensalidades" ? "Plano" : activeModule === "agenda" ? "Tipo / Responsável" : activeModule === "financeiro" ? "Tipo / Categoria" : "Responsável";
      const optionalKey = activeModule === "marketing" ? "canal" : activeModule === "clientes" ? "email" : "responsavel";

      tableArea.innerHTML = `
        ${renderFinanceTabs()}
        ${renderAgendaTabs()}
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
              <tr>
                <td>
                  <strong>${escapeHtml(row.nome || "-")}</strong>
                  ${row.source === "projeto" ? '<br><span class="badge blue">Projeto vinculado</span>' : ""}
                  ${row.source === "mensalidade" ? '<br><span class="badge blue">Mensalidade vinculada</span>' : ""}
                </td>
                <td>${activeModule === "agenda" ? `${escapeHtml(row.tipo || "-")} / ${escapeHtml(row.responsavel || "-")}` : activeModule === "financeiro" ? `${financeView === "fixos" ? "Saída fixa" : escapeHtml(row.tipo || "-")} / ${escapeHtml(row.responsavel || "-")}` : escapeHtml(row[optionalKey] || "-")}</td>
                <td><span class="badge ${statusClass(row.status)}">${escapeHtml(row.status || "-")}</span></td>
                <td>${activeModule === "agenda" ? `${formatDate(row.prazo)} ${escapeHtml(row.hora || "")}` : financeView === "fixos" && activeModule === "financeiro" ? `Dia ${escapeHtml(row.dia || "-")}` : formatDate(row.prazo)}</td>
                <td class="${activeModule === "agenda" ? "" : Number(row.valor || 0) >= 0 ? "money-positive" : "money-negative"}">${activeModule === "agenda" ? escapeHtml(row.valor || "-") : currency.format(Number(row.valor || 0))}</td>
                <td>
                  <div class="row-actions">
                    ${activeModule === "financeiro" && financeView === "movimentacoes" && row.status !== "Pago" ? `<button class="icon-button" type="button" title="Marcar como pago" data-paid="${row.id}">$</button>` : ""}
                    ${activeModule === "mensalidades" && row.status !== "Pago" && row.status !== "Cancelado" ? `<button class="icon-button" type="button" title="Marcar mensalidade como paga" data-monthly-paid="${row.id}">$</button>` : ""}
                    ${activeModule === "agenda" && row.status !== "Concluído" && row.status !== "Cancelado" ? `<button class="icon-button" type="button" title="Marcar como concluído" data-done="${row.id}">✓</button>` : ""}
                    ${activeModule === "clientes" ? `<button class="icon-button" type="button" title="Gerar contrato para PDF" data-contract="${row.id}">PDF</button>` : ""}
                    <button class="icon-button" type="button" title="Editar" data-edit="${row.id}">✎</button>
                    <button class="icon-button" type="button" title="Excluir" data-delete="${row.id}">×</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;

      tableArea.querySelectorAll("[data-edit]").forEach((button) => {
        button.addEventListener("click", async () => {
          editingId = button.dataset.edit;
          render();
        });
      });

      tableArea.querySelectorAll("[data-contract]").forEach((button) => {
        button.addEventListener("click", () => {
          const client = state.clientes.find((row) => row.id === button.dataset.contract);
          printClientContract(client);
        });
      });

      attachFinanceTabEvents();
      attachAgendaTabEvents();

      tableArea.querySelectorAll("[data-paid]").forEach((button) => {
        button.addEventListener("click", async () => {
          state.financeiro = state.financeiro.map((row) => row.id === button.dataset.paid ? { ...row, status: "Pago", pagoEm: todayIso() } : row);
          await persist();
          render();
        });
      });

      tableArea.querySelectorAll("[data-monthly-paid]").forEach((button) => {
        button.addEventListener("click", async () => {
          state.mensalidades = state.mensalidades.map((row) => row.id === button.dataset.monthlyPaid ? { ...row, status: "Pago", pagoEm: todayIso() } : row);
          const monthly = state.mensalidades.find((row) => row.id === button.dataset.monthlyPaid);
          syncMonthlyFinance(monthly, state);
          await persist();
          render();
        });
      });

      tableArea.querySelectorAll("[data-done]").forEach((button) => {
        button.addEventListener("click", async () => {
          state.agenda = state.agenda.map((row) => row.id === button.dataset.done ? { ...row, status: "Concluído" } : row);
          await persist();
          render();
        });
      });

      tableArea.querySelectorAll("[data-delete]").forEach((button) => {
        button.addEventListener("click", async () => {
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

    function attachFinanceTabEvents() {
      tableArea.querySelectorAll("[data-finance-view]").forEach((button) => {
        button.addEventListener("click", () => {
          financeView = button.dataset.financeView;
          editingId = null;
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
