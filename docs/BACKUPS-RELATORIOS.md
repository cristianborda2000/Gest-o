# Backups e relatórios administrativos

Em **Configurações**, use **Baixar backup completo** para proteger todos os módulos da conta. O arquivo JSON contém `type: "zama-backup"`, `version: 1`, a data de geração e o estado completo em `data`. Guarde o arquivo em um local seguro; ele contém os registros e os dados da empresa.

## Restaurar com segurança

**Restaurar backup** verifica o formato antes de iniciar qualquer gravação. A revisão apresenta a quantidade de registros por módulo. A pessoa precisa digitar **RESTAURAR**; uma cópia completa dos dados atuais é baixada antes da tentativa de salvar na nuvem.

- Relatórios mensais, inclusive os antigos chamados “backup do mês”, são recusados como restauração.
- Backups parciais, coleções ou campos com tipos inválidos, IDs repetidos, versões desconhecidas, propriedades de protótipo e arquivos acima de 10 MB são recusados.
- Valores financeiros armazenados somente em centavos são preservados na restauração e ao reabrir a conta. O valor legado em reais, quando presente, continua tendo prioridade.
- Backups completos antigos continuam aceitos quando contêm todos os módulos originais. Coleções e configurações que não existiam no arquivo antigo são preservadas a partir da conta atual. Isso evita apagar ideias e investimentos ao restaurar um arquivo anterior à criação desses módulos.
- Categorias financeiras são incluídas em `financeCategories`. Backups antigos sem esse campo, inclusive de versão 1, preservam o catálogo atual; um catálogo explicitamente vazio substitui o atual. A revisão informa quando as categorias serão preservadas.
- Falhas de conexão preservam os dados atuais e a tela de revisão para nova tentativa. A gravação usa o mesmo controle de versão da conta para evitar sobrescrever uma mudança feita por outro dispositivo.
- Trocar de conta ou espaço de trabalho invalida a restauração que estava aberta.

Os backups guardam o estado administrativo da conta. A configuração de acesso compartilhado, os usuários autenticados e as permissões mantidas em tabelas próprias não são concedidos nem alterados pela importação de um arquivo.

## Relatórios mensais

**Relatórios mensais** abre a escolha explícita do mês. O padrão acompanha o período da visão geral ou o mês do filtro financeiro quando a tela financeira está aberta. Os relatórios incluem todas as movimentações desse mês, sem aplicar silenciosamente filtros de pesquisa, categoria ou situação.

- **CSV (Excel):** arquivo UTF-8, separador ponto e vírgula e decimais com vírgula, com as movimentações detalhadas. É um arquivo CSV, não XLSX. Textos que poderiam ser interpretados como fórmulas recebem proteção.
- **Imprimir / PDF:** relatório formatado em A4 horizontal, identificação da empresa, totais, categorias, movimentações e investimentos. Na impressão do navegador, escolha **Salvar como PDF**. O navegador precisa permitir a abertura da janela do relatório.
- **JSON:** relatório estruturado com `type: "zama-monthly-report"`, mês, critérios, categorias, totais em centavos e registros. Esse formato serve para análise; não pode restaurar uma conta.

Os valores recebidos e pagos entram pela data da liquidação. As pendências entram pelo vencimento. Registros históricos sem data de liquidação usam a data disponível. Cancelados aparecem no detalhamento e não somam aos totais. Registros sem data ficam fora do período e são informados na prévia e na impressão.

Investimentos vinculados ao financeiro já estão nas saídas. O total de investimentos é informativo e não é subtraído uma segunda vez do saldo. Gastos fixos entram no relatório pelas contas geradas no financeiro, sem somar novamente o valor do cadastro de recorrência.

## Verificação

```powershell
node --test tests/admin-data.test.js
npx.cmd playwright test tests/browser/admin-data.spec.js
```

Os testes cobrem rejeição de arquivos parciais e relatórios, preservação do legado, tipos e propriedades perigosas, escolha de mês, liquidação, centavos, escape HTML, proteção de CSV, download de proteção, falha de gravação e nova tentativa.
