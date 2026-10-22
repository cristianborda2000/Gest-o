# Arquitetura e manutenção do ZAMA

O ZAMA tem um frontend estático, APIs Node e banco Supabase. O Vite serve o
ambiente local; a Vercel publica `app/` e executa as funções de `api/`.
O JavaScript do navegador é carregado por scripts em ordem, sem empacotamento.

## Mapa do repositório

| Diretório | Responsabilidade |
| --- | --- |
| `app/` | HTML, estilos, módulos do navegador, imagens e worker de notificações |
| `api/` | Entradas das funções da Vercel; delegam para os serviços |
| `services/` | Autenticação, validação e operações executadas no servidor |
| `database/migrations/` | Evolução incremental do banco e das permissões |
| `database/instalar-projetos.sql` | Instalador gerado a partir das migrations |
| `scripts/` | Servidor local, verificações e geração de arquivos |
| `tests/` | Testes de regras, persistência, APIs e banco PGlite |
| `tests/browser/` | Fluxos e layout em Chromium com contas/APIs simuladas |
| `docs/` | Guias de instalação, operação e manutenção |
| `releases/`, `shortcuts/` | Entregas históricas e atalhos locais |

`node_modules/`, `.playwright/`, `.npm-cache/`, `logs/` e `test-results*/` são
dependências ou resultados locais. Não são a fonte da aplicação.

## Frontend por responsabilidade

| Arquivo em `app/assets/js/` | Responsabilidade |
| --- | --- |
| `env.js`, `config.js` | Configuração pública, recursos habilitados, cliente Supabase e definições legadas |
| `core.js` | Estado, carregamento, revisão da nuvem e transações `ceoCommit` |
| `boot.js` | Inicialização, autenticação, eventos globais e configuração |
| `ceo-shell.js` | Navegação atual, visão geral e composição dos módulos |
| `ceo-time.js` | Datas da aplicação em `America/Sao_Paulo` |
| `finance-categories.js` | Regras de categorias financeiras |
| `ceo-finance.js` | Financeiro, investimentos, totais, filtros, gráficos e formulários |
| `ceo-agenda.js` | Tarefas, recorrência, ocorrências, calendário e diálogos |
| `ceo-ideas.js` | Ideias pessoais/compartilhadas e tarefas vinculadas |
| `admin-data.js` | Backups, restauração, relatórios e exportações |
| `workspaces.js` | Empresa selecionada, papel na equipe, convites e contexto |
| `project-data.js` | Regras puras: metadados permitidos, listas, status, telefone, links e mensagens de erro |
| `project-planning.js` | Progresso, prazos e ordenação de projetos/processos/etapas |
| `ceo-projects.js` | Quadro, formulários, RPCs, permissões, revisões e consulta temporária de senhas |
| `push-reminders.js` | Inscrição do dispositivo e integração com notificações |
| `jarvis.js`, `jarvis-voice.js` | Interface do assistente e sessão de voz |
| `mobile-forms.js`, `pwa-install.js` | Formulários em telas pequenas e instalação do aplicativo |
| `forms.js`, `records.js`, `table.js`, `dashboard.js`, `contracts.js` | Compatibilidade, renderização e operações dos registros legados |

Os arquivos legados ainda participam da inicialização e preservam clientes,
mensalidades, Marketing, RH e contratos. Retirar um botão da navegação não torna
automaticamente essas funções ou coleções descartáveis.

### Dependências de carregamento

`app/index.html` é a fonte da ordem de scripts. Ao acrescentar um módulo:

1. Carregue configuração antes dos consumidores.
2. Carregue regras antes das interfaces: `finance-categories` antes de
   `ceo-finance`; `project-data` e `project-planning` antes de `ceo-projects`.
3. Mantenha `core` antes dos módulos que usam estado e `ceoCommit`.
4. Mantenha `boot` depois dos módulos que ele inicializa.
5. Atualize a versão `?v=` dos scripts/estilos alterados antes da publicação.

As regras puras exportam APIs `Zama*` no navegador; algumas também usam
`module.exports` para testes no Node. Elas não devem consultar DOM, sessão ou
rede. Os controladores cuidam dessas integrações.

### Fluxo de gravação

Para dados administrativos, use `ceoCommit(mutator, mensagem)`: ele trabalha em
uma cópia, grava com controle de revisão e só então publica o novo estado.
Não altere `state` antes da confirmação do banco. Um segundo envio durante uma
gravação deve manter o rascunho, sem modificar a cópia confirmada.

Operações assíncronas pertencem à conta, empresa e sessão que as iniciaram.
Respostas atrasadas não podem restaurar conteúdo após logout/troca de empresa,
nem fechar um diálogo diferente daquele que iniciou a operação.

Projetos usam RPCs próprias e revisão incremental. Ideias compartilhadas também
usam RPCs próprias. Não inclua essas gravações no backup geral de `app_state`.

## Onde os dados ficam

| Dados | Persistência e acesso |
| --- | --- |
| Financeiro, investimentos, empresa e registros legados | `app_state`, com revisão `updated_at` e acesso do proprietário |
| Agenda | Linha pessoal da conta, inclusive em uma empresa compartilhada |
| Ideias da equipe | RPCs da empresa; preservam os dados privados dos demais módulos |
| Projetos, processos e etapas | Tabelas/RPCs próprias; membros confirmados da empresa |
| Senhas de clientes | Cifradas no banco; consulta separada para administrador ou responsável autorizado |
| Modelos de produção | Estrutura de listas/etapas; sem dados específicos do projeto |
| Cache do navegador | Separado por conta e empresa; não substitui o banco como fonte de verdade |

O backup administrativo JSON não contém projetos, modelos nem senhas de clientes.
Veja [Projetos](PROJETOS.md) para contratos, migrations e recuperação.

## CSS e arquivos públicos

`styles.input.css` é a fonte Tailwind da base legada. `styles.css` é gerado por
`npm run build:css` e importado por `legacy.css` em uma camada de baixa prioridade.

O visual atual usa `ceo.css` e folhas específicas: `finance.css`,
`ceo-agenda.css`, `ceo-ideas.css`, `ceo-projects.css`, `admin.css`, `mobile.css`,
`overview-week.css` e estilos de JARVIS/PWA. Edite a folha do módulo; não edite
`styles.css` diretamente nem adicione regras do módulo ao HTML.

Somente arquivos de `app/` são públicos. Configurações do navegador contêm valores
públicos. Chaves administrativas e de provedores ficam no ambiente do servidor,
conforme `.env.example` e os guias de cada serviço.

## Serviços e APIs

| Entrada | Serviço | Papel |
| --- | --- | --- |
| `api/jarvis.js` | `services/jarvis/` | Assistente, ferramentas autorizadas, confirmações, notícias e voz |
| `api/reminders.js` | `services/reminders/http.js` | Configuração e inscrição de notificações |
| `api/reminder-cron.js` | `services/reminders/dispatcher.js` | Entrega agendada e prevenção de duplicatas |
| `api/project-access.js` | `services/project-access/` | Cadastro de acesso pelo administrador autorizado |

`services/http/read-json-body.js` reúne a leitura de JSON com limite de bytes.
Cada serviço fornece seus limites e erros. O helper junta os bytes antes de
decodificar UTF-8 para preservar acentos divididos entre pacotes de rede.

Autorização, validação de domínio e persistência continuam nos respectivos
serviços. O usuário é derivado da sessão validada; um identificador no corpo da
requisição não concede acesso a outra conta. As entradas `api/` permanecem
pequenas e o servidor local reutiliza os mesmos handlers.

## Verificar e publicar

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:browser
npm.cmd run build
```

- `check`: sintaxe JS, referências locais do HTML/imports CSS e instalador SQL.
- `test`: descobre todos os arquivos `tests/*.test.js`, incluindo testes novos.
- `test:admin` e `test:jarvis`: grupos para validações focadas.
- `test:browser`: navegação, persistência, sessão, permissões e layout. Inicia
  o servidor na porta 5174 ou reutiliza o servidor existente.
- `build`: verificações estáticas e geração do CSS; usado pela Vercel.

Os testes usam dados fictícios, APIs simuladas e PostgreSQL WASM. Não gravam na
conta de produção. Uma reorganização deve preservar contratos e ser validada
pelos fluxos afetados. Mudanças no salvamento exigem verificar falha, concorrência
e troca de sessão, além do caminho de sucesso.

Publicar código não aplica SQL no Supabase. Depois de editar migrations, execute
`npm run build:projects-sql` e siga o guia do módulo para ativá-las. O instalador
legado `database/supabase-setup.sql` contém operações destrutivas e não deve ser
usado para atualizar uma instalação existente.

## Guias complementares

- [Central CEO: financeiro, investimentos, agenda e ideias](CENTRAL-CEO.md)
- [Projetos, processos e acesso da equipe](PROJETOS.md)
- [Administração, backups, sessão e relatórios](ADMINISTRATIVO.md)
- [JARVIS: configuração, ferramentas e limites](JARVIS.md)
- [Lembretes em segundo plano](lembretes-em-segundo-plano.md)
