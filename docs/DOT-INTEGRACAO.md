# Integração Dot / ZAM4

O servidor privado está em `/api/dot-mcp`. A descoberta OAuth está em
`/.well-known/oauth-authorization-server` e `/.well-known/oauth-protected-resource`.
A conta proprietária autoriza a conexão na página `dot-authorize.html`.

## Contrato em produção

OAuth V2 usa PKCE, acesso de até uma hora, renovação com sete dias de inatividade
e limite absoluto de 30 dias. Os metadados anunciam `authorization_code`,
`refresh_token`, `zama_refresh_version: 2` e a política de duração.
A rota `/api/dot-oauth/revoke` permite revogação pelo cliente.

O escopo básico é `zama:private`. A permissão adicional `zama:expenses:write`
habilita `record_expense` somente quando concedida pelo proprietário e quando a
flag do servidor está ativa. O status pago/pendente é obrigatório. Propostas
continuam exigindo confirmação pelo proprietário. Renovar não amplia permissões.

## Publicação e regressão de 11/11/2026

Uma publicação pelo Git substituiu código OAuth V2 publicado anteriormente por
upload de arquivos por uma versão antiga do repositório. Isso removia renovação,
rejeitava concessões com `record_expense` e retornava `invalid_request` para
autorização com os dois escopos. O código restaurado veio da fonte conferida do
deployment anterior, preservando as melhorias mobile.

Antes de publicar, compare a versão e os recursos do backend ativo com os do
commit, inclusive em mudanças apenas visuais. Publique a partir da fonte
versionada e mantenha nela correções feitas por outros meios.

Execute `npm test` e `npm run build`. Os testes `dot-oauth-v2-*`, `dot-direct-*`,
`dot-refresh` e os testes de consentimento exercitam autorização, renovação,
expiração, revogação, escopos e isolamento com dados fictícios locais.

Depois da publicação, confira os metadados, a abertura do consentimento para
ambos os escopos e a rejeição de MCP sem credencial. A validação final é uma
consulta pela conexão do host. Se o host exigir reautenticação, o proprietário
deve usar **Reconectar** na conexão ZAM4 e aprovar o fluxo no navegador. Nunca
copiar tokens do navegador nem mudar concessões para contornar esse passo.

As migrations OAuth, despesas diretas, refresh V1 e refresh V2 já estavam
aplicadas em produção antes deste reparo. Os SQL restaurados no repositório
servem também às fixtures de testes; não devem ser reaplicados no banco existente.
Publicar o site não executa esses SQL.
