/*
  contracts.js
  Gera a tela de impressao/PDF do contrato de prestacao de servico
  a partir dos dados cadastrados em Clientes.
*/

    async function printClientContract(client) {
      if (!client) return;

      const win = window.open("", "_blank");
      if (!win) {
        alert("Permita pop-ups para gerar o contrato em PDF.");
        return;
      }

      const contractRecord = registerContractHistory(client);
      await persist();
      render();

      win.document.write(buildClientContractHtml(client, contractRecord));
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 300);
    }

    function registerContractHistory(client) {
      const year = new Date().getFullYear();
      const sequence = String((state.contractHistory || []).length + 1).padStart(4, "0");
      const record = {
        id: createId(),
        numero: `ZAMA-${year}-${sequence}`,
        clienteId: client.id,
        cliente: client.nome,
        plano: client.plano,
        valor: Number(client.valor || 0),
        implantacao: Number(client.implantacao || 0),
        data: new Date().toISOString()
      };

      state.contractHistory.unshift(record);
      return record;
    }

    function buildClientContractHtml(client, contractRecord = {}) {
      const installationValue = Number(client.implantacao || 0);
      const firstPayment = installationValue / 2;
      const finalPayment = installationValue / 2;
      const monthlyValue = Number(client.valor || 0);
      const dueDay = client.prazo ? client.prazo.split("-")[2] : "";
      const contractDate = new Date().toLocaleDateString("pt-BR");
      const company = {
        ...defaultCompanyProfile,
        ...(state.companyProfile || {})
      };
      const logoUrl = /^https?:|^data:/.test(company.logoUrl || "")
        ? company.logoUrl
        : new URL(company.logoUrl || "zama-logo.png", window.location.href).href;
      const companyName = company.nome || "ZAMA";
      const companySignature = company.assinatura || companyName;

      const c = (value) => escapeHtml(value || "____________________________");
      const money = (value) => currency.format(Number(value || 0));

      return `<!doctype html>
        <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <title>Contrato - ${c(client.nome)}</title>
          <style>
            @page { size: A4; margin: 3cm 2cm 2cm 3cm; }
            * { box-sizing: border-box; }
            html, body { margin: 0; padding: 0; background: #ffffff; color: #000000; }
            body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.5; }
            .document { width: 100%; margin: 0; }
            .print-action { position: fixed; right: 16px; top: 16px; z-index: 10; padding: 10px 14px; border: 0; border-radius: 6px; background: #ff6b00; color: #ffffff; cursor: pointer; font-family: Arial, Helvetica, sans-serif; font-size: 13px; }
            .brand-header { display: grid; grid-template-columns: 4cm 1fr; gap: 14pt; align-items: center; margin-bottom: 18pt; padding-bottom: 10pt; border-bottom: 1px solid #000000; }
            .logo { width: 4cm; max-height: 2.2cm; object-fit: contain; }
            .company-info { text-align: right; font-size: 10pt; line-height: 1.25; }
            .company-info strong { display: block; font-size: 12pt; margin-bottom: 2pt; text-transform: uppercase; }
            .contract-number { margin: 0 0 12pt; text-align: right; text-indent: 0; font-size: 10pt; }
            .title { text-align: center; margin: 0 0 22pt; }
            .title h1 { margin: 0; font-size: 12pt; font-weight: 700; text-transform: uppercase; line-height: 1.5; }
            .title p { margin: 6pt 0 0; font-size: 10pt; line-height: 1.2; text-align: center; text-indent: 0; }
            h2 { margin: 12pt 0 6pt; font-size: 12pt; font-weight: 700; text-transform: uppercase; line-height: 1.5; break-after: avoid; }
            p { margin: 0 0 6pt; text-align: justify; text-indent: 1.25cm; }
            ul { margin: 0 0 6pt 1.25cm; padding: 0; }
            li { margin: 0 0 4pt; text-align: justify; }
            table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 11pt; line-height: 1.3; }
            th, td { border: 1px solid #000000; padding: 5pt 6pt; vertical-align: top; text-align: left; }
            th { width: 34%; font-weight: 700; background: #f2f2f2; }
            .payment-table th { width: auto; }
            .qualification p, .no-indent { text-indent: 0; }
            .clause { break-inside: avoid; }
            .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5cm; margin-top: 48pt; break-inside: avoid; }
            .signature { text-align: center; border-top: 1px solid #000000; padding-top: 6pt; min-height: 42pt; }
            .signature p { margin: 0; text-align: center; text-indent: 0; line-height: 1.3; }
            .small { font-size: 10pt; }
            @media print { .no-print { display: none; } body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
          </style>
        </head>
        <body>
          <button class="no-print print-action" onclick="window.print()">Imprimir / Salvar PDF</button>
          <main class="document">
            <header class="brand-header">
              <img class="logo" src="${logoUrl}" alt="${c(companyName)}">
              <div class="company-info">
                <strong>${c(companyName)}</strong>
                ${company.documento ? `CPF/CNPJ: ${c(company.documento)}<br>` : ""}
                ${company.endereco ? `${c(company.endereco)}<br>` : ""}
                ${company.cidade ? `${c(company.cidade)}<br>` : ""}
                ${company.telefone ? `Telefone: ${c(company.telefone)}<br>` : ""}
                ${company.email ? `E-mail: ${c(company.email)}` : ""}
              </div>
            </header>

            <p class="contract-number"><strong>Contrato n. ${c(contractRecord.numero)}</strong></p>

            <div class="title">
              <h1>Instrumento Particular de Contrato de Prestação de Serviços de Catálogo Digital</h1>
              <p>Criação, implantação, configuração e personalização de catálogo digital/loja digital.</p>
            </div>

            <section class="qualification">
              <h2>Das partes</h2>
              <p><strong>CONTRATANTE:</strong> ${c(client.nome)}, inscrito(a) no CPF/CNPJ sob n. ${c(client.documento)}, neste ato representado(a) por ${c(client.responsavel)}, com endereço em ${c(client.endereco)}, ${c(client.cidade)}, telefone ${c(client.telefone)} e e-mail ${c(client.email)}.</p>
              <p><strong>CONTRATADA:</strong> ${c(companyName)}, ${company.documento ? `inscrita no CPF/CNPJ sob n. ${c(company.documento)}, ` : ""}com endereço em ${c(company.endereco)}, ${c(company.cidade)}, telefone ${c(company.telefone)} e e-mail ${c(company.email)}, responsável pela prestação dos serviços descritos neste instrumento.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 1 - Do objeto</h2>
              <p>O presente contrato tem por objeto a prestação de serviços de criação, implantação, configuração e personalização de catálogo digital/loja digital para o CONTRATANTE, conforme plano contratado e informações fornecidas pelas partes.</p>
              <p>Os serviços poderão compreender, conforme a necessidade do projeto:</p>
              <ul>
                <li>criação e configuração inicial do catálogo digital;</li>
                <li>cadastro e organização de produtos, categorias, descrições, preços e imagens;</li>
                <li>upload, ajuste e aplicação de banners fornecidos pelo CONTRATANTE;</li>
                <li>configuração visual da loja, incluindo cores, identidade visual, layout e apresentação dos produtos;</li>
                <li>ajustes de design visual para adequação à marca do CONTRATANTE;</li>
                <li>configuração de impressoras compatíveis com o sistema utilizado pelo CONTRATANTE, quando aplicável;</li>
                <li>orientações básicas de uso da plataforma; e</li>
                <li>suporte inicial para funcionamento do catálogo digital até a entrega final.</li>
              </ul>
            </section>

            <section class="clause">
              <h2>Cláusula 2 - Do plano, prazo e mensalidade</h2>
              <table>
                <tbody>
                  <tr><th>Plano contratado</th><td>${c(client.plano)}</td></tr>
                  <tr><th>Tempo pretendido</th><td>${c(client.tempo)}</td></tr>
                  <tr><th>Valor mensal</th><td>${money(monthlyValue)}</td></tr>
                  <tr><th>Vencimento mensal</th><td>Dia ${c(dueDay)}</td></tr>
                </tbody>
              </table>
              <p>A mensalidade refere-se ao controle/continuidade do serviço contratado, conforme combinado entre as partes, sem prejuízo de cobranças realizadas em sistema externo utilizado pelo CONTRATANTE ou pela CONTRATADA.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 3 - Do valor de implantação e da forma de pagamento</h2>
              <p>Pela implantação, configuração e personalização inicial do catálogo digital/loja digital, o CONTRATANTE pagará à CONTRATADA o valor total de <strong>${money(installationValue)}</strong>.</p>
              <table class="payment-table">
                <thead>
                  <tr><th>Descrição</th><th>Condição</th><th>Valor</th></tr>
                </thead>
                <tbody>
                  <tr><td>Primeira parcela</td><td>50% antes do início dos serviços</td><td>${money(firstPayment)}</td></tr>
                  <tr><td>Segunda parcela</td><td>50% na conclusão da implantação</td><td>${money(finalPayment)}</td></tr>
                  <tr><td><strong>Valor total de implantação</strong></td><td>Implantação completa</td><td><strong>${money(installationValue)}</strong></td></tr>
                </tbody>
              </table>
              <p>O início dos serviços fica condicionado ao pagamento da primeira parcela. A entrega final, a liberação completa ou o encerramento da implantação poderá ficar condicionado ao pagamento da segunda parcela.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 4 - Das obrigações da contratada</h2>
              <p>A CONTRATADA compromete-se a executar os serviços contratados com zelo técnico, organizar as informações recebidas, configurar o catálogo digital de acordo com o plano contratado e realizar os ajustes necessários dentro do escopo combinado.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 5 - Das obrigações do contratante</h2>
              <p>O CONTRATANTE deverá fornecer informações corretas, imagens, banners, descrições, preços, links, dados de produtos, dados de impressoras, dados de acesso e demais materiais necessários para a montagem e configuração do catálogo digital.</p>
              <p>O atraso no envio de informações, materiais ou aprovações poderá impactar o prazo de entrega, sem responsabilidade da CONTRATADA.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 6 - Da suspensão, atraso e cancelamento</h2>
              <p>Em caso de atraso no pagamento de valores de implantação ou mensalidade, a CONTRATADA poderá suspender temporariamente a manutenção, atualização, suporte ou entrega final do catálogo digital até a regularização dos valores pendentes.</p>
              <p>O cancelamento poderá ser solicitado por qualquer uma das partes mediante aviso prévio, respeitados os valores pendentes e os serviços já executados até a data do encerramento.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 7 - Dos dados, imagens e conteúdos</h2>
              <p>O CONTRATANTE declara ser responsável pela veracidade, autorização de uso e regularidade dos dados, imagens, marcas, textos, preços, produtos e demais informações enviados para utilização no catálogo digital.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 8 - Da proteção de dados</h2>
              <p>As partes deverão observar a legislação aplicável de proteção de dados pessoais, especialmente a Lei Geral de Proteção de Dados Pessoais (LGPD), quando houver tratamento de dados pessoais durante a execução dos serviços.</p>
            </section>

            <section class="clause">
              <h2>Cláusula 9 - Das observações específicas</h2>
              <p>${c(client.observacoes)}</p>
            </section>

            <section class="clause">
              <h2>Cláusula 10 - Do foro</h2>
              <p>As partes elegem o foro da comarca de ${c(client.cidade)} para dirimir eventuais dúvidas ou controvérsias decorrentes deste contrato, salvo acordo escrito em sentido diverso.</p>
            </section>

            <p class="no-indent">E, por estarem justas e contratadas, as partes firmam o presente instrumento para que produza seus efeitos legais.</p>
            <p class="no-indent"><strong>Local e data:</strong> ${c(client.cidade)}, ${contractDate}.</p>

            <div class="signatures">
              <div class="signature">
                <p>${c(client.nome)}</p>
                <p class="small">CONTRATANTE</p>
              </div>
              <div class="signature">
                <p>${c(companySignature)}</p>
                <p class="small">CONTRATADA</p>
              </div>
            </div>
          </main>
        </body>
        </html>`;
    }
