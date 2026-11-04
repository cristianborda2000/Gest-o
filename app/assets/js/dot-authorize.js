/* Consent is explicit; loading this page never issues an authorization code. */
(() => {
  'use strict';
  const el = id => document.getElementById(id), params = new URLSearchParams(location.search);
  const config = window.ZAMA_CONFIG || {};
  let session = null, busy = false;
  const disable = () => { el('allow').disabled = true; el('deny').disabled = true; };
  if (window.top !== window.self || !window.supabase || !config.supabaseUrl || !config.supabaseAnonKey) { el('status').textContent = 'Abra esta página diretamente no ZAM4.'; return; }
  if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) { el('status').textContent='Pedido inválido.'; return; }
  const client = window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);
  el('destination').textContent = `Aplicativo: ${params.get('client_id') || 'não informado'}`;
  async function load() {
    if (busy) return;
    disable(); session = null;
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) { el('account').textContent=''; el('status').textContent='Entre na conta proprietária do ZAM4 e volte a esta página.'; return; }
    session=data.session; el('account').textContent=`Conta: ${session.user.email || ''}`;
    el('status').textContent='Confira as permissões antes de autorizar.';
    el('allow').disabled=false; el('deny').disabled=false;
  }
  async function decide(approve) {
    if (!session || busy) return;
    busy=true; disable(); el('reload').disabled=true;
    try {
      const {data,error}=await client.auth.getSession();
      if(error || !data.session || data.session.user.id !== session.user.id) throw Error('Sessão alterada. Verifique o login novamente.');
      const response=await fetch('/api/dot-oauth/consent',{method:'POST',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.session.access_token}`},body:JSON.stringify({request:Object.fromEntries(params),approve})});
      const body=await response.json();
      if(!response.ok) throw Error('Não foi possível autorizar. Confira a conta proprietária e reinicie a conexão pelo ChatGPT.');
      const target=new URL(body.redirect),expected=new URL(params.get('redirect_uri'));
      if(target.origin!==expected.origin || target.pathname!==expected.pathname || target.hash || target.searchParams.get('state')!==params.get('state') || target.searchParams.get('iss')!==location.origin) throw Error('Resposta de autorização inválida.');
      location.replace(target.href);
    } catch(error) { el('status').textContent=error.message; }
    finally { busy=false; el('reload').disabled=false; }
  }
  client.auth.onAuthStateChange(()=>{ session=null; disable(); });
  el('allow').addEventListener('click',()=>decide(true)); el('deny').addEventListener('click',()=>decide(false)); el('reload').addEventListener('click',load);
  load();
})();
