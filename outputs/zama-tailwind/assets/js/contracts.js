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
            @page { size: A4; margin: 16mm; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #111827; font-family: Arial, Helvetica, sans-serif; line-height: 1.48; font-size: 12.5px; }
            .document { max-width: 780px; margin: 0 auto; }
            .header { display: grid; grid-template-columns: 220px 1fr; align-items: center; gap: 24px; border-bottom: 4px solid #ff6b00; padding-bottom: 14px; margin-bottom: 18px; }
            .header img { width: 210px; height: auto; }
            .header-info { text-align: right; font-size: 12px; color: #7a4b22; }
            .header-info strong { display: block; color: #111827; font-size: 18px; letter-spacing: 0; margin-bottom: 4px; }
            .contract-number { display: inline-block; margin-top: 6px; padding: 5px 8px; border-radius: 6px; background: #fff1dc; color: #9a3412; font-weight: 700; }
            .title { text-align: center; margin: 18px 0 20px; }
            .title h1 { font-size: 20px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0; }
            .title p { color: #7a4b22; margin: 0; }
            h2 { font-size: 13px; margin: 18px 0 8px; color: #9a3412; text-transform: uppercase; border-bottom: 1px solid #ffc078; padding-bottom: 5px; }
            p { margin: 0 0 9px; }
            ul { margin: 8px 0 12px 18px; padding: 0; }
            li { margin: 4px 0; }
            .box { border: 1px solid #ffc078; border-radius: 8px; padding: 12px; background: #fff8f0; margin: 10px 0 14px; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; }
            .payment-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0 14px; }
            .payment-card { border: 1px solid #ffc078; border-radius: 8px; padding: 11px; background: #fff8f0; }
            .payment-card span { display: block; color: #7a4b22; font-size: 11px; text-transform: uppercase; margin-bottom: 6px; }
            .payment-card strong { display: block; color: #111827; font-size: 16px; }
            .clause { break-inside: avoid; }
            .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin-top: 58px; }
            .signature { text-align: center; border-top: 1px solid #111827; padding-top: 8px; min-height: 60px; }
            .small { font-size: 11px; color: #555; }
            @media print { .no-print { display: none; } }
          </style>
        </head>
        <body>
          <button class="no-print" onclick="window.print()" style="position:fixed;right:16px;top:16px;padding:10px 14px;border:0;border-radius:8px;background:#ff6b00;color:#fff;cursor:pointer;">Imprimir / Salvar PDF</button>
          <main class="document">
            <div class="header">
              <img src="${logoUrl}" alt="${c(companyName)}">
              <div class="header-info">
                <strong>${c(companyName)}</strong>
                Prestação de serviços digitais<br>
                ${company.telefone ? `${c(company.telefone)}<br>` : ""}
                ${company.email ? `${c(company.email)}<br>` : ""}
                ${company.endereco ? `${c(company.endereco)}<br>` : ""}
                ${company.cidade ? `${c(company.cidade)}<br>` : ""}
                ${company.documento ? `CNPJ/CPF: ${c(company.documento)}<br>` : ""}
                Contrato gerado em ${contractDate}
                <span class="contract-number">Contrato ${c(contractRecord.numero)}</span>
              </div>
            </div>

            <div class="title">
              <h1>Contrato de Prestação de Serviços de Catálogo Digital</h1>
              <p>Criação, implantação, configuração e personalização de catálogo digital/loja digital.</p>
            </div>

            <section class="clause">
              <h2>Contratante</h2>
              <div class="box grid">
                <p><strong>Cliente/Empresa:</strong> ${c(client.nome)}</p>
                <p><strong>CPF/CNPJ:</strong> ${c(client.documento)}</p>
                <p><strong>Responsável:</strong> ${c(client.responsavel)}</p>
                <p><strong>E-mail:</strong> ${c(client.email)}</p>
                <p><strong>Telefone:</strong> ${c(client.telefone)}</p>
                <p><strong>Cidade/UF:</strong> ${c(client.cidade)}</p>
                <p style="grid-column:1 / -1;"><strong>Endereço:</strong> ${c(client.endereco)}</p>
              </div>
            </section>

            <section class="clause">
              <h2>Contratada</h2>
              <p><strong>ZAMA</strong>, responsável pela prestação dos serviços digitais descritos neste contrato.</p>
            </section>

            <section class="clause">
              <h2>1. Objeto</h2>
              <p>O presente contrato tem como objeto a prestação de serviços de criação, implantação, configuração e personalização de catálogo digital/loja digital para o CONTRATANTE.</p>
              <p>Os serviços poderão incluir, conforme o plano contratado e as necessidades do CONTRATANTE:</p>
              <ul>
                <li>criação e configuração inicial do catálogo digital;</li>
                <li>cadastro e organização de produtos, categorias, descrições, preços e imagens;</li>
                <li>upload e ajuste de banners fornecidos pelo CONTRATANTE;</li>
                <li>configuração visual da loja, incluindo cores, identidade visual, layout e apresentação dos produtos;</li>
                <li>ajustes de design visual para adequação à marca do CONTRATANTE;</li>
                <li>configuração de impressoras compatíveis com o sistema utilizado pelo CONTRATANTE, quando aplicável;</li>
                <li>orientações básicas de uso da plataforma;</li>
                <li>suporte inicial para funcionamento do catálogo digital;</li>
                <li>ajustes necessários até a entrega final, conforme escopo combinado entre as partes.</li>
              </ul>
            </section>

            <section class="clause">
              <h2>2. Plano, prazo e mensalidade</h2>
              <div class="box grid">
                <p><strong>Plano contratado:</strong> ${c(client.plano)}</p>
                <p><strong>Tempo pretendido:</strong> ${c(client.tempo)}</p>
                <p><strong>Valor mensal:</strong> ${money(monthlyValue)}</p>
                <p><strong>Vencimento mensal:</strong> dia ${c(dueDay)}</p>
              </div>
            </section>

            <section class="clause">
              <h2>3. Valor de implantação e forma de pagamento</h2>
              <p>Pela implantação, configuração e personalização inicial do catálogo digital/loja digital, o CONTRATANTE pagará à CONTRATADA o valor total de <strong>${money(installationValue)}</strong>.</p>
              <div class="payment-grid">
                <div class="payment-card"><span>Valor total</span><strong>${money(installationValue)}</strong></div>
                <div class="payment-card"><span>50% antes do início</span><strong>${money(firstPayment)}</strong></div>
                <div class="payment-card"><span>50% na conclusão</span><strong>${money(finalPayment)}</strong></div>
              </div>
              <p>O início dos serviços fica condicionado ao pagamento da primeira parcela. A entrega final, liberação completa ou encerramento da implantação poderá ficar condicionada ao pagamento da segunda parcela.</p>
            </section>

            <section class="clause">
              <h2>4. Responsabilidades do contratante</h2>
              <p>O CONTRATANTE deverá fornecer informações corretas, imagens, banners, descrições, preços, links, dados de produtos, dados de impressoras e demais informações necessárias para a montagem e configuração do catálogo digital.</p>
            </section>

            <section class="clause">
              <h2>5. Atraso, suspensão e cancelamento</h2>
              <p>Em caso de atraso no pagamento de valores de implantação ou mensalidade, a CONTRATADA poderá suspender temporariamente a manutenção, atualização, suporte ou entrega final do catálogo digital até a regularização.</p>
              <p>O cancelamento poderá ser solicitado por qualquer uma das partes mediante aviso prévio, respeitando valores pendentes até a data do encerramento.</p>
            </section>

            <section class="clause">
              <h2>6. Dados, imagens e conteúdos</h2>
              <p>O CONTRATANTE declara ser responsável pelos dados, imagens, marcas, textos, preços, produtos e informações enviados para uso no catálogo digital.</p>
            </section>

            <section class="clause">
              <h2>7. Proteção de dados</h2>
              <p>As partes deverão observar a legislação aplicável de proteção de dados pessoais, especialmente a LGPD, quando houver tratamento de dados pessoais.</p>
            </section>

            <section class="clause">
              <h2>8. Observações específicas</h2>
              <div class="box">
                <p>${c(client.observacoes)}</p>
              </div>
            </section>

            <p><strong>Local e data:</strong> ${c(client.cidade)}, ${contractDate}</p>

            <div class="signatures">
              <div class="signature">
                ${c(client.nome)}<br>
                <span class="small">CONTRATANTE</span>
              </div>
              <div class="signature">
                ${c(companySignature)}<br>
                <span class="small">CONTRATADA</span>
              </div>
            </div>
          </main>
        </body>
        </html>`;
    }
