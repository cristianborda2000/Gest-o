(function () {
  'use strict';

  let deferredPrompt = null;
  let prompting = false;
  let requested = false;
  let installed = false;
  let section;
  let dialog;
  let returnFocus;
  const displayMode = window.matchMedia('(display-mode: standalone)');

  function isInstalled() {
    return installed || displayMode.matches || navigator.standalone === true;
  }

  function platform() {
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    return /Android/i.test(navigator.userAgent) ? 'android' : 'desktop';
  }

  function update(message) {
    if (!section) return;
    const done = isInstalled();
    const button = section.querySelector('button');
    button.hidden = done;
    button.disabled = prompting || requested;
    button.textContent = prompting ? 'Aguardando o navegador…' : requested ? 'Instalação solicitada' : 'Instalar ZAMA';
    section.querySelector('[data-pwa-status]').textContent = message || (done
      ? 'ZAMA já está aberta ou instalada como aplicativo neste navegador.'
      : requested ? 'Instalação solicitada. Aguarde o navegador e procure o ícone ZAMA nos seus aplicativos.'
        : 'Abra a ZAMA pela tela inicial do celular, com acesso direto ao JARVIS.');
  }

  function closeHelp() {
    if (dialog?.open) dialog.close();
  }

  function showHelp() {
    if (isInstalled()) { update(); return; }
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'pwa-install-dialog';
      dialog.setAttribute('aria-labelledby', 'pwaInstallTitle');
      dialog.innerHTML = '<div class="pwa-install-head"><h2 id="pwaInstallTitle">Instalar ZAMA</h2><button type="button" class="pwa-install-close" aria-label="Fechar instruções de instalação">×</button></div><div data-pwa-guide></div><p class="pwa-install-note">Depois, abra o ícone ZAMA e entre com sua conta. O JARVIS e a sincronização dos dados precisam de internet.</p><button type="button" class="pwa-install-button" data-pwa-done>Entendi</button>';
      document.body.append(dialog);
      dialog.querySelector('.pwa-install-close').addEventListener('click', closeHelp);
      dialog.querySelector('[data-pwa-done]').addEventListener('click', closeHelp);
      // Keep Escape scoped to this dialog instead of also closing account settings.
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeHelp();
      });
      dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); });
    }
    const ios = '<p>No iPhone ou iPad:</p><ol><li>Abra <strong>www.zam4.com</strong> no <strong>Safari</strong>.</li><li>Toque em <strong>Compartilhar</strong> (quadrado com uma seta para cima).</li><li>Escolha <strong>Adicionar à Tela de Início</strong>.</li><li>Se aparecer, ative <strong>Abrir como App da Web</strong> e toque em <strong>Adicionar</strong>.</li></ol>';
    const android = '<p>No Android:</p><ol><li>Abra <strong>www.zam4.com</strong> no <strong>Chrome</strong>.</li><li>Toque no menu de <strong>três pontos ⋮</strong>.</li><li>Escolha <strong>Adicionar à tela inicial</strong> ou <strong>Instalar aplicativo</strong>.</li><li>Confirme a instalação.</li></ol>';
    const desktop = '<p>No computador, procure <strong>Instalar ZAMA</strong> na barra de endereço ou no menu do Chrome ou Edge.</p><details><summary>Instalar no celular</summary>' + ios + android + '</details>';
    dialog.querySelector('[data-pwa-guide]').innerHTML = platform() === 'ios' ? ios : platform() === 'android' ? android : desktop;
    returnFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
  }

  async function openInstall() {
    if (isInstalled() || prompting || requested) { update(); return; }
    if (!deferredPrompt) { showHelp(); return; }
    // A native install dialog is only invoked by the user's install button.
    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompting = true;
    update();
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      requested = choice?.outcome === 'accepted';
      update(requested ? undefined : 'Instalação cancelada. Você pode instalar depois pelo menu do navegador.');
    } catch (_) {
      update('O navegador não abriu a instalação. Veja como adicionar a ZAMA à tela inicial.');
      showHelp();
    } finally {
      prompting = false;
      update(section?.querySelector('[data-pwa-status]').textContent);
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    if (!isInstalled()) deferredPrompt = event;
    update();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    requested = false;
    closeHelp();
    update('ZAMA instalada. Abra o aplicativo pelo ícone na tela inicial.');
  });
  displayMode.addEventListener?.('change', () => { if (isInstalled()) closeHelp(); update(); });

  function mount() {
    const container = document.querySelector('#settingsPanel .settings-content');
    if (!container || document.getElementById('pwaInstallSection')) return;
    section = document.createElement('section');
    section.id = 'pwaInstallSection';
    section.className = 'settings-section pwa-install-section';
    section.innerHTML = '<span class="settings-label">ZAMA no seu celular</span><p data-pwa-status role="status" aria-live="polite"></p><button type="button" id="pwaInstallBtn" class="pwa-install-button">Instalar ZAMA</button>';
    section.querySelector('button').addEventListener('click', openInstall);
    container.prepend(section);
    update();
  }

  window.ZamaPwa = Object.freeze({ openInstall });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
