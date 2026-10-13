# Projetos de clientes

## Como usar

1. Abra **Projetos** no menu e clique em **Novo projeto**.
2. Preencha o título e o nome do cliente, que são obrigatórios. Complete a empresa, e-mail e senha de acesso quando necessário. Informe o nome e o e-mail da pessoa responsável e o prazo.
3. Ajuste as etapas de **Criação do catálogo** e **Estruturação do cliente**. As barras de progresso refletem as etapas marcadas como concluídas.
4. Salve e, nos detalhes, clique em **Gerar convite para projetos**. Copie o link e compartilhe com a pessoa responsável.
5. A pessoa abre o link, entra ou cria uma conta com o e-mail indicado, confirma o e-mail e aceita o convite nas configurações. Na empresa compartilhada, verá somente os projetos atribuídos a ela.
6. O responsável usa **Atualizar andamento** para marcar etapas, mudar a situação e registrar notas. O proprietário pode alterar dados do cliente, credenciais e atribuição.

Use **Atualizar** para consultar alterações de outras pessoas. O filtro de situação e a busca ajudam a encontrar clientes, empresas e responsáveis. O botão **Mostrar senha** faz uma consulta autorizada; a senha é ocultada ao sair, ao trocar de aba ou depois de um minuto. Em **Configurações → Empresa e equipe**, o proprietário pode remover o acesso ou alterar a permissão.

O acesso restrito vale para a empresa compartilhada. A conta pessoal do convidado continua independente, assim como outras empresas às quais ele já tenha acesso.

O proprietário também pode usar **Acesso do time**, no cabeçalho de **Projetos**, para abrir **Empresa e equipe** e gerenciar membros, permissões e convites.

## Instalação do banco

No SQL Editor do projeto Supabase existente, execute as migrations na ordem:

1. `database/migrations/20261005_workspaces.sql`, caso ainda não tenha sido aplicada.
2. `database/migrations/20261012_projects.sql`.

Execute como proprietário do banco. A migration de projetos é aditiva e pode ser reaplicada: preserva os dados existentes, a chave de criptografia e os projetos já cadastrados. Não execute `database/supabase-setup.sql` em uma base existente. A entrega dos arquivos não aplica a migration automaticamente no Supabase.

O banco armazena projetos em `public.zama_projects`, separado de `app_state`. Nenhum dado legado de projetos é convertido ou removido automaticamente. O backup JSON administrativo baseado em `app_state` não contém os novos projetos nem suas credenciais; sua restauração não recupera essa área. Para recuperação completa, use o backup do banco Supabase, incluindo o schema `zama_private`.

## Permissões

O convite da equipe aceita o perfil `projects` (Somente projetos). Cada pessoa entra com sua própria conta e precisa confirmar o e-mail e aceitar o convite enviado para esse mesmo endereço. O proprietário pode cadastrar o e-mail responsável antes de gerar ou aceitar o convite; isso ainda não concede acesso.

| Pessoa | Projetos visíveis | Alterações | Senha do cliente |
| --- | --- | --- | --- |
| Proprietário | Todos os seus projetos | Criar, editar, atribuir e excluir | Consultar, substituir e remover |
| Responsável com perfil `projects` ou `editor` | Somente os atribuídos ao seu e-mail confirmado | Status, observações e duas listas de etapas | Consultar |
| Responsável com perfil `viewer` | Somente os atribuídos ao seu e-mail confirmado | Nenhuma | Sem acesso |
| Membro sem atribuição | Nenhum | Nenhuma | Sem acesso |

O perfil `projects` não pode ler nem alterar o `app_state` da empresa, onde ficam financeiro e outras áreas. A restrição é aplicada no banco, inclusive em chamadas diretas à API. Os perfis `editor` e `viewer` conservam suas permissões administrativas existentes; para restringir alguém somente aos projetos, selecione `projects`.

Toda consulta verifica a associação atual à empresa, o perfil, a confirmação do e-mail e a correspondência com o e-mail responsável. Remover o membro, mudar a atribuição ou alterar seu e-mail invalida o próximo acesso. Consultar a lista de empresas compartilhadas revela apenas o nome da empresa e seu perfil, como no fluxo de equipe existente.

Alterar o perfil ou remover uma pessoa da equipe também cancela convites pendentes da mesma empresa para o e-mail atual dela. Um link antigo não pode restaurar a permissão anterior; o proprietário pode gerar um novo convite quando quiser conceder acesso novamente.

## Credenciais e proteção

Senhas são cifradas com `pgcrypto` e AES-256 antes de gravar a linha. A chave aleatória fica em `zama_private.project_key`, sem acesso para `anon`, `authenticated` ou `service_role`. O schema privado não deve ser exposto pela API. A migration resolve o schema em que a extensão `pgcrypto` já estiver instalada (`public` ou `extensions`).

Tabela e chave têm RLS ativada e forçada, sem políticas que concedam acesso direto ao navegador. As funções públicas usam `SECURITY DEFINER`, caminho de busca vazio e verificações explícitas de identidade. Listagem e gravação retornam somente `has_password`; o texto da senha só é devolvido pela função específica de consulta, após autorização.

A chave é mantida no mesmo banco: isso protege contra leitura indevida pela API, mas não impede que um administrador do banco ou alguém com o backup completo recupere as credenciais. O backup do banco contém ciphertext e chave, e deve receber a mesma proteção que os demais segredos administrativos. Não remover ou substituir a linha da chave: isso tornaria as senhas atuais ilegíveis. A interface não deve colocar senhas em `app_state`, localStorage, IndexedDB, logs ou backups JSON.

## Contrato RPC

Todas as funções abaixo exigem sessão autenticada:

| Função | Argumentos | Retorno |
| --- | --- | --- |
| `zama_projects_list` | `p_owner: uuid` | Array JSON dos projetos autorizados, sem senhas |
| `zama_project_save` | `p_owner: uuid`, `p_project: jsonb` | Projeto completo gravado, sem senha |
| `zama_project_secret` | `p_owner: uuid`, `p_id: uuid` | Senha em texto; string vazia quando não cadastrada |
| `zama_project_delete` | `p_owner: uuid`, `p_id: uuid` | Sem conteúdo; somente proprietário |

O objeto do projeto contém `id`, `title`, `client_name`, `company_name`, `client_email`, `access_url`, `responsible_email`, `responsible_name`, `status`, `due_date`, `notes`, `catalog_steps`, `onboarding_steps`, `revision`, `created_at`, `updated_at` e `has_password`.

`title` e `client_name` são obrigatórios e não aceitam somente espaços, tabulações ou quebras de linha; espaços externos são removidos. Gravações parciais preservam esses campos quando não forem enviados. `status` aceita `planning`, `in_progress`, `waiting` e `completed`. `due_date` é `null` ou data `YYYY-MM-DD`. Cada lista contém até 100 objetos com exatamente `{id, label, done}`; IDs são únicos dentro da lista, com até 80 caracteres, rótulos têm até 254 caracteres e `done` é booleano. Texto curto aceita até 254 caracteres; observações, 20.000; URL HTTP(S), 2.048; senha, 4.096. E-mails são normalizados para minúsculas sem espaços externos.

Criação aceita `revision` ausente ou zero e devolve `revision: 1`. Edição exige a revisão recebida na última leitura; cada alteração incrementa a revisão. Revisão desatualizada gera `PROJECT_CONFLICT` (SQLSTATE `40001`) e cancela toda a gravação, inclusive uma substituição de senha. A interface deve recarregar antes de tentar novamente. Não refazer automaticamente uma edição inteira sobre dados mais novos.

O campo opcional `password` só é aceito do proprietário: ausente preserva a senha, string vazia remove, outra string substitui. Ele nunca aparece no retorno. Gravações parciais são aceitas. O responsável pode reenviar campos protegidos inalterados junto com o formulário, mas qualquer modificação nesses campos gera `PROJECT_ACCESS_DENIED` (SQLSTATE `42501`). Dados inválidos geram erros `PROJECT_INVALID_*` (`22023`; formatos UUID/data inválidos também podem retornar os códigos nativos do PostgreSQL).

## Verificação local

```text
node --test tests/projects-database.test.js
```

Os testes usam PostgreSQL em WASM (PGlite) e a extensão `pgcrypto` real, sem acesso a dados de produção. Cobrem convite e confirmação, bloqueio de financeiro, isolamento entre empresas e responsáveis, consulta de senhas, revisão concorrente, revogação, troca de atribuição/e-mail, bloqueio de acesso direto, reexecução da migration e extensão preexistente em outro schema.
