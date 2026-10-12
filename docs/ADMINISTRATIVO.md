# Central administrativa — melhorias de outubro de 2026

O Jarvis permanece oculto por padrão. As mudanças preservam os registros existentes e não publicam nem alteram a base hospedada automaticamente.

## Uso diário

- **Financeiro:** indicadores acompanham período, categoria, tipo, situação e pesquisa. O aviso de pendências anteriores abre todas as contas vencidas. A baixa pede a data real do pagamento/recebimento, usada no caixa.
- **Gastos fixos:** em Financeiro → Gastos fixos, escolha a competência e revise “Gerar contas do mês”. É possível vincular uma saída já cadastrada, inclusive já paga. Cada gasto gera uma única parcela por mês. Pagamentos e cancelamentos são preservados; dia 31 é ajustado ao último dia do mês. Cadastro de uma nova despesa permite gerar a competência atual. A leitura da tela não cria lançamentos e não retroage meses automaticamente.
- **Agenda:** a previsão de gasto fixo desaparece quando existe a parcela correspondente, inclusive depois de paga/cancelada. Lembretes no aplicativo aberto continuam disponíveis para contas com permissão de edição; o acesso somente leitura não altera os recibos compartilhados.
- **Backup e relatórios:** Configurações separa “Baixar backup completo”, “Restaurar backup” e “Relatórios mensais”. Relatório mensal não é aceito como restauração. Há prévia de contagens e confirmação digitada, com cópia anterior baixada antes de restaurar. Relatório exporta CSV compatível com Excel, JSON e impressão/Salvar como PDF. O mês é escolhido explicitamente. Consulte [BACKUPS-RELATORIOS.md](BACKUPS-RELATORIOS.md).
- **Sessão:** sair da conta limpa as telas e formulários de todas as abas notificadas pelo Auth. Respostas atrasadas e assinaturas antigas não podem restaurar o estado da sessão anterior. O cache é separado por usuário e empresa.

## Acesso de equipe

1. Faça um backup completo e aplique somente a migração aditiva `database/migrations/20261005_workspaces.sql` no SQL Editor do Supabase, como proprietário do projeto. Ela usa a tabela `app_state` existente. Não execute o instalador legado `supabase-setup.sql` em uma base com dados.
2. Publique o frontend atualizado. A aplicação detecta a disponibilidade das funções. `workspaceEnabled: false` em `window.ZAMA_CONFIG` desliga a interface de compartilhamento, sem remover vínculos no banco. O padrão é tentar detectar o recurso e manter a conta pessoal funcional quando a migração ainda não foi aplicada.
3. Salve os dados da empresa e confirme o e-mail da conta proprietária.
4. Em Configurações → Empresa e equipe, gere o convite para um e-mail e escolha **Somente leitura** ou **Pode editar**. Copie o link e envie ao destinatário por seu canal habitual. O aplicativo não envia esse convite por e-mail automaticamente.
5. O destinatário abre o link, entra ou cria uma conta com o mesmo e-mail confirmado e clica **Aceitar convite** nas configurações. O link expira em sete dias. Gerar outro convite para o mesmo e-mail revoga os anteriores ainda pendentes.

| Permissão | Acesso |
|---|---|
| Proprietário | Consulta, edição, exportação, restauração e gestão de membros/convites |
| Pode editar | Consulta e edição dos registros da empresa, incluindo exclusões e restauração |
| Somente leitura | Consulta e exportação; gravações bloqueadas no banco |

O proprietário pode alterar permissões, remover membros e revogar convites. Os dados continuam na linha do proprietário: não são copiados para a conta convidada. Cada usuário conserva também sua própria empresa. A transferência ou exclusão da linha de outra empresa é bloqueada no banco. Editores têm acesso amplo aos registros; não há permissões por módulo nem aprovação financeira nesta versão.

Troque a empresa pelo seletor das configurações. Ao voltar à janela ou a cada minuto enquanto aberta, a aplicação atualiza as permissões; uma revogação força o retorno à própria empresa e descarta edições locais. O banco já bloqueia novas operações assim que o vínculo é removido. Realtime de `app_state` deve continuar habilitado para sincronização das alterações de dados.

## Lembretes com o app fechado

O código de Web Push está implementado e testado com provedores simulados. A ativação real exige migração, chaves VAPID, segredo do cron e um agendador que chame o servidor a cada minuto. Sem essa configuração a interface mostra o recurso indisponível, sem prometer envio.

O escopo é a agenda pessoal. Trocar para uma empresa compartilhada desativa a inscrição deste navegador; ao voltar, ative novamente se desejar. Não há distribuição automática de lembretes para a equipe. Consulte [a configuração e os limites de entrega](lembretes-em-segundo-plano.md).

## Uso no celular

Na página inicial, as tarefas da semana aparecem primeiro no celular, agrupadas de segunda a domingo no horário de São Paulo. A lista inclui as ocorrências e exceções da agenda; editar ou concluir uma ocorrência preserva as demais. O seletor de mês financeiro não muda a semana exibida.

O cabeçalho separa o nome da empresa do título da página. O menu lateral tem botão de fechar, fechamento ao tocar fora e navegação por teclado; o conteúdo ao fundo fica inativo enquanto o menu está aberto. Trocar de módulo retorna ao início da página.

No financeiro, as movimentações e os gastos fixos aparecem como cartões no celular, com os mesmos valores e ações da tabela no computador. Campos de data, botões e formulários têm mais espaço. Configurações ocupa a tela e mantém o botão de fechar visível durante a rolagem. A agenda mostra a quantidade de tarefas no calendário e os detalhes no dia selecionado.

O formulário lateral da interface antiga e seu botão flutuante foram retirados. Os editores atuais de financeiro, investimentos, tarefas e ideias ocupam a tela do telefone: campos rolam em uma área própria, com cabeçalho e ações acessíveis. A altura acompanha o teclado pelo `visualViewport`. Falhas no salvamento mantêm os dados digitados para tentar novamente.

Os testes `mobile-layout.spec.js`, `mobile-settings.spec.js`, `mobile-forms.spec.js` e `overview-week.spec.js` verificam larguras de 320, 390 e 430 pixels, formulários em telas de 360 pixels de altura e a semana em São Paulo, com contas simuladas no Chromium. Isso verifica o layout e os fluxos, sem substituir uma conferência no aparelho real com teclado virtual e notificações autorizadas.

## Validação e publicação

```powershell
npm.cmd test
npm.cmd run test:browser
npm.cmd run build:css
```

Os testes usam contas, banco PostgreSQL WASM e APIs simulados; não alteram produção nem enviam notificações reais. Antes de ativar equipe ou push em produção, confira as migrações, permissões e configuração da hospedagem. Os arquivos SQL são reaplicáveis e preservam a tabela existente.

Referências de implementação: [eventos de autenticação do Supabase](https://supabase.com/docs/reference/javascript/auth-onauthstatechange), [funções do banco](https://supabase.com/docs/guides/database/functions) e [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
