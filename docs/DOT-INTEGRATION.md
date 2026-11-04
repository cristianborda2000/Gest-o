# Integração privada dot / ZAM4

Revisão local de 2026-11-04, baseada no pacote `zama-dot-v0.2.1-auth-review.zip`. Código integrado ao repositório e validado com 90 testes. A conexão remota ainda não foi publicada nem instalada. Nenhuma credencial foi criada e nenhuma migration foi aplicada no banco hospedado.

## Funcionalidades

Sete ferramentas: `list_tasks`, `get_agenda`, `search_ideas`, `create_task`, `create_agenda_event`, `save_idea` e `prepare_expense`. Reutilizam as regras e o repositório do JARVIS, sem uma segunda chamada à OpenAI. Não expõem exclusão, equipe, receitas, confirmação financeira ou o financeiro completo.

Tarefas e compromissos com horário aceitam `reminder_minutes: 60`. Datas relativas usam `America/Sao_Paulo`. A antecedência salva depende da infraestrutura de Web Push para entregar o aviso; não cria lembretes no chat do dot.

## Componentes

| Componente | Função |
| --- | --- |
| `api/dot-mcp.js`, `services/dot/mcp-http.js` | MCP remoto por HTTPS, respostas JSON sem estado |
| `services/dot/private-runtime.js`, `api-key-auth.js`, `guarded-repository.js` | Chave dedicada, autorização por ferramenta e verificação transacional da concessão |
| `database/migrations/20261104_dot_grants.sql` | Concessões privadas e commit protegido; depende da migration JARVIS existente |
| `api/dot.js`, `services/dot/http.js` | API com sessão humana, incluindo consulta e decisão da proposta |
| `app/dot-confirm.html` e assets | Revisão e confirmação financeira pelo usuário |
| `services/dot/service.js` | Recibos, validação, idempotência e propostas |
| `plugin/zama-private-remote` | Rascunho remoto; ainda sem `mcp.json` instalável |
| `plugin/zama-private` | Protótipo stdio local com sessão temporária; não é a conexão remota proposta |

Os dois endpoints também estão registrados em `scripts/dev.mjs`. O `vercel.json` protege a página de confirmação contra enquadramento e cache.

## Autenticação e preservação dos dados

O MCP remoto exige uma chave opaca dedicada de 256 bits, armazenada somente como hash no banco. A cada chamada verifica proprietário, cliente, URL exata, ferramentas, validade e revogação. JWT de conta Supabase não serve como chave do plugin. A chave de serviço existente permanece exclusivamente no servidor.

Operações passam pelo repositório transacional existente; não substituem o estado completo por uma cópia importada do pacote. A migration nova é aditiva e não insere concessões. Não executar o setup legado. A revisão remove explicitamente privilégios de escrita herdados pelo `service_role` na nova tabela de concessões.

Cada chamada exige `request_id` UUID. Repetir o identificador e os mesmos argumentos recupera o recibo; mudar o conteúdo gera conflito. Consultas atualizadas precisam de um novo identificador. Auditoria e alterações usam o commit atômico do JARVIS; no transporte remoto, a concessão é verificada novamente sob bloqueio de linha antes do commit. Uma operação que obteve o bloqueio antes da revogação pode terminar; operações posteriores à revogação não aceitam a versão antiga.

Os limites de armazenamento do JARVIS continuam aplicáveis. O backup administrativo de `app_state` não inclui toda a auditoria; manter o backup do PostgreSQL.

## Confirmação financeira

`prepare_expense` salva somente uma proposta e retorna `/dot-confirm.html?action=...`. O usuário revisa e decide na página, autenticado na mesma conta. O plugin não tem ferramenta de confirmação. A API humana exige sessão Supabase e origem válida; ela não aceita a chave opaca do plugin.

Abrir ou recarregar a página não lança a despesa. Confirmação inclui digest dos dados revisados e validade de 24 horas. Em erro incerto, a página consulta o resultado sem repetir automaticamente o POST. A verificação de Origin protege o navegador, mas não é prova criptográfica de clique humano para quem já detenha a sessão completa da conta.

## Ativação e testes

`DOT_MCP_ENABLED` controla o MCP remoto. `DOT_ENABLED` controla a API humana e deve ser ativado também para que os links de confirmação funcionem. Ambos ficam desativados por padrão. As tabelas/RPCs do JARVIS são necessárias; não é preciso ativar a interface JARVIS nem fornecer uma nova chave OpenAI.

Consulte [ativação e aprovações](DOT-AUTH-ACTIVATION.md), [plano de conexão](DOT-CONNECTION-PLAN.md), [transporte remoto](DOT-REMOTE.md) e [resultado dos testes](DOT-TEST-REPORT.md). A validação local não comprova conexão instalada no dot nem entrega real no aparelho.
