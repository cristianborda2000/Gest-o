/*
  forms.js
  Monta o formulario dinamico com base no modulo ativo e desenha as abas internas
  da gestao financeira e da agenda.
*/

    // Decide qual array do state esta sendo usado no momento.
    // Exemplo: financeiro/fixos usa state.gastosFixos em vez de state.financeiro.
    function getCurrentRowsKey() {
      if (activeModule === "financeiro" && financeView === "fixos") {
        return "gastosFixos";
      }

      return activeModule;
    }

    function getCurrentModuleConfig() {
      return modules[getCurrentRowsKey()] || modules[activeModule];
    }

    // Cria os inputs conforme a lista fields definida em config.js.
    function renderForm() {
      const module = getCurrentModuleConfig();
      const rowsKey = getCurrentRowsKey();
      const record = state[rowsKey].find((row) => row.id === editingId) || {};
      const fields = module.fields.map((field) => {
        const value = activeModule === "financeiro" && financeView === "fixos" && field.key === "valor"
          ? Math.abs(Number(record[field.key] || 0)) || ""
          : record[field.key] ?? "";
        if (field.type === "select") {
          const options = field.options.map((option) => {
            const selected = String(value || field.options[0]) === option ? "selected" : "";
            return `<option ${selected}>${escapeHtml(option)}</option>`;
          }).join("");
          return `<label>${field.label}<select name="${field.key}">${options}</select></label>`;
        }

        if (field.type === "textarea") {
          return `<label>${field.label}<textarea name="${field.key}">${escapeHtml(value)}</textarea></label>`;
        }

        const required = field.required ? "required" : "";
        return `<label>${field.label}<input name="${field.key}" type="${field.type}" value="${escapeHtml(value)}" ${required}></label>`;
      });

      recordForm.innerHTML = `
        <div class="form-grid">${fields.slice(0, 4).join("")}</div>
        ${fields.slice(4).join("")}
        <button class="button primary" type="submit">${editingId ? "Salvar alterações" : "Adicionar"}</button>
        ${editingId ? '<button class="button" type="button" id="cancelEditBtn">Cancelar edição</button>' : ""}
      `;

      const cancelButton = document.getElementById("cancelEditBtn");
      if (cancelButton) {
        cancelButton.addEventListener("click", () => {
          editingId = null;
          render();
        });
      }
    }

    function renderFinanceTabs() {
      if (activeModule !== "financeiro") return "";

      return `
        <div class="finance-tabs" aria-label="Abas financeiras">
          <button type="button" class="${financeView === "movimentacoes" ? "active" : ""}" data-finance-view="movimentacoes">Movimentações</button>
          <button type="button" class="${financeView === "fixos" ? "active" : ""}" data-finance-view="fixos">Gastos mensais fixos</button>
        </div>
      `;
    }

    function renderAgendaTabs() {
      if (activeModule !== "agenda") return "";

      return `
        <div class="finance-tabs" aria-label="Abas da agenda">
          <button type="button" class="${agendaView === "lista" ? "active" : ""}" data-agenda-view="lista">Lista</button>
          <button type="button" class="${agendaView === "calendario" ? "active" : ""}" data-agenda-view="calendario">Calendário mensal</button>
        </div>
      `;
    }
