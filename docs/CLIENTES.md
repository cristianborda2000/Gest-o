# Clientes e contato pelo WhatsApp

A aba Clientes importa Excel (.xlsx, .xls) e CSV. Use títulos na primeira linha, escolha a aba e as colunas de nome e telefone e revise antes de importar. Limites: 5 MB, 5.000 clientes e 100 colunas por aba. A prévia é paginada de 100 em 100 contatos, com Anterior e Próxima; a contagem e a importação consideram a aba inteira. Uma planilha com 129 linhas, incluindo o cabeçalho e sem linhas vazias, contém 128 contatos.

Telefones brasileiros devem incluir DDD. Números internacionais devem começar com + ou 00 e o código do país. Por padrão, contatos com nome e sem telefone ou com telefone inválido são importados com WhatsApp desativado; use **Corrigir telefone** no cartão para adicionar o número depois. A opção de incluir contatos com telefone pendente pode ser desmarcada antes da importação. Linhas sem nome e contatos repetidos com o mesmo nome e telefone são ignorados. Pessoas diferentes podem compartilhar um telefone. Registros existentes não são substituídos. A leitura usa o valor numérico original da célula, preservando telefones que o Excel exibe em notação científica. O resumo final informa quantos contatos foram importados, quantos ficaram com telefone pendente e quantos foram ignorados.

Escreva a mensagem uma vez usando `{nome}`. A lista compacta mostra nome, telefone e o botão **WhatsApp** ao lado, sem repetir o texto em cada contato. O botão abre uma conversa com a mensagem atual personalizada; o usuário precisa clicar em Enviar no WhatsApp. Não há disparo automático nem confirmação de entrega. Abrir uma conversa não altera o status do cliente.

Os contatos usam a coleção autenticada `clientes`, incluindo persistência e backups existentes. A mensagem e a planilha em revisão ficam somente na sessão da tela e são descartadas ao trocar de conta. O módulo segue as restrições existentes de navegação da equipe.

Leitura local da planilha com SheetJS CE 0.20.3, distribuído em `app/assets/vendor/xlsx.full.min.js`, com licença Apache-2.0 no mesmo diretório. Fonte: https://docs.sheetjs.com/docs/getting-started/installation/standalone/. A planilha não é enviada a um serviço de conversão.

Validação: `node --test tests/clients.test.js` e `npx playwright test tests/browser/clients.spec.js`.
