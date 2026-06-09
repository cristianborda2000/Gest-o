/*
  records.js
  Centraliza regras de negocio e utilitarios:
  salvar registros, sincronizar projetos/mensalidades com financeiro,
  normalizar dados, calcular vencimentos da agenda e totais do dashboard.
*/

    // Salva o formulario atual. Depois aplica sincronizacoes conforme o modulo.
    async function saveRecord(event) {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(recordForm).entries());
      data.valor = Number(data.valor || 0);
      if ("implantacao" in data) {
        data.implantacao = Number(data.implantacao || 0);
      }
      const rowsKey = getCurrentRowsKey();

      if (activeModule === "financeiro" && financeView === "fixos") {
        normalizeFixedExpenseRow(data);
      } else if (activeModule === "financeiro") {
        normalizeFinanceRow(data);
      } else if (activeModule === "agenda") {
        normalizeAgendaRow(data);
      }

      if (editingId) {
        state[rowsKey] = state[rowsKey].map((row) => row.id === editingId ? { ...row, ...data } : row);
      } else {
        const newRecord = { id: createId(), createdAt: new Date().toISOString(), ...data };
        if (rowsKey === "clientes" || rowsKey === "agenda") {
          state[rowsKey].unshift(newRecord);
        } else {
          state[rowsKey].push(newRecord);
        }
      }

      if (activeModule === "projetos") {
        const savedProject = editingId
          ? state.projetos.find((row) => row.id === editingId)
          : state.projetos[state.projetos.length - 1];
        syncProjectFinance(savedProject, state);
      }

      if (activeModule === "mensalidades") {
        const savedMonthly = editingId
          ? state.mensalidades.find((row) => row.id === editingId)
          : state.mensalidades[state.mensalidades.length - 1];
        syncMonthlyFinance(savedMonthly, state);
      }

      if (activeModule === "clientes") {
        const savedClient = editingId
          ? state.clientes.find((row) => row.id === editingId)
          : state.clientes[0];
        syncClientMonthly(savedClient, state);
      }

      if (activeModule === "agenda" && data.prazo) {
        calendarMonth = data.prazo.slice(0, 7);
      }

      editingId = null;
      await persist();
      recordForm.reset();
      formPanelOpen = false;
      render();
    }

    function formatDate(value) {
      if (!value) return "-";
      const [year, month, day] = value.split("-");
      if (!year || !month || !day) return value;
      return `${day}/${month}/${year}`;
    }

    function formatFieldLabel(key) {
      const labels = {
        nome: "Nome",
        responsavel: "Responsável",
        email: "E-mail",
        telefone: "Telefone",
        documento: "Documento",
        endereco: "Endereço",
        cidade: "Cidade/UF",
        plano: "Plano",
        tempo: "Tempo",
        implantacao: "Implantação",
        inicio: "Início",
        prazo: "Data",
        hora: "Hora",
        status: "Status",
        valor: "Valor",
        observacoes: "Observações",
        canal: "Canal",
        tipo: "Tipo",
        dia: "Dia de vencimento",
        pagoEm: "Pago em",
        createdAt: "Criado em"
      };
      return labels[key] || key;
    }

    function formatDetailValue(key, value) {
      if (key === "valor" || key === "implantacao") return currency.format(Number(value || 0));
      if (key === "prazo" || key === "inicio" || key === "pagoEm") return formatDate(String(value).slice(0, 10));
      if (key === "createdAt") return new Date(value).toLocaleString("pt-BR");
      return escapeHtml(value);
    }

    function statusClass(status = "") {
      if (/conclu|pago|ativo/i.test(status)) return "green";
      if (/cancel|atras|paus|afast|deslig/i.test(status)) return "red";
      if (/andamento|agend/i.test(status)) return "blue";
      return "yellow";
    }

    // Projetos geram duas entradas financeiras: 50% no inicio e 50% na conclusao.
    function syncProjectFinance(project, targetState) {
      if (!project) return;

      const halfValue = Number(project.valor || 0) / 2;
      const firstDueDate = project.inicio || todayIso();
      const finalDueDate = project.prazo || firstDueDate;
      const finalStatus = /conclu/i.test(project.status || "") ? "Pendente" : "Agendado";

      upsertFinanceFromProject(targetState, project, {
        installment: "inicio",
        nome: `Entrada 50% - ${project.nome}`,
        prazo: firstDueDate,
        status: "Pendente",
        valor: halfValue,
        observacoes: `Receita vinculada ao projeto "${project.nome}". Cobrança inicial para começar.`
      });

      upsertFinanceFromProject(targetState, project, {
        installment: "final",
        nome: `Final 50% - ${project.nome}`,
        prazo: finalDueDate,
        status: finalStatus,
        valor: halfValue,
        observacoes: `Receita vinculada ao projeto "${project.nome}". Cobrança final após conclusão.`
      });
    }

    function upsertFinanceFromProject(targetState, project, entry) {
      const existingIndex = targetState.financeiro.findIndex((row) => row.projectId === project.id && row.installment === entry.installment);
      const record = {
        tipo: "Entrada",
        responsavel: "Receita",
        source: "projeto",
        projectId: project.id,
        installment: entry.installment,
        ...entry
      };

      if (existingIndex >= 0) {
        const current = targetState.financeiro[existingIndex];
        const preservedStatus = current.status === "Pago" ? current.status : record.status;
        targetState.financeiro[existingIndex] = {
          ...current,
          ...record,
          status: preservedStatus
        };
        return;
      }

      targetState.financeiro.push({ id: createId(), ...record });
    }

    function removeProjectFinance(projectId) {
      state.financeiro = state.financeiro.filter((row) => row.projectId !== projectId);
    }

    // Mensalidades marcadas como pagas criam uma entrada no financeiro.
    function syncMonthlyFinance(monthly, targetState) {
      if (!monthly || monthly.status === "Cancelado") {
        if (monthly) removeMonthlyFinance(monthly.id, targetState);
        return;
      }

      const existingIndex = targetState.financeiro.findIndex((row) => row.monthlyId === monthly.id);
      const record = {
        nome: `Mensalidade - ${monthly.nome}`,
        tipo: "Entrada",
        responsavel: "Receita",
        prazo: monthly.prazo,
        status: monthly.status === "Pago" ? "Pago" : monthly.status,
        valor: Math.abs(Number(monthly.valor || 0)),
        observacoes: `Mensalidade vinculada ao cliente "${monthly.nome}". Plano: ${monthly.responsavel || "-"}.`,
        source: "mensalidade",
        monthlyId: monthly.id,
        pagoEm: monthly.status === "Pago" ? (monthly.pagoEm || todayIso()) : ""
      };

      if (existingIndex >= 0) {
        targetState.financeiro[existingIndex] = {
          ...targetState.financeiro[existingIndex],
          ...record
        };
        return;
      }

      targetState.financeiro.push({ id: createId(), ...record });
    }

    function removeMonthlyFinance(monthlyId, targetState = state) {
      targetState.financeiro = targetState.financeiro.filter((row) => row.monthlyId !== monthlyId);
    }

    // Clientes ativos criam/atualizam automaticamente um registro em Mensalidades.
    function syncClientMonthly(client, targetState) {
      if (!client) return;

      const existingIndex = targetState.mensalidades.findIndex((row) => row.clientId === client.id || (!row.clientId && row.nome === client.nome));
      const status = client.status === "Inativo" ? "Cancelado" : "Pendente";
      const monthly = {
        nome: client.nome,
        responsavel: normalizePlan(client.plano || "Básico"),
        prazo: client.prazo || todayIso(),
        status,
        valor: Math.abs(Number(client.valor || 0)),
        observacoes: `Mensalidade gerada automaticamente pelo cadastro do cliente. Contato: ${client.responsavel || "-"}.`,
        source: "cliente",
        clientId: client.id
      };

      if (existingIndex >= 0) {
        const current = targetState.mensalidades[existingIndex];
        const preservedPayment = current.status === "Pago" ? {
          status: current.status,
          pagoEm: current.pagoEm || todayIso()
        } : {};

        targetState.mensalidades[existingIndex] = {
          ...current,
          ...monthly,
          ...preservedPayment
        };
        syncMonthlyFinance(targetState.mensalidades[existingIndex], targetState);
        return;
      }

      const newMonthly = { id: createId(), ...monthly };
      targetState.mensalidades.push(newMonthly);
      syncMonthlyFinance(newMonthly, targetState);
    }

    function removeClientMonthly(clientId) {
      const linked = state.mensalidades.filter((row) => row.clientId === clientId);
      linked.forEach((monthly) => removeMonthlyFinance(monthly.id));
      state.mensalidades = state.mensalidades.filter((row) => row.clientId !== clientId);
    }

    function normalizeMonthlyPlans(targetState) {
      targetState.clientes.forEach((client) => {
        client.plano = normalizePlan(client.plano || client.responsavel || "Básico");
      });
      targetState.mensalidades.forEach((monthly) => {
        monthly.responsavel = normalizePlan(monthly.responsavel || "Básico");
      });
    }

    function normalizePlan(plan) {
      const value = String(plan || "").toLowerCase();
      if (value.includes("premium") || value.includes("personal") || value.includes("avanç") || value.includes("avanc")) return "Avançado";
      if (value.includes("prof") || value.includes("inter")) return "Intermediário";
      return "Básico";
    }

    // Datas e normalizacoes evitam inconsistencias quando dados antigos sao importados.
    function todayIso() {
      return new Date().toISOString().slice(0, 10);
    }

    function toIsoDate(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    function shiftMonth(monthKey, amount) {
      const [year, month] = monthKey.split("-").map(Number);
      const date = new Date(year, month - 1 + amount, 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }

    function normalizeFinanceRows(targetState) {
      targetState.financeiro.forEach(normalizeFinanceRow);
    }

    function normalizeFixedExpenseRows(targetState) {
      targetState.gastosFixos.forEach(normalizeFixedExpenseRow);
    }

    function normalizeAgendaRows(targetState) {
      targetState.agenda.forEach(normalizeAgendaRow);
    }

    function normalizeFinanceRow(row) {
      if (!row.tipo) {
        row.tipo = Number(row.valor || 0) < 0 || row.responsavel !== "Receita" ? "Saída" : "Entrada";
      }

      if (row.tipo === "Saída") {
        row.valor = -Math.abs(Number(row.valor || 0));
      } else {
        row.valor = Math.abs(Number(row.valor || 0));
      }
    }

    function normalizeFixedExpenseRow(row) {
      row.tipo = "Saída";
      row.valor = -Math.abs(Number(row.valor || 0));
      row.dia = Math.min(31, Math.max(1, Number(row.dia || 1)));
    }

    function normalizeAgendaRow(row) {
      const fallbackDate = row.prazo || row.data || row.date || "";
      row.prazo = String(fallbackDate).slice(0, 10);
      row.tipo = row.tipo || "Reunião";
      row.status = row.status || "Pendente";
      row.hora = row.hora || "";
      row.valor = Number(row.valor || 0);
    }

    function getActiveFixedExpenses() {
      return state.gastosFixos.filter((row) => row.status !== "Pausado" && row.status !== "Cancelado");
    }

    // Agenda combina compromissos manuais com vencimentos financeiros.
    function getTodayAgenda() {
      return getAgendaForDate(todayIso(), todayIso().slice(0, 7))
        .filter((row) => row.status !== "Concluído" && row.status !== "Cancelado")
        .sort((a, b) => String(a.hora || "").localeCompare(String(b.hora || "")));
    }

    function getAgendaForDate(dateKey, monthKey) {
      const agendaItems = state.agenda
        .filter((row) => row.prazo === dateKey);
      const expenseItems = getExpenseDueItemsForDate(dateKey, monthKey);

      return [...agendaItems, ...expenseItems]
        .sort((a, b) => String(a.hora || "").localeCompare(String(b.hora || "")));
    }

    function getExpenseDueItemsForDate(dateKey, monthKey) {
      const financeExpenses = state.financeiro
        .filter((row) => isOutcome(row) && row.status !== "Pago" && row.status !== "Cancelado" && row.prazo === dateKey)
        .map((row) => ({
          id: `finance-${row.id}`,
          nome: `${row.nome} - ${currency.format(Math.abs(Number(row.valor || 0)))}`,
          tipo: "Vencimento",
          prazo: row.prazo,
          hora: "",
          status: row.status,
          generatedType: "expense"
        }));

      const fixedExpenses = getActiveFixedExpenses()
        .map((row) => {
          const dueDate = fixedExpenseDate(row, monthKey);
          return {
            id: `fixed-${row.id}`,
            nome: `${row.nome} - ${currency.format(Math.abs(Number(row.valor || 0)))}`,
            tipo: "Gasto fixo",
            prazo: dueDate,
            hora: "",
            status: row.status,
            generatedType: "expense"
          };
        })
        .filter((row) => row.prazo === dateKey);

      return [...financeExpenses, ...fixedExpenses];
    }

    function fixedExpenseDate(row, monthKey) {
      const [year, month] = monthKey.split("-").map(Number);
      const lastDay = new Date(year, month, 0).getDate();
      const day = Math.min(lastDay, Math.max(1, Number(row.dia || 1)));
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    function isIncome(row) {
      return row.tipo === "Entrada" || Number(row.valor || 0) > 0;
    }

    function isOutcome(row) {
      return row.tipo === "Saída" || Number(row.valor || 0) < 0;
    }

    function isCurrentMonth(value) {
      const date = value || todayIso();
      return date.slice(0, 7) === todayIso().slice(0, 7);
    }

    function rowMatchesMonth(row, monthKey = todayIso().slice(0, 7)) {
      const date = row.pagoEm || row.prazo || "";
      return String(date).slice(0, 7) === monthKey;
    }

    function getStatusFilterOptions() {
      const rowsKey = getCurrentRowsKey();
      const commonStatuses = ["Pendente", "Pago", "Concluído", "Atrasado"];
      const statuses = (state[rowsKey] || [])
        .map((row) => row.status)
        .filter(Boolean);
      return ["Todos", ...Array.from(new Set([...commonStatuses, ...statuses]))];
    }

    function passesStatusFilter(row) {
      return statusFilter === "Todos" || row.status === statusFilter;
    }

    function daysUntil(dateKey) {
      const today = new Date(`${todayIso()}T00:00:00`);
      const target = new Date(`${dateKey}T00:00:00`);
      return Math.round((target - today) / 86400000);
    }

    function isWithinNextDays(dateKey, amount) {
      const diff = daysUntil(dateKey);
      return diff >= 0 && diff <= amount;
    }

    function getFinancialTotalsForMonth(monthKey = todayIso().slice(0, 7)) {
      const monthRows = state.financeiro.filter((row) => rowMatchesMonth(row, monthKey));
      const paid = monthRows.filter((row) => row.status === "Pago");
      const entradas = paid
        .filter(isIncome)
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const saidas = paid
        .filter(isOutcome)
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const entradasPendentes = monthRows
        .filter((row) => isIncome(row) && row.status !== "Pago" && row.status !== "Cancelado")
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const saidasPendentes = monthRows
        .filter((row) => isOutcome(row) && row.status !== "Pago" && row.status !== "Cancelado")
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const gastosFixosVencendo = getFixedExpensesForMonth(monthKey)
        .filter((row) => row.status !== "Cancelado")
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);

      return {
        entradas,
        saidas,
        lucro: entradas - saidas,
        entradasPendentes,
        saidasPendentes,
        gastosFixosVencendo,
        lancamentos: monthRows.length
      };
    }

    function getFixedExpensesForMonth(monthKey = todayIso().slice(0, 7)) {
      return getActiveFixedExpenses().map((row) => ({
        ...row,
        prazo: fixedExpenseDate(row, monthKey)
      }));
    }

    function getUpcomingMonthlyDue(days = 7) {
      return state.mensalidades.filter((row) => (
        row.status !== "Pago" &&
        row.status !== "Cancelado" &&
        row.prazo &&
        isWithinNextDays(row.prazo, days)
      ));
    }

    function getUpcomingFixedExpenses(days = 7) {
      const monthKey = todayIso().slice(0, 7);
      return getFixedExpensesForMonth(monthKey).filter((row) => (
        row.prazo &&
        isWithinNextDays(row.prazo, days)
      ));
    }

    function getPendingProjectFinalPayments() {
      return state.financeiro.filter((row) => (
        row.source === "projeto" &&
        row.installment === "final" &&
        row.status !== "Pago" &&
        row.status !== "Cancelado"
      ));
    }

    function fillCompanyForm() {
      if (!companyForm || !state?.companyProfile) return;
      Object.entries(state.companyProfile).forEach(([key, value]) => {
        const input = companyForm.elements[key];
        if (input) input.value = value || "";
      });
    }

    function maybeShowOnboarding() {
      if (!state || state.setupDone || !onboardingPanel || !onboardingBackdrop) return;
      onboardingPanel.hidden = false;
      onboardingBackdrop.hidden = false;
    }

    function hideOnboarding() {
      onboardingPanel.hidden = true;
      onboardingBackdrop.hidden = true;
    }

    function closeDetailPanel() {
      if (!detailPanel || !detailBackdrop) return;
      detailPanel.hidden = true;
      detailBackdrop.hidden = true;
      detailContent.innerHTML = "";
    }

    function getFinancialTotals() {
      const paid = state.financeiro.filter((row) => row.status === "Pago");
      const paidIncome = paid
        .filter(isIncome)
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const paidOutcome = paid
        .filter(isOutcome)
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const monthlyExpenses = paid
        .filter((row) => isOutcome(row) && isCurrentMonth(row.pagoEm || row.prazo))
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const pendingOutcome = state.financeiro
        .filter((row) => isOutcome(row) && row.status !== "Pago")
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const fixedMonthlyExpenses = getActiveFixedExpenses()
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);
      const pendingMonthly = state.mensalidades
        .filter((row) => row.status !== "Pago" && row.status !== "Cancelado")
        .reduce((sum, row) => sum + Math.abs(Number(row.valor || 0)), 0);

      return {
        paidIncome,
        paidOutcome,
        monthlyExpenses,
        pendingOutcome,
        fixedMonthlyExpenses,
        pendingMonthly,
        balance: paidIncome - paidOutcome
      };
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[char]));
    }

    function createId() {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }

      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
