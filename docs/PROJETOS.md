# Espaço da equipe ZAMA

A equipe tem três abas: **Agenda**, **Projetos** e **Ideias**. Projetos e ideias são compartilhados entre todos os membros confirmados da mesma empresa. Cada pessoa tem uma agenda privada, inclusive o administrador. O administrador mantém os módulos administrativos, o financeiro e a gestão de acessos.

## Projetos

O quadro usa cartões e formulários brancos, com cores pastéis para identificar a situação: lavanda em **Planejamento**, azul em **Em andamento**, pêssego em **Aguardando cliente** e verde em **Concluído**. Os nomes das situações permanecem visíveis junto das cores.

Os cartões começam recolhidos, mostrando nome, cliente, situação e progresso. Clique na seta **Ver informações** para abrir as listas, etapas, responsável, prazo e demais controles; clique novamente para recolher. O título abre a janela completa do projeto. Cada cartão mantém sua abertura ao filtrar, atualizar ou salvar alterações enquanto o quadro está aberto. Ao sair da área de Projetos, os cartões voltam a iniciar recolhidos.

No cartão expandido, marque/desmarque etapas diretamente, com salvamento automático e confirmação. O controle **Mover para** altera a coluna e a cor sem concluir etapas automaticamente. **Adicionar projeto** em uma coluna já inicia o cadastro naquela situação.

Em **Cliente e projeto**, o campo opcional **WhatsApp do cliente** aceita DDD e número brasileiro, como `(11) 99999-9999`. Para outro país, informe `+` e o código do país. Depois de salvar, **Abrir WhatsApp** aparece no cartão e nos detalhes do projeto, apontando para o telefone cadastrado. Apagar o campo remove o botão. O atalho usa o [formato oficial de clique para conversa do WhatsApp](https://faq.whatsapp.com/5913398998672934/?locale=pt_BR) e abre em outra aba, sem enviar uma mensagem automaticamente.

O painel destaca todos os projetos, atrasos de projetos ou etapas, entregas dos próximos sete dias e projetos aguardando o cliente. As métricas funcionam como filtros e combinam com a busca e a situação. A ordenação permite priorizar os prazos, os nomes ou as alterações recentes. Projetos concluídos não entram nas pendências de prazo.

1. Qualquer membro confirmado da equipe abre **Projetos → Novo projeto** e preenche o título e o cliente. Empresa, acesso, responsável e prazo são opcionais.
2. Cria as listas e etapas necessárias. É possível renomear, reordenar, remover e marcar etapas, além de definir um prazo individual para cada uma.
3. O administrador pode usar **Modelos de produção** para salvar a estrutura atual com um nome e reutilizá-la em outro projeto. Aplicar um modelo acrescenta listas ao rascunho; substitui apenas a lista inicial vazia. O modelo não copia dados do cliente, senha, notas, progresso ou datas. As listas copiadas recebem identificadores novos.
4. Toda a equipe, inclusive o perfil com ideias em leitura, usa **Editar projeto** para alterar título, cliente, empresa, dados de acesso, responsável, prazos, listas, situação e notas. Senhas e exclusão continuam com o administrador. Quando o projeto tem uma senha cadastrada, somente o administrador altera o e-mail responsável, pois esse campo também controla acesso à senha.

Projetos antigos preservam as listas **Catálogo** e **Estruturação**. Um projeto aceita até 20 listas, com até 100 etapas por lista; listas vazias e projetos sem listas são válidos. Cada administrador pode guardar até 50 modelos. Use **Atualizar** para consultar alterações de outras pessoas. Revisões concorrentes são recusadas para evitar sobrescrever trabalho recente.

## Ideias e agenda

As ideias pertencem à empresa selecionada. Os membros com perfil de equipe podem criar, editar, mudar a etapa, arquivar e restaurar ideias. O perfil de leitura pode consultar. **Atualizar ideias** busca a revisão mais recente.

**Criar tarefa** em uma ideia compartilhada cria uma tarefa somente na agenda de quem clicou. O dia e o horário da tarefa não são publicados para a equipe. Os vínculos privados do administrador com suas tarefas são preservados quando outra pessoa edita a ideia. Empresas diferentes não compartilham projetos, ideias nem vínculos de tarefas.

As agendas ficam na linha pessoal de `app_state`, mesmo durante o uso do espaço da equipe. Um colega ou administrador da empresa não tem acesso à agenda de outra conta. A associação à equipe não concede leitura do `app_state` do administrador; a consulta de ideias usa uma função específica que retorna apenas os campos compartilhados.

## Criar e gerenciar acesso

Em **Projetos → Criar acesso**, a tela **Acesso à equipe ZAMA** informa as três abas e mostra os projetos compartilhados, independentemente do e-mail responsável.

O administrador autorizado pode preencher e-mail, senha e confirmação e escolher **Criar acesso com senha**. A senha precisa ter pelo menos 10 caracteres. A conta nova recebe o perfil `projects`, agora apresentado como **Equipe ZAMA**, e pode entrar imediatamente. O cadastro não envia e-mail nem cria uma caixa de correio. Use **Copiar dados de acesso** para entregar os dados à pessoa.

Para uma conta existente, **Gerar link de acesso** cria um convite válido por sete dias, destinado ao endereço informado. A pessoa entra com sua própria senha, confirma o e-mail quando necessário e aceita o convite. A senha existente nunca é substituída. O link deve ser entregue manualmente.

A lista de equipe mostra membros e convites de todos os perfis. É possível cancelar um convite ou remover um membro sem excluir os projetos. **Usar perfil da equipe** muda um acesso existente para `projects`. Alterar o perfil ou remover o membro invalida convites anteriores do mesmo endereço.

| Perfil | Projetos e ideias | Agenda | Senhas de clientes |
| --- | --- | --- | --- |
| Administrador (`owner`) | Todos da própria empresa; administração completa | Somente a própria | Consultar, substituir e remover |
| Equipe (`projects` ou `editor`) | Todos da empresa; criar/editar projetos e editar ideias | Somente a própria, com edição | Consultar apenas nos projetos atribuídos ao seu e-mail confirmado |
| Ideias em leitura (`viewer`) | Todos da empresa; criar/editar projetos e consultar ideias | Somente a própria, com edição | Sem acesso |
| Pessoa sem vínculo | Sem acesso à empresa | Somente a própria | Sem acesso |

O e-mail do responsável organiza o trabalho e restringe a consulta de senhas; não restringe mais a visibilidade dos projetos. Preencher esse e-mail no projeto não cria uma associação à empresa.

## Instalação e atualização do banco

Execute o conteúdo completo de [`database/instalar-projetos.sql`](../database/instalar-projetos.sql) no **SQL Editor** do Supabase da ZAMA, como proprietário do banco. O instalador exige a tabela `public.app_state` existente e reúne estas migrations em uma transação:

1. `20261005_workspaces.sql` — empresas, membros e convites.
2. `20261012_projects.sql` — projetos e credenciais cifradas.
3. `20261013_project_lists.sql` — listas manuais.
4. `20261015_project_planning.sql` — prazos por etapa e modelos.
5. `20261015_team_space.sql` — projetos/ideias compartilhados e agendas privadas.
6. `20261015_project_collaboration.sql` — criação/edição de projetos por todos os membros e marcação direta de etapas.
7. `20261016_project_phone.sql` — telefone do cliente e capacidade de cadastro para o atalho do WhatsApp.

O instalador pode ser reaplicado: preserva dados, membros, progresso, modelos e a chave de criptografia. As listas legadas só são convertidas quando `production_lists` está ausente ou nulo. A migration `20261015_team_space.sql` retira dos perfis antigos `editor` e `viewer` o acesso amplo ao `app_state` de outra conta e aplica o modelo da equipe às associações existentes.

**Aplique o instalador completo para ativar todas as permissões e o WhatsApp desta versão.** Se as seis primeiras migrations já estão instaladas, basta executar `database/migrations/20261016_project_phone.sql`. Publicar o site não executa SQL no Supabase. Sem a migration de colaboração, o quadro mantém as permissões anteriores: membros de leitura não criam ou editam projetos e os demais membros editam apenas o andamento. Sem a migration de telefone, o campo de WhatsApp fica desabilitado para evitar um salvamento sem persistência. Não reaplique apenas uma migration antiga depois desta atualização, pois ela pode restaurar permissões anteriores. Não execute `database/supabase-setup.sql` sobre uma base existente.

Após mudar migrations, gere novamente o instalador com `npm run build:projects-sql`. A interface usa `zama_projects_list_v3`; em instalações antigas com v2, os campos de prazo por etapa e modelos ficam indisponíveis. Ideias compartilhadas exigem a migration de equipe e apresentam uma mensagem de configuração pendente quando ela falta.

## Cadastro de login pelo servidor

`GET/POST /api/project-access` exige a sessão confirmada do administrador autorizado. `PROJECT_ACCESS_ADMIN_EMAIL` permite configurar essa conta; as variáveis de servidor são `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `APP_ORIGIN`. `PROJECT_ACCESS_ENABLED=false` desativa o cadastro. Nenhuma chave administrativa vai para o navegador.

O servidor verifica identidade e empresa, aplica limites de cadastro e cria exclusivamente contas novas com perfil `projects`. Se a associação falhar, tenta desfazer apenas a conta recém-criada. Falhas ambíguas orientam conferir o usuário no Supabase antes de repetir. O convite interno de preparação nunca é enviado nem retornado e é cancelado ao final.

## Dados e credenciais

As senhas de login ficam no Supabase Auth, sem cópia recuperável no ZAMA. A senha de uma conta recém-criada fica mascarada para cópia e é apagada ao fechar a janela, perder o foco, sair da sessão ou após um minuto.

As senhas dos clientes são cifradas com `pgcrypto` e AES-256 em `public.zama_projects`. A chave fica em `zama_private.project_key`; tabelas e schema privado não concedem acesso direto a `anon`, `authenticated` ou `service_role`. A listagem de projetos retorna apenas `has_password`. **Mostrar senha** faz uma consulta autorizada, reservada ao administrador ou ao responsável confirmado com perfil de escrita. A senha é apagada da interface ao fechar, trocar de aba ou depois de um minuto e não entra no estado persistido do navegador.

O backup JSON administrativo baseado em `app_state` não inclui projetos, modelos ou credenciais de clientes. A recuperação completa exige backup do banco Supabase, incluindo o schema `zama_private` e sua chave.

## Contratos das funções

| RPC | Uso |
| --- | --- |
| `zama_projects_list_v3(p_owner)` | Projetos da empresa, listas e prazos por etapa, sem senhas |
| `zama_project_save(p_owner, p_project)` | Criar/editar com revisão; senha e atribuição com senha só para administrador |
| `zama_project_step_set(p_owner, p_id, p_list_id, p_step_id, p_done, p_revision)` | Alterar somente uma etapa sob revisão |
| `zama_project_collaboration_capabilities(p_owner)` | Verificar a instalação da edição colaborativa |
| `zama_project_phone_capabilities(p_owner)` | Verificar se o banco aceita o telefone do cliente |
| `zama_project_secret(p_owner, p_id)` | Consultar senha sob autorização separada |
| `zama_project_delete(p_owner, p_id)` | Excluir como administrador |
| `zama_project_templates_list()` | Modelos da própria conta |
| `zama_project_template_save(p_template)` | Salvar estrutura, sem progresso, prazos ou dados de cliente |
| `zama_project_template_delete(p_id, p_revision)` | Excluir modelo com revisão |
| `zama_team_ideas_get(p_owner)` | Ideias compartilhadas e revisão, sem links de tarefas privadas |
| `zama_team_ideas_save(p_owner, p_revision, p_ideas)` | Alterar somente as ideias, preservando o restante do estado |

Etapas aceitam `{id, label, done, due_date?}`. `due_date` deve ser uma data real `YYYY-MM-DD` ou `null`. Clientes antigos que omitem a propriedade preservam a data existente da mesma lista/etapa; `null` remove explicitamente o prazo. O limite do JSON do projeto é 4 MiB. As listas mantêm a compatibilidade com os campos legados `catalog_steps` e `onboarding_steps`.

`client_phone` contém de 8 a 15 dígitos internacionais, sem `+`, iniciando por 1–9; `''` remove o telefone. A interface normaliza o número antes de salvar. Atualizações que omitem esse campo, inclusive marcações de etapas, preservam o telefone existente. Ele é compartilhado somente com os membros autorizados da empresa, como os demais dados do cliente.

Projetos e modelos usam revisão incremental. Ideias usam o timestamp de revisão da linha da empresa, com bloqueio durante a gravação; mudanças simultâneas em ideias ou outros dados do administrador invalidam a revisão antiga. Conflitos (`40001`) não gravam parcialmente nem são repetidos automaticamente. A interface mantém o rascunho e orienta consultar a versão atual. Acesso negado usa `42501` e dados inválidos usam `22023`.

## Verificação local

```text
npm test
npx playwright test
node scripts/build-projects-setup.mjs --check
```

Os testes com PGlite e `pgcrypto` real verificam isolamento entre empresas e agendas, acesso a senhas, revisões concorrentes, preservação dos vínculos privados de ideias, compatibilidade dos prazos, modelos e reaplicação do instalador. Os testes de navegador cobrem as três abas, agendas pessoais, ideias compartilhadas, troca de sessão/perfil, convites, criação de acesso, rascunhos, prioridades, modelos e telas de 320, 390 e 1.440 pixels. Não usam dados de produção.

Marcações rápidas são processadas em sequência por projeto. Em falha ou conflito, a interface desfaz as marcações ainda não confirmadas e orienta atualizar. Respostas antigas após troca de sessão não restauram o conteúdo. O navegador só habilita criação/edição completa aos membros após confirmar a nova capacidade no banco.
