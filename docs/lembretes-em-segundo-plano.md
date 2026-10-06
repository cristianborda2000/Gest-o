# Lembretes com o aplicativo fechado

O código contém envio Web Push pelo servidor, inscrição por navegador, revogação no logout e um worker que exibe as notificações. O recurso fica **desativado por padrão**. Nenhuma chave, migração, agendamento externo ou notificação real foi configurada por esta implementação.

## Ativação no ambiente hospedado

1. Aplique **somente** `database/migrations/20261005_reminders.sql` no projeto Supabase existente. A migração é aditiva e pode ser reaplicada; não execute `database/supabase-setup.sql`, que é um procedimento legado destrutivo.
2. Gere uma única vez um par VAPID com `npx web-push generate-vapid-keys --json`, em um terminal privado. Guarde a chave privada no gerenciador de segredos da hospedagem; não a copie para arquivos de frontend, Git ou logs.
3. Configure as variáveis de servidor abaixo. `APP_ORIGIN` deve ser a origem HTTPS exata, sem barra final. A chave pública pode ser entregue ao navegador; as demais credenciais permanecem no servidor.

```dotenv
PUSH_REMINDERS_ENABLED=false
SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
APP_ORIGIN=https://www.zam4.com
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:SEU_EMAIL_DE_CONTATO
CRON_SECRET=
```

4. Gere `CRON_SECRET` aleatório com pelo menos 32 caracteres e configure um agendador para chamar `GET /api/reminder-cron` **a cada minuto**, com o cabeçalho `Authorization: Bearer <CRON_SECRET>`. Use o gerenciador de segredos do agendador; o token não deve aparecer na URL. O código não instala um cron automaticamente. Em Vercel, confirme se o plano permite essa frequência; caso contrário, use um agendador externo. Cron diário não atende este recurso.
5. Publique as funções `/api/reminders` e `/api/reminder-cron`, o worker e os scripts. Somente depois de validar a infraestrutura, mude `PUSH_REMINDERS_ENABLED=true` e faça o deploy correspondente. Configuração incompleta mantém o recurso indisponível, mesmo com a flag ligada.
6. Entre na conta pessoal, ative as preferências em **Agenda → Configurar**, configure uma tarefa futura e clique **Ativar neste dispositivo** na agenda ou nas configurações da conta. Aceite a permissão do navegador. Faça a verificação de entrega com um dispositivo de teste autorizado, após a ativação real do ambiente.

## Comportamento e limites

- O horário é calculado com `America/Sao_Paulo`, pelos mesmos helpers da agenda aberta. O servidor considera os dois minutos mais recentes; não envia uma fila antiga de tarefas perdidas durante uma indisponibilidade.
- A agenda pessoal é o escopo desta versão. Inscrições pertencem ao usuário autenticado; o cliente não escolhe outro proprietário. Em um espaço compartilhado, a UI explica que o envio com o app fechado está disponível apenas na agenda pessoal. A integração deve revogar a inscrição ao trocar de espaço e permitir nova ativação ao retornar à conta pessoal.
- Cada lembrete é reivindicado uma única vez por conta. Ele chega ao aplicativo aberto que reivindicar primeiro ou ao último navegador explicitamente ativado para Web Push. Não é uma transmissão para todos os dispositivos. Cada navegador precisa de consentimento próprio.
- Uma função SQL bloqueia e verifica a revisão de `app_state` e grava no mesmo `reminderReceipts` usado pelo aplicativo aberto. Isso evita que cron simultâneo, duas abas e um novo dispositivo dupliquem o aviso. Tarefas concluídas, excluídas, reagendadas e preferências desligadas são reavaliadas antes da reivindicação. Uma mensagem já aceita pelo provedor não pode ser retirada; sua validade é curta.
- A confirmação do provedor indica **aceitação**, não comprova a exibição na tela. Entrega depende do navegador, sistema operacional, conexão, modo de economia de bateria e permissões. No iOS/iPadOS, use o aplicativo instalado na Tela de Início quando o navegador exigir isso.
- A aplicação registra a reivindicação antes do envio. Se o processo cair nesse intervalo ou houver timeout incerto do provedor, o aviso pode ser perdido; não há repetição automática que possa gerar um aviso duplicado. Erros definitivos `404/410` removem a inscrição expirada e permitem tentar o próximo navegador válido dentro da mesma execução.
- O worker armazena apenas um marcador de conta, sem token de sessão. O logout primeiro limpa esse marcador e tenta revogar a inscrição no navegador e no servidor. Se o navegador recusar a revogação, a tentativa no servidor e o fechamento das notificações continuam, sem bloquear o logout; se a API estiver indisponível, a revogação local ainda é tentada. A revogação depende da disponibilidade de cada serviço. Um payload de outra conta, sem marcador ativo ou vencido não é exibido.
- A implementação aceita serviços Web Push conhecidos de Chrome/Edge, Firefox e Safari, exige HTTPS e valida endereços DNS no momento da conexão. Novos provedores devem ser incluídos por alteração de código revisada; a API não é um webhook aberto.

## Operação

`GET /api/reminders?path=config` expõe apenas disponibilidade e chave VAPID pública. Inscrição, consulta de estado e exclusão exigem um access token Supabase válido. As tabelas e funções de envio não ficam acessíveis ao papel anônimo nem diretamente ao navegador.

O cron responde apenas contagens (`accounts`, `accepted`, `skipped`, `expired`, `failed`, `truncated`), sem títulos, URLs de assinatura ou credenciais. Monitore respostas `207/503`, falhas, duração e `truncated=true`; este último requer elevar a capacidade ou dividir o processamento antes de aumentar a base. O limite de execução permite término previsível, mas pode deixar contas sem processamento se a capacidade for excedida. Mantenha o agendador com tentativas frequentes, sem reexecutar payloads diretamente.

Ao trocar as chaves VAPID, publique o novo par junto, reinicie as funções e peça a cada usuário para ativar novamente. A identificação da chave impede uso de inscrições vinculadas à chave anterior. Mantenha o mesmo par em deploys comuns. Há limite de dez inscrições por conta; desative dispositivos antigos antes de cadastrar outros.

## Integração e verificação local

- Carregue `assets/js/push-reminders.js` antes de `boot.js`.
- Chame `ZamaPushReminders.init()` depois de carregar a sessão e os dados. A UI monta automaticamente em `.za-reminders` e `#settingsPanel .settings-content`; opcionalmente use `mount(container)`.
- Antes de `signOut` e antes de trocar de espaço, aguarde `disconnect()` para revogar com a sessão capturada. Ao receber `SIGNED_OUT` de outra aba, chame `reset()` imediatamente: ele invalida as operações locais de forma síncrona e inicia a limpeza do worker/inscrição, sem depender de um token expirado. A limpeza é serializada; `init()` aguarda seu término antes de inicializar uma nova conta. Reinicialize após a nova sessão/espaço.
- O servidor local deve encaminhar `/api/reminders` para `services/reminders/http.createHandler()` e `/api/reminder-cron` para `services/reminders/dispatcher.createHandler()`; o frontend usa o parâmetro `?path=`, dispensando rewrite para subrotas.
- Execute `node --test tests/push-reminders.test.js tests/push-reminders-worker.test.js tests/push-reminders-client.test.js`. Os testes usam chaves efêmeras, remetente simulado e PostgreSQL WASM descartável. Não acessam a base hospedada e não enviam notificações.

Documentação consultada: [biblioteca web-push](https://github.com/web-push-libs/web-push), [PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe), [Web Push da Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
