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

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadFundReportCsv() {
  const rows = [['Record type', 'Date/time', 'Member', 'Details', 'Amount', 'Principal', 'Interest', 'Principal due', 'Interest due', 'Note']];
  (state.contributions || []).forEach((item) => rows.push([
    'Contribution', formatDateTime(item.createdAt || `${item.date}T00:00:00`), item.memberId ? memberName(item.memberId) : 'Group fund', 'Contribution received', Number(item.amount).toFixed(2), '', '', '', '', item.note || '',
  ]));
  state.loans.forEach((loan) => {
    const totals = loanTotals(loan);
    const principalPaid = loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
    const interestPaid = loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0);
    rows.push(['Loan', formatDateTime(loan.createdAt || `${loan.date}T00:00:00`), memberName(loan.memberId), 'Loan issued', Number(loan.principal).toFixed(2), principalPaid.toFixed(2), interestPaid.toFixed(2), totals.principalDue.toFixed(2), totals.interestDue.toFixed(2), '']);
    loan.payments.forEach((payment) => rows.push([
      'Payment', formatDateTime(payment.createdAt || `${payment.date}T00:00:00`), memberName(loan.memberId), payment.type === 'principal' ? 'Principal repayment' : 'Interest payment', Number(payment.amount).toFixed(2), payment.type === 'principal' ? Number(payment.amount).toFixed(2) : '', payment.type === 'principal' ? '' : Number(payment.amount).toFixed(2), '', '', `Loan date ${loan.date}`,
    ]));
  });
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `samriddhi-fund-report-${today()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#fund-report-whatsapp').addEventListener('click', () => {
  window.open(`https://wa.me/?text=${encodeURIComponent(buildWhatsAppSummary())}`, '_blank', 'noopener');
});
$('#fund-report-download').addEventListener('click', downloadFundReportCsv);
