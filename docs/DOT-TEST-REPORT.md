# Revisão e testes locais — 2026-11-04

Pacote de origem: `zama-dot-v0.2.1-auth-review.zip`. Os hashes dos 37 arquivos de mudanças conferiram antes da integração. Os baselines de `scripts/dev.mjs` e `vercel.json` coincidiram com o repositório, desconsiderando quebras de linha.

## Resultado

**90 testes aprovados, zero falhas, zero ignorados.** Inclui os 89 testes do pacote e uma regressão nova de privilégios SQL. Execução em aproximadamente 11 segundos.

```powershell
node --test tests/dot*.test.js tests/jarvis-domain.test.js tests/jarvis-database.test.js
npm.cmd run build
```

Build aprovado: 131 arquivos JavaScript e referências de assets verificados; CSS compilado. Houve apenas aviso de desatualização da base Browserslist.

## Correções da revisão

- A migration revogava privilégios de `public`, `anon` e `authenticated`, mas não eliminava permissões herdadas pelo `service_role`. Em projetos com grants padrão legados, esse papel poderia manter INSERT/UPDATE/DELETE na tabela de concessões. O teste reproduziu a falha de INSERT antes da correção. A migration agora remove todos os privilégios desses papéis antes de conceder somente SELECT ao runtime; também restringe a função de versão.
- A rota `/api/dot-mcp` foi incluída no servidor de desenvolvimento, além da API humana `/api/dot` já proposta pelo pacote.
- O teste Chromium passa a localizar o navegador existente em `.playwright`, respeitando uma configuração externa quando fornecida. A captura de teste é gravada em `test-results/dot/confirmation-preview.png`, pasta ignorada pelo Git.
- Documentação antiga foi substituída pelo estado atual. Ativar somente `DOT_MCP_ENABLED` não habilita a confirmação humana: `DOT_ENABLED` também é necessário.

## Cobertura

Ferramentas de tarefa/agenda/ideia, propostas e confirmação humana; recibos idempotentes, concorrência e falha atômica; isolamento de proprietário; MCP stdio e HTTP real em loopback; tamanho, origem, Host, versões e mensagens inválidas; hash, expiração, escopos, revogação e versão da concessão; permissões SQL e auditoria; confirmação real no Chromium com rede simulada; preservação dos módulos existentes e 33 regressões do JARVIS.

Lembretes usam dispatcher real com remetente falso: antecedência de 60 minutos, cruzamento de meia-noite, concorrência, dispositivo ausente, agenda pausada, conclusão/reagendamento e timeout incerto. Nenhum aviso foi enviado a pessoas.

## Limites

PostgreSQL local descartável via PGlite não substitui concorrência entre conexões no banco hospedado. O protocolo testado é um subconjunto explícito, não certificação de conformidade do host. Não houve teste com dot instalado, chave real, TLS/proxy de produção, iPhone físico ou provedor Web Push real. O limite de requisições anterior à autenticação ainda precisa ser configurado no provedor de hospedagem.

O site público e sua configuração de lembretes foram consultados somente por GET. Não houve alteração de dados, acesso, migration, configuração de cron ou emissão de credencial em produção. Publicação e ativação permanecem pendentes conforme [plano](DOT-CONNECTION-PLAN.md).
