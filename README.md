# ZAMA Admin

Este projeto foi separado por pastas para ficar mais facil de entender e manter.

## Estrutura

```text
app/          Sistema que abre no navegador: HTML, CSS, JS, imagens e videos.
database/     Arquivos SQL do Supabase.
docs/         Explicacoes de arquitetura e manutencao.
scripts/      Atalhos e comandos auxiliares.
releases/     Arquivos compactados para entrega/publicacao.
shortcuts/    Atalhos para abrir o sistema local.
logs/         Logs locais do servidor.
```

Os arquivos `package.json`, `package-lock.json`, `tailwind.config.js` e
`vercel.json` ficam na raiz porque o npm, Tailwind e Vercel esperam encontrar
essas configuracoes aqui.

## Como rodar

```cmd
npm.cmd run serve
```

Ou execute:

```text
scripts/iniciar-zama.bat
```

O sistema abre em:

```text
http://localhost:5174/
```

## Onde mexer

- Tela principal: `app/index.html`
- Visual: `app/assets/styles.input.css`
- JavaScript: `app/assets/js/`
- Banco/Supabase: `database/`
- Explicacao completa: `docs/ARQUITETURA.md`
