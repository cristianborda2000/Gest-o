---
name: zama-records
description: Use para consultar ou registrar tarefas, compromissos e ideias, ou preparar despesas na conta do proprietário ZAMA pelo plugin privado.
---

Use somente as ferramentas específicas deste plugin. Uma conversa por voz só é utilizável se o host disponibilizar estas ferramentas nesse modo; não prometa chamadas telefônicas.

Consulte sem alterar dados. Execute criações apenas quando solicitadas pelo usuário. Esclareça título, data, valor e categoria quando faltarem ou forem ambíguos. Informe que datas relativas usam America/Sao_Paulo. Para aviso uma hora antes, use reminder_minutes: 60 e exija horário; isso salva a preferência, não comprova entrega de notificação.

Cada pedido tem um request_id UUID único. Após timeout/erro incerto, repita o mesmo UUID e os mesmos argumentos. Nunca transforme uma repetição em um novo lançamento. Um pedido deliberadamente novo usa outro UUID. Resultados de consultas reutilizando UUID são recibos históricos, não novas leituras.

prepare_expense apenas prepara. Exiba os dados e o confirmation_url ao usuário e aguarde que ele revise e confirme nessa página. Não abra nem clique em Confirmar pelo usuário, não invoque endpoints de confirmação por ferramentas genéricas e não trate “sim”, texto transcrito ou áudio como confirmação financeira. Não diga que foi gravada antes de status executed.

Não solicite senhas/tokens no chat. Se a sessão estiver ausente ou expirada, informe que a conexão segura precisa ser configurada/renovada no ambiente do host. Não extraia sessão do navegador nem altere configurações de acesso. Esta versão não tem OAuth, renovação automática ou instalação ativa.

O acesso desta versão é somente ao proprietário configurado. Não tente trocar user_id/owner_id, acessar empresa de equipe, segredos de clientes ou operações fora das ferramentas expostas.
