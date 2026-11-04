'use strict';
const {createClient}=require('@supabase/supabase-js');
const {createMcpHandler}=require('./mcp-http');
const {createApiKeyAuthenticator,createGrantStore}=require('./api-key-auth');
const {createGuardedRepository}=require('./guarded-repository');
const {configuration:oauthConfiguration}=require('./oauth');
// Factory for the API entrypoint. Disabled by default; no server is started on import.
function createPrivateMcpHandler({env=process.env,client}={}) {
 if(env.DOT_MCP_ENABLED!=='true')return createMcpHandler();
 try {
  const resource=new URL(env.DOT_MCP_RESOURCE),appOrigin=new URL(env.APP_ORIGIN);
  if(resource.protocol!=='https:'||resource.origin!==appOrigin.origin||appOrigin.origin!==env.APP_ORIGIN||resource.search||resource.hash||resource.username||resource.password)throw new Error();
  const db=client||createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const config={enabled:true,ownerId:env.DOT_OWNER_ID,clientId:env.DOT_MCP_CLIENT_ID,resource:env.DOT_MCP_RESOURCE,appOrigin:env.APP_ORIGIN,allowedOrigins:[env.APP_ORIGIN]};
  if(oauthConfiguration(env)) config.oauthMetadata=`${config.appOrigin}/.well-known/oauth-protected-resource`;
  const authenticate=createApiKeyAuthenticator({store:createGrantStore(db),ownerId:config.ownerId,clientId:config.clientId,resource:config.resource});
  return createMcpHandler({config,authenticate,repositoryFactory:principal=>createGuardedRepository(db,principal)});
 }catch{return createMcpHandler();}
}
module.exports={createPrivateMcpHandler};
