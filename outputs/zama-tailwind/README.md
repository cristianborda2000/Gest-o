# ZAMA Admin

Sistema administrativo da ZAMA.

Esta versao esta separada em HTML, CSS, JavaScript e Tailwind para facilitar
manutencao futura.

## Mapa rapido do projeto

```text
outputs/zama-tailwind/
  index.html                  Tela principal e estrutura base
  ARQUITETURA.md              Explicacao completa dos fluxos e arquivos
  zama-logo.png               Logo usado no sistema e no contrato
  assets/styles.input.css     CSS de origem, edite este arquivo
  assets/styles.css           CSS compilado pelo Tailwind
  assets/js/config.js         Modulos, campos dos formularios e dados iniciais
  assets/js/core.js           Estado, localStorage, troca de telas e indicadores
  assets/js/forms.js          Formularios dinamicos e abas internas
  assets/js/dashboard.js      Dashboard, resumos e graficos
  assets/js/contracts.js      Contrato/PDF de clientes
  assets/js/table.js          Tabelas, calendario e botoes de acao
  assets/js/records.js        Regras de negocio, financeiro, agenda e utilitarios
  assets/js/boot.js           Inicializacao e eventos globais
```

Para entender a arquitetura inteira, leia primeiro `ARQUITETURA.md`.

## Onde mexer

- Para mudar campos de cadastro: edite `assets/js/config.js`.
- Para mudar cores, layout e responsividade: edite `assets/styles.input.css`.
- Para mudar o dashboard: edite `assets/js/dashboard.js`.
- Para mudar o contrato/PDF: edite `assets/js/contracts.js`.
- Para mudar calendario, tabelas ou botoes de acao: edite `assets/js/table.js`.
- Para mudar regras automaticas de financeiro, projetos, mensalidades ou agenda: edite `assets/js/records.js`.
- Para mudar botoes globais como importar/exportar/limpar: edite `assets/js/boot.js`.

## Como os dados sao salvos

Os dados ficam no navegador usando `localStorage`, com a chave definida em
`assets/js/config.js`:

```js
const storageKey = "admin-simples-v1";
```

Isso significa que os dados nao ficam dentro dos arquivos do projeto. Para levar
dados de uma versao para outra, use os botoes `Exportar dados` e `Importar dados`.

## Dados em todos os navegadores

Para acessar os mesmos dados no computador, celular e qualquer navegador, o
projeto precisa sair do `localStorage` e usar um banco de dados online.

Este projeto ja esta preparado para usar Supabase com login.

Passos no Supabase:

1. Abra o projeto Supabase.
2. Va em `SQL Editor`.
3. Execute o arquivo `supabase-setup.sql`, que fica na raiz do projeto.
4. Va em `Authentication > Users`.
5. Crie apenas o seu usuario de acesso.
6. Em `Authentication`, desative cadastro publico se estiver habilitado.

Depois disso, ao abrir o sistema, faca login com seu e-mail e senha. Os dados
passam a ser salvos na tabela `app_state` e ficam disponiveis em qualquer
navegador ou celular.

Importante: a chave `sb_secret_...` nunca deve ir no codigo. Se ela foi exposta,
gere uma nova no Supabase. O sistema usa somente a chave anon/public.

## Logica principal

- Projetos geram duas entradas financeiras automaticamente: 50% no inicio e 50% na conclusao.
- Mensalidades pagas geram entrada financeira.
- Clientes ativos criam/atualizam mensalidades automaticamente.
- Gastos fixos e vencimentos financeiros aparecem na agenda.
- Itens concluidos da agenda aparecem em verde no calendario.

## Ordem dos scripts

O `index.html` carrega os arquivos JS nesta ordem:

```text
config.js -> core.js -> forms.js -> dashboard.js -> contracts.js -> table.js -> records.js -> boot.js
```

Essa ordem e importante porque os arquivos compartilham funcoes e variaveis
globais. Se criar um arquivo novo, coloque-o antes de `boot.js`.

## Regra de manutencao

- Edite `assets/styles.input.css`, nunca `assets/styles.css` diretamente.
- Depois de mexer no visual, rode `npm.cmd run build:css`.
- Depois de mexer em JavaScript, rode `node --check` no arquivo alterado.
- Antes de mudar regras automaticas, leia `ARQUITETURA.md`.

## Instalar dependencias

Se o comando `npm` nao for reconhecido, instale primeiro o Node.js LTS pelo site oficial:

```text
https://nodejs.org/en/download
```

Durante a instalacao, mantenha marcada a opcao de adicionar o Node.js ao PATH.
Depois feche e abra novamente o terminal.

Para conferir se instalou corretamente:

```bash
node -v
npm -v
```

Depois rode na raiz do projeto:

```bash
npm.cmd install
```

## Compilar Tailwind

```bash
npm.cmd run build:css
```

## Rodar localmente

```bash
npm.cmd run serve
```

O arquivo principal desta versao e:

```text
outputs/zama-tailwind/index.html
```

## Publicar na Vercel

O projeto ja tem um arquivo `vercel.json` na raiz. Ele informa para a Vercel:

```text
installCommand: npm install
buildCommand: npm run build:css
outputDirectory: outputs/zama-tailwind
```

### Pelo site da Vercel

1. Crie uma conta em `https://vercel.com`.
2. Suba este projeto para um repositorio no GitHub.
3. Na Vercel, clique em `Add New...` > `Project`.
4. Importe o repositorio.
5. Confirme as configuracoes e clique em `Deploy`.

### Pelo terminal

Na raiz do projeto:

```bash
npm.cmd install
npm.cmd install -g vercel
vercel login
vercel
vercel --prod
```

O comando `vercel` cria um link de teste. O comando `vercel --prod` publica o
link final de producao.

## Levar dados da versao antiga

Os dados ficam salvos no navegador pelo `localStorage`. Quando o sistema muda de
link, pasta ou servidor, o navegador pode nao carregar os dados antigos
automaticamente.

Para migrar:

1. Abra a versao antiga.
2. Clique em `Exportar dados`.
3. Abra esta versao nova.
4. Clique em `Importar dados`.
5. Selecione o arquivo `.json` exportado.
