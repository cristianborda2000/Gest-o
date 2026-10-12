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
