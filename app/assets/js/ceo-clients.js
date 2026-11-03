/* Excel contacts use the existing authenticated clientes collection. Opening WhatsApp never implies delivery. */
(function (root) {
  'use strict';
  const initialMessage = 'Olá, {nome}! Tudo bem? Gostaria de conversar com você sobre nossos serviços.';
  let message = initialMessage, workbook = null, sheet = '', nameColumn = 0, phoneColumn = 1, search = '', generation = 0;
  let previewPage = 0, includePending = true, importSummary = '';
  const pageSize = 100;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plain = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  function phone(value) {
    const raw = String(value ?? '').trim();
    if (!raw || /[^\d\s()+.\-]/.test(raw)) return '';
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (!raw.startsWith('+') && !raw.startsWith('00') && [10, 11].includes(digits.length)) digits = '55' + digits;
    if (digits.startsWith('55')) return /^55[1-9]\d(?:[2-5]\d{7}|9\d{8})$/.test(digits) ? digits : '';
    return /^(?:\+|00)/.test(raw) && /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
  }
  const personalize = (template, name) => String(template).replace(/\{nome\}/gi, () => String(name));
  const contactKey = (name, number) => JSON.stringify([plain(name).replace(/\s+/g, ' '), phone(number) || plain(number)]);
  function candidates(rows, nameIndex, phoneIndex, existing = [], allowPending = true) {
    const seen = new Set(existing.map(row => contactKey(row.nome, row.telefone)));
    return rows.slice(1).map((row, index) => {
      const nome = String(row[nameIndex] ?? '').trim(), telefone = String(row[phoneIndex] ?? '').trim();
      const normalized = phone(telefone);
      const warning = normalized ? '' : telefone ? 'Telefone inválido: confira DDD e número' : 'Sem telefone';
      const key = contactKey(nome, telefone);
      const problem = !nome ? 'Nome ausente' : seen.has(key) ? 'Contato duplicado (mesmo nome e telefone)' : !allowPending && warning ? warning : '';
      if (!problem) seen.add(key);
      return { nome, telefone, problem, warning, line: index + 2 };
    }).filter(row => row.nome || row.telefone);
  }
  function reset() { generation++; workbook = null; sheet = ''; search = ''; message = initialMessage; previewPage = 0; includePending = true; importSummary = ''; }
  // Read underlying numeric values so Excel display formats cannot round phone numbers.
  function worksheetRows(tab, xlsx = root.XLSX) {
    return xlsx.utils.sheet_to_json(tab, { header: 1, defval: '', raw: true, blankrows: true, range: 0 });
  }
  function matrix() { return workbook ? worksheetRows(workbook.Sheets[sheet]) : []; }
  function guessColumns() {
    const headers = (matrix()[0] || []).map(plain);
    nameColumn = Math.max(0, headers.findIndex(h => /nome|cliente|contato/.test(h)));
    phoneColumn = headers.findIndex(h => /telefone|celular|whatsapp|\bzap\b|fone/.test(h));
    if (phoneColumn < 0) phoneColumn = headers.length > 1 ? 1 : 0;
  }
  function render(container) {
    const clients = state.clientes || [];
    const rows = matrix(), headers = rows[0] || [];
    const preview = workbook ? candidates(rows, nameColumn, phoneColumn, clients, includePending) : [];
    const valid = preview.filter(row => !row.problem);
    const pending = valid.filter(row => row.warning).length;
    const pages = Math.max(1, Math.ceil(preview.length / pageSize));
    previewPage = Math.min(previewPage, pages - 1);
    const pageRows = preview.slice(previewPage * pageSize, (previewPage + 1) * pageSize);
    const matching = clients.filter(row => plain(`${row.nome} ${row.telefone}`).includes(plain(search)));
    const options = selected => headers.map((h, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(h || `Coluna ${i + 1}`)}</option>`).join('');
    container.innerHTML = `<div class="clients-workspace">
      <section class="ceo-card"><div class="ceo-card-head"><div><h2>Importar clientes</h2><p>Excel (.xlsx ou .xls) e CSV, até 5 MB e 5.000 linhas. A primeira linha deve conter os títulos das colunas.</p></div></div>
      <label class="clients-field">Planilha de clientes<input id="clientsFile" type="file" accept=".xlsx,.xls,.csv"></label>
      <p>Números brasileiros: DDD + telefone. Para outros países, use + e o código do país.</p>
      <p id="clientsNotice" role="status">${esc(importSummary)}</p>
      ${workbook ? `<div class="clients-fields"><label class="clients-field">Aba da planilha<select id="clientsSheet">${workbook.SheetNames.map(s => `<option ${s === sheet ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label><label class="clients-field">Coluna do nome<select id="clientsNameColumn">${options(nameColumn)}</select></label><label class="clients-field">Coluna do telefone<select id="clientsPhoneColumn">${options(phoneColumn)}</select></label></div>
      <label class="clients-pending-option"><input id="clientsIncludePending" type="checkbox" ${includePending ? 'checked' : ''}> Incluir contatos sem telefone ou com telefone inválido (WhatsApp desativado)</label>
      <p>${preview.length} contatos encontrados na aba selecionada, sem contar o cabeçalho e as linhas vazias.</p>
      <p>${valid.length} prontos para importar · ${preview.length - valid.length} ignorados · ${pending} com telefone pendente. Nenhum cliente existente será substituído.</p>
      <div class="ceo-table-scroll clients-import-preview"><table class="ceo-table"><thead><tr><th>Linha</th><th>Nome</th><th>Telefone</th><th>Revisão</th></tr></thead><tbody>${pageRows.map(row => `<tr><td>${row.line}</td><td>${esc(row.nome)}</td><td>${esc(row.telefone || 'Sem telefone')}</td><td>${esc(row.problem || (row.warning ? `Será importado · ${row.warning}` : 'Pronto'))}</td></tr>`).join('')}</tbody></table></div>
      <div class="clients-pagination"><button class="ceo-button" id="clientsPreviousPage" ${previewPage === 0 ? 'disabled' : ''}>Anterior</button><span role="status">Página ${previewPage + 1} de ${pages} · Mostrando ${preview.length ? previewPage * pageSize + 1 : 0}–${Math.min((previewPage + 1) * pageSize, preview.length)} de ${preview.length} contatos</span><button class="ceo-button" id="clientsNextPage" ${previewPage >= pages - 1 ? 'disabled' : ''}>Próxima</button></div>
      <p>O botão abaixo importa todos os contatos prontos da aba selecionada, incluindo os das outras páginas.</p>
      <button class="ceo-button primary" id="clientsImport" ${!valid.length || nameColumn === phoneColumn ? 'disabled' : ''}>Importar ${valid.length} clientes</button> <button class="ceo-button" id="clientsCancel">Cancelar importação</button>` : ''}</section>
      <section class="ceo-card"><div class="ceo-card-head"><div><h2>Mensagem de contato</h2><p>Escreva uma vez e use {nome} para inserir o nome de cada pessoa automaticamente.</p></div></div>
      <label class="clients-field">Sua mensagem<textarea id="clientsMessage" rows="4" maxlength="3000">${esc(message)}</textarea></label>
      <p>O WhatsApp abre com o texto preenchido. Você confere e toca em Enviar manualmente.</p></section>
      <section class="ceo-card"><div class="ceo-card-head"><div><h2>Clientes (${clients.length})</h2><p>Clique em WhatsApp para abrir a conversa com a mensagem acima personalizada.</p></div></div>
      <label class="clients-field">Buscar cliente<input id="clientsSearch" type="search" value="${esc(search)}" placeholder="Nome ou telefone"></label>
      <ul class="clients-list" aria-label="Lista de clientes">${matching.length ? matching.map(row => {
        const index = clients.indexOf(row), number = phone(row.telefone);
        return `<li class="clients-contact"><div class="clients-contact-details"><h3>${esc(row.nome)}</h3><p>${esc(row.telefone || 'Sem telefone')}${!number && row.telefone ? ' · Telefone pendente' : ''}</p></div><div class="clients-contact-actions"><a class="ceo-button primary clients-whatsapp" aria-label="Abrir WhatsApp" title="${esc(`Abrir WhatsApp de ${row.nome}`)}" data-client-open="${index}" target="_blank" rel="noopener noreferrer" ${number && message.trim() ? `href="https://wa.me/${number}?text=${encodeURIComponent(personalize(message, row.nome))}"` : 'aria-disabled="true"'}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 11.5a9 9 0 0 1-13.4 7.8L3 21l1.7-4.6A9 9 0 1 1 21 11.5Z"></path><path d="M8 7c-2 4 2 8 6 9l2-2-3-2-1 1-2-2 1-1-2-3Z"></path></svg><span>WhatsApp</span></a>${!number ? '<button class="ceo-button" data-client-phone-edit="' + index + '">Corrigir telefone</button>' : ''}</div></li>`;
      }).join('') : '<li class="ceo-empty">Nenhum cliente encontrado. Importe uma planilha para começar.</li>'}</ul></section></div>`;
    container.querySelector('#clientsMessage').oninput = event => {
      message = event.target.value;
      container.querySelectorAll('[data-client-open]').forEach(el => {
        const row = clients[Number(el.dataset.clientOpen)], number = phone(row.telefone);
        el.removeAttribute('href'); el.setAttribute('aria-disabled', 'true');
        if (number && message.trim()) { el.href = `https://wa.me/${number}?text=${encodeURIComponent(personalize(message, row.nome))}`; el.removeAttribute('aria-disabled'); }
      });
    };
    container.querySelector('#clientsSearch').oninput = event => {
      const position = event.target.selectionStart; search = event.target.value; render(container);
      const input = container.querySelector('#clientsSearch'); input.focus(); input.setSelectionRange(position, position);
    };
    container.querySelectorAll('[data-client-phone-edit]').forEach(button => {
      button.onclick = () => {
        const row = clients[Number(button.dataset.clientPhoneEdit)], epoch = cloudEpoch;
        const form = document.createElement('form');
        form.innerHTML = `<label class="clients-field">Telefone de ${esc(row.nome)}<input name="phone" type="tel" value="${esc(row.telefone)}" required placeholder="DDD + telefone"></label><p role="status"></p><button class="ceo-button primary" type="submit">Salvar telefone</button> <button class="ceo-button" type="button">Cancelar</button>`;
        button.hidden = true;
        button.closest('.clients-contact').append(form);
        const input = form.elements.phone, status = form.querySelector('[role="status"]'), submit = form.querySelector('[type="submit"]');
        form.querySelector('[type="button"]').onclick = () => render(container);
        form.onsubmit = async event => {
          event.preventDefault();
          const value = input.value.trim();
          if (!phone(value)) { status.textContent = 'Confira o DDD e o número. Para outros países, use + e o código do país.'; return; }
          if (epoch !== cloudEpoch) return;
          submit.disabled = true;
          await ceoCommit(draft => {
            const target = draft.clientes.find(client => client.id === row.id);
            if (!target || target.telefone !== row.telefone) throw new Error('Este cliente mudou. Atualize a lista e tente novamente.');
            if (draft.clientes.some(client => client.id !== row.id && contactKey(client.nome, client.telefone) === contactKey(target.nome, value))) throw new Error('Já existe um contato com este nome e telefone.');
            target.telefone = value;
          }, 'Telefone salvo');
          submit.disabled = false;
        };
        input.focus();
      };
    });
    container.querySelector('#clientsFile').onchange = async event => {
      const file = event.target.files[0], ticket = ++generation, epoch = cloudEpoch;
      if (!file) return;
      const notice = container.querySelector('#clientsNotice'); notice.textContent = 'Lendo planilha…';
      workbook = null;
      try {
        if (!/\.(xlsx|xls|csv)$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw new Error('Escolha um Excel ou CSV de até 5 MB.');
        const buffer = await file.arrayBuffer();
        if (ticket !== generation || epoch !== cloudEpoch) return;
        const parsed = root.XLSX.read(buffer, { type: 'array', sheetRows: 5002, raw: true });
        if (!parsed.SheetNames.length) throw new Error('A planilha não possui abas.');
        for (const name of parsed.SheetNames) {
          const tab = parsed.Sheets[name], ref = tab['!fullref'] || tab['!ref'];
          if (ref && (root.XLSX.utils.decode_range(ref).e.r > 5000 || root.XLSX.utils.decode_range(ref).e.c > 99)) throw new Error('Use até 5.000 linhas de clientes e 100 colunas por aba.');
        }
        workbook = parsed; sheet = parsed.SheetNames[0]; previewPage = 0; importSummary = ''; guessColumns();
        if (activeModule === 'clientes') render(container);
      } catch (error) {
        if (ticket !== generation || epoch !== cloudEpoch) return;
        workbook = null;
        if (activeModule === 'clientes') {
          render(container);
          container.querySelector('#clientsNotice').textContent = error.message || 'Não foi possível ler a planilha.';
        }
      }
    };
    if (!workbook) return;
    container.querySelector('#clientsSheet').onchange = event => { sheet = event.target.value; previewPage = 0; guessColumns(); render(container); };
    container.querySelector('#clientsIncludePending').onchange = event => { includePending = event.target.checked; render(container); };
    container.querySelector('#clientsPreviousPage').onclick = () => { previewPage--; render(container); };
    container.querySelector('#clientsNextPage').onclick = () => { previewPage++; render(container); };
    container.querySelector('#clientsNameColumn').onchange = event => { nameColumn = Number(event.target.value); render(container); };
    container.querySelector('#clientsPhoneColumn').onchange = event => { phoneColumn = Number(event.target.value); render(container); };
    container.querySelector('#clientsCancel').onclick = () => { workbook = null; generation++; render(container); };
    container.querySelector('#clientsImport').onclick = async event => {
      event.target.disabled = true;
      const epoch = cloudEpoch, ticket = generation;
      let added = 0, pendingAdded = 0;
      const saved = await ceoCommit(draft => {
        const fresh = candidates(rows, nameColumn, phoneColumn, draft.clientes || [], includePending).filter(row => !row.problem);
        added = fresh.length; pendingAdded = fresh.filter(row => row.warning).length;
        draft.clientes ||= [];
        fresh.forEach(row => draft.clientes.push({ id: crypto.randomUUID(), nome: row.nome, responsavel: row.nome, telefone: row.telefone, status: 'Lead', valor: 0, createdAt: new Date().toISOString() }));
      }, 'Clientes importados');
      if (epoch !== cloudEpoch || ticket !== generation) return;
      if (saved) { workbook = null; importSummary = `${added} clientes importados, sendo ${pendingAdded} com telefone pendente. ${preview.length - added} contatos ignorados. Todas as páginas da aba selecionada foram consideradas.`; }
      if (activeModule === 'clientes') render(container);
    };
  }
  root.ZamaClients = { render, reset, phone, personalize, candidates, worksheetRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ZamaClients;
})(typeof window !== 'undefined' ? window : globalThis);
