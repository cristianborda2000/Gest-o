# Central ZAMA — gestão e rotina

Atualizacao JARVIS: clientes, mensalidades, projetos, Marketing e equipe foram retirados da interface. Dados historicos preservados. Consulte [JARVIS.md](JARVIS.md) para a arquitetura e configuracao atuais. As descricoes de navegacao legada abaixo pertencem a entrega anterior.

A central evolui o frontend existente (HTML, JavaScript global, Vite e Tailwind),
mantendo Supabase Auth, recuperação de senha, RLS por `auth.uid() = user_id`,
tabela `app_state`, Realtime, clientes, mensalidades, projetos, marketing,
equipe e contratos. Não foram criados usuários, dados de exemplo ou registros
financeiros na conta de produção durante a implementação.

## Como usar

- **Visão geral:** escolha o mês para ver entradas recebidas, saídas pagas,
  saldo e investimentos realizados. Tarefas usam a data atual de São Paulo;
  ideias mostram as capturas mais recentes. Marque a tarefa para concluir ou
  clique no título para editar.
- **Financeiro:** cadastre movimentos, filtre datas, categoria, tipo ou situação,
  e consulte contas a pagar/receber. A data de liquidação determina o mês do
  caixa; o vencimento determina o período das pendências. Gastos fixos continuam
  acessíveis. Recebimentos de mensalidades são editados na origem.
- **Investimentos:** diferencie Planejado, Realizado e Cancelado. Um investimento
  pode criar uma saída ou se vincular a uma saída existente. A mesma saída muda
  de pendente para paga quando o investimento é realizado. O investimento é
  mostrado separadamente como informação; o saldo subtrai apenas a saída.
  Desmarcar o vínculo permite registrar investimentos sem desembolso.
- **Agenda:** navegue pelos meses, clique em um dia e use o painel expandido.
  Configure título, descrição, hora, duração, prioridade, situação e recorrência.
  A edição/exclusão de uma tarefa recorrente permite escolher uma ocorrência
  ou a série. A conclusão vale só para aquela ocorrência. Recorrência mensal
  no dia 31 usa o último dia nos meses mais curtos. Vencimentos financeiros
  aparecem separadamente das tarefas.
- **Ideias:** capture, pesquise, filtre, mova entre etapas e arquive/restaure.
  Criar tarefa pede data e horário, mantém os dois registros vinculados e
  impede conversões duplicadas.

## Dados e compatibilidade

Os novos campos são acrescentados ao JSON da linha já pertencente à conta:
`investimentos`, `ideias`, `agendaSettings`, `reminderReceipts` e metadados das
tarefas. IDs, observações, campos antigos e vínculos são preservados. As
exceções de recorrência são registradas em `agenda[].exceptions`; não são
criadas centenas de tarefas repetidas. Valores do financeiro mantêm `valor`
assinado por compatibilidade, com cálculos e novos registros em centavos
inteiros. Cancelados ficam fora dos totais.

Não é necessária migração SQL para esta versão. **Não execute o antigo
`database/supabase-setup.sql` em um projeto com dados: ele contém DROP TABLE.**
Continue usando a tabela e as políticas já instaladas. A coluna `updated_at`
e o gatilho existentes são usados para rejeitar sobrescritas concorrentes.
Se outra aba/dispositivo alterar os dados enquanto um formulário estiver
aberto, uma gravação obsoleta é rejeitada; atualize a página e refaça a edição.

Uma falha de carregamento mostra erro com botão de tentar novamente. Não é
enviada automaticamente uma cópia local antiga ao banco. Gravações só são
confirmadas após resposta da nuvem; erros preservam o formulário. O cache é
separado por usuário. Se existir o cache antigo, sem identificação de conta,
Configurações oferece **Baixar backup local anterior**. Confira o arquivo antes
de usar Importar dados; a importação substitui os registros e pede confirmação.
Exportar dados continua gerando um backup completo, incluindo os novos módulos.

## Lembretes e dependências

Tudo usa **America/Sao_Paulo**, independentemente do fuso do aparelho.
Em Agenda → Configurar, ative as notificações e escolha o resumo diário
(padrão 08:00) e a antecedência (padrão 15 minutos). É possível desativar cada
tipo ou substituir a antecedência em uma tarefa. A permissão só é solicitada
quando o usuário salva a ativação. É necessário HTTPS (ou localhost),
permissão do navegador e conexão com o Supabase.

O aplicativo verifica os lembretes a cada 20 segundos enquanto está aberto.
Um registro de entrega em `app_state.reminderReceipts`, protegido por revisão,
evita envio duplicado entre dispositivos; armazenamento local e Web Locks
reforçam a deduplicação entre abas. Antes do envio, o banco é consultado para
validar se a tarefa ainda está pendente e no mesmo horário. Há uma tolerância
de um minuto: lembretes antigos perdidos com o aplicativo fechado não são
enviados em lote ao reabrir. Sem rede, a entrega não é garantida.

O `notification-worker.js` oferece exibição de notificações nos navegadores
móveis que exigem service worker. Se o navegador não conseguir exibir a
notificação, o aplicativo mostra um aviso interno. O navegador/SO pode limitar
timers de abas em segundo plano ou suspensas.

**Envio com o aplicativo fechado ainda depende de infraestrutura adicional:**
um agendador no servidor (por exemplo Supabase Cron/Edge Function) e um serviço
de Web Push ou de e-mail com credenciais e inscrições por usuário. O worker
desta versão não agenda tarefas nem substitui esse serviço. Nenhum e-mail de
lembrete é enviado atualmente.

Para recuperação de senha em produção, mantenha no Supabase:

- Site URL: `https://www.zam4.com/`
- Redirect URLs: `https://www.zam4.com/?reset=password`

## Manutenção e validação

Os arquivos `ceo-time.js`, `ceo-finance.js`, `ceo-agenda.js`, `ceo-ideas.js` e
`ceo-shell.js` são carregados antes de `boot.js`. `core.js` continua responsável
pelo estado e pela gravação. `ceoCommit()` salva uma cópia isolada e só publica
a alteração na tela após sucesso no Supabase.

O tema fica em `ceo.css`, com estilos específicos de agenda e ideias. As regras
dos componentes legados ficam na camada CSS `legacy`, importada por
`legacy.css`. Overrides antigos de tema e layout móvel foram removidos;
`styles.input.css` ainda gera `styles.css` via Tailwind.

```sh
npm test
npm run test:browser
npm run build:css
```

Os testes de navegador usam Playwright/Chromium com Supabase simulado e rede
de produção bloqueada: não precisam de senha nem alteram a conta real.
Instale o Chromium do Playwright em `.playwright` antes de executá-los.
Os cenários cobrem centavos, cancelamentos, vínculos de investimentos,
recorrências/exceções, horários, lembretes, conflito entre dispositivos,
erros/repetição de salvamento, ideias convertidas e recarga da página.
As telas são verificadas em computador e celular com capturas em `test-results`.

Referências técnicas:
[Supabase: updates com filtros](https://supabase.com/docs/reference/javascript/update)
e [MDN: notificações](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API).
