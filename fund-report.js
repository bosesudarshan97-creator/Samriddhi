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

  const loanRows = [['Member', 'Loan date', 'Principal issued', 'Principal repaid', 'Interest paid', 'Principal due', 'Interest due', 'Total due']];
  state.loans.slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a)).forEach((loan) => {
    const totals = loanTotals(loan);
    const principalPaid = loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
    const interestPaid = loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
    loanRows.push([memberName(loan.memberId), formatDate(loan.date), Number(loan.principal), principalPaid, interestPaid, totals.principalDue, totals.interestDue, totals.totalDue]);
  });
  const loanSheet = XLSX.utils.aoa_to_sheet(loanRows);
  fitSheetColumns(loanSheet, [28, 16, 20, 20, 18, 18, 18, 18]);
  loanSheet['!autofilter'] = { ref: `A1:H${Math.max(1, loanRows.length)}` };
  loanRows.slice(1).forEach((_, index) => ['C', 'D', 'E', 'F', 'G', 'H'].forEach((column) => { const cell = `${column}${index + 2}`; if (loanSheet[cell]) loanSheet[cell].z = '₹#,##0.00'; }));
  XLSX.utils.book_append_sheet(workbook, loanSheet, 'Loans');

  const paymentRows = [['Payment date / time', 'Member', 'Loan date', 'Payment type', 'Amount']];
  state.loans.forEach((loan) => loan.payments.slice().sort((a, b) => recordTimestamp(a) - recordTimestamp(b)).forEach((payment) => paymentRows.push([
    formatDateTime(payment.createdAt || `${payment.date}T00:00:00`), memberName(loan.memberId), formatDate(loan.date), payment.type === 'principal' ? 'Principal repayment' : 'Interest payment', Number(payment.amount),
  ])));
  const paymentSheet = XLSX.utils.aoa_to_sheet(paymentRows);
  fitSheetColumns(paymentSheet, [24, 28, 16, 24, 18]);
  paymentSheet['!autofilter'] = { ref: `A1:E${Math.max(1, paymentRows.length)}` };
  paymentRows.slice(1).forEach((_, index) => { const cell = `E${index + 2}`; if (paymentSheet[cell]) paymentSheet[cell].z = '₹#,##0.00'; });
  XLSX.utils.book_append_sheet(workbook, paymentSheet, 'Payments');
  XLSX.writeFile(workbook, `samriddhi-fund-report-${today()}.xlsx`);
}

$('#fund-report-whatsapp').addEventListener('click', () => {
  window.open(`https://wa.me/?text=${encodeURIComponent(buildWhatsAppSummary())}`, '_blank', 'noopener');
});
$('#fund-report-download').addEventListener('click', downloadFundReportCsv);
