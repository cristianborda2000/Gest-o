/*
  core.js
  Cuida do estado geral: carregar/salvar dados no Supabase ou localStorage,
  trocar de modulo, renderizar a tela atual e atualizar os indicadores do topo.
*/

    let cloudRevision = null;
    let cloudUserId = null;
    let cloudSnapshot = null;
    let cloudWritePending = false;

    function userStorageKey() { return `${storageKey}:${cloudUserId || "signed-out"}`; }
    function cacheCloudState(value) {
      try { localStorage.setItem(userStorageKey(), JSON.stringify(value)); } catch {}
    }

    function prepareState(savedState) {
      Object.keys(modules).forEach((key) => {
        if (!Array.isArray(savedState[key])) savedState[key] = [];
      });
      normalizeUtilityState(savedState);
      normalizeFinanceRows(savedState);
      normalizeFixedExpenseRows(savedState);
      normalizeAgendaRows(savedState);
      normalizeMonthlyPlans(savedState);
      // Linked records are synchronized when their source is edited, never on read.
      if (typeof ZamaFinance !== "undefined") ZamaFinance.normalize(savedState);
      if (typeof ZamaAgenda !== "undefined") ZamaAgenda.normalize(savedState);
      if (typeof ZamaIdeas !== "undefined") ZamaIdeas.normalize(savedState);
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
        []
      ]));

      return prepareState(initialState);
    }

    function createExampleState() {
      const exampleState = Object.fromEntries(Object.entries(modules).map(([key, module]) => [
        key,
        (module.rows || []).map((row) => ({ id: createId(), createdAt: new Date().toISOString(), ...row }))
      ]));

      return prepareState(exampleState);
    }

    async function getCurrentUser() {
      if (!supabaseClient) return null;
      const { data } = await supabaseClient.auth.getSession();
      return data.session?.user || null;
    }

    async function loadCloudState() {
      const user = await getCurrentUser();
      if (!supabaseClient || !user) throw new Error("Sua sessão expirou. Entre novamente.");
      cloudUserId = user.id;
      const { data, error } = await supabaseClient.from(cloudStateTable)
        .select("data,updated_at").eq("user_id", user.id).maybeSingle();
      if (error) throw new Error("Não foi possível carregar seus dados. Verifique a conexão e tente novamente.");
      cloudRevision = data?.updated_at || null;
      return data?.data ? prepareState(data.data) : null;
    }

    async function saveCloudState(candidate = state) {
      const user = await getCurrentUser();
      if (!supabaseClient || !user || user.id !== cloudUserId || !candidate) {
        throw new Error("Sua sessão expirou. Entre novamente para salvar.");
      }
      const payload = { user_id: user.id, data: candidate, updated_at: new Date().toISOString() };
      const query = cloudRevision
        ? supabaseClient.from(cloudStateTable).update(payload).eq("user_id", user.id).eq("updated_at", cloudRevision)
        : supabaseClient.from(cloudStateTable).insert(payload);
      const { data, error } = await query.select("updated_at").maybeSingle();
      if (error || !data) {
        if ((!data && !error) || error?.code === "23505") {
          throw new Error("Os dados foram alterados em outro dispositivo. Atualize a página antes de tentar novamente.");
        }
        throw new Error("Não foi possível salvar na nuvem. Verifique sua conexão e tente novamente.");
      }
      cloudRevision = data.updated_at;
      cloudSnapshot = structuredClone(candidate);
      cacheCloudState(candidate);
      setCloudStatus("Salvo na nuvem", "");
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
            if (cloudWritePending) return;
            if (payload.new?.updated_at && payload.new.updated_at === cloudRevision) return;
            if (document.querySelector("dialog[open]") || formPanelOpen) {
              setCloudStatus("Há alterações em outro dispositivo. Atualize antes de salvar.", "error");
              return;
            }
            if (payload.eventType === "DELETE") {
              state = createInitialState();
            } else if (payload.new?.data) {
              state = prepareState(payload.new.data);
            } else {
              return;
            }

            cloudRevision = payload.new?.updated_at || null;
            cloudSnapshot = structuredClone(state);
            cacheCloudState(state);
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
      const loaded = await loadCloudState();
      const result = loaded || createInitialState();
      cloudSnapshot = structuredClone(result);
      cacheCloudState(result);
      return result;
    }

    async function persist() {
      if (cloudWritePending) return false;
      cloudWritePending = true;
      setCloudStatus("Salvando...", "saving");
      try {
        return await saveCloudState();
      } catch (error) {
        if (cloudSnapshot) state = structuredClone(cloudSnapshot);
        setCloudStatus(error.message, "error");
        showToast("Alteração não salva", error.message, "error");
        return false;
      } finally { cloudWritePending = false; }
    }

    async function ceoCommit(mutator, message = "Alterações salvas") {
      if (cloudWritePending) return false;
      cloudWritePending = true;
      setCloudStatus("Salvando...", "saving");
      const draft = structuredClone(state);
      try {
        await mutator(draft);
        await saveCloudState(draft);
        state = draft;
        render();
        showToast(message, "Salvo na sua conta.");
        return true;
      } catch (error) {
        setCloudStatus(error.message, "error");
        showToast("Alteração não salva", error.message, "error");
        return false;
      } finally { cloudWritePending = false; }
    }

    // Claim delivery in the existing user-owned JSON row. The revision filter makes
    // two devices compete for a single receipt without requiring a new SQL table.
    async function claimCloudReminder(key, now = Date.now()) {
      if (cloudWritePending) return false;
      cloudWritePending = true;
      try {
        const user = await getCurrentUser();
        if (!user || user.id !== cloudUserId) return false;
        const { data: remote, error } = await supabaseClient.from(cloudStateTable)
          .select("data,updated_at").eq("user_id", user.id).maybeSingle();
        if (error || !remote?.data || !remote.updated_at) return false;
        const receipts = { ...(remote.data.reminderReceipts || {}) };
        if (receipts[key]) return false;
        // A completion/edit in another device must cancel the old reminder too.
        const reminder = ZamaAgenda.helpers.remindersBetween(remote.data, now - 60000, now).find(item => item.key === key);
        if (!reminder) return false;
        Object.keys(receipts).forEach(id => { if (now - receipts[id] > 35 * 86400000) delete receipts[id]; });
        receipts[key] = now;
        const payload = { ...remote.data, reminderReceipts: receipts };
        const { data: result, error: writeError } = await supabaseClient.from(cloudStateTable)
          .update({ data: payload, updated_at: new Date().toISOString() })
          .eq("user_id", user.id).eq("updated_at", remote.updated_at).select("updated_at").maybeSingle();
        if (writeError || !result) return false;
        if (cloudRevision === remote.updated_at) {
          cloudRevision = result.updated_at;
          state.reminderReceipts = receipts;
          if (cloudSnapshot) cloudSnapshot.reminderReceipts = structuredClone(receipts);
          cacheCloudState(state);
        }
        return reminder;
      } catch { return false; }
      finally { cloudWritePending = false; }
    }

    function setCloudStatus(text, statusClass = "") {
      const sync = document.getElementById("ceoSync");
      if (sync) { sync.textContent = text; sync.className = `ceo-sync ${statusClass}`; }
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
      if (!['dashboard', 'financeiro', 'investimentos', 'agenda', 'ideias', 'jarvis'].includes(module)) module = 'dashboard';
      activeModule = module;
      if (options.financeView) financeView = options.financeView;
      if (options.agendaView) agendaView = options.agendaView;
      editingId = null;
      formPanelOpen = !shouldCollapseFormByDefault(module);
      searchInput.value = "";
      navButtons.forEach((item) => item.classList.toggle("active", item.dataset.module === module));
      document.querySelector(".nav").classList.remove("expanded");
      document.body.classList.remove("menu-open");
      document.getElementById("ceoMenuBtn")?.setAttribute("aria-expanded", "false");
      closeDetailPanel();
      render();
    }

    function render() {
      if (!state) return;
      if (!['dashboard', 'financeiro', 'investimentos', 'agenda', 'ideias', 'jarvis'].includes(activeModule)) activeModule = 'dashboard';
      if (typeof renderCeoModule === "function" && renderCeoModule()) return;
      // Renderizacao central: sempre que dados/modulo mudam, esta funcao redesenha a tela.
      const module = modules[activeModule];
      moduleTitle.textContent = module.title;
      moduleSubtitle.textContent = module.subtitle;
      const currentModule = getCurrentModuleConfig();
      listTitle.textContent = currentModule.listTitle;
      formTitle.textContent = editingId ? "Editar registro" : currentModule.formTitle;
      const calendarOnlyMode = activeModule === "agenda" && agendaView === "calendario";
      workspace.classList.toggle("dashboard-mode", activeModule === "dashboard");
      workspace.classList.toggle("agenda-calendar-mode", calendarOnlyMode);
      workspace.classList.toggle("form-collapsed", activeModule !== "dashboard" && !formPanelOpen);
      formPanel.style.display = activeModule === "dashboard" || calendarOnlyMode ? "none" : "";
      formPanel.classList.toggle("collapsed", activeModule !== "dashboard" && !formPanelOpen);
      recordForm.hidden = calendarOnlyMode || (activeModule !== "dashboard" && !formPanelOpen);
      formToggleBtn.textContent = getFormToggleLabel();
      formToggleBtn.setAttribute("aria-expanded", String(formPanelOpen));
      quickAddBtn.title = activeModule === "agenda" ? "Nova tarefa" : "Adicionar registro";
      quickAddBtn.setAttribute("aria-label", quickAddBtn.title);
      quickAddBtn.classList.toggle("agenda-context", activeModule === "agenda");
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
      const isFinanceMovements = activeModule === "financeiro" && financeView === "movimentacoes";
      const hasActiveFilters = searchInput.value.trim() || statusFilter !== "Todos" || financeTypeFilter !== "Todos" || (activeModule === "financeiro" && financeMonth !== todayIso().slice(0, 7));
      financeTypeFilterInput.hidden = !isFinanceMovements;
      statusFilterInput.hidden = isDashboard;
      financeMonthFilter.hidden = activeModule !== "financeiro";
      clearFiltersBtn.hidden = isDashboard || !hasActiveFilters;
      viewToggleBtn.hidden = isDashboard;
      viewToggleBtn.textContent = listViewMode === "table" ? "Cards" : "Tabela";
      financeMonthFilter.value = financeMonth;
      financeTypeFilterInput.value = financeTypeFilter;

      if (isDashboard) return;

      const options = getStatusFilterOptions();
      if (!options.includes(statusFilter)) statusFilter = "Todos";
      statusFilterInput.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option)}" ${option === statusFilter ? "selected" : ""}>${escapeHtml(option)}</option>`)
        .join("");

      if (!["Todos", "Entrada", "Saída"].includes(financeTypeFilter)) financeTypeFilter = "Todos";
      financeTypeFilterInput.innerHTML = ["Todos", "Entrada", "Saída"]
        .map((option) => `<option value="${escapeHtml(option)}" ${option === financeTypeFilter ? "selected" : ""}>${escapeHtml(option)}</option>`)
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

        setStat("Saldo em caixa", currency.format(totals.balance), "A receber", currency.format(monthTotals.entradasPendentes), "A pagar", currency.format(monthTotals.saidasPendentes), "Lucro realizado", currency.format(monthTotals.lucro));
        return;
      }

      if (activeModule === "dashboard") {
        const totals = getFinancialTotals();
        const openProjects = state.projetos.filter((row) => !/conclu/i.test(row.status || "")).length;
        setStat("Agenda de hoje", getTodayAgenda().length, "Mensalidades a receber", currency.format(totals.pendingMonthly), "Saldo em caixa", currency.format(totals.balance), "Gastos do mês", currency.format(totals.monthlyExpenses));
        return;
      }

      if (activeModule === "agenda") {
        const rows = state.agenda;
        const pending = rows.filter((row) => /pendente|adiado/i.test(row.status || "")).length;
        const done = rows.filter((row) => /conclu/i.test(row.status || "")).length;
        const today = rows.filter((row) => row.prazo === todayIso()).length;
        const priorities = rows
          .map((row) => Number(row.valor || 0))
          .filter((value) => Number.isFinite(value) && value > 0);
        const averagePriority = priorities.length
          ? (priorities.reduce((sum, value) => sum + value, 0) / priorities.length).toFixed(1)
          : "-";

        setStat("Tarefas na agenda", rows.length, "Pendentes / adiadas", pending, "Concluídas", done, "Hoje / prioridade média", `${today} / ${averagePriority}`);
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
