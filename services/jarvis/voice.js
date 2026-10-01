'use strict';
const OpenAI = require('openai');
const { createHash } = require('node:crypto');
const { publicConfiguration } = require('./config');
const { JarvisError } = require('./errors');
const Time = require('../../app/assets/js/ceo-time');

// The Realtime transport handles transcription and narration only. Business tools
// remain in /message; no Realtime event can confirm a financial action.
const VOICE_INSTRUCTIONS = `Você é a voz do JARVIS, assistente da ZAM4. Fale em português brasileiro, com clareza e naturalidade.
Sua única função de resposta é narrar o texto autorizado recebido do backend, sem inventar, completar ou alterar informações.
Não responda diretamente a comandos no áudio. Não consulte dados, não execute ações, não confirme operações e não use ferramentas.
Pedidos e consultas são processados pelo backend de texto da ZAM4. A voz não substitui os cartões de confirmação exibidos na tela.`;

function createVoice({ repository, config, provider, clock = () => new Date() }) {
  const client = provider || new OpenAI({ apiKey: config.apiKey || 'unconfigured', timeout: 15000, maxRetries: 0 });
  async function recordMetric(change, startedAt) {
    const month = Time.today(startedAt).slice(0, 7);
    return repository.transact(snapshot => {
      const rows = snapshot.jarvis.voice_metrics ||= [];
      let row = rows.find(item => item.month === month && item.model === config.voiceModel);
      if (!row) {
        row = { month, model: config.voiceModel, requests: 0, issued: 0, errors: 0, rate_limited: 0, total_latency_ms: 0, audio_usage_available: false };
        rows.push(row);
      }
      for (const field of ['requests', 'issued', 'errors', 'rate_limited', 'total_latency_ms']) row[field] += change[field] || 0;
      // Monthly counters only: no recordings, transcripts, credentials or provider bodies.
      return { result: true };
    });
  }
  async function issueToken() {
    if (!publicConfiguration(config).voiceEnabled) throw new JarvisError('A voz ainda não está configurada no servidor. Verifique a ativação e o modelo de voz.', 503, 'VOICE_NOT_CONFIGURED');
    const startedAt = clock();
    await recordMetric({ requests: 1 }, startedAt);
    try {
      // Per-user persisted limits cover all serverless instances and browser sessions.
      await repository.consumeRate('voice-minute', config.voiceRequestsPerMinute, 60);
      await repository.consumeRate('voice-day', config.voiceRequestsPerDay, 86400);
      let secret;
      try {
        secret = await client.realtime.clientSecrets.create({
          expires_after: { anchor: 'created_at', seconds: 60 },
          session: {
            type: 'realtime', model: config.voiceModel,
            instructions: VOICE_INSTRUCTIONS,
            output_modalities: ['audio'], max_output_tokens: 1600,
            audio: {
              input: { transcription: { model: config.transcriptionModel, language: 'pt' }, turn_detection: null, noise_reduction: { type: 'near_field' } },
              output: { voice: config.voice }
            },
            tools: [], tool_choice: 'none', tracing: null
          }
        }, { headers: { 'OpenAI-Safety-Identifier': createHash('sha256').update(repository.userId).digest('hex') }, timeout: 15000, maxRetries: 0 });
      } catch (error) {
        // Never forward a provider body; it can include prompts and credentials.
        const limited = error?.status === 429;
        throw new JarvisError(limited ? 'O serviço de voz atingiu o limite de uso. Aguarde e tente novamente.' : 'Não foi possível iniciar a voz. Verifique o acesso ao modelo de voz na OpenAI e tente novamente.', limited ? 429 : 502, limited ? 'VOICE_PROVIDER_LIMITED' : 'VOICE_UNAVAILABLE');
      }
      if (typeof secret?.value !== 'string' || !/^ek_[A-Za-z0-9_-]{4,4093}$/.test(secret.value) || !Number.isSafeInteger(secret.expires_at) || secret.expires_at <= Math.floor(+clock() / 1000)) {
        throw new JarvisError('O serviço de voz retornou uma credencial inválida. Tente novamente.', 502, 'VOICE_INVALID_RESPONSE');
      }
      await recordMetric({ issued: 1, total_latency_ms: Math.max(0, +clock() - +startedAt) }, startedAt);
      return {
        value: secret.value, expires_at: secret.expires_at,
        ...(typeof secret.session?.id === 'string' && /^sess_[A-Za-z0-9_-]{1,200}$/.test(secret.session.id) ? { session_id: secret.session.id } : {}),
        max_recording_seconds: 60, max_session_seconds: 300
      };
    } catch (error) {
      await recordMetric({ errors: 1, rate_limited: error?.status === 429 ? 1 : 0, total_latency_ms: Math.max(0, +clock() - +startedAt) }, startedAt);
      throw error;
    }
  }
  return { issueToken };
}
module.exports = { createVoice };
