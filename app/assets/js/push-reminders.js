/* Server-scheduled Web Push is opt-in per browser and personal account. */
(function (global) {
  'use strict';
  let generation = 0, userId = '', config = null, subscription = null, registered = false, busy = false, failure = '', observer;
  let registrationRef = null, pendingCleanup = Promise.resolve(), activeOperation = null;
  const regions = new Set();
  const ownWorkspace = () => typeof cloudOwnerId === 'undefined' || !cloudOwnerId || cloudOwnerId === userId;
  const supported = () => Boolean(global.isSecureContext && global.navigator?.serviceWorker && global.PushManager && global.Notification);
  const workerUrl = () => new URL('notification-worker.js', global.location.href);
  async function session() {
    if (typeof supabaseClient === 'undefined') return null;
    const { data } = await supabaseClient.auth.getSession(); return data?.session || null;
  }
  async function hash(value) {
    const bytes = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function api(path, method = 'GET', body, currentSession, expectedUser = userId) {
    const headers = {};
    if (path !== 'config') {
      const auth = currentSession || await session();
      if (!auth?.access_token || auth.user.id !== expectedUser) throw new Error('Sua sessão mudou. Entre novamente.');
      headers.Authorization = `Bearer ${auth.access_token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController(), timeout = global.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await global.fetch(`/api/reminders?path=${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store' });
      let result; try { result = await response.json(); } catch { throw new Error('Serviço de lembretes ainda não disponível.'); }
      if (!response.ok) throw new Error(result.error || 'Não foi possível configurar os lembretes.');
      return result;
    } finally { global.clearTimeout(timeout); }
  }
  function describe() {
    if (failure) return failure;
    if (!userId) return 'Entre na sua conta para configurar este dispositivo.';
    if (!ownWorkspace()) return 'O envio com o aplicativo fechado está disponível na sua agenda pessoal. A agenda compartilhada mantém os avisos com o aplicativo aberto.';
    if (!supported()) return 'Este navegador não oferece notificações em segundo plano. No iPhone ou iPad, instale o aplicativo na Tela de Início e abra por lá.';
    if (!config) return 'Verificando disponibilidade dos lembretes…';
    if (!config.enabled) return config.reason;
    if (global.Notification.permission === 'denied') return 'Notificações bloqueadas. Libere a permissão nas configurações deste site no navegador.';
    if (registered) return 'Ativado neste navegador. O servidor usa os horários da sua agenda pessoal em São Paulo. Mantenha os lembretes da agenda ativados; a entrega depende da conexão e das permissões do dispositivo.';
    return 'Receba avisos mesmo com a página fechada. A ativação requer sua permissão e usa as preferências da agenda pessoal. Cada lembrete chega ao último dispositivo ativado ou ao aplicativo aberto.';
  }
  function paint() {
    for (const region of regions) {
      if (!region.isConnected) { regions.delete(region); continue; }
      region.querySelector('[data-push-status]').textContent = describe();
      const activate = region.querySelector('[data-push-enable]');
      activate.hidden = registered;
      activate.disabled = busy || !userId || !ownWorkspace() || !supported() || !config?.enabled || global.Notification.permission === 'denied';
      activate.textContent = busy ? 'Aguarde…' : 'Ativar neste dispositivo';
      const deactivate = region.querySelector('[data-push-disable]');
      deactivate.hidden = !subscription; deactivate.disabled = busy;
      const badge = region.querySelector('[data-push-badge]');
      badge.textContent = registered ? 'Ativado' : config?.enabled ? 'Não ativado' : 'Aguardando configuração';
    }
  }
  function mount(container) {
    if (!container || container.querySelector('[data-push-region]')) return;
    const region = global.document.createElement('section');
    region.dataset.pushRegion = ''; region.className = 'settings-section zama-push-reminders';
    region.innerHTML = '<div class="ceo-toolbar"><strong>Lembretes com o app fechado</strong><span class="ceo-badge" data-push-badge></span></div><p class="settings-note za-help" role="status" aria-live="polite" data-push-status></p><div class="ceo-toolbar"><button class="ceo-button primary" type="button" data-push-enable>Ativar neste dispositivo</button><button class="ceo-button" type="button" data-push-disable hidden>Desativar neste dispositivo</button></div>';
    region.querySelector('[data-push-enable]').onclick = enable;
    region.querySelector('[data-push-disable]').onclick = async () => {
      busy = true; failure = ''; paint();
      try { await disconnect({ keepUser: true }); } catch { failure = 'Não foi possível concluir a desativação. Tente novamente.'; }
      finally { busy = false; paint(); }
    };
    container.appendChild(region); regions.add(region); paint();
  }
  function mountVisible() {
    global.document.querySelectorAll('[data-zama-push], .za-reminders, #settingsPanel .settings-content').forEach(mount);
  }
  async function workerSession(registration, accountId) {
    const worker = registration?.active || registration?.waiting;
    if (!worker) return;
    await new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = global.setTimeout(resolve, 2000);
      channel.port1.onmessage = () => { global.clearTimeout(timeout); channel.port1.close(); resolve(); };
      worker.postMessage({ type: 'zama-push-account', userId: accountId || '' }, [channel.port2]);
    });
  }
  async function existingRegistration() {
    if (!global.navigator?.serviceWorker) return null;
    const registration = await global.navigator.serviceWorker.getRegistration(new URL('./', workerUrl()).href);
    if (registration) registrationRef = registration;
    return registration;
  }
  async function activatedRegistration(registration) {
    const installing = registration.installing || registration.waiting;
    if (installing && installing.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const timeout = global.setTimeout(() => reject(new Error('Não foi possível preparar as notificações. Tente novamente.')), 10000);
        const changed = () => {
          if (installing.state === 'activated') { global.clearTimeout(timeout); installing.removeEventListener('statechange', changed); resolve(); }
          if (installing.state === 'redundant') { global.clearTimeout(timeout); installing.removeEventListener('statechange', changed); reject(new Error('Atualize a página e tente novamente.')); }
        };
        installing.addEventListener('statechange', changed); changed();
      });
    }
    registrationRef = registration;
    return registration;
  }
  async function init() {
    const epoch = ++generation; failure = ''; registered = false;
    // A previous account may still be revoking its browser subscription. Do not
    // start another account until those side effects are fully finished.
    await pendingCleanup.catch(() => {});
    // init also invalidates an activation waiting for permission or network.
    // Let that operation finish cleanup before reading its subscription state.
    await activeOperation?.catch(() => {});
    if (epoch !== generation) return;
    busy = false;
    const auth = await session();
    if (epoch !== generation) return;
    userId = auth?.user?.id || ''; mountVisible();
    if (!observer && global.MutationObserver) {
      observer = new global.MutationObserver(mountVisible);
      observer.observe(global.document.body, { childList: true, subtree: true });
    }
    try {
      config = await api('config');
      if (epoch !== generation) return;
      const registration = await existingRegistration();
      const existing = await registration?.pushManager?.getSubscription();
      if (epoch !== generation) return;
      subscription = existing || null;
      if (subscription && userId && ownWorkspace()) {
        const result = await api(`subscription&hash=${await hash(subscription.endpoint)}`);
        if (epoch !== generation) return;
        registered = Boolean(result.enabled && result.registered && global.Notification?.permission === 'granted');
      }
      await workerSession(registration, registered ? userId : '');
    } catch { if (epoch === generation) failure = 'Serviço de lembretes com o app fechado indisponível. Os avisos do aplicativo aberto continuam disponíveis.'; }
    finally { if (epoch === generation) paint(); }
  }
  function applicationKey(value) {
    const decoded = global.atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(decoded, letter => letter.charCodeAt(0));
  }
  function enable() {
    if (activeOperation) return activeOperation;
    const operation = performEnable(); activeOperation = operation;
    operation.finally(() => { if (activeOperation === operation) activeOperation = null; });
    return operation;
  }
  async function performEnable() {
    if (busy || !supported() || !config?.enabled || !ownWorkspace() || !userId) return;
    const epoch = generation, earlierCleanup = pendingCleanup;
    busy = true; failure = ''; paint();
    let created = null, registration;
    try {
      // Permission is requested directly inside the click, before network work.
      const permission = await global.Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Permissão não concedida. Você pode ativar novamente quando desejar.');
      if (epoch !== generation) return;
      await earlierCleanup.catch(() => {});
      if (epoch !== generation) return;
      registration = await activatedRegistration(await global.navigator.serviceWorker.register(workerUrl()));
      if (epoch !== generation) return;
      const old = await registration.pushManager.getSubscription();
      if (old) {
        // Also renew subscriptions after VAPID rotation or an account change.
        await workerSession(registration, '');
        await api('subscription', 'DELETE', { hash: await hash(old.endpoint) });
        await old.unsubscribe();
      }
      if (epoch !== generation) return;
      created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(config.publicKey) });
      if (epoch !== generation) { await created.unsubscribe(); return; }
      await api('subscription', 'POST', { keyId: config.keyId, subscription: created.toJSON() });
      if (epoch !== generation) { await created.unsubscribe(); return; }
      subscription = created; registered = true;
      await workerSession(registration, userId);
    } catch (error) {
      if (created) { try { await created.unsubscribe(); } catch {} }
      if (epoch === generation) { registered = false; subscription = null; failure = error.message || 'Não foi possível ativar. Tente novamente.'; }
    } finally { if (epoch === generation) { busy = false; paint(); } }
  }
  function invalidate({ keepUser = false, revokeServer = false } = {}) {
    const previousUser = userId, previousSubscription = subscription;
    const previousCleanup = pendingCleanup, operation = activeOperation;
    const previousSession = revokeServer ? session().catch(() => null) : Promise.resolve(null);
    ++generation; registered = false; subscription = null; busy = false; failure = '';
    if (!keepUser) userId = '';
    // postMessage executes before this function returns when the worker is known.
    // It immediately invalidates the worker marker without waiting for network.
    const immediateClear = workerSession(registrationRef, '').catch(() => {});
    paint();
    pendingCleanup = (async () => {
      await immediateClear;
      await previousCleanup.catch(() => {});
      await operation?.catch(() => {});
      const registration = registrationRef || await existingRegistration();
      await workerSession(registration, '');
      const current = previousSubscription || await registration?.pushManager?.getSubscription();
      if (current) {
        // Capture and revoke the OLD subscription; init waits for this queue, so
        // an old logout can never unsubscribe a newly activated account.
        // A browser/provider outage must not skip server revocation or keep the
        // user signed in. The worker marker has already been cleared above.
        try { await current.unsubscribe(); } catch {}
        const auth = await previousSession;
        if (revokeServer && auth?.user?.id === previousUser) {
          try { await api('subscription', 'DELETE', { hash: await hash(current.endpoint) }, auth, previousUser); } catch {}
        }
      }
      if (registration?.getNotifications) {
        const notifications = await registration.getNotifications(); notifications.forEach(notification => notification.close());
      }
    })();
    // External auth events may deliberately call reset synchronously without await.
    pendingCleanup.catch(() => {});
    return pendingCleanup;
  }
  function reset() { return invalidate(); }
  function disconnect({ keepUser = false } = {}) { return invalidate({ keepUser, revokeServer: true }); }
  global.ZamaPushReminders = { init, mount, disconnect, reset };
})(window);
