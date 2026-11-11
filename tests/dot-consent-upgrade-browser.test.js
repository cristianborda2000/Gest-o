'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= require('node:path').resolve(__dirname, '../.playwright');
const {chromium}=require('playwright');
test('base OAuth request requires an unchecked explicit opt-in for direct expenses',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});const posts=[];let directEnabled=true;
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'application/javascript',body:`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:'fixture-owner',email:'owner@example.test'}}}}),onAuthStateChange:()=>({})}})};`});
   if(url.pathname==='/assets/js/env.js')return route.fulfill({contentType:'application/javascript',body:"window.ZAMA_CONFIG={supabaseUrl:'https://supabase.example',supabaseAnonKey:'fixture'};"});
   if(url.pathname==='/.well-known/oauth-protected-resource')return route.fulfill({contentType:'application/json',body:JSON.stringify({scopes_supported:directEnabled?['zama:private','zama:expenses:write']:['zama:private']})});
   if(url.pathname==='/.well-known/oauth-authorization-server')return route.fulfill({contentType:'application/json',body:JSON.stringify({issuer:'https://zama.example',grant_types_supported:['authorization_code','refresh_token'],scopes_supported:directEnabled?['zama:private','zama:expenses:write']:['zama:private']})});
   if(url.pathname==='/api/dot-oauth/consent'){posts.push(JSON.parse(route.request().postData()));return route.fulfill({status:503,contentType:'application/json',body:'{"error":"server_error"}'});}
   const files={'/dot-authorize.html':['app/dot-authorize.html','text/html'],'/assets/js/dot-authorize.js':['app/assets/js/dot-authorize.js','application/javascript'],'/assets/dot-confirm.css':['app/assets/dot-confirm.css','text/css']};
   if(files[url.pathname])return route.fulfill({body:readFileSync(files[url.pathname][0]),contentType:files[url.pathname][1]});return route.abort();
  });
  const url='https://zama.example/dot-authorize.html?'+new URLSearchParams({client_id:'fixture',redirect_uri:'https://chatgpt.com/cb',state:'fixture',scope:'zama:private'});
  async function ready(){await page.goto(url);await page.waitForFunction(()=>!document.getElementById('allow').disabled);}
  await ready();assert.equal(posts.length,0);assert.equal(await page.locator('#direct-consent').isChecked(),false);assert.equal(await page.locator('#direct-option').isVisible(),true);
  await page.locator('#allow').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Não foi possível'));assert.equal(posts[0].consent_direct,false);assert.equal(posts[0].request.scope,'zama:private');
  await ready();await page.locator('#direct-consent').check();assert.match(await page.locator('#permissions').textContent(),/sem confirmação por lançamento/);assert.match(await page.locator('main').textContent(),/renovada automaticamente/);
  await page.locator('#allow').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Não foi possível'));assert.equal(posts[1].consent_direct,true);assert.equal(posts[1].request.scope,'zama:private');
  await ready();await page.locator('#direct-consent').check();await page.locator('#deny').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Não foi possível'));assert.equal(posts[2].approve,false);assert.equal(posts[2].consent_direct,false);
  directEnabled=false;await ready();assert.equal(await page.locator('#direct-option').isVisible(),false);assert.equal(await page.locator('#direct-consent').isDisabled(),true);assert.equal(posts.length,3);
 }finally{await browser.close();}
});
