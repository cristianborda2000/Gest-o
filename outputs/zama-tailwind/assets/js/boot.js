/*
  boot.js
  Inicializa o sistema depois que todos os outros arquivos JS foram carregados.
  Captura elementos da tela, liga eventos dos botoes e chama render() pela primeira vez.
*/

    let state = null;
    let activeModule = "dashboard";
    let financeView = "movimentacoes";
    let agendaView = "lista";
    let calendarMonth = todayIso().slice(0, 7);
    let selectedCalendarDate = todayIso();
    let financeMonth = todayIso().slice(0, 7);
    let statusFilter = "Todos";
    let listViewMode = window.matchMedia("(max-width: 640px)").matches ? "cards" : "table";
    let editingId = null;
    let formPanelOpen = false;
    let cloudChangesChannel = null;

    const appShell = document.querySelector(".app");
    const authScreen = document.getElementById("authScreen");
    const loginForm = document.getElementById("loginForm");
    const loginEmail = document.getElementById("loginEmail");
    const loginPassword = document.getElementById("loginPassword");
    const authError = document.getElementById("authError");
    const navButtons = document.querySelectorAll("[data-module]");
    const moduleTitle = document.getElementById("moduleTitle");
    const moduleSubtitle = document.getElementById("moduleSubtitle");
    const listTitle = document.getElementById("listTitle");
    const formTitle = document.getElementById("formTitle");
    const tableArea = document.getElementById("tableArea");
    const recordForm = document.getElementById("recordForm");
    const searchInput = document.getElementById("searchInput");
    const statusFilterInput = document.getElementById("statusFilter");
    const financeMonthFilter = document.getElementById("financeMonthFilter");
    const viewToggleBtn = document.getElementById("viewToggleBtn");
    const workspace = document.getElementById("workspace");
    const formPanel = document.getElementById("formPanel");
    const formToggleBtn = document.getElementById("formToggleBtn");
    const quickAddBtn = document.getElementById("quickAddBtn");
    const mobileMoreBtn = document.getElementById("mobileMoreBtn");
    const detailBackdrop = document.getElementById("detailBackdrop");
    const detailPanel = document.getElementById("detailPanel");
    const detailCloseBtn = document.getElementById("detailCloseBtn");
    const detailEyebrow = document.getElementById("detailEyebrow");
    const detailTitle = document.getElementById("detailTitle");
    const detailContent = document.getElementById("detailContent");
    const onboardingBackdrop = document.getElementById("onboardingBackdrop");
    const onboardingPanel = document.getElementById("onboardingPanel");
    const onboardingForm = document.getElementById("onboardingForm");
    const skipOnboardingBtn = document.getElementById("skipOnboardingBtn");
    const companyForm = document.getElementById("companyForm");
    const monthlyBackupBtn = document.getElementById("monthlyBackupBtn");
    const importBtn = document.getElementById("importBtn");
    const importInput = document.getElementById("importInput");
    const logoutBtn = document.getElementById("logoutBtn");
    const userEmail = document.getElementById("userEmail");
    const cloudStatus = document.getElementById("cloudStatus");
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsPanel = document.getElementById("settingsPanel");
    const settingsBackdrop = document.getElementById("settingsBackdrop");
    const settingsCloseBtn = document.getElementById("settingsCloseBtn");

    function openSettings() {
      fillCompanyForm();
      settingsPanel.hidden = false;
      settingsBackdrop.hidden = false;
    }

    function closeSettings() {
      settingsPanel.hidden = true;
      settingsBackdrop.hidden = true;
    }

    function showAuth(message = "") {
      authError.textContent = message;
      authScreen.hidden = false;
      appShell.hidden = true;
      loginPassword.value = "";
    }

    async function showApp(session) {
      authScreen.hidden = true;
      appShell.hidden = false;
      userEmail.textContent = session?.user?.email || "";
      state = await loadState();
      await subscribeToCloudChanges(session?.user);
      editingId = null;
      fillCompanyForm();
      render();
      maybeShowOnboarding();
    }

    async function initializeAuth() {
      if (!supabaseClient) {
        showAuth("Nao foi possivel carregar o Supabase. Verifique sua conexao.");
        return;
      }

      const { data } = await supabaseClient.auth.getSession();
      if (data.session) {
        await showApp(data.session);
      } else {
        showAuth();
      }
    }

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      authError.textContent = "";

      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: loginEmail.value.trim(),
        password: loginPassword.value
      });

      if (error) {
        showAuth("E-mail ou senha invalidos.");
        return;
      }

      await showApp(data.session);
    });

    navButtons.forEach((button) => {
      button.addEventListener("click", () => {
        goToModule(button.dataset.module);
        if (window.matchMedia("(max-width: 640px)").matches) {
          document.querySelector(".nav").classList.remove("expanded");
        }
      });
    });

    settingsBtn.addEventListener("click", openSettings);
    settingsCloseBtn.addEventListener("click", closeSettings);
    settingsBackdrop.addEventListener("click", closeSettings);
    formToggleBtn.addEventListener("click", () => {
      formPanelOpen = !formPanelOpen;
      if (!formPanelOpen) editingId = null;
      render();
    });
    quickAddBtn.addEventListener("click", () => {
      if (activeModule === "dashboard") {
        activeModule = "agenda";
        agendaView = "lista";
        navButtons.forEach((item) => item.classList.toggle("active", item.dataset.module === "agenda"));
      }
      if (activeModule === "agenda" && agendaView === "calendario") {
        agendaView = "lista";
      }

      editingId = null;
      formPanelOpen = true;
      render();
      formPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    mobileMoreBtn.addEventListener("click", () => {
      document.querySelector(".nav").classList.toggle("expanded");
    });
    viewToggleBtn.addEventListener("click", () => {
      listViewMode = listViewMode === "table" ? "cards" : "table";
      renderTable();
      renderListControls();
    });
    detailCloseBtn.addEventListener("click", closeDetailPanel);
    detailBackdrop.addEventListener("click", closeDetailPanel);
    onboardingForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      state.companyProfile = {
        ...state.companyProfile,
        ...Object.fromEntries(new FormData(onboardingForm).entries())
      };
      state.setupDone = true;
      await persist();
      fillCompanyForm();
      hideOnboarding();
      render();
    });
    skipOnboardingBtn.addEventListener("click", async () => {
      state.setupDone = true;
      await persist();
      hideOnboarding();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSettings();
        closeDetailPanel();
      }
    });

    document.getElementById("resetBtn").addEventListener("click", async () => {
      if (confirm("Deseja apagar todos os dados e voltar ao exemplo inicial?")) {
        localStorage.removeItem(storageKey);
        await resetCloudState();
        state = createInitialState();
        await persist();
        editingId = null;
        render();
      }
    });

    document.getElementById("exportBtn").addEventListener("click", () => {
      downloadStateBackup("dados-zama-completo.json", state);
    });

    monthlyBackupBtn.addEventListener("click", () => {
      const monthKey = financeMonth || todayIso().slice(0, 7);
      const backup = {
        geradoEm: new Date().toISOString(),
        mes: monthKey,
        empresa: state.companyProfile,
        financeiro: state.financeiro.filter((row) => rowMatchesMonth(row, monthKey)),
        gastosFixos: getActiveFixedExpenses(),
        mensalidades: state.mensalidades.filter((row) => rowMatchesMonth(row, monthKey)),
        totais: getFinancialTotalsForMonth(monthKey)
      };
      downloadStateBackup(`backup-zama-${monthKey}.json`, backup);
    });

    function downloadStateBackup(filename, data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }

    companyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      state.companyProfile = {
        ...state.companyProfile,
        ...Object.fromEntries(new FormData(companyForm).entries())
      };
      await persist();
      fillCompanyForm();
      render();
      alert("Dados da empresa salvos.");
    });

    importBtn.addEventListener("click", () => {
      importInput.click();
    });

    importInput.addEventListener("change", async () => {
      const file = importInput.files[0];
      if (!file) return;

      try {
        const importedState = JSON.parse(await file.text());
        Object.keys(modules).forEach((key) => {
          if (!Array.isArray(importedState[key])) importedState[key] = [];
        });
        normalizeUtilityState(importedState);
        normalizeFinanceRows(importedState);
        normalizeFixedExpenseRows(importedState);
        normalizeAgendaRows(importedState);
        normalizeMonthlyPlans(importedState);
        importedState.projetos.forEach((project) => syncProjectFinance(project, importedState));
        importedState.clientes.forEach((client) => syncClientMonthly(client, importedState));
        importedState.mensalidades.forEach((monthly) => syncMonthlyFinance(monthly, importedState));
        state = importedState;
        await persist();
        editingId = null;
        render();
        alert("Dados importados com sucesso.");
      } catch (error) {
        alert("Nao foi possivel importar este arquivo. Verifique se ele foi exportado pelo sistema ZAMA.");
      } finally {
        importInput.value = "";
      }
    });

    logoutBtn.addEventListener("click", async () => {
      await unsubscribeFromCloudChanges();
      await supabaseClient.auth.signOut();
      state = null;
      closeSettings();
      showAuth();
    });

    searchInput.addEventListener("input", renderTable);
    statusFilterInput.addEventListener("change", () => {
      statusFilter = statusFilterInput.value;
      renderTable();
    });
    financeMonthFilter.addEventListener("change", () => {
      financeMonth = financeMonthFilter.value || todayIso().slice(0, 7);
      render();
    });
    recordForm.addEventListener("submit", saveRecord);

    initializeAuth();
