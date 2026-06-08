/*
  core.js
  Cuida do estado geral: carregar/salvar dados no Supabase ou localStorage,
  trocar de modulo, renderizar a tela atual e atualizar os indicadores do topo.
*/

    function prepareState(savedState) {
      Object.keys(modules).forEach((key) => {
        if (!savedState[key]) savedState[key] = [];
      });
      normalizeFinanceRows(savedState);
      normalizeFixedExpenseRows(savedState);
      normalizeAgendaRows(savedState);
      normalizeMonthlyPlans(savedState);
      savedState.projetos.forEach((project) => syncProjectFinance(project, savedState));
      savedState.clientes.forEach((client) => syncClientMonthly(client, savedState));
      savedState.mensalidades.forEach((monthly) => syncMonthlyFinance(monthly, savedState));
      return savedState;
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
      if (!supabaseClient || !user || !state) return;

      const { error } = await supabaseClient
        .from(cloudStateTable)
        .upsert({
          user_id: user.id,
          data: state,
          updated_at: new Date().toISOString()
        }, { onConflict: "user_id" });

      if (error) {
        console.warn("Nao foi possivel salvar dados no Supabase.", error);
      }
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
      localStorage.setItem(storageKey, JSON.stringify(state));
      await saveCloudState();
    }

    // Troca de aba no menu lateral e permite abrir sub-abas como financeiro/fixos.
    function goToModule(module, options = {}) {
      activeModule = module;
      if (options.financeView) financeView = options.financeView;
      if (options.agendaView) agendaView = options.agendaView;
      editingId = null;
      searchInput.value = "";
      navButtons.forEach((item) => item.classList.toggle("active", item.dataset.module === module));
      render();
    }

    function render() {
      const module = modules[activeModule];
      moduleTitle.textContent = module.title;
      moduleSubtitle.textContent = module.subtitle;
      const currentModule = getCurrentModuleConfig();
      listTitle.textContent = currentModule.listTitle;
      formTitle.textContent = editingId ? "Editar registro" : currentModule.formTitle;
      workspace.classList.toggle("dashboard-mode", activeModule === "dashboard");
      formPanel.style.display = activeModule === "dashboard" ? "none" : "";
      searchInput.style.display = activeModule === "dashboard" ? "none" : "";

      renderStats();
      if (activeModule === "dashboard") {
        renderDashboard();
        return;
      }

      renderForm();
      renderTable();
    }

    function renderStats() {
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
