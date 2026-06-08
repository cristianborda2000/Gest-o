/*
  config.js
  Define configuracoes globais, os modulos do sistema, campos dos formularios
  e dados iniciais usados quando ainda nao existe nada salvo no navegador.
*/

    const storageKey = "admin-simples-v1";
    const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

    // Cada chave em modules representa uma aba do menu lateral.
    // fields controla o formulario; rows serve como dados de exemplo iniciais.
    const modules = {
      dashboard: {
        title: "ZAMA",
        subtitle: "Visão geral de projetos, clientes, equipe e dinheiro em caixa.",
        listTitle: "Dashboard geral",
        formTitle: "",
        moneyLabel: "Saldo"
      },
      projetos: {
        title: "Projetos",
        subtitle: "Acompanhe entregas, responsáveis, prazos e status.",
        listTitle: "Lista de projetos",
        formTitle: "Novo projeto",
        moneyLabel: "Orçamento",
        fields: [
          { key: "nome", label: "Nome do projeto", type: "text", required: true },
          { key: "responsavel", label: "Responsável", type: "text", required: true },
          { key: "inicio", label: "Início", type: "date" },
          { key: "prazo", label: "Prazo", type: "date" },
          { key: "status", label: "Status", type: "select", options: ["Planejado", "Em andamento", "Concluído", "Atrasado"] },
          { key: "valor", label: "Orçamento", type: "number" },
          { key: "observacoes", label: "Observações", type: "textarea" }
        ],
        rows: [
          { nome: "Implantação CRM", responsavel: "Ana", inicio: "2026-06-03", prazo: "2026-06-20", status: "Em andamento", valor: 12000, observacoes: "Configuração inicial e treinamento." },
          { nome: "Portal do cliente", responsavel: "Carlos", inicio: "2026-06-10", prazo: "2026-07-12", status: "Planejado", valor: 18000, observacoes: "Escopo em validação." }
        ]
      },
      marketing: {
        title: "Marketing",
        subtitle: "Organize campanhas, canais, investimento e performance.",
        listTitle: "Campanhas de marketing",
        formTitle: "Nova campanha",
        moneyLabel: "Investimento",
        fields: [
          { key: "nome", label: "Campanha", type: "text", required: true },
          { key: "responsavel", label: "Responsável", type: "text", required: true },
          { key: "canal", label: "Canal", type: "select", options: ["Instagram", "Google Ads", "E-mail", "Evento", "Outro"] },
          { key: "status", label: "Status", type: "select", options: ["Planejada", "Em andamento", "Concluída", "Pausada"] },
          { key: "valor", label: "Investimento", type: "number" },
          { key: "observacoes", label: "Resultados / notas", type: "textarea" }
        ],
        rows: [
          { nome: "Lançamento Junho", responsavel: "Marina", canal: "Instagram", status: "Em andamento", valor: 3500, observacoes: "Criativos aprovados." }
        ]
      },
      clientes: {
        title: "Clientes",
        subtitle: "Centralize contatos, empresas, status comercial e contratos.",
        listTitle: "Base de clientes",
        formTitle: "Novo cliente",
        moneyLabel: "Contrato",
        fields: [
          { key: "nome", label: "Cliente / empresa", type: "text", required: true },
          { key: "responsavel", label: "Contato", type: "text", required: true },
          { key: "documento", label: "CPF/CNPJ", type: "text" },
          { key: "email", label: "E-mail", type: "email" },
          { key: "telefone", label: "Telefone", type: "text" },
          { key: "endereco", label: "Endereço completo", type: "text" },
          { key: "cidade", label: "Cidade/UF", type: "text" },
          { key: "plano", label: "Plano", type: "select", options: ["Básico", "Intermediário", "Avançado"] },
          { key: "prazo", label: "Vencimento mensal", type: "date" },
          { key: "tempo", label: "Tempo pretendido", type: "select", options: ["3 meses", "6 meses", "12 meses", "Indeterminado"] },
          { key: "implantacao", label: "Valor de implantação", type: "number" },
          { key: "status", label: "Status", type: "select", options: ["Lead", "Ativo", "Inativo", "Proposta"] },
          { key: "valor", label: "Valor da mensalidade", type: "number" },
          { key: "observacoes", label: "Observações", type: "textarea" }
        ],
        rows: [
          { nome: "NovaTech Ltda", responsavel: "João Lima", documento: "00.000.000/0001-00", email: "joao@novatech.com", telefone: "(00) 00000-0000", endereco: "Rua Exemplo, 100", cidade: "São Paulo/SP", plano: "Intermediário", prazo: "2026-06-10", tempo: "12 meses", implantacao: 2000, status: "Ativo", valor: 8400, observacoes: "Contrato mensal." }
        ]
      },
      mensalidades: {
        title: "Mensalidades",
        subtitle: "Controle os clientes que pagam mensalmente fora do sistema.",
        listTitle: "Controle de mensalidades",
        formTitle: "Nova mensalidade",
        moneyLabel: "Valor",
        fields: [
          { key: "nome", label: "Cliente / empresa", type: "text", required: true },
          { key: "responsavel", label: "Plano", type: "select", options: ["Básico", "Intermediário", "Avançado"] },
          { key: "prazo", label: "Vencimento", type: "date", required: true },
          { key: "status", label: "Status", type: "select", options: ["Pendente", "Pago", "Atrasado", "Cancelado"] },
          { key: "valor", label: "Valor mensal", type: "number", required: true },
          { key: "observacoes", label: "Observações", type: "textarea" }
        ],
        rows: [
          { nome: "NovaTech Ltda", responsavel: "Intermediário", prazo: "2026-06-10", status: "Pendente", valor: 8400, observacoes: "Cobrança feita por fora." },
          { nome: "Clínica Alfa", responsavel: "Básico", prazo: "2026-06-15", status: "Atrasado", valor: 490, observacoes: "Aguardando confirmação." }
        ]
      },
      agenda: {
        title: "Agenda",
        subtitle: "Anote reuniões futuras, tarefas do dia e lembretes importantes.",
        listTitle: "Calendário e tarefas",
        formTitle: "Novo compromisso",
        moneyLabel: "Prioridade",
        fields: [
          { key: "nome", label: "Título", type: "text", required: true },
          { key: "tipo", label: "Tipo", type: "select", options: ["Reunião", "Tarefa", "Lembrete"] },
          { key: "prazo", label: "Data", type: "date", required: true },
          { key: "hora", label: "Hora", type: "time" },
          { key: "status", label: "Status", type: "select", options: ["Pendente", "Concluído", "Adiado", "Cancelado"] },
          { key: "responsavel", label: "Com quem / responsável", type: "text" },
          { key: "valor", label: "Prioridade", type: "number" },
          { key: "observacoes", label: "Anotações", type: "textarea" }
        ],
        rows: [
          { nome: "Reunião de alinhamento", tipo: "Reunião", prazo: "2026-06-03", hora: "10:00", status: "Pendente", responsavel: "Equipe interna", valor: 2, observacoes: "Revisar próximos projetos." },
          { nome: "Enviar proposta", tipo: "Tarefa", prazo: "2026-06-03", hora: "15:00", status: "Pendente", responsavel: "Comercial", valor: 3, observacoes: "Enviar proposta do plano intermediário." }
        ]
      },
      rh: {
        title: "RH",
        subtitle: "Gerencie colaboradores, cargos, admissões e situação interna.",
        listTitle: "Equipe e RH",
        formTitle: "Novo colaborador",
        moneyLabel: "Salário",
        fields: [
          { key: "nome", label: "Colaborador", type: "text", required: true },
          { key: "responsavel", label: "Cargo", type: "text", required: true },
          { key: "prazo", label: "Admissão", type: "date" },
          { key: "status", label: "Status", type: "select", options: ["Ativo", "Férias", "Afastado", "Desligado"] },
          { key: "valor", label: "Salário", type: "number" },
          { key: "observacoes", label: "Observações", type: "textarea" }
        ],
        rows: [
          { nome: "Paula Mendes", responsavel: "Analista Financeira", prazo: "2026-05-02", status: "Ativo", valor: 4200, observacoes: "Experiência até agosto." }
        ]
      },
      financeiro: {
        title: "Gestão financeira",
        subtitle: "Controle entradas, saídas, gastos mensais e dinheiro realmente recebido.",
        listTitle: "Movimentações financeiras",
        formTitle: "Novo lançamento",
        moneyLabel: "Valor",
        fields: [
          { key: "nome", label: "Descrição", type: "text", required: true },
          { key: "tipo", label: "Tipo", type: "select", options: ["Entrada", "Saída"] },
          { key: "responsavel", label: "Categoria", type: "select", options: ["Receita", "Despesa", "Imposto", "Folha", "Fornecedor"] },
          { key: "prazo", label: "Vencimento", type: "date" },
          { key: "status", label: "Status", type: "select", options: ["Pendente", "Pago", "Atrasado", "Agendado"] },
          { key: "valor", label: "Valor", type: "number", required: true },
          { key: "observacoes", label: "Observações", type: "textarea" }
        ],
        rows: [
          { nome: "Mensalidade NovaTech", tipo: "Entrada", responsavel: "Receita", prazo: "2026-06-10", status: "Pendente", valor: 8400, observacoes: "Boleto enviado." },
          { nome: "Fornecedor de mídia", tipo: "Saída", responsavel: "Fornecedor", prazo: "2026-06-08", status: "Agendado", valor: -2200, observacoes: "Campanha Junho." }
        ]
      },
      gastosFixos: {
        title: "Gastos mensais fixos",
        subtitle: "Contas recorrentes que se repetem todos os meses.",
        listTitle: "Gastos mensais fixos",
        formTitle: "Novo gasto fixo",
        moneyLabel: "Valor mensal",
        fields: [
          { key: "nome", label: "Descrição", type: "text", required: true },
          { key: "responsavel", label: "Categoria", type: "select", options: ["Aluguel", "Internet", "Energia", "Sistema", "Contabilidade", "Assinatura", "Outro"] },
          { key: "dia", label: "Dia do vencimento", type: "number", required: true },
          { key: "status", label: "Status", type: "select", options: ["Ativo", "Pausado", "Cancelado"] },
          { key: "valor", label: "Valor mensal", type: "number", required: true },
          { key: "observacoes", label: "Observações", type: "textarea" }
        ],
        rows: [
          { nome: "Internet empresarial", responsavel: "Internet", dia: 10, status: "Ativo", valor: 180, observacoes: "Plano mensal." },
          { nome: "Contabilidade", responsavel: "Contabilidade", dia: 5, status: "Ativo", valor: 450, observacoes: "Honorários fixos." }
        ]
      }
    };
