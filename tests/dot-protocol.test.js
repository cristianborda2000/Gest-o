'use strict';
// Separate raw JSON-RPC client; no imports from the server implementation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
async function exchange(lines) {
  const child = spawn(process.execPath, [resolve(__dirname, '../plugin/zama-private/server/index.js')], { windowsHide: true, env: { ...process.env, ZAMA_API_ORIGIN: '', ZAMA_ACCESS_TOKEN: '' } });
  let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const completion = new Promise((yes, no) => { child.on('error', no); child.on('close', yes); });
  child.stdin.end(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  const code = await completion; assert.equal(code, 0); assert.equal(err, ''); return out.trim().split('\n').filter(Boolean).map(JSON.parse);
}
const init = protocolVersion => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'Raw test client', version: '1.0' } } });
for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
  test(`processo MCP: negociação ${version}, catálogo, ping e chamada sem credencial`, async () => {
    const replies = await exchange([init(version), { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_tasks', arguments: { request_id: randomUUID() } } }]);
    assert.deepEqual(replies.map(r => r.id), [1, 2, 3, 4]); assert.equal(replies[0].result.protocolVersion, version); assert.ok(replies[0].result.instructions);
    assert.equal(replies[1].result.tools.length, 7); for (const tool of replies[1].result.tools) { assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.inputSchema.required.includes('request_id')); assert.equal(typeof tool.annotations.readOnlyHint, 'boolean'); }
    assert.deepEqual(replies[2].result, {}); assert.equal(replies[3].result.isError, true); assert.match(replies[3].result.content[0].text, /NOT_CONFIGURED/);
  });
}
test('processo MCP: JSON quebrado, chamada prematura, método desconhecido e ferramenta proibida', async () => {
  const replies = await exchange(['{broken', { jsonrpc: '2.0', id: 9, method: 'tools/list' }, init('unsupported-future-version'), { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 3, method: 'invented' }, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'confirm_expense', arguments: { request_id: randomUUID() } } }]);
  assert.equal(replies[0].error.code, -32700); assert.equal(replies[1].error.code, -32000); assert.equal(replies[2].result.protocolVersion, '2025-11-25'); assert.equal(replies[3].error.code, -32601); assert.equal(replies[4].error.code, -32602);
});
