function fundReportMetrics() {
  const contributions = state.contributions || [];
  const contributionTotal = contributions.reduce((sum, item) => sum + Number(item.amount), 0);
  const loansIssued = state.loans.reduce((sum, loan) => sum + Number(loan.principal), 0);
  const principalRepaid = state.loans.reduce((sum, loan) => sum + loan.payments.filter((payment) => payment.type === 'principal').reduce((amount, payment) => amount + Number(payment.amount), 0), 0);
  const interestReceived = state.loans.reduce((sum, loan) => sum + loan.payments.filter((payment) => payment.type !== 'principal').reduce((amount, payment) => amount + Number(payment.amount), 0), 0);
  const outstandingPrincipal = state.loans.reduce((sum, loan) => sum + loanTotals(loan).principalDue, 0);
  const totalDue = state.loans.reduce((sum, loan) => sum + loanTotals(loan).totalDue, 0);
  return { contributionTotal, loansIssued, principalRepaid, interestReceived, outstandingPrincipal, totalDue, availableFund: contributionTotal + principalRepaid + interestReceived - loansIssued };
}

function renderFundReportPreview() {
  const metrics = fundReportMetrics();
  $('#fund-report-generated').textContent = `Generated ${formatDateTime(new Date().toISOString())}`;
  const summary = [
    ['Total contributions', metrics.contributionTotal],
    ['Available fund', metrics.availableFund],
    ['Loans issued', metrics.loansIssued],
    ['Principal repaid', metrics.principalRepaid],
    ['Interest received', metrics.interestReceived],
    ['Principal outstanding', metrics.outstandingPrincipal],
    ['Total due incl. interest', metrics.totalDue],
  ];
  $('#fund-report-summary').innerHTML = summary.map(([label, amount]) => `<div class="fund-report-metric"><span>${label}</span><strong>${formatMoney(amount)}</strong></div>`).join('');

  const contributions = (state.contributions || []).slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
  $('#fund-report-contributions').innerHTML = contributions.length
    ? contributions.map((item) => `<tr><td>${escapeHtml(formatDateTime(item.createdAt || `${item.date}T00:00:00`))}</td><td>${escapeHtml(item.memberId ? memberName(item.memberId) : 'Group fund')}</td><td>${escapeHtml(item.note || '')}</td><td>${formatMoney(item.amount)}</td></tr>`).join('')
    : '<tr><td colspan="4">No contributions recorded.</td></tr>';

  const loans = state.loans.slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
  $('#fund-report-loans').innerHTML = loans.length
    ? loans.map((loan) => {
      const totals = loanTotals(loan);
      const principalPaid = loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
      const interestPaid = loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
      return `<tr><td>${escapeHtml(memberName(loan.memberId))}</td><td>${escapeHtml(formatDate(loan.date))}</td><td>${formatMoney(loan.principal)}</td><td>${formatMoney(principalPaid)}</td><td>${formatMoney(interestPaid)}</td><td>${formatMoney(totals.principalDue)}</td><td>${formatMoney(totals.interestDue)}</td></tr>`;
    }).join('')
    : '<tr><td colspan="7">No loans recorded.</td></tr>';
}

function buildWhatsAppSummary() {
  const metrics = fundReportMetrics();
  const members = state.members.filter((member) => member.active !== false).map((member) => {
    const loans = state.loans.filter((loan) => loan.memberId === member.id);
    return {
      name: member.name,
      principal: loans.reduce((sum, loan) => sum + Number(loan.principal), 0),
      due: loans.reduce((sum, loan) => sum + loanTotals(loan).totalDue, 0),
    };
  }).filter((member) => member.principal > 0).sort((a, b) => a.name.localeCompare(b.name));
  const memberLines = members.length
    ? members.map((member) => `- ${member.name}: borrowed ${formatMoney(member.principal)}, due ${formatMoney(member.due)}`)
    : ['- No loans recorded'];
  return [
    '*SAMRIDDHI COMMUNITY FUND*',
    `Report: ${formatDateTime(new Date().toISOString())}`,
    '',
    '*Fund overview*',
    `Contributions: ${formatMoney(metrics.contributionTotal)}`,
    `Available fund: ${formatMoney(metrics.availableFund)}`,
    `Loans issued: ${formatMoney(metrics.loansIssued)}`,
    `Principal repaid: ${formatMoney(metrics.principalRepaid)}`,
    `Interest received: ${formatMoney(metrics.interestReceived)}`,
    `Outstanding principal: ${formatMoney(metrics.outstandingPrincipal)}`,
    `Total due incl. interest: ${formatMoney(metrics.totalDue)}`,
    '',
    '*Member loan summary*',
    ...memberLines,
    '',
    'Download the full contribution, loan, and payment spreadsheet from the app report.',
  ].join('\n');
}

function fitSheetColumns(sheet, widths) {
  sheet['!cols'] = widths.map((width) => ({ wch: width }));
}

function uniqueSheetName(value, usedNames) {
  const baseName = String(value || 'Member').replace(/[\\/?*:[\]]/g, ' ').trim().slice(0, 31) || 'Member';
  let name = baseName;
  let suffix = 2;
  while (usedNames.has(name.toLowerCase())) {
    const suffixText = ` (${suffix})`;
    name = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

function downloadFundReportCsv() {
  if (!window.XLSX) {
    showToast('Excel export could not load. Refresh and try again.');
    return;
  }

  const metrics = fundReportMetrics();
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: 'Samriddhi Community Fund Report', Subject: 'Fund contributions, loans, and repayments' };

  const summarySheet = XLSX.utils.aoa_to_sheet([
    ['SAMRIDDHI COMMUNITY FUND'],
    ['Report generated', formatDateTime(new Date().toISOString())],
    [],
    ['FUND SUMMARY', 'AMOUNT'],
    ['Total contributions', metrics.contributionTotal],
    ['Interest income received', metrics.interestReceived],
    ['Available amount', metrics.availableFund],
    ['Total principal loaned', metrics.loansIssued],
    ['Principal repaid', metrics.principalRepaid],
    ['Outstanding principal', metrics.outstandingPrincipal],
    ['Total outstanding including interest', metrics.totalDue],
  ]);
  fitSheetColumns(summarySheet, [42, 24]);
  ['B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11'].forEach((cell) => { if (summarySheet[cell]) summarySheet[cell].z = '₹#,##0.00'; });
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

  const contributionRows = [['Date / time', 'Member', 'Note', 'Contribution amount']];
  (state.contributions || []).slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a)).forEach((item) => contributionRows.push([
    formatDateTime(item.createdAt || `${item.date}T00:00:00`), item.memberId ? memberName(item.memberId) : 'Group fund', item.note || '', Number(item.amount),
  ]));
  const contributionSheet = XLSX.utils.aoa_to_sheet(contributionRows);
  fitSheetColumns(contributionSheet, [24, 28, 40, 22]);
  contributionSheet['!autofilter'] = { ref: `A1:D${Math.max(1, contributionRows.length)}` };
  contributionRows.slice(1).forEach((_, index) => { const cell = `D${index + 2}`; if (contributionSheet[cell]) contributionSheet[cell].z = '₹#,##0.00'; });
  XLSX.utils.book_append_sheet(workbook, contributionSheet, 'Contributions');

  const borrowerIds = [...new Set(state.loans.map((loan) => loan.memberId))];
  const usedSheetNames = new Set(['summary', 'contributions']);
  borrowerIds.forEach((memberId) => {
    const memberLoans = state.loans.filter((loan) => loan.memberId === memberId).sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
    const memberContributions = (state.contributions || []).filter((item) => item.memberId === memberId).reduce((sum, item) => sum + Number(item.amount), 0);
    const memberBorrowed = memberLoans.reduce((sum, loan) => sum + Number(loan.principal), 0);
    const memberPrincipalPaid = memberLoans.reduce((sum, loan) => sum + loan.payments.filter((payment) => payment.type === 'principal').reduce((total, payment) => total + Number(payment.amount), 0), 0);
    const memberInterestPaid = memberLoans.reduce((sum, loan) => sum + loan.payments.filter((payment) => payment.type !== 'principal').reduce((total, payment) => total + Number(payment.amount), 0), 0);
    const rows = [
      [`MEMBER REPORT: ${memberName(memberId)}`],
      ['Member contributions', memberContributions],
      ['Total principal borrowed', memberBorrowed],
      ['Principal repaid', memberPrincipalPaid],
      ['Interest paid', memberInterestPaid],
      [],
      ['LOAN SUMMARY'],
      ['Loan date', 'Principal issued', 'Principal repaid', 'Interest paid', 'Principal due', 'Interest due', 'Total due'],
    ];
    memberLoans.forEach((loan) => {
      const totals = loanTotals(loan);
      const principalPaid = loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
      const interestPaid = loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
      rows.push([formatDate(loan.date), Number(loan.principal), principalPaid, interestPaid, totals.principalDue, totals.interestDue, totals.totalDue]);
    });
    rows.push([], ['PAYMENT HISTORY'], ['Payment date / time', 'Loan date', 'Payment type', 'Amount']);
    const payments = memberLoans.flatMap((loan) => loan.payments.map((payment) => ({ ...payment, loanDate: loan.date }))).sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
    payments.forEach((payment) => rows.push([
      formatDateTime(payment.createdAt || `${payment.date}T00:00:00`), formatDate(payment.loanDate), payment.type === 'principal' ? 'Principal repayment' : 'Interest payment', Number(payment.amount),
    ]));
    if (!payments.length) rows.push(['No payments recorded.']);

    const memberSheet = XLSX.utils.aoa_to_sheet(rows);
    fitSheetColumns(memberSheet, [25, 20, 23, 18, 18, 18, 18]);
    const summaryAmountCells = ['B2', 'B3', 'B4', 'B5'];
    summaryAmountCells.forEach((cell) => { if (memberSheet[cell]) memberSheet[cell].z = '₹#,##0.00'; });
    const paymentHeaderIndex = rows.findIndex((row) => row[0] === 'Payment date / time');
    const loanHeaderIndex = rows.findIndex((row) => row[0] === 'Loan date' && row[1] === 'Principal issued');
    for (let index = loanHeaderIndex + 1; index < paymentHeaderIndex - 1; index += 1) {
      ['B', 'C', 'D', 'E', 'F', 'G'].forEach((column) => { const cell = `${column}${index + 1}`; if (memberSheet[cell]) memberSheet[cell].z = '₹#,##0.00'; });
    }
    for (let index = paymentHeaderIndex + 1; index < rows.length; index += 1) {
      const cell = `D${index + 1}`;
      if (memberSheet[cell] && typeof memberSheet[cell].v === 'number') memberSheet[cell].z = '₹#,##0.00';
    }
    XLSX.utils.book_append_sheet(workbook, memberSheet, uniqueSheetName(memberName(memberId), usedSheetNames));
  });
  XLSX.writeFile(workbook, `samriddhi-fund-report-${today()}.xlsx`);
}

$('#fund-report-whatsapp').addEventListener('click', () => {
  window.open(`https://wa.me/?text=${encodeURIComponent(buildWhatsAppSummary())}`, '_blank', 'noopener');
});
$('#fund-report-download').addEventListener('click', downloadFundReportCsv);
