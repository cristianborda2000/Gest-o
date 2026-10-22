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

Clientes, mensalidades, Marketing e RH legados continuam preservados no estado
e nos backups. A área de Projetos usa tabelas separadas, listas de produção
criadas manualmente, processos internos e acesso compartilhado com a equipe.
A consulta de senhas é reservada ao administrador e ao responsável autorizado. Veja
[instalação e uso de Projetos](../docs/PROJETOS.md).

Nunca execute database/supabase-setup.sql em um banco com dados existentes:
o script legado contém DROP TABLE. Use as migrations aditivas descritas no guia
do módulo que deseja ativar. O [mapa da arquitetura](../docs/ARQUITETURA.md) explica
as responsabilidades dos arquivos e o fluxo de gravação.
