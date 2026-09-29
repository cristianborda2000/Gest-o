const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function setup({ hash = '', search = '', session = null } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false,
      handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
      focus() {}, checkValidity() { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.value); }
    });
    return elements.get(id);
  }
  const calls = [];
  const auth = {
    getSession: async () => ({ data: { session }, error: null }),
    onAuthStateChange(fn) { this.listener = fn; },
    resetPasswordForEmail: async (...args) => { calls.push(['reset', ...args]); return {}; },
    updateUser: async (...args) => { calls.push(['update', ...args]); return {}; },
    signOut: async () => ({})
  };
  const context = {
    URL, URLSearchParams, Intl, Date, console,
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    window: {
      location: { hash, search, origin: 'https://zama.example', pathname: '/', href: `https://zama.example/${search}${hash}` },
      history: { replaceState() {} }, matchMedia: () => ({ matches: false }),
      ZAMA_CONFIG: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public' },
      supabase: { createClient: () => ({ auth }) }
    },
    todayIso: () => '2026-09-29', renderTable() {}, saveRecord() {}, closeDetailPanel() {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('app/assets/js/config.js', 'utf8') + '\n' + fs.readFileSync('app/assets/js/boot.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { element, calls, auth };
}

(async () => {
  const normal = await setup();
  await normal.element('forgotPasswordBtn').handlers.click();
  assert.equal(normal.calls.length, 0);
  normal.element('loginEmail').value = 'person@example.com';
  await normal.element('forgotPasswordBtn').handlers.click();
  assert.equal(normal.calls[0][0], 'reset');
  assert.equal(normal.calls[0][2].redirectTo, 'https://zama.example/?reset=password');
  assert.match(normal.element('authStatus').textContent, /Se este e-mail/);

  const recovery = await setup({ hash: '#type=recovery', session: { user: { id: 'test' } } });
  assert.equal(recovery.element('resetPasswordForm').hidden, false);
  assert.equal(recovery.element('loginForm').hidden, true);
  assert.equal(recovery.element('.app').hidden, true);
  recovery.element('newPassword').value = 'new-test-password';
  recovery.element('confirmPassword').value = 'different-password';
  await recovery.element('resetPasswordForm').handlers.submit({ preventDefault() {} });
  assert.equal(recovery.calls.length, 0);
  recovery.element('confirmPassword').value = 'new-test-password';
  await recovery.element('resetPasswordForm').handlers.submit({ preventDefault() {} });
  assert.equal(recovery.calls[0][0], 'update');
  assert.match(recovery.element('authStatus').textContent, /Senha atualizada/);
  assert.equal(recovery.element('newPassword').value, '');

  for (const options of [{ hash: '#error_code=otp_expired', session: { user: {} } }, { search: '?reset=password' }]) {
    const expired = await setup(options);
    assert.equal(expired.element('resetPasswordForm').hidden, true);
    assert.match(expired.element('authError').textContent, /expirou/);
    assert.equal(expired.calls.length, 0);
  }
  const rejected = await setup();
  rejected.element('loginEmail').value = 'person@example.com';
  rejected.auth.resetPasswordForEmail = async () => ({ error: { status: 429 } });
  await rejected.element('forgotPasswordBtn').handlers.click();
  assert.match(rejected.element('authError').textContent, /Aguarde/);
  assert.equal(rejected.element('forgotPasswordBtn').disabled, false);
  console.log('Auth recovery tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
