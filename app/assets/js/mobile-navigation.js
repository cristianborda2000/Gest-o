/* Phone shortcuts reuse the same navigation, forms and workspace permissions. */
(function (global) {
  'use strict';
  const phone = global.matchMedia('(max-width: 720px)');
  const paths = {
    dashboard: 'M3 10l9-7 9 7v10H3V10Zm5 10v-7h8v7',
    agenda: 'M5 5h14v16H5V5Zm3-3v6m8-6v6M5 10h14',
    projetos: 'M3 7h7l2-3h9v16H3V7Zm4 5h10m-10 4h6',
    financeiro: 'M5 20V10m7 10V4m7 16v-7',
    ideias: 'M9 18h6m-6 3h6m-7-8a6 6 0 1 1 8 0l-1 3H9l-1-3',
    more: 'M5 6h14M5 12h14M5 18h14',
    plus: 'M12 5v14M5 12h14',
  };
  const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name]}"></path></svg>`;
  const team = () => Boolean(global.ZamaWorkspace?.isTeamSpace?.());
  const ready = () => typeof state !== 'undefined' && Boolean(state) && !document.querySelector('.app')?.hidden;
  const identity = () => `${typeof cloudEpoch === 'undefined' ? '' : cloudEpoch}:${global.ZamaWorkspace?.ownerId?.() || ''}`;
  const canCreate = kind => ready() && (kind === 'agenda' || kind === 'financeiro' && !team() || kind === 'ideias' && (!team() || global.ZamaWorkspace.role() !== 'viewer'));
  let controls = null, sheet = null, pendingIdea = null, lastIdentity = '';

  function stopPendingIdea() {
    pendingIdea?.disconnect();
    pendingIdea = null;
  }

  function closeSheet(restoreFocus = true) {
    if (!sheet) return;
    const previous = sheet;
    sheet = null;
    previous.close();
    previous.remove();
    const launcher = controls?.querySelector('[data-mobile-create]');
    launcher?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && ready() && phone.matches && !document.querySelector('dialog[open]')) launcher?.focus({ preventScroll: true });
  }

  function reset() {
    stopPendingIdea();
    closeSheet(false);
    if (controls) controls.hidden = true;
    lastIdentity = '';
    document.body.classList.remove('has-mobile-navigation');
  }

  function openIdeaWhenReady() {
    const ticket = identity();
    const container = document.getElementById('ceoWorkspace');
    const attempt = () => {
      if (!ready() || ticket !== identity() || activeModule !== 'ideias' || !canCreate('ideias') || document.body.classList.contains('menu-open') || document.querySelector('dialog[open], #settingsPanel:not([hidden])')) {
        stopPendingIdea();
        return;
      }
      const button = container.querySelector('[data-idea-new]:not(:disabled)');
      if (button) {
        stopPendingIdea();
        button.click();
      } else if (container.querySelector('[role="alert"]')) stopPendingIdea();
    };
    stopPendingIdea();
    pendingIdea = new MutationObserver(attempt);
    pendingIdea.observe(container, { childList: true, subtree: true });
    attempt();
  }

  function create(kind) {
    if (!canCreate(kind)) { closeSheet(); return; }
    closeSheet(false);
    goToModule(kind, kind === 'financeiro' ? { financeView: 'movimentacoes' } : {});
    if (!canCreate(kind)) return;
    if (kind === 'agenda') ZamaAgenda.openTask({ date: ZamaTime.today() });
    if (kind === 'financeiro') ZamaFinance.openMovement();
    if (kind === 'ideias') openIdeaWhenReady();
  }

  function openSheet() {
    if (!ready() || !phone.matches || document.querySelector('dialog[open]')) return;
    stopPendingIdea();
    const choices = [
      ['agenda', 'Nova tarefa', 'Um compromisso na sua agenda'],
      ['financeiro', 'Nova movimentação', 'Uma entrada ou saída'],
      ['ideias', 'Nova ideia', team() ? 'Uma ideia para a equipe' : 'Guarde sua próxima ideia'],
    ].filter(([kind]) => canCreate(kind));
    sheet = document.createElement('dialog');
    sheet.id = 'mobileCreateDialog';
    sheet.className = 'mobile-create-dialog';
    sheet.setAttribute('aria-labelledby', 'mobileCreateTitle');
    sheet.innerHTML = `<header><div><span class="mobile-create-eyebrow">CADASTRO RÁPIDO</span><h2 id="mobileCreateTitle">O que vamos adicionar?</h2></div><button type="button" class="mobile-create-close" aria-label="Fechar cadastro rápido">×</button></header><div class="mobile-create-options">${choices.map(([kind, title, description]) => `<button type="button" data-mobile-new="${kind}">${icon(kind)}<span><strong>${title}</strong><small>${description}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.mobile-create-close').onclick = () => closeSheet();
    sheet.querySelectorAll('[data-mobile-new]').forEach(button => button.onclick = () => create(button.dataset.mobileNew));
    sheet.addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
    sheet.addEventListener('click', event => {
      if (event.target !== sheet) return;
      const bounds = sheet.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSheet();
    });
    controls.querySelector('[data-mobile-create]').setAttribute('aria-expanded', 'true');
    sheet.showModal();
    sheet.querySelector('[data-mobile-new]')?.focus();
  }

  function render() {
    if (!ready()) { reset(); return; }
    const currentIdentity = identity();
    if (lastIdentity && lastIdentity !== currentIdentity) reset();
    lastIdentity = currentIdentity;
    if (typeof activeModule !== 'undefined' && activeModule !== 'ideias') stopPendingIdea();
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'mobileNavigation';
      controls.className = 'mobile-navigation';
      document.querySelector('.app').appendChild(controls);
    }
    const destinations = team()
      ? [['agenda', 'Agenda'], ['projetos', 'Projetos'], ['ideias', 'Ideias']]
      : [['dashboard', 'Início'], ['agenda', 'Agenda'], ['projetos', 'Projetos'], ['financeiro', 'Finanças']];
    const signature = JSON.stringify(destinations);
    if (controls.dataset.destinations !== signature) {
      controls.dataset.destinations = signature;
      const addButton = `<button type="button" class="mobile-create-launcher" data-mobile-create aria-label="Adicionar registro" aria-haspopup="dialog" aria-expanded="false" aria-controls="mobileCreateDialog"><span class="mobile-create-icon">${icon('plus')}</span><span>Novo</span></button>`;
      controls.innerHTML = `<nav class="mobile-tabbar" aria-label="Navegação rápida">${destinations.map(([kind, title], index) => `${index === 2 ? addButton : ''}<button type="button" data-mobile-go="${kind}">${icon(kind)}<span>${title}</span></button>`).join('')}<button type="button" data-mobile-more aria-label="Mais opções" aria-controls="ceoSidebar">${icon('more')}<span>Mais</span></button></nav>`;
      controls.querySelector('[data-mobile-create]').onclick = openSheet;
      controls.querySelectorAll('[data-mobile-go]').forEach(button => button.onclick = () => {
        stopPendingIdea();
        goToModule(button.dataset.mobileGo, { financeView: 'movimentacoes' });
      });
      controls.querySelector('[data-mobile-more]').onclick = () => { stopPendingIdea(); setCeoMenu(true); };
    }
    const moreActive = !destinations.some(([kind]) => kind === activeModule);
    controls.querySelectorAll('[data-mobile-go], [data-mobile-more]').forEach(button => {
      const selected = button.hasAttribute('data-mobile-more') ? moreActive : button.dataset.mobileGo === activeModule;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    controls.hidden = false;
    document.body.classList.add('has-mobile-navigation');
  }

  phone.addEventListener('change', () => { closeSheet(false); stopPendingIdea(); render(); });
  global.ZamaMobileNavigation = { render, reset };
})(window);
