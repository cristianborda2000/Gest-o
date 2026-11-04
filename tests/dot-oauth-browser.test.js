'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync,mkdirSync}=require('node:fs'),{resolve}=require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(__dirname,'../.playwright');
const {chromium}=require('playwright');
test('OAuth consent page requires a click, prevents duplicate posts and safely renders account',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:390,height:844}});let posts=0,approval,session=true;
 await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'application/javascript',body:`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:${session?JSON.stringify({access_token:'fixture',user:{id:'fixture-owner',email:'<img src=x onerror=alert(1)>@example.test'}}):'null'}}}),onAuthStateChange:()=>({})}})};`});
 if(url.pathname==='/assets/js/env.js')return route.fulfill({contentType:'application/javascript',body:"window.ZAMA_CONFIG={supabaseUrl:'https://supabase.example',supabaseAnonKey:'fixture'};"});
 if(url.pathname==='/api/dot-oauth/consent'){posts++;approval=JSON.parse(route.request().postData()).approve;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"server_error"}'});}
 const files={'/dot-authorize.html':['app/dot-authorize.html','text/html'],'/assets/js/dot-authorize.js':['app/assets/js/dot-authorize.js','application/javascript'],'/assets/dot-confirm.css':['app/assets/dot-confirm.css','text/css']};
 if(files[url.pathname])return route.fulfill({body:readFileSync(files[url.pathname][0]),contentType:files[url.pathname][1]});return route.abort();
 });
 const url='https://zama.example/dot-authorize.html?'+new URLSearchParams({client_id:'fixture',redirect_uri:'https://chatgpt.com/cb',state:'fixture'});
 await page.goto(url);await page.waitForFunction(()=>!document.getElementById('allow').disabled);assert.equal(posts,0);assert.equal(await page.locator('#account img').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 mkdirSync('test-results/dot',{recursive:true});await page.screenshot({path:'test-results/dot/oauth-consent.png',fullPage:true});
 await page.locator('#allow').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Não foi possível'));assert.equal(posts,1);assert.equal(approval,true);assert.equal(await page.locator('#allow').isDisabled(),true);
 await page.reload();await page.waitForFunction(()=>!document.getElementById('deny').disabled);assert.equal(posts,1);await page.locator('#deny').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Não foi possível'));assert.equal(posts,2);assert.equal(approval,false);
 session=false;await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Entre na conta'));assert.equal(await page.locator('#allow').isDisabled(),true);assert.equal(posts,2);
 } finally {await browser.close();}
});
