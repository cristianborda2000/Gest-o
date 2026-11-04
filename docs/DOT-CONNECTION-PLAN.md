# Plano de conexão dot / ZAM4

Estado verificado em 2026-11-04. O caminho proposto é MCP remoto HTTPS na hospedagem existente. O protótipo stdio permanece para desenvolvimento; não comprova disponibilidade quando o computador estiver desligado.

## Destinos e evidências

| Item | Evidência | Pendente |
| --- | --- | --- |
| Origem | `https://zam4.com/` redireciona para `https://www.zam4.com/` | Confirmar o projeto responsável no painel |
| Vercel | O commit `805c109` tem deploys dos projetos `gest-o`, `gest-o-24mq`, `gest-o-bpu4`, na equipe `cristhian-borda-s-projects` | Identificar qual atende `www.zam4.com`; não escolher apenas pelo nome |
| Supabase | A configuração pública do site usa `rtiwoctipvlsejxcptks.supabase.co` | Confirmar projeto, proprietário e schema pelo acesso autorizado |
| Web Push | GET público `/api/reminders?path=config` retornou `enabled: true`, origem canônica e chave pública presente | Cron, assinatura do aparelho, preferências e entrega real |
| MCP remoto | Código integrado e testes locais aprovados | Deploy, autenticação no host e descoberta das ferramentas |

Não há configuração `.vercel/project.json` no repositório. Os conectores de Vercel e Supabase foram sugeridos, mas ainda não ficaram disponíveis nesta sessão. A tentativa de consultar o navegador falhou ao iniciar o runtime local. Essas limitações impedem confirmar os painéis, não indicam indisponibilidade do site.

## Sequência de publicação

1. Consultar os dois painéis em modo de leitura: domínio/projeto, variáveis por nome e presença, migrations existentes, proprietário, extensões e agendador. Não copiar valores secretos para logs ou chat.
2. Apresentar os destinos e as mudanças exatas para aprovação antes de criar credencial ou alterar acesso, conforme pedido do usuário. A migration de concessões muda permissões e está incluída nessa aprovação.
3. Publicar o código inicialmente desativado no destino confirmado. Validar as rotas e os cabeçalhos sem realizar operações de negócio.
4. Após aprovação, aplicar somente a migration nova, configurar a concessão privada e as flags. As duas APIs devem estar disponíveis para que propostas financeiras possam ser revisadas pelo usuário.
5. Conectar pelo campo protegido de API key do host, se suportado. Se o host exigir OAuth, parar a ativação e implementar esse fluxo. O pacote remoto não pode conter segredo.
6. Testar catálogo e leitura real; conferir rejeição de acesso e revogação da concessão. Depois, com autorização para o registro de teste, validar criação e confirmação de persistência. Não realizar lançamento financeiro para testar conectividade.

## Lembretes

Conservar VAPID e CRON_SECRET existentes se estiverem válidos. Não criar outro cron sem verificar o atual. O dispatcher usa uma janela de dois minutos e precisa ser chamado a cada minuto; uma tarefa diária ou horária não atende esse desenho. Uma janela perdida não é recuperada automaticamente.

Para Web Push, verificar migration, agendador, preferências e dispositivo. A configuração pública habilitada não demonstra que esses itens estão ativos. Após autorização para o teste, criar um compromisso com hora e antecedência explícitas; confirmar a entrega no aparelho com o aplicativo fechado. Aceitação pelo provedor não comprova exibição. Atualmente somente o último dispositivo ativado recebe o envio Web Push.

Avisos dentro da conversa do dot precisam de outro mecanismo, como eventos do host. Esta integração não implementa esse canal. O canal a ativar deve ser confirmado antes do teste real.

## Aceite

Só considerar a conexão ativa após observar autenticação e ferramentas descobertas no dot, leitura real autorizada e rejeição/revogação verificadas. Só considerar lembretes ativos após conferir agendamento e entrega no aparelho/canal escolhido. Ver [aprovações detalhadas](DOT-AUTH-ACTIVATION.md).
