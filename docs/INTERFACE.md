# Padrão visual da ZAMA

O arquivo `app/assets/interface.css`, carregado depois dos estilos dos módulos, define o padrão compartilhado: fundo claro, superfícies brancas, menu escuro, títulos consistentes, campos e botões com cantos de 10 px. Alterações visuais comuns devem usar esse arquivo e as variáveis de cor e espaçamento existentes.

- A ação principal usa `.ceo-button.primary`; ações secundárias usam `.ceo-button`; ações destrutivas usam `.danger` ou `[data-danger]`.
- Botões têm pelo menos 42 px no computador e 44 px no celular. Abas e ações de tarefas/ideias usam 44 px. Campos de formulário usam 16 px no celular para facilitar a leitura.
- O foco por teclado tem contorno visível. Estados desativados, sucesso, erro e pendência possuem tratamentos próprios; rótulos continuam identificando cada situação.
- Valores pagos/recebidos aparecem em verde, pendências em âmbar e erros em vermelho. WhatsApp usa verde e conserva o envio manual.
- Indicadores de salvamento e erro continuam visíveis no cabeçalho do celular. Formulários móveis conservam cabeçalho e ações acessíveis durante a rolagem.
- O Financeiro tem Resumo, Lançamentos e Análises, com filtros compartilhados. Lançamentos mostram as ações secundárias em um menu; no celular, os detalhes se expandem por registro. O saldo acumulado continua fixo acima das abas.
- As transições respeitam a preferência de movimento reduzido.

Validar mudanças globais com os testes de navegação, formulários e layout de cada módulo. Os testes de navegador usam dados fictícios e não alteram a conta de produção.
