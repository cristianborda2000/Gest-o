'use strict';
const on = value => value === 'true' || value === '1';
const num = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
function configuration(env = process.env) {
  const config = {
    enabled: on(env.JARVIS_ENABLED), memoryEnabled: on(env.JARVIS_MEMORY_ENABLED),
    voiceRequested: on(env.JARVIS_VOICE_ENABLED),
    apiKey: env.OPENAI_API_KEY || '', model: env.OPENAI_JARVIS_MODEL || '',
    voiceModel: env.OPENAI_JARVIS_VOICE_MODEL || '',
    voice: env.OPENAI_JARVIS_VOICE || 'marin',
    transcriptionModel: env.OPENAI_JARVIS_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    voiceRequestsPerMinute: Math.floor(num(env.JARVIS_VOICE_REQUESTS_PER_MINUTE, 3, 1, 10)),
    voiceRequestsPerDay: Math.floor(num(env.JARVIS_VOICE_REQUESTS_PER_DAY, 30, 1, 200)),
    supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    origin: env.APP_ORIGIN || '', maxTools: num(env.JARVIS_MAX_TOOL_CALLS, 6, 1, 10),
    requestsPerMinute: num(env.JARVIS_REQUESTS_PER_MINUTE, 10, 1, 60),
    requestsPerDay: num(env.JARVIS_REQUESTS_PER_DAY, 200, 1, 5000),
    inputPrice: Math.max(0, Number(env.OPENAI_JARVIS_INPUT_USD_PER_MILLION) || 0),
    outputPrice: Math.max(0, Number(env.OPENAI_JARVIS_OUTPUT_USD_PER_MILLION) || 0)
  };
  config.voiceEnabled = Boolean(config.enabled && config.voiceRequested && configuredForText(config) && config.voiceModel);
  return config;
}
const configuredForText = config => Boolean(config.apiKey && config.model && config.supabaseUrl && config.supabaseKey);
function publicConfiguration(config) {
  const configured = configuredForText(config);
  const voiceEnabled = Boolean(config.enabled && config.voiceRequested && configured && config.voiceModel);
  return { enabled: config.enabled, configured, voiceEnabled, memoryEnabled: config.memoryEnabled,
    reason: !config.enabled ? 'JARVIS ainda não foi ativado no servidor.' : !configured ? 'Configure a integração OpenAI e Supabase no servidor para conversar com o JARVIS.' : '',
    voiceReason: voiceEnabled ? '' : !config.voiceRequested ? 'Ative JARVIS_VOICE_ENABLED no servidor para usar o microfone.' : !config.voiceModel ? 'Configure OPENAI_JARVIS_VOICE_MODEL no servidor para usar a voz.' : 'Conclua a configuração do JARVIS no servidor para usar a voz.' };
}
module.exports = { configuration, publicConfiguration };
