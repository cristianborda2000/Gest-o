# ZAMA - frontend

A aplicacao usa HTML, JavaScript e o design da Central CEO.
Os dados administrativos ficam no Supabase, protegidos por autenticacao e RLS;
localStorage serve somente como cache separado por conta.

- [Guia da Central CEO](../docs/CENTRAL-CEO.md)
- [JARVIS: arquitetura, migration, variaveis e testes](../docs/JARVIS.md)

O JARVIS usa a API Node em ../api e ../services. Inicie a partir da raiz:

```powershell
npm.cmd run serve
```

O servidor disponibiliza frontend e API em http://localhost:5174/.
Nao publique arquivos de servidor dentro desta pasta. Nao coloque chaves
OpenAI nem a service-role do Supabase em assets/js/env.js.

Clientes, mensalidades, projetos, Marketing e equipe foram retirados da
interface. Os dados historicos continuam preservados no estado e nos backups.

Nunca execute database/supabase-setup.sql em um banco com dados existentes:
o script legado contem DROP TABLE. Use apenas a migration aditiva descrita
no guia do JARVIS.
