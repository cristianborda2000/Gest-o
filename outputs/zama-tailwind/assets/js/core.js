/*
  core.js
  Cuida do estado geral: carregar/salvar dados no Supabase ou localStorage,
  trocar de modulo, renderizar a tela atual e atualizar os indicadores do topo.
*/

    function prepareState(savedState) {
      Object.keys(modules).forEach((key) => {
        if (!savedState[key]) savedState[key] = [];
      });
      normalizeUtilityState(savedState);
      normalizeFinanceRows(savedState);
      normalizeFixedExpenseRows(savedState);
      normalizeAgendaRows(savedState);
      normalizeMonthlyPlans(savedState);
      savedState.projetos.forEach((project) => syncProjectFinance(project, savedState));
      savedState.clientes.forEach((client) => syncClientMonthly(client, savedState));
      savedState.mensalidades.forEach((monthly) => syncMonthlyFinance(monthly, savedState));
      return savedState;
    }

    function normalizeUtilityState(targetState) {
      targetState.companyProfile = {
        ...defaultCompanyProfile,
        ...(targetState.companyProfile || {})
      };
      if (!Array.isArray(targetState.contractHistory)) {
        targetState.contractHistory = [];
      }
      targetState.backups = targetState.backups || {};
      targetState.setupDone = Boolean(
        targetState.setupDone ||
        targetState.companyProfile.documento ||
        targetState.companyProfile.telefone ||
        targetState.companyProfile.endereco
      );
    }

    function createInitialState() {
      const initialState = Object.fromEntries(Object.entries(modules).map(([key, module]) => [
        key,
        (module.rows || []).map((row) => ({ id: createId(), ...row }))
      ]));

      return prepareState(initialState);
    }

    async function getCurrentUser() {
      if (!supabaseClient) return null;
      const { data } = await supabaseClient.auth.getSession();
      return data.session?.user || null;
    }

    async function loadCloudState() {
      const user = await getCurrentUser();
      if (!supabaseClient || !user) return null;

      const { data, error } = await supabaseClient
        .from(cloudStateTable)
        .select("data")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        console.warn("Nao foi possivel carregar dados do Supabase.", error);
        return null;
      }

      return data?.data ? prepareState(data.data) : null;
    }

    async function saveCloudState() {
      const user = await getCurrentUser();
      if (!supabaseClient || !user || !state) return false;

      setCloudStatus("Salvando...", "saving");

      const { data: existing, error: lookupError } = await supabaseClient
        .from(cloudStateTable)
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (lookupError) {
        console.warn("Nao foi possivel verificar registro no Supabase.", lookupError);
        setCloudStatus(`Erro: ${lookupError.message}`, "error");
        return false;
      }

      const payload = {
        user_id: user.id,
        data: state,
        updated_at: new Date().toISOString()
      };

      const query = existing
        ? supabaseClient.from(cloudStateTable).update(payload).eq("user_id", user.id)
        : supabaseClient.from(cloudStateTable).insert(payload);

      const { error } = await query;

      if (error) {
        console.warn("Nao foi possivel salvar dados no Supabase.", error);
        setCloudStatus(`Erro: ${error.message}`, "error");
        return false;
      }

      setCloudStatus("Nuvem salva", "");
      return true;
    }

    async function resetCloudState() {
      const user = await getCurrentUser();
      if (!supabaseClient || !user) return false;

      const { error } = await supabaseClient
        .from(cloudStateTable)
        .delete()
        .eq("user_id", user.id);

      if (error) {
        console.warn("Nao foi possivel apagar dados no Supabase.", error);
        setCloudStatus(`Erro: ${error.message}`, "error");
        return false;
      }

      setCloudStatus("Nuvem limpa", "");
      return true;
    }

    async function subscribeToCloudChanges(user) {
      if (!supabaseClient || !user) return;

      await unsubscribeFromCloudChanges();
      cloudChangesChannel = supabaseClient
        .channel(`app-state-${user.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: cloudStateTable,
            filter: `user_id=eq.${user.id}`
          },
          (payload) => {
            if (payload.eventType === "DELETE") {
              state = createInitialState();
            } else if (payload.new?.data) {
              state = prepareState(payload.new.data);
            } else {
              return;
            }

            localStorage.setItem(storageKey, JSON.stringify(state));
            setCloudStatus("Atualizado", "");
            render();
          }
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setCloudStatus("Sincronizado", "");
        });
    }

    async function unsubscribeFromCloudChanges() {
      if (!supabaseClient || !cloudChangesChannel) return;
      await supabaseClient.removeChannel(cloudChangesChannel);
      cloudChangesChannel = null;
    }

    async function loadState() {
      const cloudState = await loadCloudState();
      if (cloudState) {
        localStorage.setItem(storageKey, JSON.stringify(cloudState));
        return cloudState;
      }

      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const savedState = prepareState(JSON.parse(saved));
          state = savedState;
          await saveCloudState();
          return savedState;
        } catch (error) {
          localStorage.removeItem(storageKey);
        }
      }

      const initialState = createInitialState();
      state = initialState;
      await saveCloudState();
      return initialState;
    }

    async function persist() {
      // Salvamento central: primeiro grava no navegador, depois tenta sincronizar com Supabase.
      localStorage.setItem(storageKey, JSON.stringify(state));
      return saveCloudState();
    }

    function setCloudStatus(text, statusClass = "") {
      if (!cloudStatus) return;
      cloudStatus.textContent = text;
      cloudStatus.classList.toggle("saving", statusClass === "saving");
      cloudStatus.classList.toggle("error", statusClass === "error");
    }

    function shouldCollapseFormByDefault(module) {
      return module !== "dashboard";
    }

    function getFormToggleLabel() {
      if (formPanelOpen) return editingId ? "Cancelar" : "Recolher";

      const labels = {
        projetos: "Adicionar projeto",
        marketing: "Adicionar campanha",
        clientes: "Adicionar cliente",
        mensalidades: "Adicionar mensalidade",
        agenda: "Adicionar tarefa",
        rh: "Adicionar colaborador",
        financeiro: financeView === "fixos" ? "Adicionar gasto" : "Adicionar lançamento"
      };

      return labels[activeModule] || "Adicionar";
    }

    // Troca de aba no menu lateral e permite abrir sub-abas como financeiro/fixos.
    function goToModule(module, options = {}) {
      activeModule = module;
      if (options.financeView) financeView = options.financeView;
      if (options.agendaView) agendaView = options.agendaView;
      editingId = null;
      formPanelOpen = !shouldCollapseFormByDefault(module);
      searchInput.value = "";
      navButtons.forEach((item) => item.classList.toggle("active", item.dataset.module === module));
      document.querySelector(".nav").classList.remove("expanded");
      closeDetailPanel();
      render();
    }

    function render() {
      // Renderizacao central: sempre que dados/modulo mudam, esta funcao redesenha a tela.
      const module = modules[activeModule];
      moduleTitle.textContent = module.title;
      moduleSubtitle.textContent = module.subtitle;
      const currentModule = getCurrentModuleConfig();
      listTitle.textContent = currentModule.listTitle;
      formTitle.textContent = editingId ? "Editar registro" : currentModule.formTitle;
      workspace.classList.toggle("dashboard-mode", activeModule === "dashboard");
      workspace.classList.toggle("form-collapsed", activeModule !== "dashboard" && !formPanelOpen);
      formPanel.style.display = activeModule === "dashboard" ? "none" : "";
      formPanel.classList.toggle("collapsed", activeModule !== "dashboard" && !formPanelOpen);
      recordForm.hidden = activeModule !== "dashboard" && !formPanelOpen;
      formToggleBtn.textContent = getFormToggleLabel();
      formToggleBtn.setAttribute("aria-expanded", String(formPanelOpen));
      searchInput.style.display = activeModule === "dashboard" ? "none" : "";
      renderListControls();

      renderStats();
      if (activeModule === "dashboard") {
        renderDashboard();
        return;
      }

      renderForm();
      renderTable();
    }

    function renderListControls() {
      const isDashboard = activeModule === "dashboard";
      statusFilterInput.hidden = isDashboard;
      financeMonthFilter.hidden = activeModule !== "financeiro";
      viewToggleBtn.hidden = isDashboard;
      viewToggleBtn.textContent = listViewMode === "table" ? "Cards" : "Tabela";
      financeMonthFilter.value = financeMonth;

      if (isDashboard) return;

      const options = getStatusFilterOptions();
      if (!options.includes(statusFilter)) statusFilter = "Todos";
      statusFilterInput.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option)}" ${option === statusFilter ? "selected" : ""}>${escapeHtml(option)}</option>`)
        .join("");
    }

    function renderStats() {
      if (activeModule === "financeiro") {
        const totals = getFinancialTotals();
        const monthTotals = getFinancialTotalsForMonth(financeMonth);
        if (financeView === "fixos") {
          setStat("Gastos fixos ativos", getActiveFixedExpenses().length, "Total mensal fixo", currency.format(totals.fixedMonthlyExpenses), "Vencem no mês", currency.format(monthTotals.gastosFixosVencendo), "Saídas pagas", currency.format(monthTotals.saidas));
          return;
        }

        setStat("Entradas do mês", currency.format(monthTotals.entradas), "Saídas do mês", currency.format(monthTotals.saidas), "Lucro do mês", currency.format(monthTotals.lucro), "Pendências", currency.format(monthTotals.entradasPendentes + monthTotals.saidasPendentes));
        return;
      }

      if (activeModule === "dashboard") {
        const totals = getFinancialTotals();
        const openProjects = state.projetos.filter((row) => !/conclu/i.test(row.status || "")).length;
        setStat("Agenda de hoje", getTodayAgenda().length, "Mensalidades a receber", currency.format(totals.pendingMonthly), "Saldo em caixa", currency.format(totals.balance), "Gastos do mês", currency.format(totals.monthlyExpenses));
        return;
      }

      if (activeModule === "financeiro") {
        const totals = getFinancialTotals();
        if (financeView === "fixos") {
          setStat("Gastos fixos ativos", getActiveFixedExpenses().length, "Total mensal fixo", currency.format(totals.fixedMonthlyExpenses), "Vencem este mês", currency.format(totals.fixedMonthlyExpenses), "Saídas pagas", currency.format(totals.paidOutcome));
          return;
        }

        setStat("Entradas pagas", currency.format(totals.paidIncome), "Saídas pagas", currency.format(totals.paidOutcome), "Saldo em caixa", currency.format(totals.balance), "Gastos do mês", currency.format(totals.monthlyExpenses));
        return;
      }

      const rows = state[activeModule];
      const inProgress = rows.filter((row) => /andamento|pendente|agendado|planejad/i.test(row.status || "")).length;
      const done = rows.filter((row) => /conclu|pago|ativo/i.test(row.status || "")).length;
      const money = rows.reduce((sum, row) => sum + Number(row.valor || 0), 0);

      setStat("Total no módulo", rows.length, "Em andamento", inProgress, "Concluídos / pagos", done, "Valor financeiro", currency.format(money));
    }

    function setStat(labelA, valueA, labelB, valueB, labelC, valueC, labelD, valueD) {
      document.querySelector("#totalStat").previousElementSibling.textContent = labelA;
      document.getElementById("totalStat").textContent = valueA;
      document.querySelector("#progressStat").previousElementSibling.textContent = labelB;
      document.getElementById("progressStat").textContent = valueB;
      document.querySelector("#doneStat").previousElementSibling.textContent = labelC;
      document.getElementById("doneStat").textContent = valueC;
      document.querySelector("#moneyStat").previousElementSibling.textContent = labelD;
      document.getElementById("moneyStat").textContent = valueD;
    }
