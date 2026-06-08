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
    let editingId = null;

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
    const workspace = document.getElementById("workspace");
    const formPanel = document.getElementById("formPanel");
    const importBtn = document.getElementById("importBtn");
    const importInput = document.getElementById("importInput");
    const logoutBtn = document.getElementById("logoutBtn");
    const userEmail = document.getElementById("userEmail");
    const cloudStatus = document.getElementById("cloudStatus");

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
      editingId = null;
      render();
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
      });
    });

    document.getElementById("resetBtn").addEventListener("click", async () => {
      if (confirm("Deseja apagar todos os dados e voltar ao exemplo inicial?")) {
        localStorage.removeItem(storageKey);
        state = createInitialState();
        await persist();
        editingId = null;
        render();
      }
    });

    document.getElementById("exportBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dados-admin-simples.json";
      link.click();
      URL.revokeObjectURL(url);
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
      await supabaseClient.auth.signOut();
      state = null;
      showAuth();
    });

    searchInput.addEventListener("input", renderTable);
    recordForm.addEventListener("submit", saveRecord);

    initializeAuth();
