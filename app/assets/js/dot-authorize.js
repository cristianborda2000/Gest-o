/* Consent is explicit; loading this page never issues an authorization code. */
(() => {
  'use strict';
  const el = id => document.getElementById(id), params = new URLSearchParams(location.search);
  const config = window.ZAMA_CONFIG || {};
  let session = null, busy = false, loading = false, canConsentDirect = false, allowRefreshV2 = false;
  const requestedDirect = (params.get('scope') || '').split(' ').includes('zama:expenses:write');
  const basePermissions = el('permissions').textContent;
  const updatePermissions = () => {
    el('permissions').textContent = requestedDirect || (canConsentDirect && el('direct-consent').checked)
      ? 'Além das permissões básicas, esta conexão poderá registrar diretamente despesas solicitadas por você, sem confirmação por lançamento. Pago ou pendente deve estar explícito; quando não estiver, o dot deverá perguntar. Sem teto comercial de valor. Não efetua pagamentos nem transferências. Propostas continuam exigindo confirmação.'
      : basePermissions;
  };
  updatePermissions();
  const disable = () => { el('allow').disabled = true; el('deny').disabled = true; el('direct-consent').disabled = true; };
  if (window.top !== window.self || !window.supabase || !config.supabaseUrl || !config.supabaseAnonKey) { el('status').textContent = 'Abra esta página diretamente no ZAM4.'; return; }
  if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) { el('status').textContent='Pedido inválido.'; return; }
  const client = window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);
  el('destination').textContent = `Aplicativo: ${params.get('client_id') || 'não informado'}`;
  async function loadPolicy() {
    const response = await fetch('/.well-known/oauth-authorization-server', {credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('Política indisponível.');
    const metadata = await response.json(), grants = metadata?.grant_types_supported;
    if (metadata?.issuer !== location.origin || !Array.isArray(grants) || !grants.includes('authorization_code') || grants.some(value => typeof value !== 'string') || new Set(grants).size !== grants.length) throw Error('Política inválida.');
    const renewable = grants.includes('refresh_token'), version = metadata.zama_refresh_version, policy = metadata.zama_refresh_policy;
    if (version === 2) {
      if (!renewable || !policy || policy.access_expires_in !== 3600 || policy.idle_expires_in !== 604800 || policy.absolute_expires_in !== 2592000) throw Error('Política inválida.');
      allowRefreshV2 = true;
      el('connection-lifetime').textContent = 'Ao autorizar, você permite renovar automaticamente esta conexão por até 30 dias, com encerramento após 7 dias sem renovação. Cada token de acesso dura até uma hora. A renovação mantém as permissões aprovadas e a conexão pode ser revogada. Após esses prazos ou a revogação, será necessário conectar novamente.';
    } else {
      if (version !== undefined || policy !== undefined) throw Error('Política inválida.');
      allowRefreshV2 = false;
      el('connection-lifetime').textContent = renewable
        ? 'A conexão será renovada automaticamente durante o uso. Cada token de acesso dura uma hora. Após 30 dias sem uso, revogação ou falha de segurança, poderá ser necessário autorizar novamente. Uma renovação válida reinicia o prazo de inatividade, sem prazo absoluto adicional.'
        : 'O acesso dura uma hora. Após expirar, será necessário conectar novamente.';
    }
    const scopes = metadata.scopes_supported;
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some(value => typeof value !== 'string') || new Set(scopes).size !== scopes.length)) throw Error('Permissões inválidas.');
    canConsentDirect = !requestedDirect && scopes?.includes('zama:expenses:write') === true;
    el('direct-option').hidden = !canConsentDirect;
    if (!canConsentDirect) el('direct-consent').checked = false;
    updatePermissions();
  }
  async function load() {
    if (busy || loading) return;
    loading = true; disable(); session = null; allowRefreshV2 = false; canConsentDirect = false; el('reload').disabled = true;
    el('account').textContent = ''; el('connection-lifetime').textContent = 'Verificando o prazo de autorização da conexão.';
    try {
      await loadPolicy();
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) { el('status').textContent='Entre na conta proprietária do ZAM4 e volte a esta página.'; return; }
      session=data.session; el('account').textContent=`Conta: ${session.user.email || ''}`;
      el('status').textContent='Confira as permissões e o prazo antes de autorizar.';
      el('allow').disabled=false; el('deny').disabled=false; el('direct-consent').disabled=!canConsentDirect;
    } catch {
      session = null; allowRefreshV2 = false; canConsentDirect = false; disable();
      el('status').textContent='Não foi possível verificar o prazo da conexão. Verifique o login para tentar novamente.';
    } finally { loading = false; el('reload').disabled = false; }
  }
  async function decide(approve) {
    if (!session || busy) return;
    busy=true; disable(); el('reload').disabled=true;
    try {
      const {data,error}=await client.auth.getSession();
      if(error || !data.session || data.session.user.id !== session.user.id) throw Error('Sessão alterada. Verifique o login novamente.');
      const response=await fetch('/api/dot-oauth/consent',{method:'POST',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.session.access_token}`},body:JSON.stringify({request:Object.fromEntries(params),approve,consent_direct:approve && canConsentDirect && el('direct-consent').checked,...(approve && allowRefreshV2 ? {allow_refresh:true} : {})})});
      const body=await response.json();
      if(!response.ok) throw Error('Não foi possível autorizar. Confira a conta proprietária e reinicie a conexão pelo ChatGPT.');
      const target=new URL(body.redirect),expected=new URL(params.get('redirect_uri'));
      if(target.origin!==expected.origin || target.pathname!==expected.pathname || target.hash || target.searchParams.get('state')!==params.get('state') || target.searchParams.get('iss')!==location.origin) throw Error('Resposta de autorização inválida.');
      location.replace(target.href);
    } catch(error) { el('status').textContent=error.message; }
    finally { busy=false; el('reload').disabled=false; }
  }
  client.auth.onAuthStateChange(()=>{ session=null; allowRefreshV2=false; disable(); });
  el('allow').addEventListener('click',()=>decide(true)); el('deny').addEventListener('click',()=>decide(false)); el('reload').addEventListener('click',load);
  el('direct-consent').addEventListener('change',updatePermissions);
  load();
})();
