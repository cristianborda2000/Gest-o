# JARVIS — texto, voz e notícias

## Atualização: agendamento, fluidez e fones Apple

### Lembrete individual solicitado ao JARVIS

“Agendar reunião amanhã às 10, me avisar 15 min antes” usa um único compromisso,
com `reminder_minutes: 15` no schema e `reminderMinutes: 15` no registro existente.
O retorno confirma 10:00 e o lembrete às 09:45 calculado em São Paulo, sem modificar
preferências globais. Criar e editar aceitam 0–1440 minutos, -1 para desativar e
null para voltar à configuração geral. Sem horário, o agente deve pedir esse
detalhe antes de definir um lembrete individual. Consultas retornam antecedência,
data/horário calculados e a condição de entrega com aplicativo aberto.

Isso não implementa Web Push. No iPhone, aplicativo suspenso/tela bloqueada não
tem entrega garantida pela rotina atual. Instalar a PWA sozinho não resolve:
continua necessário implementar inscrições, envio no servidor e agendamento
fora da página. Não foi criada uma reunião na conta de produção durante o teste.

No conjunto informado, iPhone 14 Pro Max + AirPods Pro 3, conferir iOS 26 ou mais
recente, conectar os fones antes de abrir o JARVIS e selecionar AirPods como saída
na Central de Controle se necessário. O botão de fala permanece na tela da ZAMA;
a haste dos AirPods não é um acionador do JARVIS. A compatibilidade física e a
qualidade de captação precisam ser verificadas no aparelho.
[Apple: configuração dos AirPods](https://support.apple.com/pt-br/104989),
[Apple: modelos com iOS 26](https://support.apple.com/pt-br/123705),
[WebKit: Web Push no iPhone](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

O servidor reconhece pedidos explícitos como “coloca na agenda”, “marca uma
reunião” e “me lembra amanhã”, também em espanhol. A resposta a uma pergunta de
esclarecimento pode completar o pedido anterior durante até 30 minutos e quatro
detalhes consecutivos. Perguntas educativas, cancelamento e “sim” isolado não
autorizam uma criação. A confirmação financeira continua exclusivamente no botão.

Criações simples respondem com um recibo dos dados gravados (título, dia, horário
e recorrência), eliminando a segunda chamada à IA que apenas redigia o sucesso.
O frontend atualiza o seletor com a conversa já recebida, sem buscar o histórico
novamente após cada envio. Não foi medido um tempo de resposta na conta real;
rede, transcrição, modelo e busca externa ainda influenciam a espera.

A voz padrão agora é Cedar. Se `OPENAI_JARVIS_VOICE` já existir na Vercel, seu
valor prevalece: use `cedar`, publique novamente e toque em **Desligar voz** antes
de iniciar outra sessão. Nenhuma mudança de chave é necessária.

Para Safari/iPhone e AirPods, o cliente usa `navigator.audioSession` quando
disponível para alternar captura/reprodução, restaura o modo anterior ao sair e
trata interrupção por outros apps, desconexão de fone e constraints incompatíveis.
Não mantém o microfone aberto para preservar a rota Bluetooth. A seleção de saída
permanece com o sistema operacional; não controla Siri ou o botão físico do fone.
Valide com o fone conectado antes de abrir o microfone, teste ouvir/gravar duas
vezes, retirar/reconectar o fone e voltar de outra aplicação. Testes automatizados
simulam essas condições; não substituem o teste físico em iPhone/AirPods.

## Notícias do dia

Use o atalho **Notícias** ou pergunte “Quais as notícias de hoje?” e “Notícias de
tecnologia”. A ferramenta de leitura `get_daily_news` aceita apenas categorias
geral, Brasil, mundo, economia/negócios ou tecnologia. Faz uma chamada Responses
com `web_search` obrigatório, data de São Paulo, até duas chamadas de busca e
resumo de até três notícias. O conteúdo mantém as citações verificadas, exibidas
como links junto ao texto e como lista de fontes; ficam salvas no histórico.

A busca recebe somente categoria pública fixa, data e horário. Não recebe o
histórico privado, financeiro, agenda, memórias ou uma consulta livre. Páginas
externas não voltam ao ciclo de ferramentas empresariais: o boletim é anexado ao
final, preservando suas citações. Sem busca concluída e fontes válidas, retorna
erro explícito, sem notícias fictícias. A voz narra o texto; os links ficam na tela.

Não há cache de notícias nem envio automático. A busca usa a chave existente,
precisa de acesso ao `web_search` no modelo configurado e gera consumo adicional
na OpenAI. `/api/jarvis/usage` inclui `news_metrics`: requests, erros, tokens,
chamadas de busca e latência mensais por modelo, separados das métricas do chat.
Esse contador não é uma fatura nem estima o custo de busca/áudio.

Arquivos novos desta atualização: `services/jarvis/intent.js`,
`services/jarvis/news.js`, `tests/jarvis-news.test.js`. Alterados: agente, tools,
configuração e HTTP em `services/jarvis`, cliente de chat e voz em `app/assets/js`,
CSS do JARVIS, versão dos assets em `app/index.html`, testes de backend/banco e
browser, `.env.example`, script de testes e este documento. Nenhuma migration ou
biblioteca adicional: os campos privados de auditoria e métricas usam a estrutura
JSON e as permissões existentes.

Referências: [OpenAI — busca na web](https://developers.openai.com/api/docs/guides/tools-web-search),
[OpenAI — vozes Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations),
[MDN — AudioSession](https://developer.mozilla.org/en-US/docs/Web/API/AudioSession).

O JARVIS foi acrescentado ao projeto existente. O código usa a API oficial da
OpenAI e o Supabase real; não há respostas, usuários ou registros fictícios como
fallback em produção. **A ativação depende das variáveis de servidor e da migration.**
Essa configuração é feita no ambiente de hospedagem e no Supabase, separadamente
da publicação do código. Não é aplicada automaticamente pelo deploy.

## Digitação, envio e voz

O campo de mensagem aceita rascunhos durante o carregamento e também quando a
integração está indisponível. O rascunho é mantido ao atualizar a conexão ou trocar
entre a página e o painel do JARVIS, dentro da mesma sessão da página; não é salvo
no banco antes do envio. O botão Enviar só é liberado após carregar a configuração,
o resumo e o histórico, com a integração habilitada e uma mensagem preenchida.
Escrever um rascunho não chama a OpenAI nem altera registros.

Ao enviar, a mensagem aparece imediatamente com o estado “Enviando”, sem afirmar
que já foi salva. O campo continua disponível para preparar o próximo rascunho;
o próximo envio aguarda a resposta atual. O tamanho do campo acompanha o texto,
e atualizações preservam cursor e posição de leitura. Se a resposta não chegar,
“Tentar novamente” reutiliza o mesmo identificador. Uma falha ao atualizar o
histórico depois de receber a resposta não oferece repetir a ação já recebida.
Essas melhorias reduzem esperas na interface; não simulam streaming nem alteram
o tempo de processamento do modelo.

O microfone usa a API Realtime da OpenAI por WebRTC, com credencial efêmera emitida
no servidor. Requer `JARVIS_VOICE_ENABLED=true` e `OPENAI_JARVIS_VOICE_MODEL`.
Com a voz desativada, o botão explica a configuração sem solicitar permissão.
O modelo de texto continua em `OPENAI_JARVIS_MODEL`; não substitua esse valor pelo
modelo de áudio. A chave da OpenAI existente é reutilizada somente no servidor.

Próximo passo de ativação: aplicar a migration aditiva abaixo, configurar as
credenciais exclusivas do servidor e o modelo, habilitar `JARVIS_ENABLED` e
reiniciar o servidor local (ou publicar novamente na Vercel). Validar então, com
uma conta real, consulta financeira, tarefa, ideia e confirmação de uma única
despesa. Os testes automatizados usam respostas controladas de IA/API e não
substituem essa validação conectada.

O usuário confirmou que o texto funciona na conta real antes da implementação de
voz. A experiência usa dois toques: tocar para falar e tocar em **Enviar áudio**.
Após entender o áudio, o mesmo agente de texto processa a transcrição. A resposta
salva aparece na conversa e é narrada pela voz. É possível interromper a fala.

## Análise da arquitetura anterior

| Área | Estrutura encontrada e preservada |
| --- | --- |
| Frontend | HTML, scripts globais JavaScript, Tailwind e Vite; sem React/Next/router |
| Backend | Supabase Auth, PostgREST e Realtime; publicação estática na Vercel, sem APIs próprias |
| Banco/client | PostgreSQL, `@supabase/supabase-js`, sem ORM |
| Isolamento | Uma linha `app_state(user_id, data jsonb, updated_at)` por conta, RLS por `auth.uid()` |
| Financeiro | `data.financeiro`, valores assinados legados + centavos; investimentos em `data.investimentos` |
| Tarefas/agenda | `data.agenda`, recorrências e exceções por dia; fuso America/Sao_Paulo |
| Ideias | `data.ideias`, etapas, arquivo e vínculo com agenda |
| Módulos retirados | Arrays `clientes`, `mensalidades`, `projetos`, `marketing`, `rh` preservados no banco e backup |
| Design | `ceo.css`, cartões, botões, diálogos, menu preto e conteúdo claro |
| Mobile anterior | Responsivo, worker de notificações; não havia manifest PWA |

Clientes, mensalidades, projetos, Marketing e equipe saíram da navegação e das
rotas acessíveis. Eles não são ferramentas do agente. As categorias financeiras
Marketing/Produto continuam disponíveis. Recebimentos antigos vinculados a
mensalidades permanecem nos totais e no backup, com edição na origem desativada.

## Arquitetura acrescentada

```text
jarvis.js (sessão Supabase existente)
    → /api/jarvis/* (Node, autentica access token no Supabase)
    → services/jarvis/agent.js (SDK oficial OpenAI Responses)
    → tools.js (registry fechado + validação Zod)
    → ceo-finance / ceo-agenda / ceo-ideas (mesmas regras do frontend)
    → repository.js → RPC transacional → PostgreSQL
```

O SDK `openai` foi escolhido para a execução explícita e limitada de function
calling. O projeto não usa TypeScript nem precisava de múltiplos agentes ou de
uma segunda camada de orquestração. Por isso, `@openai/agents` não foi acrescentado
como dependência redundante. Zod valida os argumentos no servidor, mesmo quando
vierem de uma chamada estruturada. O modelo é definido somente por configuração.

## Arquivos desta entrega

Criados:

- `api/jarvis.js`: entrada da função Vercel.
- `services/jarvis/{agent,config,errors,http,repository,tools}.js`.
- `services/jarvis/voice.js`, `app/assets/js/jarvis-voice.js`,
  `app/assets/jarvis-voice.css` e testes `jarvis-voice.test.js`/`jarvis-voice.spec.js`.
- `app/assets/js/jarvis.js`, `app/assets/jarvis.css`.
- `app/manifest.webmanifest`, `app/icons/zama-{180,192,512}.png`.
- `scripts/dev.mjs`: Vite e API na mesma origem local.
- `.env.example`: configuração de servidor, sem segredos.
- `database/migrations/20260930_jarvis.sql`.
- `tests/jarvis-{agent,database,domain}.test.js` e `tests/browser/jarvis.spec.js`.
- Este guia.

Modificados:

- `app/index.html`: acesso global, navegação JARVIS, manifest e estilos.
- `app/assets/js/{boot,core,ceo-shell}.js`: integração de sessão e navegação.
- `app/assets/js/ceo-agenda.js`: `saveTask` compartilhado e exportação Node.
- `app/assets/js/ceo-finance.js`: tratamento do histórico de mensalidades.
- `package.json`, `package-lock.json`, `.gitignore`, `vercel.json`.
- `tests/ceo-finance.test.js`, `tests/browser/mock-supabase.js` e
  `tests/browser/workspace.spec.js`.
- `README.md`, `app/README.md` e `docs/CENTRAL-CEO.md` para apontar a configuração atual.

A pasta de trabalho já continha a reformulação da Central CEO antes do JARVIS.
O diff geral também inclui esses arquivos; nenhuma dessas alterações foi descartada.

## Migration e persistência

Execute **somente** `database/migrations/20260930_jarvis.sql` no SQL Editor do
Supabase do mesmo projeto usado pelo frontend. A migration é aditiva e repetível.
Não execute `database/supabase-setup.sql`: o script antigo contém `DROP TABLE`.

A migration cria:

- `jarvis_accounts`: linha privada por usuário. Seu JSON contém `conversations`,
  `messages`, `actions`, `memories`, `requests` e `metrics`.
- `jarvis_rate_limits`: contadores persistentes por conta/janela.
- `jarvis_commit`: transação que grava histórico/auditoria e, quando necessário,
  altera o `app_state` existente de forma atômica.
- `jarvis_consume_rate`: rate limiting atômico.

O formato JSON acompanha a convenção do projeto. O histórico do JARVIS fica
separado do `app_state` para não ser apagado por um backup administrativo antigo.
Consequentemente, **Exportar/Importar dados e Limpar tudo do administrativo não
incluem nem apagam as conversas/auditoria do JARVIS**. O histórico deve fazer parte
dos backups do PostgreSQL. Exportação/arquivamento de conversas pela UI ainda não
foi implementado.

RPCs e tabelas JARVIS são inacessíveis às roles `anon`/`authenticated`; somente a
API de servidor pode acessá-las. O `user_id` vem do JWT validado e é a partição de
todos os objetos. Não existem tabelas financeiras paralelas.

## Variáveis e ativação

Node 22 ou superior. Localmente copie `.env.example` para `.env`, na raiz, e
configure os valores por um editor seguro. Nunca coloque chaves no chat, no
`app/assets/js/env.js`, em variáveis `VITE_*` ou no Git.

| Variável | Uso |
| --- | --- |
| `SUPABASE_URL` | URL do mesmo projeto Supabase do frontend |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave exclusiva do servidor; necessária às RPCs privadas |
| `OPENAI_API_KEY` | Chave da API OpenAI, exclusiva do servidor |
| `OPENAI_JARVIS_MODEL` | Modelo disponível na conta, compatível com Responses e function calling |
| `APP_ORIGIN` | `https://www.zam4.com` em produção |
| `JARVIS_ENABLED` | `true` após configurar e aplicar a migration; padrão desativado |
| `JARVIS_MEMORY_ENABLED` | `true` para permitir memórias explícitas; padrão desativado |
| `JARVIS_VOICE_ENABLED` | `true` para habilitar voz após configurar modelo; padrão `false` |
| `OPENAI_JARVIS_VOICE_MODEL` | Modelo Realtime disponível no projeto OpenAI, por exemplo `gpt-realtime` |
| `OPENAI_JARVIS_VOICE` | Voz opcional; padrão `cedar`. Encerre a sessão de voz anterior após alterar. |
| `JARVIS_NEWS_ENABLED` | Notícias com busca pública; padrão `true`. `false` desativa. |
| `OPENAI_JARVIS_NEWS_MODEL` | Opcional: modelo Responses com `web_search`; usa o modelo de texto quando vazio. |
| `OPENAI_JARVIS_TRANSCRIPTION_MODEL` | Transcrição opcional; padrão `gpt-4o-mini-transcribe` |
| `JARVIS_VOICE_REQUESTS_PER_MINUTE` | Emissões de credenciais por conta/minuto; padrão 3, teto 10 |
| `JARVIS_VOICE_REQUESTS_PER_DAY` | Emissões por conta/janela de 24 horas; padrão 30, teto 200 |
| `JARVIS_MAX_TOOL_CALLS` | Limite por execução; padrão 6, teto 10, até 5 rodadas de modelo |
| `JARVIS_REQUESTS_PER_MINUTE` | Padrão 10 mensagens por conta/minuto |
| `JARVIS_REQUESTS_PER_DAY` | Padrão 200 mensagens por conta/janela de 24 horas |
| `OPENAI_JARVIS_INPUT_USD_PER_MILLION` | Preço opcional para estimativa de custo |
| `OPENAI_JARVIS_OUTPUT_USD_PER_MILLION` | Preço opcional para estimativa de custo |

Depois reinicie:

```powershell
npm.cmd install
npm.cmd run serve
```

Abra `http://localhost:5174/?view=jarvis` e entre com a conta existente.
No Vercel, cadastre as variáveis no ambiente correto e publique o repositório com
a raiz de projeto atual. `vercel.json` mantém `app` como saída estática e encaminha
`/api/jarvis/*` à função Node. O plano deve permitir a duração configurada de 180s.
Não hospede a pasta `services` como arquivo público. Após o deploy, uma consulta
sem sessão a `/api/jarvis/config` deve retornar HTTP 401 com JSON; HTTP 404 indica
que a função ainda não está publicada. Esse teste confirma a publicação da API,
mas não valida credenciais, migration ou uma conversa autenticada com a OpenAI.

## Ferramentas e endpoints

| Grupo | Tools disponíveis |
| --- | --- |
| Leitura | `get_today_summary`, `list_tasks`, `get_agenda`, `get_financial_summary`, `search_ideas`, `get_daily_news` (quando habilitada) |
| Escrita | `create_task`, `create_agenda_event`, `update_task`, `complete_task`, `save_idea` |
| Com confirmação | `register_expense`, `register_income` |
| Memória opcional | `save_memory`, `search_memories` |

As ferramentas de clientes, follow-up de clientes e projetos não são registradas,
conforme a remoção solicitada. O agente não oferece exclusão de dados nem edição
financeira. Eventos e tarefas usam a mesma agenda. A edição pelo JARVIS de tarefas
recorrentes afeta somente a ocorrência identificada; edição da série permanece
no editor da agenda. Datas relativas são resolvidas em São Paulo; “sexta” significa
a próxima sexta (se já é sexta, a da semana seguinte). Sem horário, a tarefa fica
sem hora definida. Se faltar título/contexto, o agente deve perguntar.

Todos os endpoints exigem `Authorization: Bearer <sessão Supabase>`:

```text
GET    /api/jarvis/config
GET    /api/jarvis/summary
GET    /api/jarvis/conversations
GET    /api/jarvis/conversations/:id
POST   /api/jarvis/message
POST   /api/jarvis/actions/:id/confirm  { "confirmation": true }
POST   /api/jarvis/actions/:id/cancel   {}
GET    /api/jarvis/memories
DELETE /api/jarvis/memories/:id        (desativa, não apaga)
GET    /api/jarvis/usage
POST   /api/jarvis/realtime/token      {} (credencial efêmera de voz)
```

Envio: `{message, request_id: UUID, conversation_id?: UUID}`. O frontend mantém
o mesmo `request_id` ao tentar novamente. Campos extras como `user_id` são rejeitados.

## Fluxo de segurança

1. API valida o access token no Supabase; não aceita identidade escolhida pelo
   modelo ou frontend. Conferência de origem, limite de corpo e `no-store`.
2. Limites persistentes entre instâncias serverless: 120 requisições por minuto
   para os endpoints operacionais, além dos limites específicos de mensagens.
   `/config` exige autenticação, mas não usa o contador do banco.
3. Registry fechado e schemas estritos. A IA não recebe cliente Supabase, chave,
   SQL nem ferramentas de confirmação. Pedidos de escrita precisam também de
   intenção explícita na mensagem atual; dados retornados não autorizam ações.
4. Para editar/concluir uma tarefa, seu ID deve ter sido obtido por consulta na
   mesma execução. Dados de negócio são consultados; memória não substitui saldo.
5. Despesas/entradas passam por validação completa e ficam `pending`, com data e
   valor fixados no cartão. Somente o botão de confirmação envia o booleano
   exigido. “Sim”, “ok”, argumentos adicionais e confirmação por ferramenta não
   executam a ação. A proposta expira em 24 horas.
6. A transação usa lock e revisão da conta JARVIS + `updated_at` do administrativo.
   Grava lançamento e auditoria juntos. Em conflito, refaz sobre os dados atuais.
   Confirmação repetida devolve o resultado existente. Cancelada não executa.
7. Cada ação guarda ID, conversa, requisição, ferramenta, argumentos validados,
   resultado/status e data de confirmação. A movimentação recebe `jarvisActionId`.
   Assim é possível rastrear a origem pelo histórico da conversa e pela auditoria.
8. Sem retry automático do provedor. Requisições encerradas são reapresentadas;
   execução interrompida não reinicia escritas escondidas. O histórico alerta
   sobre ações parciais já executadas. Mensagens com padrões de credenciais são
   rejeitadas; logs operacionais não imprimem prompt, token ou corpo do provedor.

Contexto limitado às últimas 12 mensagens, até 16 mil caracteres de histórico,
resultados resumidos e orçamento de 80 mil caracteres por chamada. Consultas
retornam até 50 itens, com indicação de truncamento; o modelo recebe trechos ainda
menores. Não é enviado o banco inteiro. Conversas têm até 200 mensagens; a conta
tem limite de 8 MiB de histórico, sem exclusão automática da auditoria. Ao atingir
o limite, é necessário um procedimento de arquivamento administrativo.

Memórias são explícitas e podem ser desativadas na interface. Scopes inicial:
`personal`/`company`, sempre privados à conta; `project`/`client` foram omitidos
porque esses módulos foram retirados.

## Custos e observabilidade

`GET /usage` mostra métricas mensais por modelo: mensagens processadas, erros,
latência acumulada, tools e tokens informados pela OpenAI. Preços configuráveis
produzem estimativa em USD, sem confundir ausência de preço com custo zero.
Não contempla descontos de tokens em cache, impostos ou câmbio. A fatura da
OpenAI é a referência. A função usa `store: false`; a persistência da conversa
é responsabilidade do Supabase, respeitadas as políticas do provedor.

## PWA e voz

Manifest, ícones PNG/maskable, Apple touch icon e display standalone adicionados.
O worker existente continua sem cache de documentos/APIs: sempre se usa a rede,
evitando manter uma versão antiga do administrativo. Não existe suporte offline
de dados autenticados. A instalação depende de HTTPS e dos critérios do navegador;
iPhone usa “Adicionar à Tela de Início”. Instalação física em iOS/Android não foi
verificada nesta máquina.

Em **Configurações → Instalar ZAMA**, o navegador abre o pedido de instalação
quando disponível. Caso contrário, a interface apresenta as instruções para a
plataforma. A instalação só é solicitada após o clique; o botão fica oculto ao
receber a confirmação do navegador ou ao abrir em modo aplicativo.

- Android: abra `https://www.zam4.com` no Chrome, menu ⋮, “Instalar aplicativo”
  ou “Adicionar à tela inicial”, e confirme.
- iPhone/iPad: abra o endereço no Safari, Compartilhar, “Adicionar à Tela de
  Início”, ative “Abrir como App da Web” se aparecer e toque em Adicionar.
- Computador: use o mesmo botão nas Configurações ou a opção de instalação do
  Chrome/Edge. O aplicativo precisa de internet para conversar e sincronizar.

Implementação: `app/assets/js/pwa-install.js`, `app/assets/pwa-install.css` e
referências em `app/index.html`. Testes em `tests/browser/pwa.spec.js` simulam
disponibilidade, recusa, instalação concluída, modo standalone e instruções
iOS/Android; não instalam um aplicativo físico. Nenhuma migration ou variável
de ambiente nova é necessária para essas melhorias de interface.

### Ativar e usar a voz

1. Na Vercel, em **Environment Variables / Production**, acrescentar
   `JARVIS_VOICE_ENABLED=true` e `OPENAI_JARVIS_VOICE_MODEL=gpt-realtime` (ou outro
   modelo Realtime habilitado no projeto OpenAI). Manter as credenciais atuais.
2. Publicar novamente, abrir a ZAMA por HTTPS, entrar e atualizar o JARVIS.
3. Tocar no microfone, permitir o acesso, falar e tocar em **Enviar áudio**.
4. Conferir a transcrição, a resposta por texto e a narração. Se o navegador
   bloquear o áudio, tocar em **Ouvir resposta**. Esse botão regenera somente a
   narração da resposta já salva; não repete ferramentas ou ações de negócio.
5. Usar **Interromper resposta** para parar a fala ou **Desligar voz** para fechar
   a conexão. Tarefas e ideias seguem as mesmas regras do texto; despesas e
   entradas continuam dependendo do cartão **Confirmar**.

A interface mostra microfone desligado, conexão, gravação, transcrição, consulta
e fala. Ao terminar a gravação, as faixas do microfone são paradas fisicamente.
Também são encerradas ao sair da conta, navegar para outro módulo sem o painel
aberto, fechar o painel, colocar o aplicativo em segundo plano ou perder a
conexão. Gravações têm limite de 60 segundos; sessão de 5 minutos e pausa de um
minuto encerram a conexão. Não há wake word nem escuta contínua.

### Fluxo e limites de segurança da voz

O backend valida a sessão Supabase e a origem, exige JSON vazio e aplica limites
persistentes antes de chamar `realtime.clientSecrets.create` pelo SDK oficial já
instalado. Modelo e voz são configurados no servidor. A resposta contém somente
credencial efêmera, validade, identificador da sessão e limites de interface.
A chave principal nunca é enviada ao navegador. Não há SQL, cliente Supabase
privilegiado ou ferramenta de negócio na sessão Realtime.

A transcrição final é enviada sem reconstrução pelo modelo ao `/message` atual.
Cada turno usa um UUID, repetido em retries; eventos de transcrição duplicados não
criam novos envios. O agente existente continua validando intenção, autorização,
schemas e transações. Respostas espontâneas do Realtime não são usadas para ações.
A narração recebe somente o texto da resposta do backend, com `conversation:none`
e ferramentas desativadas. Um “sim” falado não confirma uma movimentação.

Áudio é transmitido à OpenAI para processamento. A ZAMA não salva gravações de
áudio; salva as transcrições e respostas no histórico normal. A UI identifica a
voz como gerada por IA. A pronúncia e a fidelidade da narração devem ser conferidas
com o modelo real, especialmente em valores e datas; o registro na tela continua
disponível. Envio de arquivos de áudio já gravados não faz parte desta entrega.

`GET /usage` inclui `voice_metrics` mensais por modelo: requisições de credenciais,
emissões, erros, limites atingidos e latência. Esses contadores não medem tokens,
minutos ou custo de áudio. O uso de transcrição/Realtime e do agente de texto
gera consumo separado na OpenAI; a fatura do provedor é a referência.

A credencial efêmera tem 60 segundos de validade **para novas conexões**. Essa
validade não encerra uma conexão já aberta. Os limites de duração são controles
da aplicação no navegador, não um teto rígido de gasto: um cliente modificado pode
alterar parâmetros Realtime ou reutilizar a credencial enquanto válida. Limites
de emissão e controles de gasto no projeto OpenAI complementam a proteção. As
regras de autorização e confirmação do ERP ficam no backend e não dependem desses
controles do cliente. Controle duradouro de sessões por conexão sideband não foi
acrescentado à função serverless.

Nenhuma migration nova ou biblioteca extra é necessária para a voz. As métricas
usam o JSON privado existente com a mesma transação e permissões.

## Validações e teste manual

```powershell
npm.cmd test
npm.cmd run test:browser
npm.cmd run build:css
```

As novas suites cobrem domínio, schemas, fuso, registros antigos, confirmação,
cancelamento, idempotência, contas distintas, memória explícita, falhas e segredo
ausente no frontend. Testes de banco executam a migration e PL/pgSQL reais em
PostgreSQL local via PGlite, incluindo rollback, CAS, permissões, RLS e o caminho
agente → tools → confirmação → banco. O provedor OpenAI é simulado nesses testes.
Os testes de browser também simulam a API/Supabase e bloqueiam o banco de produção.
Isso valida o código e a interface, não a disponibilidade de uma conta OpenAI ou
o comportamento linguístico de um modelo real.

Após a ativação, validar em uma conta de teste:

1. “Quanto gastei este mês?” — conferir com Financeiro no mesmo período.
2. “Crie uma tarefa para amanhã às 9h para finalizar a proposta.” — conferir na
   Agenda; atualizar a página e conferir novamente.
3. “Salve a ideia de criar um programa de indicação.” — conferir em Ideias.
4. “Registra R$350 de marketing.” — não pode aparecer no financeiro antes da
   confirmação. Confirmar uma vez, recarregar histórico, repetir request: deve
   continuar uma única despesa. Testar também Cancelar.
5. Entrar com uma segunda conta e tentar abrir IDs da primeira: deve retornar 404.
6. Testar memória explícita, desativação e acesso por outro dispositivo.
7. Verificar a chave somente no servidor, logs sem conteúdo sensível, limite de
   uso, instalação PWA e telas com teclado de iPhone/Android reais.
8. Ativar voz, falar “Quanto gastei este mês?” e conferir a resposta com Financeiro.
   Criar uma tarefa por áudio e verificar Agenda. Falar uma despesa e confirmar
   que apenas o clique no cartão executa. Testar permissão negada, interrupção e
   desligamento ao fechar/colocar o aplicativo em segundo plano.

Os testes automatizados de voz simulam transporte WebRTC, microfone, respostas
OpenAI e banco. Eles verificam segurança e fluxo, mas não validam captação física,
entendimento linguístico, pronúncia ou acesso do projeto OpenAI ao modelo. Esses
pontos exigem o teste acima com a conta real em Safari/iPhone e Chrome/Android.

## Dependências e limites da entrega

- Migration e variáveis de servidor precisam ser configuradas no ambiente real;
  o deploy do código não cria essas configurações nem executa a migration.
- Nenhuma chamada real de inferência ou gravação financeira de produção foi feita.
- Push com aplicativo fechado, wake word, exportação/arquivamento de
  conversas e painel visual de custos não estão implementados.
- Publicação e ativação são etapas distintas: verificar a API após o deploy e
  validar a conversa com uma sessão real após configurar banco e credenciais.
- O armazenamento JSON privado simplifica a integração atual, mas deve evoluir
  para tabelas relacionais/arquivo quando o volume de conversas crescer.
- Como qualquer agente generativo, a interpretação deve ser validada com o modelo
  escolhido. Confirmações, autorização, schema, idempotência e transações são
  controles de código/banco e não dependem da obediência do modelo ao prompt.
- Auditoria de dependências de produção (`npm audit --omit=dev`) passou sem
  vulnerabilidades encontradas; o audit completo apontou alertas na cadeia de
  ferramentas de desenvolvimento já existente, a revisar separadamente.

Referências oficiais usadas na implementação:
[OpenAI — function calling](https://developers.openai.com/api/docs/guides/function-calling),
[OpenAI — Realtime](https://developers.openai.com/api/docs/guides/realtime),
[OpenAI — WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc),
[OpenAI — conversas Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations),
[Apple — aplicativo da web no iPhone](https://support.apple.com/pt-br/guide/iphone/iphea86e5236/ios),
[Google — instalar aplicativos da web](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=pt-BR),
[PGlite — API PostgreSQL local](https://pglite.dev/docs/api).
