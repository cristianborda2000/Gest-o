const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  statuses, processStatuses, metadata, productionLists, progress,
  safeUrl, storedPhone, normalizePhone, phoneLabel, friendly
} = require('../app/assets/js/project-data');

test('project metadata excludes secret and unknown fields at every level', () => {
  const source = {
    id: 'project-1', title: 'Projeto interno', client_email: 'cliente@example.com',
    has_password: true, password: 'secret-marker', password_cipher: 'encrypted-marker',
    owner_id: 'owner-private', revision: '4', status: 'in_progress',
    production_lists: [{
      id: 'list-1', title: 'Revisão', password: 'secret-marker',
      description: 'Conferir os arquivos.', responsible_name: 'Equipe', due_date: null,
      status: 'waiting', links: [{ label: 'Briefing', url: 'https://example.com/briefing', token: 'secret-marker' }],
      steps: [{ id: 'step-1', label: 'Conferir', done: true, due_date: '2026-10-20', password: 'secret-marker' }]
    }]
  };
  const result = metadata(source);

  assert.equal(result.client_email, source.client_email);
  assert.equal(result.has_password, true);
  assert.equal(result.revision, 4);
  assert.equal(result.status, 'in_progress');
  assert.deepEqual(result.production_lists, [{
    id: 'list-1', title: 'Revisão', description: 'Conferir os arquivos.',
    responsible_name: 'Equipe', due_date: null, status: 'waiting',
    links: [{ label: 'Briefing', url: 'https://example.com/briefing' }],
    steps: [{ id: 'step-1', label: 'Conferir', done: true, due_date: '2026-10-20' }]
  }]);
  assert.equal(JSON.stringify(result).includes('secret-marker'), false);
  assert.equal(Object.hasOwn(result, 'password_cipher'), false);
  assert.equal(Object.hasOwn(result, 'owner_id'), false);

  result.production_lists[0].steps[0].done = false;
  result.production_lists[0].links[0].label = 'Alterado';
  assert.equal(source.production_lists[0].steps[0].done, true);
  assert.equal(source.production_lists[0].links[0].label, 'Briefing');
});

test('legacy lists keep their IDs and omit unavailable process fields', () => {
  const result = productionLists({
    catalog_steps: [{ id: 1, label: 'Catálogo', done: 'true' }],
    onboarding_steps: [{ id: 'step-2', label: 'Acesso', done: true }]
  });
  assert.deepEqual(result, [
    { id: 'catalog', title: 'Catálogo', steps: [{ id: '1', label: 'Catálogo', done: false }] },
    { id: 'onboarding', title: 'Estruturação', steps: [{ id: 'step-2', label: 'Acesso', done: true }] }
  ]);
  assert.deepEqual(productionLists({ production_lists: [], catalog_steps: [{ id: 'old' }] }), []);
  assert.deepEqual(productionLists({}), []);
});

test('metadata rejects invalid responses and defaults only unknown project statuses', () => {
  for (const input of [null, undefined, 'project', {}, []]) {
    assert.throws(() => metadata(input), /PROJECT_INVALID_RESPONSE/);
  }
  for (const status of Object.keys(statuses)) {
    assert.equal(metadata({ id: 'project-1', status }).status, status);
  }
  for (const status of ['', 'unknown', '__proto__', 'constructor', 'toString']) {
    assert.equal(metadata({ id: 'project-1', status }).status, 'planning');
  }
  assert.equal(Object.isFrozen(statuses), true);
  assert.equal(Object.isFrozen(processStatuses), true);
});

test('progress handles empty, partial and completed checklists', () => {
  assert.deepEqual(progress([]), { total: 0, done: 0, percent: 0 });
  assert.deepEqual(progress([{ done: true }, { done: false }, { done: false }]), { total: 3, done: 1, percent: 33 });
  assert.deepEqual(progress([{ done: true }]), { total: 1, done: 1, percent: 100 });
});

test('access and file links allow only absolute HTTP URLs', () => {
  assert.equal(safeUrl('https://example.com/document?q=1#page'), 'https://example.com/document?q=1#page');
  assert.equal(safeUrl('http://example.com'), 'http://example.com/');
  for (const value of ['', null, 'example.com', '/relative', '//example.com', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', 'mailto:client@example.com']) {
    assert.equal(safeUrl(value), '');
  }
});

test('phones preserve Brazilian and explicit international normalization and display', () => {
  for (const value of ['(11) 99999-9999', '11 99999 9999', '+55 (11) 99999-9999', '0055 11 99999-9999', '5511999999999']) {
    assert.equal(normalizePhone(value), '5511999999999');
  }
  assert.equal(normalizePhone('(11) 3456-7890'), '551134567890');
  assert.equal(normalizePhone('+1 (202) 555-0100'), '12025550100');
  assert.equal(normalizePhone('0044 20 7946 0958'), '442079460958');
  assert.equal(normalizePhone(' '), '');
  assert.equal(phoneLabel('5511999999999'), '+55 (11) 99999-9999');
  assert.equal(phoneLabel('551134567890'), '+55 (11) 3456-7890');
  assert.equal(phoneLabel('12025550100'), '+12025550100');
  assert.equal(phoneLabel('invalid'), '');
  for (const value of ['99999-9999', '(01) 99999-9999', '+55 11 1234-5678', 'abc5511999999999', 'https://wa.me/5511999999999', '+', '1'.repeat(41)]) {
    assert.throws(() => normalizePhone(value), /Informe o WhatsApp com DDD/, value);
  }
  for (const value of ['+5511999999999', '0123456789', '1234567', '1'.repeat(16)]) {
    assert.equal(storedPhone(value), '');
  }
});

test('error messages keep conflicts, permissions and unsupported migrations actionable', () => {
  assert.match(friendly({ code: '40001' }), /atualizado por outra pessoa/);
  assert.match(friendly({ message: 'PROJECT_ACCESS_DENIED' }), /acesso a este projeto mudou/);
  assert.match(friendly({ code: 'PGRST202' }), /configuração do banco de dados/);
  assert.match(friendly({ code: '22023', message: 'PROJECT_INVALID_PROCESS_LINKS' }), /links de arquivos/);
  assert.match(friendly({ code: '22023', message: 'PROJECT_INVALID_PROCESS' }), /andamento de cada processo/);
  assert.match(friendly({ message: 'PROJECT_INVALID_PHONE' }), /WhatsApp/);
  assert.equal(friendly({ message: 'Convite inválido.' }), 'Convite inválido.');
  assert.equal(friendly({ message: 'Internal secret or SQL detail' }).includes('Internal'), false);
});
