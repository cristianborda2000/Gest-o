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
    let financeTypeFilter = "Todos";
    let listViewMode = window.matchMedia("(max-width: 640px)").matches ? "cards" : "table";
    let editingId = null;
    let formPanelOpen = false;
    let cloudChangesChannel = null;

    const appShell = document.querySelector(".app");
    const authScreen = document.getElementById("authScreen");
    const loginForm = document.getElementById("loginForm");
    const loginEmail = document.getElementById("loginEmail");
    const loginPassword = document.getElementById("loginPassword");
    const loginSubmitBtn = document.getElementById("loginSubmitBtn");
    const signupBtn = document.getElementById("signupBtn");
    const authError = document.getElementById("authError");
    const navButtons = document.querySelectorAll("[data-module]");
    const moduleTitle = document.getElementById("moduleTitle");
    const moduleSubtitle = document.getElementById("moduleSubtitle");
    const listTitle = document.getElementById("listTitle");
    const formTitle = document.getElementById("formTitle");
    const tableArea = document.getElementById("tableArea");
    const recordForm = document.getElementById("recordForm");
    const searchInput = document.getElementById("searchInput");
    const financeTypeFilterInput = document.getElementById("financeTypeFilter");
    const statusFilterInput = document.getElementById("statusFilter");
    const financeMonthFilter = document.getElementById("financeMonthFilter");
    const clearFiltersBtn = document.getElementById("clearFiltersBtn");
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
    const loadExamplesBtn = document.getElementById("loadExamplesBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const userEmail = document.getElementById("userEmail");
    const cloudStatus = document.getElementById("cloudStatus");
    const newUserEmail = document.getElementById("newUserEmail");
    const createUserBtn = document.getElementById("createUserBtn");
    const createUserStatus = document.getElementById("createUserStatus");
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsPanel = document.getElementById("settingsPanel");
    const settingsBackdrop = document.getElementById("settingsBackdrop");
    const settingsCloseBtn = document.getElementById("settingsCloseBtn");
    const toastStack = document.getElementById("toastStack");
    const confirmBackdrop = document.getElementById("confirmBackdrop");
    const confirmDialog = document.getElementById("confirmDialog");
    const confirmEyebrow = document.getElementById("confirmEyebrow");
    const confirmTitle = document.getElementById("confirmTitle");
    const confirmMessage = document.getElementById("confirmMessage");
    const confirmInputWrap = document.getElementById("confirmInputWrap");
    const confirmInput = document.getElementById("confirmInput");
    const confirmCancelBtn = document.getElementById("confirmCancelBtn");
    const confirmOkBtn = document.getElementById("confirmOkBtn");
    let confirmResolve = null;

    function showToast(title, message = "", type = "success") {
      if (!toastStack) return;
      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      toast.innerHTML = `
        <strong>${escapeHtml(title)}</strong>
        ${message ? `<span>${escapeHtml(message)}</span>` : ""}
      `;
      toastStack.appendChild(toast);
      window.setTimeout(() => toast.remove(), 4200);
    }

    function closeConfirmDialog(result = false) {
      if (!confirmDialog || !confirmBackdrop) return;
      confirmDialog.hidden = true;
      confirmBackdrop.hidden = true;
      confirmInput.value = "";
      if (confirmResolve) {
        confirmResolve(result);
        confirmResolve = null;
      }
    }

    function requestConfirmation({ eyebrow = "Confirmação", title, message, confirmText = "" }) {
      if (!confirmDialog || !confirmBackdrop) return Promise.resolve(false);
      confirmEyebrow.textContent = eyebrow;
      confirmTitle.textContent = title;
      confirmMessage.textContent = message;
      confirmInputWrap.hidden = !confirmText;
      confirmInput.value = "";
      confirmInput.placeholder = confirmText;
      confirmOkBtn.disabled = Boolean(confirmText);
      confirmDialog.hidden = false;
      confirmBackdrop.hidden = false;
      if (confirmText) confirmInput.focus();

      return new Promise((resolve) => {
        confirmResolve = resolve;
      });
    }

    confirmInput.addEventListener("input", () => {
      confirmOkBtn.disabled = confirmInput.placeholder && confirmInput.value !== confirmInput.placeholder;
    });
    confirmCancelBtn.addEventListener("click", () => closeConfirmDialog(false));
    confirmBackdrop.addEventListener("click", () => closeConfirmDialog(false));
    confirmOkBtn.addEventListener("click", () => closeConfirmDialog(true));

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
      setAuthLoading(false);
    }

    function setAuthLoading(isLoading) {
      loginSubmitBtn.disabled = isLoading;
      signupBtn.disabled = isLoading;
      loginEmail.disabled = isLoading;
      loginPassword.disabled = isLoading;
      loginSubmitBtn.textContent = isLoading ? "Entrando..." : "Entrar";
      signupBtn.textContent = isLoading ? "Aguarde..." : "Criar acesso";
    }

    function validateAccessFields(email, password) {
      if (!email || !password) return "Informe e-mail e senha para criar o acesso.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Informe um e-mail válido.";
      if (password.length < 6) return "Use uma senha com pelo menos 6 caracteres.";
      return "";
    }

    async function createAccessWithEmail(email, password) {
      return supabaseClient.auth.signUp({ email, password });
    }

    function validateEmailOnly(email) {
      if (!email) return "Informe o e-mail para enviar o convite.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Informe um e-mail valido.";
      return "";
    }

    function validateCompanyProfile(profile) {
      if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
        return "Informe um e-mail válido para a empresa.";
      }

      if (profile.documento) {
        const digits = onlyDigits(profile.documento);
        if (![11, 14].includes(digits.length)) {
          return "Informe CPF com 11 dígitos ou CNPJ com 14 dígitos.";
        }
      }

      if (profile.telefone) {
        const digits = onlyDigits(profile.telefone);
        if (digits.length < 10 || digits.length > 11) {
          return "Informe um telefone com DDD.";
        }
      }

      if (profile.logoUrl && !/^https?:\/\//i.test(profile.logoUrl) && !/\.(png|jpe?g|webp|gif|svg)$/i.test(profile.logoUrl)) {
        return "Informe uma URL de imagem ou um arquivo de imagem válido para a logo.";
      }

      return "";
    }

    async function inviteAccessByEmail(email) {
      return supabaseClient.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin + window.location.pathname
        }
      });
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
        showAuth("Não foi possível carregar o Supabase. Verifique sua conexão.");
        return;
      }

      try {
        const { data } = await supabaseClient.auth.getSession();
        if (data.session) {
          await showApp(data.session);
        } else {
          showAuth();
        }
      } catch {
        showAuth("Não foi possível verificar sua sessão. Tente novamente.");
      }
    }

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      authError.textContent = "";
      setAuthLoading(true);

      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email: loginEmail.value.trim(),
          password: loginPassword.value
        });

        if (error) {
          showAuth("E-mail ou senha inválidos.");
          return;
        }

        await showApp(data.session);
      } catch {
        showAuth("Não foi possível entrar agora. Verifique sua conexão.");
      } finally {
        setAuthLoading(false);
      }
    });

    signupBtn.addEventListener("click", async () => {
      const email = loginEmail.value.trim();
      const password = loginPassword.value;

      authError.textContent = "";
      const validationError = validateAccessFields(email, password);
      if (validationError) {
        authError.textContent = validationError;
        return;
      }

      setAuthLoading(true);
      try {
        const { data, error } = await createAccessWithEmail(email, password);

        if (error) {
          showAuth(error.message || "Não foi possível criar este acesso.");
          return;
        }

        if (data.session) {
          await showApp(data.session);
          return;
        }

        showAuth("Acesso criado. Verifique o e-mail para confirmar a conta antes de entrar.");
      } catch {
        showAuth("Não foi possível criar o acesso agora. Verifique sua conexão.");
      } finally {
        setAuthLoading(false);
      }
    });

    createUserBtn.addEventListener("click", async () => {
      const email = newUserEmail.value.trim();
      const validationError = validateEmailOnly(email);

      createUserStatus.classList.remove("error", "success");
      if (validationError) {
        createUserStatus.textContent = validationError;
        createUserStatus.classList.add("error");
        return;
      }

      createUserBtn.disabled = true;
      createUserBtn.textContent = "Enviando...";
      createUserStatus.textContent = "Enviando convite...";

      try {
        const { error } = await inviteAccessByEmail(email);
        if (error) {
          createUserStatus.textContent = error.message || "Nao foi possivel enviar este convite.";
          createUserStatus.classList.add("error");
          return;
        }

        newUserEmail.value = "";
        createUserStatus.textContent = "Convite enviado. O usuario recebera um link de acesso por e-mail.";
        createUserStatus.classList.add("success");
      } catch {
        createUserStatus.textContent = "Nao foi possivel enviar o convite agora. Verifique sua conexao.";
        createUserStatus.classList.add("error");
      } finally {
        createUserBtn.disabled = false;
        createUserBtn.textContent = "Enviar convite";
      }
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
        closeConfirmDialog(false);
      }
    });

    document.getElementById("resetBtn").addEventListener("click", async () => {
      const confirmed = await requestConfirmation({
        eyebrow: "Ação permanente",
        title: "Limpar todos os dados?",
        message: "Esta ação apaga os dados locais e da nuvem desta conta.",
        confirmText: "APAGAR"
      });
      if (!confirmed) return;

      localStorage.removeItem(storageKey);
      await resetCloudState();
      state = createInitialState();
      await persist();
      editingId = null;
      render();
      showToast("Dados apagados", "O sistema voltou ao estado inicial.");
    });

    loadExamplesBtn.addEventListener("click", async () => {
      const confirmed = await requestConfirmation({
        eyebrow: "Substituir dados",
        title: "Carregar dados de exemplo?",
        message: "Isso substitui os dados atuais por exemplos para demonstração.",
        confirmText: "EXEMPLO"
      });
      if (!confirmed) return;

      state = createExampleState();
      await persist();
      editingId = null;
      formPanelOpen = false;
      closeSettings();
      render();
      showToast("Exemplos carregados", "Os dados de demonstração foram aplicados.");
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
      const profile = Object.fromEntries(new FormData(companyForm).entries());
      const validationError = validateCompanyProfile(profile);
      if (validationError) {
        showToast("Revise os dados da empresa", validationError, "error");
        return;
      }

      state.companyProfile = {
        ...state.companyProfile,
        ...profile
      };
      await persist();
      fillCompanyForm();
      render();
      showToast("Dados salvos", "As informações da empresa foram atualizadas.");
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
        importedState.clientes.forEach((client) => syncClientMonthly(client, importedState));
        importedState.mensalidades.forEach((monthly) => syncMonthlyFinance(monthly, importedState));
        state = importedState;
        await persist();
        editingId = null;
        render();
        showToast("Dados importados", "O backup foi carregado com sucesso.");
      } catch (error) {
        showToast("Importação falhou", "Verifique se o arquivo foi exportado pelo sistema ZAMA.", "error");
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
    financeTypeFilterInput.addEventListener("change", () => {
      financeTypeFilter = financeTypeFilterInput.value;
      renderTable();
    });
    statusFilterInput.addEventListener("change", () => {
      statusFilter = statusFilterInput.value;
      renderTable();
    });
    financeMonthFilter.addEventListener("change", () => {
      financeMonth = financeMonthFilter.value || todayIso().slice(0, 7);
      render();
    });
    clearFiltersBtn.addEventListener("click", () => {
      searchInput.value = "";
      statusFilter = "Todos";
      financeTypeFilter = "Todos";
      financeMonth = todayIso().slice(0, 7);
      render();
    });
    recordForm.addEventListener("submit", saveRecord);

    initializeAuth();
