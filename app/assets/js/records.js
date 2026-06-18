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
      const validationError = validateRecordData(data, getCurrentModuleConfig(), rowsKey);
      if (validationError) {
        if (typeof showToast === "function") {
          showToast("Revise o formulário", validationError, "error");
        }
        return;
      }

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

    function validateRecordData(data, module, rowsKey) {
      const requiredField = (module.fields || []).find((field) => field.required && !String(data[field.key] || "").trim());
      if (requiredField) return `Preencha o campo obrigatório: ${requiredField.label}.`;

      if ("email" in data && data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        return "Informe um e-mail válido.";
      }

      if ("documento" in data && data.documento) {
        const digits = onlyDigits(data.documento);
        if (![11, 14].includes(digits.length)) {
          return "Informe um CPF com 11 dígitos ou CNPJ com 14 dígitos.";
        }
      }

      if ("telefone" in data && data.telefone) {
        const digits = onlyDigits(data.telefone);
        if (digits.length < 10 || digits.length > 11) {
          return "Informe um telefone com DDD.";
        }
      }

      if ("prazo" in data && data.prazo && !/^\d{4}-\d{2}-\d{2}$/.test(data.prazo)) {
        return "Informe uma data válida.";
      }

      if ("inicio" in data && data.inicio && !/^\d{4}-\d{2}-\d{2}$/.test(data.inicio)) {
        return "Informe uma data de início válida.";
      }

      if ("inicio" in data && data.inicio && data.prazo && data.inicio > data.prazo) {
        return "A data de início não pode ser depois do prazo.";
      }

      if ((rowsKey === "financeiro" || rowsKey === "gastosFixos" || rowsKey === "mensalidades") && !Number.isFinite(Number(data.valor))) {
        return "Informe um valor financeiro válido.";
      }

      if ((rowsKey === "financeiro" || rowsKey === "gastosFixos" || rowsKey === "mensalidades" || rowsKey === "clientes" || rowsKey === "projetos") && Number(data.valor) < 0) {
        return "Informe o valor sem sinal negativo. O sistema ajusta entradas e saídas automaticamente.";
      }

      if ("implantacao" in data && Number(data.implantacao) < 0) {
        return "Informe o valor de implantação sem sinal negativo.";
      }

      if (rowsKey === "gastosFixos" && (!Number.isInteger(Number(data.dia)) || Number(data.dia) < 1 || Number(data.dia) > 31)) {
        return "O dia de vencimento precisa ficar entre 1 e 31.";
      }

      if (rowsKey === "agenda" && data.valor && (Number(data.valor) < 1 || Number(data.valor) > 5)) {
        return "Use prioridade de 1 a 5 na agenda.";
      }

      if (rowsKey === "mensalidades" && !editingId) {
        const duplicate = state.mensalidades.some((row) => (
          row.nome === data.nome &&
          row.prazo === data.prazo &&
          row.status !== "Cancelado"
        ));
        if (duplicate) return "Já existe uma mensalidade para este cliente nesta data.";
      }

      return "";
    }

    function onlyDigits(value) {
      return String(value || "").replace(/\D/g, "");
    }

    function formatDate(value) {
      if (!value) return "-";
      const [year, month, day] = value.split("-");
      if (!year || !month || !day) return value;
      return `${day}/${month}/${year}`;
    }

    function formatFieldLabel(key) {
      if (activeModule === "agenda" && key === "valor") return "Prioridade";

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
        formaPagamento: "Forma de pagamento",
        dia: "Dia de vencimento",
        pagoEm: "Pago em",
        createdAt: "Criado em"
      };
      return labels[key] || key;
    }

    function formatDetailValue(key, value) {
      if (activeModule === "agenda" && key === "valor") return escapeHtml(value || "-");
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
      return targetState;
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
      return targetState;
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
      return state.financeiro;
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
      if (row.source === "projeto" || row.projectId) {
        delete row.source;
        delete row.projectId;
        delete row.installment;
      }

      if (!row.tipo) {
        row.tipo = Number(row.valor || 0) < 0 || row.responsavel !== "Receita" ? "Saída" : "Entrada";
      }

      if (row.tipo === "Saída") {
        row.formaPagamento = row.formaPagamento || "Pix";
        row.valor = -Math.abs(Number(row.valor || 0));
      } else {
        row.formaPagamento = row.formaPagamento || "Pix";
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
      return [];
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
