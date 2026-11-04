# Autenticação privada e ativação — revisão local de 2026-11-04

## Implementado e verificado localmente

Provedor de API key opaca dedicada, sem emissão ou renovação automática. O formato contém um identificador público de concessão e um segredo de 256 bits. O banco recebe apenas SHA-256 do token inteiro; a comparação usa timingSafeEqual. Fixtures fixas, públicas e sem utilidade externa foram usadas nos testes; nenhuma credencial foi gerada ou provisionada.

Cada pedido consulta a concessão: proprietário, aplicativo, recurso exato, ferramentas permitidas, início, expiração e revogação. JWT de conta Supabase não é aceito como chave do plugin. O runtime usa as credenciais existentes de servidor apenas internamente. Chave do plugin não pode acessar diretamente Supabase, confirmar despesas nem emitir novas chaves.

A migration proposta cria dot_api_grants, com RLS e sem acesso para anon/authenticated. O papel service_role pode consultar a concessão, mas não inserir/alterar/excluir. Somente o administrador do banco provisiona ou revoga. Atualizações incrementam a versão. Uma função SQL verifica concessão e versão na mesma transação da gravação e registra grant_id, grant_version e client_id na auditoria.

Revogação e commit são serializados por bloqueio de linha: uma operação que ganhou o bloqueio antes da revogação pode terminar; depois do commit da revogação, nenhuma transação posterior aceita a concessão anterior. Não é possível desfazer ações já concluídas. Uma proposta de despesa previamente criada continua sujeita à confirmação humana da conta ZAMA; revogar o plugin não apaga propostas ou registros.

O módulo private-runtime conecta autenticação, repositório protegido e transporte. api/dot-mcp.js é a entrada para Vercel e permanece desabilitada por padrão. As alterações foram integradas ao repositório local, sem publicação. Não há conexão real estabelecida. A revisão corrigiu privilégios herdados na migration; ver [testes](DOT-TEST-REPORT.md).

## Destinos identificados e pontos ainda desconhecidos

- A origem canônica observada é https://www.zam4.com; zam4.com redireciona para ela. O commit de produção anterior tem deploys de três projetos Vercel: gest-o, gest-o-24mq e gest-o-bpu4, na equipe cristhian-borda-s-projects. Não existe .vercel/project.json nesta cópia. Confirmar no painel qual projeto atende o domínio e qual plano está ativo.
- A configuração pública do site publicado aponta para o projeto Supabase rtiwoctipvlsejxcptks (https://rtiwoctipvlsejxcptks.supabase.co). Isso identifica o alvo esperado, mas não comprova autorização administrativa. Falta confirmar o UUID do proprietário e o schema no painel autorizado.
- Há arquivos locais de configuração de Web Push, VAPID e cron. Somente a existência foi verificada: conteúdo secreto não foi aberto ou copiado. Não gerar ou rotacionar novas chaves antes de verificar com segurança se as existentes já estão implantadas.
- GET público de /api/reminders?path=config retornou HTTP 200, enabled=true, origem canônica e chave pública presente. Não foram verificados agendador, dispositivo, preferências ou entrega real.
- Os conectores Vercel/Supabase foram sugeridos, mas ainda não estão disponíveis nesta sessão. A consulta do navegador falhou na inicialização do runtime. Acesso aos painéis corretos é necessário para inspecionar o ambiente real.

## Aprovações pontuais para a próxima etapa

1. **Supabase do projeto confirmado:** aplicar apenas database/migrations/20261104_dot_grants.sql após revisão e backup operacional. É migration nova, sem inserts de concessões ou mudanças em dados existentes. Não executar o setup legado. A aplicação deve ser controlada pelo histórico de migrations; esta migration não é um script para execução repetida.
2. **Supabase e conexão privada do dot:** aprovar uma chave dedicada à conta do proprietário, ao clientId escolhido e à URL MCP canônica verificada. Permissões propostas: list_tasks, get_agenda, search_ideas, create_task, create_agenda_event, save_idea e prepare_expense. Sem confirmação financeira, exclusão ou equipe. Proposta inicial: validade de 7 dias para validação, sem renovação automática; confirmar o prazo antes de emitir. Gerar em ambiente privado, gravar somente hash no banco e inserir o segredo exclusivamente no campo protegido da conexão do host. Não enviar pelo chat, ZIP, arquivo de frontend ou log. Depois, descartar a cópia transitória.
3. **Projeto Vercel confirmado:** publicar os arquivos revisados inicialmente desativados. Após aprovação das mudanças de acesso, configurar DOT_MCP_ENABLED=true para o MCP e DOT_ENABLED=true para a API humana de confirmação, além de DOT_OWNER_ID, DOT_MCP_CLIENT_ID, DOT_MCP_RESOURCE e APP_ORIGIN. Sem DOT_ENABLED, os links de propostas financeiras não funcionam. Reutilizar SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY exclusivamente no servidor, sem expor ao dot. Configurar limite de requisições antes da autenticação e conferir Host/proxy/TLS. URL proposta: https://www.zam4.com/api/dot-mcp, ainda não publicada/verificada.
4. **Conta/workspace do dot:** substituir mcp.json.template pela URL verificada, salvar o plugin privado e conectar via API key no fluxo protegido suportado pelo host. A sessão atual ainda não comprovou esse fluxo instalado. Se o host exigir OAuth, não usar cabeçalhos estáticos no pacote: implementar OAuth2.1/PKCE e descoberta como trabalho adicional.
5. **Lembretes no ZAMA:** verificar se a migration de lembretes já está aplicada, se VAPID/CRON_SECRET existentes são válidos e qual agendador está ativo. Aprovar somente mudanças faltantes (flag, cron, assinatura do dispositivo). Confirmar canal iPhone Web Push e fuso America/Sao_Paulo, usado atualmente no código, antes do teste real. Alterar plano ou contratar agendador requer decisão separada.

## Revogação e recuperação

Revogar uma concessão pelo administrador do Supabase definindo revoked_at; o gatilho incrementa a versão. Não apagar dados do usuário. Desabilitar DOT_MCP_ENABLED bloqueia o endpoint inteiro. A chave dedicada não deve ser aceita pelo endpoint humano /api/dot?operation=decide. Rotação futura exige nova aprovação e invalidação da concessão antiga. O gerenciamento administrativo ainda é pelo banco; não foi criada tela ou API pública de emissão/revogação.

## iPhone: o que já existe e como ativar

O código tem manifest com display standalone, worker, inscrição PushManager e chamada de permissão diretamente no toque do usuário. O painel diferencia servidor indisponível, agenda pausada e aparelho não ativado. A documentação do WebKit confirma Web Push para aplicativos da Tela de Início no iOS/iPadOS 16.4 ou posterior, com autorização após interação do usuário: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ .

Após validar o servidor: abrir a origem oficial no Safari, adicionar o ZAMA à Tela de Início, abrir pelo ícone e entrar na conta pessoal. Em Agenda → Configurar, ativar lembretes da agenda e avisos de tarefas. Tocar em Ativar neste dispositivo e aceitar o diálogo do iOS. Cadastrar um compromisso futuro com antecedência de 60 minutos e confirmar a entrega no aparelho; resposta de aceitação do provedor não é prova de exibição. Verificar também ajustes de Notificações/Foco. Essa etapa depende de ação no iPhone e não foi executada.

O dispatcher existente exige chamada a cada minuto, considera janela de dois minutos e pode perder avisos durante indisponibilidade. Apenas o último dispositivo ativado é usado para Web Push, sujeito à reivindicação do aviso pelo aplicativo aberto. Não é transmissão a todos os aparelhos nem mensagem no chat do dot. A documentação Vercel limita Hobby a execução diária; Pro/Enterprise permitem minuto: https://vercel.com/docs/cron-jobs/usage-and-pricing . O plano desta conta é desconhecido.

## Evidências

90 testes passaram no repositório local, incluindo os 89 do pacote e a regressão de privilégios herdados pelo service_role. Cobertura de hash e principal sem segredo; rejeição de JWT/formato; expiração/escopos/conta/audience/versão; falha do armazenamento; persistência/auditoria/retry em PostgreSQL local; revogação entre autenticação e commit incluindo replay; privilégios SQL; runtime com concessão fictícia no banco descartável. Build aprovado. Ver [relatório e reprodução](DOT-TEST-REPORT.md).

Limites: nenhum teste com dot instalado, API key real, produção, iPhone físico ou provedor push real. PGlite testa lógica SQL e privilégios, mas não substitui teste de concorrência entre múltiplas conexões em PostgreSQL hospedado, nem revisão independente de segurança. Escopo é conta pessoal do proprietário.
