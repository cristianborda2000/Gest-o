# Arquitetura do ZAMA Admin

Este documento explica como o sistema esta organizado, onde cada parte vive e
qual caminho seguir para fazer manutencao sem quebrar as funcoes existentes.

## Visao geral

O ZAMA Admin e uma aplicacao frontend estatica servida pelo Vite. Ela usa:

- `index.html` para a estrutura base da tela.
- `assets/styles.input.css` como CSS fonte.
- `assets/styles.css` como CSS compilado pelo Tailwind.
- Arquivos JavaScript globais em `assets/js/`.
- `localStorage` como fallback local de dados.
- Supabase Auth + tabela `app_state` para salvar dados na nuvem quando o login esta ativo.

Nao existe bundler para os arquivos JS da aplicacao. O `index.html` carrega cada
script em ordem, e todos compartilham variaveis/funcoes globais.

## Ordem de carregamento

O `index.html` carrega os scripts nesta ordem:

```text
config.js
core.js
forms.js
dashboard.js
contracts.js
table.js
records.js
boot.js
```

Essa ordem importa. Por exemplo:

- `config.js` precisa vir primeiro porque define `modules`, Supabase e moeda.
- `records.js` define utilitarios usados por renderizacoes e eventos.
- `boot.js` vem por ultimo porque captura os elementos da tela e liga os eventos.

Se criar um arquivo novo, coloque-o antes de `boot.js` e depois dos arquivos que
ele depende.

## Mapa de arquivos

```text
outputs/zama-tailwind/
  index.html
    Estrutura principal: login, menu lateral, topbar, paineis e modais.

  README.md
    Guia rapido para rodar, publicar e entender o projeto.

  ARQUITETURA.md
    Este documento.

  zama-logo.png
    Logo usado na interface e no contrato/PDF.

  assets/
    styles.input.css
      Arquivo editavel de CSS. Sempre altere este arquivo.

    styles.css
      Arquivo gerado. Nao edite manualmente.

    gato-zama-green.mov
      Video usado pelo mascote do dashboard. O fundo verde e removido via canvas.

    js/
      config.js
      core.js
      forms.js
      dashboard.js
      contracts.js
      table.js
      records.js
      boot.js
```

## Responsabilidade de cada JS

### `config.js`

Define configuracoes e dados iniciais:

- `storageKey`: chave usada no `localStorage`.
- `cloudStateTable`: tabela do Supabase.
- `supabaseUrl` e `supabaseAnonKey`.
- `currency`: formatador de moeda em BRL.
- `defaultCompanyProfile`.
- `modules`: configuracao de cada modulo do sistema.

Quando quiser adicionar campo em formulario, status, labels ou dados exemplo,
comece por `modules`.

### `core.js`

Cuida do estado geral e da renderizacao principal:

- cria estado inicial;
- normaliza dados antigos;
- carrega dados locais ou Supabase;
- salva dados com `persist()`;
- alterna modulo com `goToModule()`;
- chama `render()`;
- monta os indicadores superiores com `renderStats()`;
- controla status de salvamento na nuvem.

Regra pratica: se o assunto for estado global, troca de modulo ou salvamento,
olhe primeiro este arquivo.

### `forms.js`

Monta formularios dinamicos a partir do `modules`.

Responsabilidades:

- descobrir qual lista esta ativa;
- renderizar campos do modulo;
- criar grupos visuais de campos;
- renderizar abas de financeiro e agenda.

Regra pratica: se quiser mudar como o formulario aparece, mexa aqui. Se quiser
mudar quais campos existem, mexa no `config.js`.

### `dashboard.js`

Monta a primeira tela do sistema:

- cards de metricas;
- hero do dashboard;
- grafico financeiro simples;
- alertas;
- tarefas de hoje;
- resumo de projetos e mensalidades;
- mascote com croma key em canvas.

O mascote usa `gato-zama-green.mov`. O video original nao aparece na tela: ele e
criado em memoria pelo JavaScript e seus frames sao desenhados no canvas com o
verde removido.

### `contracts.js`

Gera o contrato/PDF do cliente.

Fluxo:

1. Usuario clica em `PDF` na lista de clientes.
2. `printClientContract(client)` abre uma nova janela.
3. `registerContractHistory(client)` registra o historico do contrato.
4. `buildClientContractHtml(client, contractRecord)` gera o HTML do contrato.
5. O navegador chama `print()`.

As margens do PDF seguem ABNT:

```text
topo: 3cm
esquerda: 3cm
direita: 2cm
baixo: 2cm
```

### `table.js`

Renderiza listas, tabelas, cards, calendario e acoes de linha.

Responsabilidades:

- `renderTable()`: decide se mostra tabela, cards ou calendario.
- `renderCalendar()`: monta a visualizacao mensal da agenda.
- `renderRowActions()`: botoes editar, excluir, pagar, concluir e PDF.
- `openDetailPanel()`: painel lateral de detalhes.
- `renderFinanceSummary()`: resumo do modulo financeiro.

Regra pratica: se o assunto for "como aparece na lista", "calendario" ou "botoes
de acao", comece aqui.

### `records.js`

Contem as regras de negocio e utilitarios.

Principais regras:

- projeto gera entradas financeiras automaticas;
- mensalidade paga gera entrada financeira;
- cliente ativo cria/atualiza mensalidade;
- gastos fixos aparecem na agenda;
- vencimentos financeiros aparecem na agenda;
- status viram classes de cor;
- totais financeiros sao calculados aqui.

Regra pratica: se mudar uma regra automatica, mexa aqui e teste financeiro,
agenda e dashboard.

### `boot.js`

Inicializa tudo.

Responsabilidades:

- captura elementos do DOM;
- controla login;
- abre/fecha configuracoes;
- liga eventos dos botoes globais;
- importa/exporta backup;
- salva perfil da empresa;
- chama `initializeAuth()` no final.

Este arquivo depende de quase todos os outros, por isso fica por ultimo.

## Fluxo dos dados

```text
Usuario interage com formulario/botao
  -> boot.js ou table.js recebe evento
  -> records.js aplica regras de negocio
  -> persist() em core.js salva estado
  -> render() em core.js redesenha a tela
  -> dashboard/table/forms exibem a versao atual
```

## Estado principal

A variavel global `state` guarda quase tudo:

```text
state = {
  projetos: [],
  marketing: [],
  clientes: [],
  mensalidades: [],
  agenda: [],
  rh: [],
  financeiro: [],
  gastosFixos: [],
  contractHistory: [],
  companyProfile: {},
  setupDone: true/false
}
```

Ela e criada em `core.js` e manipulada pelos outros arquivos.

## Salvamento

O sistema salva em dois lugares:

1. `localStorage`, sempre.
2. Supabase, quando existe usuario logado.

Funcoes principais:

- `loadState()`
- `persist()`
- `loadCloudState()`
- `saveCloudState()`
- `subscribeToCloudChanges()`

## Regras de cor por status

A funcao `statusClass(status)` em `records.js` controla as classes:

```text
Concluido, Pago, Ativo -> green
Cancelado, Atrasado, Pausado, Afastado, Desligado -> red
Em andamento, Agendado -> blue
Outros, como Pendente -> yellow
```

O CSS transforma essas classes em cores visuais.

## Como mexer sem quebrar

### Adicionar campo em um modulo

1. Abra `assets/js/config.js`.
2. Encontre o modulo em `modules`.
3. Adicione o campo em `fields`.
4. Se precisar, adicione valor exemplo em `rows`.
5. Teste criar e editar registro.

### Mudar visual

1. Edite `assets/styles.input.css`.
2. Rode:

```bash
npm.cmd run build:css
```

3. Nunca edite `assets/styles.css` diretamente.

### Mudar dashboard

1. Edite `assets/js/dashboard.js`.
2. Se mudar classes CSS, edite `styles.input.css`.
3. Rode `node --check assets/js/dashboard.js`.
4. Rode `npm.cmd run build:css`.

### Mudar contrato/PDF

1. Edite `assets/js/contracts.js`.
2. Gere um PDF de cliente.
3. Confira margens, logo e assinatura.

### Mudar regras automaticas

1. Edite `assets/js/records.js`.
2. Teste o modulo afetado e o financeiro.
3. Verifique o dashboard, porque ele usa totais calculados em `records.js`.

## Comandos uteis

Rodar localmente:

```cmd
npm.cmd run serve
```

Compilar CSS:

```cmd
npm.cmd run build:css
```

Verificar sintaxe JS:

```cmd
node --check outputs\zama-tailwind\assets\js\dashboard.js
node --check outputs\zama-tailwind\assets\js\records.js
node --check outputs\zama-tailwind\assets\js\table.js
```

Subir para GitHub:

```cmd
git status
git add .
git commit -m "atualiza sistema ZAMA"
git push origin main
```

## Observacoes importantes

- O projeto usa JavaScript global. Evite renomear funcoes sem procurar onde sao
  usadas.
- O CSS compilado e grande porque inclui Tailwind e todo o tema.
- O video do gato com fundo verde depende do processamento em canvas; se no
  futuro instalar `ffmpeg`, o ideal e converter para WebM com alpha real.
- O Supabase anon key pode ficar no frontend. Chaves secretas nunca devem entrar
  no codigo.
- Antes de publicar, rode `npm.cmd run build:css`.
