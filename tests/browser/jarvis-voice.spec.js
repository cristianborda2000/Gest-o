// All media, Realtime and business API traffic in this file are isolated fixtures.
// These tests never record real audio or contact OpenAI/the production account.
const { test, expect } = require('@playwright/test');
const { mock } = require('./mock-supabase');

const conversationId = '10000000-0000-4000-8000-000000000091';
const actionId = '20000000-0000-4000-8000-000000000091';
const conversation = { id: conversationId, title: 'Conversa por voz', created_at: '2026-09-29T15:00:00Z', updated_at: '2026-09-29T15:00:00Z' };
const summary = { date: '2026-09-29', tasks: { total: 0, tasks: [] }, overdue: { total: 0 }, financial: { expenses: 'R$ 480,25' }, nextAppointment: null };
const pendingAction = { id: actionId, tool_name: 'register_expense', status: 'pending', requires_confirmation: true, input: { amount: 350, description: 'Anúncios', category: 'Marketing', date: '2026-09-29', due_date: '2026-09-29', status: 'paid' }, result: {}, created_at: '2026-09-29T15:00:00Z' };

async function mediaFixture(page, options = {}) {
  await page.addInitScript(({ denied, blockedPlayback, audioSessionSupported, incompatibleConstraints }) => {
    const harness = window.voiceHarness = { requests: 0, peers: [], tracks: [], constraints: [], sent: [], playCalls: 0, blockedPlayback,
      audioModes: [], captureModes: [], devices: [{ kind: 'audioinput', deviceId: 'fixture-input' }] };
    if (audioSessionSupported) {
      class FakeAudioSession extends EventTarget {
        constructor() { super(); this.currentType = 'auto'; this.state = 'inactive'; }
        get type() { return this.currentType; }
        set type(value) { this.currentType = value; harness.audioModes.push(value); }
        changeState(value) { this.state = value; this.dispatchEvent(new Event('statechange')); }
      }
      Object.defineProperty(navigator, 'audioSession', { configurable: true, value: new FakeAudioSession() });
    }
    class FakeChannel extends EventTarget {
      constructor() { super(); this.readyState = 'connecting'; this.label = 'oai-events'; }
      send(data) { harness.sent.push(JSON.parse(data)); }
      close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); this.onclose?.(new Event('close')); }
      open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); this.onopen?.(new Event('open')); }
      receive(value) { const event = new MessageEvent('message', { data: JSON.stringify(value) }); this.dispatchEvent(event); this.onmessage?.(event); }
    }
    class FakePeer extends EventTarget {
      constructor() { super(); this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable'; this.localDescription = null; harness.peers.push(this); }
      createDataChannel() { return this.channel = new FakeChannel(); }
      addTrack(track) { return { track, replaceTrack: async () => {} }; }
      getSenders() { return []; }
      async createOffer() { return { type: 'offer', sdp: 'fixture-offer-sdp' }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription(value) {
        this.remoteDescription = value; this.connectionState = this.iceConnectionState = 'connected';
        queueMicrotask(() => { this.channel.open(); this.dispatchEvent(new Event('connectionstatechange')); this.onconnectionstatechange?.(new Event('connectionstatechange')); });
      }
      close() { this.connectionState = this.iceConnectionState = 'closed'; this.signalingState = 'closed'; }
      fail() { this.connectionState = this.iceConnectionState = 'failed'; this.dispatchEvent(new Event('connectionstatechange')); this.onconnectionstatechange?.(new Event('connectionstatechange')); }
    }
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: FakePeer });
    const mediaDevices = Object.assign(new EventTarget(), { enumerateDevices: async () => harness.devices, getUserMedia: async constraints => {
      harness.requests++; harness.constraints.push(constraints);
      harness.captureModes.push(navigator.audioSession?.type || null);
      if (denied) throw new DOMException('Permission denied by fixture', 'NotAllowedError');
      if (incompatibleConstraints && constraints.audio !== true) throw new DOMException('Unsupported headset processing constraints', 'OverconstrainedError');
      const track = Object.assign(new EventTarget(), { kind: 'audio', enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; this.enabled = false; }, getSettings() { return { deviceId: 'fixture-input' }; }, end() { this.stop(); this.dispatchEvent(new Event('ended')); } });
      harness.tracks.push(track);
      return { id: 'fixture-stream', getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
    } });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return this.fixtureStream; }, set(value) { this.fixtureStream = value; } });
    HTMLMediaElement.prototype.play = function () { harness.playCalls++; return harness.blockedPlayback ? Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')) : Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
    harness.receive = value => harness.peers.at(-1)?.channel.receive(value);
    harness.transcribe = (text, itemId = 'audio-item-1') => {
      harness.receive({ type: 'input_audio_buffer.committed', item_id: itemId });
      harness.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text });
    };
    harness.startAnswer = () => {
      const peer = harness.peers.at(-1), event = new Event('track');
      event.streams = [{ getTracks: () => [] }]; peer.dispatchEvent(event);
      const metadata = harness.sent.findLast(event => event.type === 'response.create')?.response.metadata;
      harness.receive({ type: 'response.created', response: { id: 'voice-answer-1', metadata } });
      harness.receive({ type: 'output_audio_buffer.started', response_id: 'voice-answer-1' });
    };
    harness.endAnswer = () => {
      const metadata = harness.sent.findLast(event => event.type === 'response.create')?.response.metadata;
      harness.receive({ type: 'output_audio_buffer.stopped', response_id: 'voice-answer-1' });
      harness.receive({ type: 'response.done', response: { id: 'voice-answer-1', status: 'completed', metadata } });
    };
  }, { denied: Boolean(options.denied), blockedPlayback: Boolean(options.blockedPlayback), audioSessionSupported: Boolean(options.audioSessionSupported), incompatibleConstraints: Boolean(options.incompatibleConstraints) });
}

async function voiceMock(page, options = {}) {
  await mediaFixture(page, options);
  const api = { requests: [], rtcRequests: [], messages: [], actions: [], confirmed: 0 };
  await page.route('https://api.openai.com/**', async route => {
    const request = route.request();
    api.rtcRequests.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
    if (new URL(request.url()).pathname !== '/v1/realtime/calls') return route.abort();
    if (options.connectionError) return route.fulfill({ status: 502, body: 'fixture connection unavailable' });
    return route.fulfill({ status: 201, contentType: 'application/sdp', body: 'fixture-answer-sdp' });
  });
  await page.route('**/api/jarvis/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/jarvis', '');
    const body = request.postDataJSON();
    api.requests.push({ path, method: request.method(), body, authorization: request.headers().authorization });
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/config') return respond({ enabled: true, configured: true, memoryEnabled: false, voiceEnabled: !options.disabled, voiceReason: options.disabled ? 'Voz desativada pelo administrador.' : null });
    if (path === '/summary') return respond({ summary });
    if (path === '/conversations') return respond({ conversations: api.messages.length ? [conversation] : [] });
    if (path === `/conversations/${conversationId}`) return respond({ conversation, messages: api.messages, actions: api.actions });
    if (path === '/realtime/token') return respond({ value: 'fixture-ephemeral-credential', expires_at: 1999999999, max_recording_seconds: 60, max_session_seconds: 300 });
    if (path === '/message') {
      if (options.messageGate) await options.messageGate;
      api.messages.push({ id: `user-${api.messages.length}`, role: 'user', content: body.message }, { id: `assistant-${api.messages.length}`, role: 'assistant', content: options.reply || 'As saídas pagas somam R$ 480,25 neste mês.' });
      if (options.pendingExpense && !api.actions.length) api.actions.push(structuredClone(pendingAction));
      return respond({ conversation, messages: api.messages, actions: api.actions, state_changed: false });
    }
    if (path === `/actions/${actionId}/confirm`) {
      if (!api.confirmed) { api.confirmed++; api.actions[0].status = 'executed'; }
      return respond({ action: api.actions[0], state_changed: false });
    }
    return respond({ error: `Endpoint de teste inesperado: ${path}` }, 404);
  });
  await mock(page);
  return api;
}

async function openVoice(page, panel = false) {
  if (panel) await page.locator('#jarvisLauncher').click();
  else {
    if (await page.locator('#ceoMenuBtn').isVisible()) await page.locator('#ceoMenuBtn').click();
    await page.locator('.nav [data-module="jarvis"]').click();
  }
  await expect(page.getByLabel('Mensagem para o JARVIS')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Falar com o JARVIS', exact: true })).toBeEnabled();
}

async function record(page) {
  await page.getByRole('button', { name: 'Falar com o JARVIS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enviar áudio', exact: true })).toBeEnabled();
}

async function transcribe(page, text, itemId = 'audio-item-1') {
  const commits = await page.evaluate(() => voiceHarness.sent.filter(event => event.type === 'input_audio_buffer.commit').length);
  // Advance the media fixture beyond the minimum useful recording duration.
  await page.clock.runFor(300);
  await page.getByRole('button', { name: 'Enviar áudio', exact: true }).click();
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.filter(event => event.type === 'input_audio_buffer.commit').length)).toBe(commits + 1);
  await page.evaluate(({ text, itemId }) => window.voiceHarness.transcribe(text, itemId), { text, itemId });
}

test('voice requests permission only after a click and exchanges only an ephemeral credential with Realtime', async ({ page }) => {
  const api = await voiceMock(page); await openVoice(page);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(0);
  expect(api.requests.filter(r => r.path === '/realtime/token')).toHaveLength(0);
  await record(page);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(1);
  expect(api.requests.filter(r => r.path === '/realtime/token')).toHaveLength(1);
  expect(api.requests.every(r => r.authorization === 'Bearer test-access-token')).toBe(true);
  expect(api.rtcRequests).toHaveLength(1);
  expect(api.rtcRequests[0].headers.authorization).toBe('Bearer fixture-ephemeral-credential');
  expect(api.rtcRequests[0].body).toBe('fixture-offer-sdp');
  expect(api.requests.some(r => JSON.stringify(r).includes('fixture-ephemeral-credential'))).toBe(false);
  expect(await page.evaluate(() => voiceHarness.sent.some(event => event.type === 'response.create'))).toBe(false);
  await page.getByRole('button', { name: 'Desligar voz', exact: true }).click();
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
});

test('disabled voice never opens the microphone or requests a session', async ({ page }) => {
  const api = await voiceMock(page, { disabled: true });
  await page.locator('#jarvisLauncher').click();
  const mic = page.locator('.jarvis-microphone'); await expect(mic).toBeVisible();
  if (await mic.isEnabled()) await mic.click();
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(0);
  expect(api.requests.filter(r => r.path === '/realtime/token')).toHaveLength(0);
});

test('denied microphone permission explains how to proceed and leaves text usable', async ({ page }) => {
  const api = await voiceMock(page, { denied: true }); await openVoice(page);
  await page.getByRole('button', { name: 'Falar com o JARVIS', exact: true }).click();
  await expect(page.locator('.jarvis-voice-status')).toContainText(/microfone|permissão/i);
  await expect(page.getByRole('button', { name: 'Falar com o JARVIS', exact: true })).toBeEnabled();
  const input = page.getByLabel('Mensagem para o JARVIS'); await input.fill('Como está meu dia?');
  await input.press('Enter');
  await expect(page.locator('.jarvis-message.assistant')).toContainText('480,25');
  expect(api.requests.filter(r => r.path === '/message')).toHaveLength(1);
  expect(await page.evaluate(() => voiceHarness.peers.length)).toBe(0);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(1);
});

test('transcribed audio uses the authenticated text endpoint once and speaks only its acknowledged answer', async ({ page }) => {
  let release; const messageGate = new Promise(resolve => { release = resolve; });
  const reply = 'As saídas pagas somam R$ 480,25 neste mês.';
  const api = await voiceMock(page, { messageGate, reply }); await openVoice(page); await record(page);
  await transcribe(page, 'Quanto eu gastei este mês?');
  await expect.poll(() => api.requests.filter(r => r.path === '/message').length).toBe(1);
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => voiceHarness.sent.filter(event => event.type === 'input_audio_buffer.commit').length)).toBe(1);
  expect(await page.evaluate(() => voiceHarness.sent.some(event => event.type === 'response.create'))).toBe(false);
  await page.evaluate(() => voiceHarness.transcribe('Quanto eu gastei este mês?', 'audio-item-1'));
  expect(api.requests.filter(r => r.path === '/message')).toHaveLength(1);
  release();
  await expect(page.locator('.jarvis-message.assistant')).toContainText(reply);
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.filter(event => event.type === 'response.create').length)).toBe(1);
  const response = await page.evaluate(() => voiceHarness.sent.find(event => event.type === 'response.create').response);
  expect(response.conversation).toBe('none'); expect(response.tools).toEqual([]); expect(response.tool_choice).toBe('none');
  expect(response.output_modalities).toEqual(['audio']);
  expect(JSON.stringify(response.input)).toContain(reply);
  expect(JSON.stringify(response.input)).not.toContain('Quanto eu gastei este mês?');
  const post = api.requests.find(r => r.path === '/message');
  expect(post.body.message).toBe('Quanto eu gastei este mês?'); expect(post.body.request_id).toMatch(/^[\da-f-]{36}$/i);
  expect(post.authorization).toBe('Bearer test-access-token'); expect(post.body).not.toHaveProperty('user_id');
});

test('spoken financial instructions and a spoken yes keep the expense pending until the confirmation button', async ({ page }) => {
  const api = await voiceMock(page, { pendingExpense: true, reply: 'Confira a despesa de R$ 350 e confirme no cartão.' });
  await openVoice(page); await record(page); await transcribe(page, 'Registra R$ 350 de marketing.');
  const card = page.locator(`[data-action-id="${actionId}"]`);
  await expect(card).toContainText('Aguardando confirmação'); await expect(card).toContainText('350,00');
  expect(api.confirmed).toBe(0);
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.some(event => event.type === 'response.create'))).toBe(true);
  await page.evaluate(() => { voiceHarness.startAnswer(); voiceHarness.endAnswer(); });
  await record(page); await transcribe(page, 'Sim', 'audio-item-2');
  await expect.poll(() => api.requests.filter(r => r.path === '/message').length).toBe(2);
  await expect(card).toContainText('Aguardando confirmação'); expect(api.confirmed).toBe(0);
  expect(api.requests.filter(r => r.path.endsWith('/confirm'))).toHaveLength(0);
  await card.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(card).toContainText('Concluída'); expect(api.confirmed).toBe(1);
  expect(api.requests.find(r => r.path.endsWith('/confirm')).body).toEqual({ confirmation: true });
});

test('voice playback can be interrupted without changing the saved answer', async ({ page }) => {
  await voiceMock(page); await openVoice(page); await record(page); await transcribe(page, 'Como está meu dia?');
  await expect(page.locator('.jarvis-message.assistant')).toBeVisible();
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.some(event => event.type === 'response.create'))).toBe(true);
  await page.evaluate(() => voiceHarness.startAnswer());
  await page.getByRole('button', { name: 'Interromper resposta', exact: true }).click();
  const events = await page.evaluate(() => voiceHarness.sent);
  expect(events.some(event => event.type === 'response.cancel')).toBe(true);
  expect(events.some(event => event.type === 'output_audio_buffer.clear')).toBe(true);
  await expect(page.locator('.jarvis-message.assistant')).toContainText('480,25');
});

for (const exit of ['close', 'navigate', 'background']) {
  test(`voice stops every microphone track and ignores delayed transcripts on ${exit}`, async ({ page }) => {
    const api = await voiceMock(page); await openVoice(page, exit === 'close'); await record(page);
    if (exit === 'close') await page.getByRole('button', { name: 'Fechar JARVIS', exact: true }).click();
    if (exit === 'navigate') await page.locator('.nav [data-module="dashboard"]').click();
    if (exit === 'background') await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
    expect(await page.evaluate(() => voiceHarness.peers.every(peer => peer.connectionState === 'closed'))).toBe(true);
    await page.evaluate(() => voiceHarness.transcribe('Crie uma tarefa que chegou atrasada.', 'late-audio'));
    expect(api.requests.filter(r => r.path === '/message')).toHaveLength(0);
  });
}

test('failed Realtime connection releases the microphone and preserves text access', async ({ page }) => {
  await voiceMock(page, { connectionError: true }); await openVoice(page);
  await page.getByRole('button', { name: 'Falar com o JARVIS', exact: true }).click();
  await expect(page.locator('.jarvis-voice-status')).toContainText(/conexão|conectar|voz|áudio/i);
  await expect.poll(() => page.evaluate(() => voiceHarness.tracks.length > 0 && voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Falar com o JARVIS', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Mensagem para o JARVIS')).toBeEnabled();
});

test('a media connection failure after recording starts stops all microphone tracks', async ({ page }) => {
  const api = await voiceMock(page); await openVoice(page); await record(page);
  await page.evaluate(() => voiceHarness.peers.at(-1).fail());
  await expect.poll(() => page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Falar com o JARVIS', exact: true })).toBeEnabled();
  expect(api.requests.filter(r => r.path === '/message')).toHaveLength(0);
});

test('mobile voice controls remain accessible and fit the monochrome assistant', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await voiceMock(page); await openVoice(page); await record(page);
  await expect(page.locator('.jarvis-voice-status')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar áudio', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/jarvis-voice-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Desligar voz', exact: true }).click();
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
});

test('blocked playback regenerates only narration on explicit click, never the business request', async ({ page }) => {
  const api = await voiceMock(page, { blockedPlayback: true });
  await openVoice(page); await record(page); await transcribe(page, 'Quanto gastei este mês?');
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.some(event => event.type === 'response.create'))).toBe(true);
  await page.evaluate(() => voiceHarness.startAnswer());
  await expect(page.getByRole('button', { name: 'Ouvir resposta', exact: true })).toBeVisible();
  await page.evaluate(() => { voiceHarness.endAnswer(); voiceHarness.blockedPlayback = false; });
  await page.getByRole('button', { name: 'Ouvir resposta', exact: true }).click();
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.filter(event => event.type === 'response.create').length)).toBe(2);
  const responses = await page.evaluate(() => voiceHarness.sent.filter(event => event.type === 'response.create'));
  expect(responses[1].response.input).toEqual(responses[0].response.input);
  expect(api.requests.filter(request => request.path === '/message')).toHaveLength(1);
});

test('Safari audio session returns to playback after capture and restores the original mode on exit', async ({ page }) => {
  await voiceMock(page, { audioSessionSupported: true }); await openVoice(page); await record(page);
  expect(await page.evaluate(() => voiceHarness.captureModes)).toEqual(['play-and-record']);
  await transcribe(page, 'Como está meu dia?');
  await expect(page.locator('.jarvis-message.assistant')).toBeVisible();
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await page.getByRole('button', { name: 'Desligar voz', exact: true }).click();
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
  // A later phone call cannot affect an already closed JARVIS session.
  await page.evaluate(() => navigator.audioSession.changeState('interrupted'));
  await expect(page.getByRole('button', { name: 'Falar com o JARVIS', exact: true })).toBeEnabled();
});

test('headset processing incompatibility retries with the system default microphone without pinning a device', async ({ page }) => {
  await voiceMock(page, { incompatibleConstraints: true }); await openVoice(page); await record(page);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(2);
  const constraints = await page.evaluate(() => voiceHarness.constraints);
  expect(constraints[1]).toEqual({ audio: true });
  expect(JSON.stringify(constraints)).not.toContain('deviceId');
  await page.getByRole('button', { name: 'Desligar voz', exact: true }).click();
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
});

test('a removed headset cancels recording and requires a new explicit click to use the current input', async ({ page }) => {
  const api = await voiceMock(page); await openVoice(page); await record(page);
  // Adding an unrelated device must not discard a healthy recording.
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await expect(page.getByRole('button', { name: 'Enviar áudio', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    voiceHarness.devices = [{ kind: 'audioinput', deviceId: 'built-in-input' }];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(page.locator('.jarvis-voice-status')).toContainText('fone foi desconectado');
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(1);
  expect(api.requests.filter(request => request.path === '/message')).toHaveLength(0);
  await record(page);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(2);
});

test('a system audio interruption stops capture and never resumes listening automatically', async ({ page }) => {
  const api = await voiceMock(page, { audioSessionSupported: true }); await openVoice(page); await record(page);
  await page.evaluate(() => navigator.audioSession.changeState('interrupted'));
  await expect(page.locator('.jarvis-voice-status')).toContainText('outro aplicativo');
  expect(await page.evaluate(() => voiceHarness.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => voiceHarness.peers.every(peer => peer.connectionState === 'closed'))).toBe(true);
  await page.evaluate(() => { navigator.audioSession.changeState('active'); voiceHarness.transcribe('Pedido interrompido'); });
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(1);
  expect(api.requests.filter(request => request.path === '/message')).toHaveLength(0);
});

test('a changed playback route resumes only audio and never repeats the business request', async ({ page }) => {
  const api = await voiceMock(page); await openVoice(page); await record(page); await transcribe(page, 'Como está meu dia?');
  await expect.poll(() => page.evaluate(() => voiceHarness.sent.some(event => event.type === 'response.create'))).toBe(true);
  await page.evaluate(() => voiceHarness.startAnswer());
  const playCalls = await page.evaluate(() => voiceHarness.playCalls);
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await expect.poll(() => page.evaluate(() => voiceHarness.playCalls)).toBe(playCalls + 1);
  expect(api.requests.filter(request => request.path === '/message')).toHaveLength(1);
  expect(await page.evaluate(() => voiceHarness.requests)).toBe(1);
});
