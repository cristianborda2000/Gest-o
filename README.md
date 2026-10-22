# ZAMA

Sistema interno com financeiro, investimentos, agenda privada, ideias e projetos
compartilhados. Cada projeto organiza processos, etapas e dados de acesso do
cliente. Supabase mantém autenticação e persistência; APIs Node atendem JARVIS,
notificações e cadastro de acessos.

## Rodar localmente

Use Node.js 22 ou superior. Na raiz do repositório:

```powershell
npm.cmd ci
npm.cmd run serve
```

Abra `http://localhost:5174/`. O comando serve frontend e APIs. O atalho
`scripts/iniciar-zama.bat` inicia o mesmo servidor. Em macOS/Linux, use `npm`.

`app/assets/js/env.js` contém a configuração pública do navegador. Para os serviços,
use as variáveis de `.env.example` no ambiente local ou na hospedagem.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `app/` | Interface e arquivos públicos |
| `api/` | Entradas das funções hospedadas |
| `services/` | Regras e integrações do servidor |
| `database/` | Migrations e instaladores SQL |
| `scripts/` | Servidor local, build e verificações |
| `tests/` | Testes de regras/APIs/banco e navegador |
| `docs/` | Arquitetura e guias de manutenção |
| `releases/`, `shortcuts/` | Entregas históricas e atalhos locais |

Veja o [mapa da arquitetura](docs/ARQUITETURA.md) para localizar cada módulo,
entender a ordem dos scripts e seguir o fluxo correto de salvamento.

## Validar

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:browser
npm.cmd run build
```

`check` verifica JavaScript, assets e o instalador SQL. `test` inclui automaticamente
os testes `tests/*.test.js`. `test:browser` verifica fluxos em Chromium.
`build` reúne verificações estáticas e geração do CSS; a Vercel usa esse comando.

O CSS atual está separado por módulo em `app/assets/`. A base Tailwind vem de
`styles.input.css`; `styles.css` é gerado e não deve ser editado manualmente.

## Guias

- [Projetos, processos, senhas e acesso da equipe](docs/PROJETOS.md)
- [Financeiro, investimentos, agenda e ideias](docs/CENTRAL-CEO.md)
- [Backups, relatórios e sessão](docs/ADMINISTRATIVO.md)
- [JARVIS: configuração e limites](docs/JARVIS.md)
- [Notificações em segundo plano](docs/lembretes-em-segundo-plano.md)

A publicação do site não executa migrations no Supabase. Para atualizar Projetos,
siga o instalador descrito em seu guia. Não use `database/supabase-setup.sql` sobre
uma base existente: esse é um procedimento legado com exclusão de tabelas.
