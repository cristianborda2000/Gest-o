'use strict';
const on = value => value === 'true' || value === '1';
const num = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
function configuration(env = process.env) {
  return {
    enabled: on(env.JARVIS_ENABLED), memoryEnabled: on(env.JARVIS_MEMORY_ENABLED),
    // Realtime is deliberately gated until text is validated with real credentials.
    voiceRequested: on(env.JARVIS_VOICE_ENABLED), voiceEnabled: false,
    apiKey: env.OPENAI_API_KEY || '', model: env.OPENAI_JARVIS_MODEL || '',
    supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    origin: env.APP_ORIGIN || '', maxTools: num(env.JARVIS_MAX_TOOL_CALLS, 6, 1, 10),
    requestsPerMinute: num(env.JARVIS_REQUESTS_PER_MINUTE, 10, 1, 60),
    requestsPerDay: num(env.JARVIS_REQUESTS_PER_DAY, 200, 1, 5000),
    inputPrice: Math.max(0, Number(env.OPENAI_JARVIS_INPUT_USD_PER_MILLION) || 0),
    outputPrice: Math.max(0, Number(env.OPENAI_JARVIS_OUTPUT_USD_PER_MILLION) || 0)
  };
}
function publicConfiguration(config) {
  const configured = Boolean(config.apiKey && config.model && config.supabaseUrl && config.supabaseKey);
  return { enabled: config.enabled, configured, voiceEnabled: false, memoryEnabled: config.memoryEnabled,
    reason: !config.enabled ? 'JARVIS ainda não foi ativado no servidor.' : !configured ? 'Configure a integração OpenAI e Supabase no servidor para conversar com o JARVIS.' : '',
    voiceReason: 'Voz será ativada após a validação da conversa por texto com a API real.' };
}
module.exports = { configuration, publicConfiguration };
