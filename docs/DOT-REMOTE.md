# MCP remoto

Estado em 2026-11-04: transporte, autenticação por chave dedicada e commit protegido implementados localmente. Endpoint ainda não publicado nem conectado ao host. O rascunho `plugin/zama-private-remote` não deve ser instalado até sua URL e o fluxo de autenticação serem verificados.

## Transporte implementado

`api/dot-mcp.js` usa `services/dot/private-runtime.js`. Implementa o subconjunto Streamable HTTP sem estado com respostas JSON: `initialize`, `ping`, `tools/list` e `tools/call`. Notificações aceitas recebem 202; GET e DELETE autenticados recebem 405. Não oferece SSE, MCP Events ou avisos espontâneos. Versões: `2025-03-26`, `2025-06-18`, `2025-11-25`.

Valida Host, caminho exato, Origin quando presente, tamanho, Content-Type, Accept e versão. O recurso proposto é `https://www.zam4.com/api/dot-mcp`, ainda sujeito à verificação do projeto e do deploy. `/api/dot` é REST para a sessão humana, não a URL de conexão MCP.

O provedor verifica a chave opaca por hash e consulta a concessão em cada chamada. Catálogo e execução respeitam as ferramentas autorizadas. O repositório verifica concessão e versão novamente na mesma transação da alteração. Não aceita JWT de conta como credencial remota. O desafio HTTP é Bearer; não existe implementação OAuth/PKCE ou descoberta OAuth nesta versão.

## Antes de ativar

1. Confirmar projeto Vercel que atende a origem canônica, projeto Supabase e proprietário. Revisar as migrations existentes sem executar o setup legado.
2. Obter aprovação para a migration de concessões, emissão da chave dedicada e configuração dos acessos. Ver [ativação](DOT-AUTH-ACTIVATION.md).
3. Configurar limite de requisições anterior à autenticação no provedor de hospedagem. O limite existente no repositório só atua após autenticar. Validar TLS e comportamento de Host/caminho no proxy real.
4. Confirmar que o host permite uma API key em campo protegido. Se exigir OAuth, implementar o fluxo adicional; não colocar cabeçalhos secretos no manifesto nem usar sessão ampla do proprietário.
5. Configurar as variáveis do servidor, incluindo as duas flags `DOT_MCP_ENABLED` e `DOT_ENABLED`, e verificar o endpoint publicado. Somente depois substituir `mcp.json.template` por `mcp.json` com a URL real.
6. Descobrir as sete ferramentas no host, testar leitura autorizada, negação e revogação. Escrita de teste e notificação real exigem um pedido específico.

## Lembretes

O transporte salva a antecedência; a entrega ocorre pela infraestrutura Web Push do ZAM4. O servidor público informa a flag de lembretes habilitada, mas cron, dispositivo e entrega ainda não foram confirmados. Para avisos no chat do dot seria necessária uma integração adicional de eventos ou automação; esta versão não a implementa.

Consulte [testes e limites](DOT-TEST-REPORT.md). Nenhum teste local usou chave real, banco hospedado, provedor push ou dot instalado.
