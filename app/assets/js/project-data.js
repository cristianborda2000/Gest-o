/* Pure project data rules. Keep workspace, RPC, DOM and secrets in the controller. */
(function (root) {
  'use strict';

  const statuses = Object.freeze({ planning: 'Planejamento', in_progress: 'Em andamento', waiting: 'Aguardando cliente', completed: 'Concluído' });
  const processStatuses = Object.freeze({ planning: 'Não iniciado', in_progress: 'Em andamento', waiting: 'Aguardando', completed: 'Concluído' });
  const text = value => String(value ?? '');
  const metadataFields = Object.freeze([
    'id', 'title', 'client_name', 'company_name', 'client_email', 'client_phone',
    'access_url', 'responsible_email', 'responsible_name', 'status', 'due_date',
    'notes', 'created_at', 'updated_at'
  ]);
  const processFields = Object.freeze(['description', 'responsible_name', 'due_date', 'status']);

  function productionLists(source) {
    const lists = Array.isArray(source.production_lists) ? source.production_lists : [
      { id: 'catalog', title: 'Catálogo', steps: source.catalog_steps },
      { id: 'onboarding', title: 'Estruturação', steps: source.onboarding_steps }
    ].filter(list => Array.isArray(list.steps) && list.steps.length);

    return lists.map(list => ({
      id: text(list.id), title: text(list.title),
      ...Object.fromEntries(processFields.filter(key => Object.hasOwn(list, key))
        .map(key => [key, key === 'due_date' && list[key] === null ? null : text(list[key])])),
      ...(Array.isArray(list.links) ? { links: list.links.map(link => ({ label: text(link.label), url: text(link.url) })) } : {}),
      steps: Array.isArray(list.steps) ? list.steps.map(step => ({
        id: text(step.id), label: text(step.label), done: step.done === true,
        ...(step.due_date ? { due_date: text(step.due_date) } : {})
      })) : []
    }));
  }

  // Only these public properties may enter the metadata cache. Password fields
  // returned accidentally by an RPC must never enter exports or app/local state.
  function metadata(source) {
    if (!source || typeof source !== 'object' || !source.id) throw new Error('PROJECT_INVALID_RESPONSE');
    const record = {};
    metadataFields.forEach(key => { record[key] = text(source[key]); });
    record.revision = Number(source.revision || 0);
    record.has_password = Boolean(source.has_password);
    record.production_lists = productionLists(source);
    if (!Object.hasOwn(statuses, record.status)) record.status = 'planning';
    return record;
  }

  function progress(steps) {
    const total = steps.length, done = steps.filter(step => step.done).length;
    return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  function storedPhone(value) {
    const phone = text(value);
    return /^[1-9]\d{7,14}$/.test(phone) ? phone : '';
  }

  function normalizePhone(value) {
    const raw = text(value).trim();
    if (!raw) return '';
    const invalid = () => { throw new Error('Informe o WhatsApp com DDD, como (11) 99999-9999. Para outro país, use + e o código do país.'); };
    if (raw.length > 40 || !/^\+?[\d\s().-]+$/.test(raw)) invalid();
    let digits = raw.replace(/\D/g, '');
    if (!raw.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
    else if (!raw.startsWith('+')) {
      if (/^\d{10,11}$/.test(digits)) digits = `55${digits}`;
      else if (!/^55\d{10,11}$/.test(digits)) invalid();
    }
    if (!storedPhone(digits) || digits.startsWith('55') && !/^55[1-9]{2}[2-9]\d{7,8}$/.test(digits)) invalid();
    return digits;
  }

  function phoneLabel(value) {
    const phone = storedPhone(value);
    if (!phone) return '';
    const brazil = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
    return brazil ? `+55 (${brazil[1]}) ${brazil[2]}-${brazil[3]}` : `+${phone}`;
  }

  function friendly(error) {
    const value = `${error?.code || ''} ${error?.message || ''}`;
    const inviteMessages = ['Confirme seu e-mail antes de convidar pessoas.', 'Você já é o proprietário desta empresa.', 'Salve os dados da sua empresa antes de gerar um convite.', 'Limite de convites atingido. Tente novamente mais tarde.', 'Convite inválido.'];
    if (inviteMessages.includes(error?.message)) return error.message;
    if (/40001|PROJECT_CONFLICT/.test(value)) return 'Este projeto foi atualizado por outra pessoa. Feche esta janela, atualize a lista e tente novamente.';
    if (/42501|PROJECT_ACCESS_DENIED|permission denied/i.test(value)) return 'Seu acesso a este projeto mudou. Atualize a lista para verificar os projetos disponíveis.';
    if (/PGRST202|42883|does not exist|schema cache|PROJECT_UNAVAILABLE/i.test(value)) return 'A área de projetos ainda não está disponível nesta instalação. A configuração do banco de dados precisa ser concluída. Depois, tente novamente.';
    if (/PROJECT_INVALID_PHONE|PROJECT_INVALID_FIELD: client_phone/.test(value)) return 'Confira o WhatsApp do cliente. Informe o DDD e o número; para outro país, use + e o código do país.';
    if (/PROJECT_INVALID_PROCESS_LINKS/.test(value)) return 'Confira os links de arquivos dos processos. Use até 20 links por processo, começando com https:// ou http://.';
    if (/PROJECT_INVALID_PROCESS/.test(value)) return 'Confira a descrição, o responsável e o andamento de cada processo antes de salvar.';
    if (/22023|PROJECT_INVALID/.test(value)) return 'Confira os campos e as etapas do projeto antes de salvar. Use um e-mail válido e preencha o nome do cliente e o título.';
    return 'Não foi possível concluir a operação. Verifique sua conexão e tente novamente.';
  }

  const api = Object.freeze({ statuses, processStatuses, productionLists, metadata, progress, safeUrl, storedPhone, normalizePhone, phoneLabel, friendly });
  root.ZamaProjectData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
