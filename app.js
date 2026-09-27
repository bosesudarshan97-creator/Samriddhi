const STORAGE_KEY = 'circle-fund-ledger';
const THEME_KEY = 'circle-fund-theme';
const MONTHLY_RATE = 0.02;
const SUPABASE_CONFIG = window.SUPABASE_CONFIG || { url: '', anonKey: '' };
const supabaseClient = SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey ? window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey) : null;
const state = supabaseClient ? emptyState() : loadLocalState();
let currentUser = null;
let currentRole = 'admin';
let realtimeChannel = null;
let authMode = 'sign-in';
const AUTH_ACTION_KEY = 'samriddhi-auth-action';
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const $ = (selector) => document.querySelector(selector);

function emptyState() { return { members: [], loans: [], contributions: [], loanApplications: [] }; }
function loadLocalState() { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (!saved || !Array.isArray(saved.members) || !Array.isArray(saved.loans)) return emptyState(); saved.contributions = Array.isArray(saved.contributions) ? saved.contributions.map((item) => ({ ...item, amount: Math.round(Number(item.amount) || 0) })) : []; return saved; } catch { return emptyState(); } }
function saveLocalState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function showDataError(error) { console.error(error); showToast(error?.message || 'Could not save the shared ledger'); }
async function loadRemoteState() {
	const [{ data: members, error: membersError }, { data: loans, error: loansError }, { data: payments, error: paymentsError }, { data: contributions, error: contributionsError }] = await Promise.all([
		supabaseClient.from('members').select('*').order('created_at'),
		supabaseClient.from('loans').select('*').order('loan_date'),
		supabaseClient.from('payments').select('*').order('payment_date'),
		supabaseClient.from('contributions').select('*').order('contribution_date')
	]);
	const error = membersError || loansError || paymentsError || contributionsError;
	if (error) throw error;
	state.members = members.map((member) => ({ id: member.id, name: member.name, phone: member.phone, email: member.email, active: member.active, userId: member.user_id }));
	state.loans = loans.map((loan) => ({ id: loan.id, memberId: loan.member_id, principal: Number(loan.principal), eligibleLimit: Number(loan.eligible_limit) || null, date: loan.loan_date, createdAt: loan.created_at, payments: payments.filter((payment) => payment.loan_id === loan.id).map((payment) => ({ id: payment.id, amount: Number(payment.amount), type: String(payment.payment_type || 'auto').toLowerCase(), date: payment.payment_date, createdAt: payment.created_at })) }));
	state.contributions = contributions.map((item) => ({ id: item.id, memberId: item.member_id, amount: Number(item.amount), date: item.contribution_date, createdAt: item.created_at, note: item.note || '' }));
	const { data: applications, error: applicationsError } = await supabaseClient.from('loan_applications').select('*').order('submitted_at', { ascending: true });
	state.loanApplicationsLoadError = applicationsError?.message || '';
	state.loanApplications = applicationsError ? [] : (applications || []).map((item) => ({ id: item.id, memberId: item.member_id, amount: Number(item.requested_amount), eligibleLimit: Number(item.eligible_limit), purpose: item.purpose || '', status: item.status, submittedAt: item.submitted_at, decidedAt: item.decided_at, loanId: item.loan_id }));
}
function subscribeToLedger() {
	if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
	realtimeChannel = supabaseClient.channel('shared-ledger').on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, refreshRemoteState).on('postgres_changes', { event: '*', schema: 'public', table: 'loans' }, refreshRemoteState).on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, refreshRemoteState).on('postgres_changes', { event: '*', schema: 'public', table: 'contributions' }, refreshRemoteState).on('postgres_changes', { event: '*', schema: 'public', table: 'loan_applications' }, refreshRemoteState).subscribe();
}
async function refreshRemoteState() { try { await loadRemoteState(); render(); } catch (error) { showDataError(error); } }
async function migrateLocalState() {
	const local = loadLocalState();
	if (!local.members.length && !local.loans.length && !local.contributions.length) return;
	const { count, error: countError } = await supabaseClient.from('members').select('id', { count: 'exact', head: true });
	if (countError || count > 0) return;
	const memberIdMap = new Map();
	for (const member of local.members) {
		const { data, error } = await supabaseClient.from('members').insert({ name: member.name, phone: member.phone, active: member.active !== false }).select('id').single();
		if (error) throw error;
		memberIdMap.set(member.id, data.id);
	}
	const loanIdMap = new Map();
	for (const loan of local.loans) {
		const { data, error } = await supabaseClient.from('loans').insert({ member_id: memberIdMap.get(loan.memberId), principal: loan.principal, loan_date: loan.date }).select('id').single();
		if (error) throw error;
		loanIdMap.set(loan.id, data.id);
		for (const payment of loan.payments || []) {
			const { error: paymentError } = await supabaseClient.from('payments').insert({ loan_id: data.id, amount: payment.amount, payment_type: payment.type || 'auto', payment_date: payment.date });
			if (paymentError) throw paymentError;
		}
	}
	for (const contribution of local.contributions || []) {
		const { error } = await supabaseClient.from('contributions').insert({ member_id: contribution.memberId ? memberIdMap.get(contribution.memberId) : null, amount: contribution.amount, contribution_date: contribution.date, note: contribution.note || null });
		if (error) throw error;
	}
	localStorage.removeItem(STORAGE_KEY);
}
async function saveRecord(table, record) { const { error } = await supabaseClient.from(table).insert(record); if (error) throw error; await refreshRemoteState(); renderAnalytics(); }
async function inviteMember(record) { const { data, error } = await supabaseClient.functions.invoke('invite-member', { body: record }); if (error) { let message = error.message; try { const details = await error.context?.json(); message = details?.error || message; } catch { /* The gateway may return a non-JSON error. */ } throw new Error(message); } if (data?.error) throw new Error(data.error); await refreshRemoteState(); }
async function removeMember(memberId) { const { data, error } = await supabaseClient.functions.invoke('remove-member', { body: { memberId } }); if (error) { let message = error.message; try { const details = await error.context?.json(); message = details?.error || message; } catch { /* The gateway may return a non-JSON error. */ } throw new Error(message); } if (data?.error) throw new Error(data.error); await refreshRemoteState(); }
async function resetLedger() { const { data, error } = await supabaseClient.functions.invoke('reset-ledger', { body: {} }); if (error) { let message = error.message; try { const details = await error.context?.json(); message = details?.error || message; } catch { /* The gateway may return a non-JSON error. */ } throw new Error(message); } if (data?.error) throw new Error(data.error); await refreshRemoteState(); return data; }
async function loadLedgerArchives() { const errorElement = $('#archive-error'); errorElement.hidden = true; const { data, error } = await supabaseClient.from('ledger_archives').select('id, archived_at, archived_by, reason, snapshot').order('archived_at', { ascending: false }); if (error) { errorElement.textContent = `Could not load archives: ${error.message}. Run the latest schema.sql in Supabase if the archive table is missing.`; errorElement.hidden = false; return; } const list = $('#archive-list'); list.replaceChildren(); $('#archive-empty').hidden = data.length > 0; data.forEach((archive) => { const row = document.createElement('article'); row.className = 'archive-row'; const counts = Object.entries(archive.snapshot || {}).map(([table, rows]) => `${table.replace('_', ' ')}: ${rows.length}`).join(' · '); row.innerHTML = `<div class="archive-details"><strong>${escapeHtml(formatDateTime(archive.archived_at))}</strong><small>${escapeHtml(archive.reason)} · ${escapeHtml(counts)}</small></div><button class="secondary-button" type="button" data-download-archive="${archive.id}">Download JSON</button>`; list.append(row); }); }
async function submitLoanApplication(amount, purpose) { const { data, error } = await supabaseClient.functions.invoke('submit-loan-application', { body: { amount, purpose } }); if (error) { let message = error.message; try { const details = await error.context?.json(); message = details?.error || message; } catch { /* The gateway may return a non-JSON error. */ } throw new Error(message); } if (data?.error) throw new Error(data.error); await refreshRemoteState(); }
async function decideLoanApplication(applicationId, decision) { const { data, error } = await supabaseClient.functions.invoke('decide-loan-application', { body: { applicationId, decision } }); if (error) { let message = error.message; try { const details = await error.context?.json(); message = details?.error || message; } catch { /* The gateway may return a non-JSON error. */ } throw new Error(message); } if (data?.error) throw new Error(data.error); await refreshRemoteState(); }
async function ensureCurrentUserMember() { const { data, error } = await supabaseClient.functions.invoke('ensure-member', { body: {} }); if (error) { let message = error.message; try { const details = await error.context?.json(); message = details?.error || message; } catch { /* The gateway may return a non-JSON error. */ } throw new Error(message); } if (data?.error) throw new Error(data.error); }
function applyAuthState() { const authenticated = Boolean(currentUser); const passwordSetup = authMode === 'password'; document.body.classList.toggle('auth-enabled', Boolean(supabaseClient)); $('#auth-screen').hidden = !supabaseClient || (authenticated && !passwordSetup); document.querySelector('.app-shell').hidden = Boolean(supabaseClient) && (!authenticated || passwordSetup); $('#auth-form').hidden = authMode !== 'sign-in'; $('#password-form').hidden = authMode !== 'password'; $('#reset-form').hidden = authMode !== 'reset'; $('#forgot-password').hidden = authMode !== 'sign-in'; $('#back-to-sign-in').hidden = authMode === 'sign-in'; $('#user-badge').hidden = !authenticated; $('#sign-out').hidden = !authenticated; if (authenticated) { $('#user-badge').textContent = `${currentUser.email} · ${currentRole}`; document.querySelectorAll('[data-admin-only]').forEach((element) => { element.hidden = currentRole !== 'admin'; }); } }
function isPasswordLink() { const queryType = new URLSearchParams(window.location.search).get('type'); const hashType = new URLSearchParams(window.location.hash.slice(1)).get('type'); return queryType === 'invite' || queryType === 'recovery' || hashType === 'invite' || hashType === 'recovery' || sessionStorage.getItem(AUTH_ACTION_KEY) === 'password'; }
async function establishLinkSession() { const query = new URLSearchParams(window.location.search); const hash = new URLSearchParams(window.location.hash.slice(1)); const code = query.get('code'); const tokenHash = query.get('token_hash') || hash.get('token_hash'); const type = query.get('type') || hash.get('type'); if (code) { const { error } = await supabaseClient.auth.exchangeCodeForSession(code); if (error) throw error; } else if (tokenHash && (type === 'invite' || type === 'recovery')) { const { error } = await supabaseClient.auth.verifyOtp({ token_hash: tokenHash, type }); if (error) throw error; } return (await supabaseClient.auth.getSession()).data.session; }
async function loadAuthState() { if (!supabaseClient) { applyAuthState(); return; } const passwordLink = isPasswordLink(); if (passwordLink) { sessionStorage.setItem(AUTH_ACTION_KEY, 'password'); authMode = 'password'; applyAuthState(); } supabaseClient.auth.onAuthStateChange((_event, nextSession) => { if (_event === 'PASSWORD_RECOVERY' || (isPasswordLink() && nextSession)) { currentUser = nextSession?.user || null; authMode = 'password'; applyAuthState(); } else setSession(nextSession); }); try { const session = passwordLink ? await establishLinkSession() : (await supabaseClient.auth.getSession()).data.session; if (passwordLink && session) { currentUser = session.user; authMode = 'password'; applyAuthState(); } else if (!passwordLink) await setSession(session); } catch (error) { $('#password-error').textContent = error.message || 'This invitation link is invalid or expired. Ask the administrator to send a new invitation.'; $('#password-error').hidden = false; applyAuthState(); } }
async function setSession(session) { currentUser = session?.user || null; currentRole = 'member'; if (currentUser) { const { data, error } = await supabaseClient.from('profiles').select('role').eq('id', currentUser.id).maybeSingle(); if (error || !data) { currentUser = null; $('#auth-error').textContent = 'This account has not been approved for Samriddhi.'; $('#auth-error').hidden = false; await supabaseClient.auth.signOut(); applyAuthState(); return; } currentRole = data.role === 'admin' ? 'admin' : 'member'; try { await ensureCurrentUserMember(); } catch (memberError) { showDataError(memberError); } try { await migrateLocalState(); } catch (migrationError) { showDataError(migrationError); } try { await loadRemoteState(); } catch (loadError) { showDataError(loadError); } subscribeToLedger(); render(); } applyAuthState(); }
function id() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`)); }
function formatDateTime(value) { const date = value ? new Date(value) : new Date(); return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
function recordTimestamp(item) { return item.createdAt ? new Date(item.createdAt).getTime() : new Date(`${item.date}T00:00:00`).getTime(); }
function formatMoney(value) { return money.format(Math.max(0, Number(value) || 0)); }
function toPaise(value) { return Math.round((Number(value) || 0) * 100); }
function fromPaise(value) { return value / 100; }
function monthsElapsed(startDate, endDate = today()) { const start = new Date(`${startDate}T00:00:00`); const end = new Date(`${endDate}T00:00:00`); return Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth()); }
function loanTotals(loan) {
	let principalDue = toPaise(loan.principal);
	let interestDue = 0;
	let interestCharged = 0;
	const loanDate = new Date(`${loan.date}T00:00:00`);
	const currentDate = new Date(`${today()}T00:00:00`);
	const daysElapsed = Math.max(0, Math.floor((currentDate - loanDate) / (1000 * 60 * 60 * 24)));
	const interestPeriods = loanDate <= currentDate ? 1 + Math.floor(daysElapsed / 30) : 0;
	const payments = loan.payments
		.map((payment) => ({ ...payment, dateValue: new Date(`${payment.date}T00:00:00`) }))
		.sort((a, b) => a.dateValue - b.dateValue);
	const events = [];

	for (let period = 0; period < interestPeriods; period += 1) {
		const interestDate = new Date(loanDate);
		interestDate.setDate(interestDate.getDate() + period * 30);
		events.push({ type: 'interest', date: interestDate });
	}

	payments.forEach((payment) => events.push({ type: 'payment', date: payment.dateValue, amount: toPaise(payment.amount), paymentType: payment.type || 'auto' }));
	events.sort((a, b) => a.date - b.date || (a.type === 'interest' ? -1 : 1));

	events.forEach((event) => {
		if (event.type === 'interest') {
			// Every interest event uses the principal balance remaining at that time.
			const interestAmount = Math.round(principalDue * MONTHLY_RATE);
			interestDue += interestAmount;
			interestCharged += interestAmount;
			return;
		}

		if (event.paymentType === 'principal') {
			principalDue = Math.max(0, principalDue - event.amount);
		} else if (event.paymentType === 'auto') {
			const interestPayment = Math.min(event.amount, interestDue);
			interestDue -= interestPayment;
			principalDue = Math.max(0, principalDue - (event.amount - interestPayment));
		} else {
			interestDue = Math.max(0, interestDue - event.amount);
		}
	});

	return { interestDue: fromPaise(Math.max(0, interestDue)), principalDue: fromPaise(principalDue), totalDue: fromPaise(Math.max(0, interestDue + principalDue)), interestCharged: fromPaise(interestCharged) };
}
function isLoanClosed(loan) { return loanTotals(loan).totalDue <= 0.005; }
function memberName(memberId) { return state.members.find((member) => member.id === memberId)?.name || 'Unknown member'; }
function memberLoanLimit(memberId) { const contributionTotal = (state.contributions || []).filter((item) => item.memberId === memberId).reduce((total, item) => total + toPaise(item.amount), 0); const loans = state.loans.filter((loan) => loan.memberId === memberId); const issued = loans.reduce((total, loan) => total + toPaise(loan.principal), 0); const principalRepayments = loans.reduce((total, loan) => total + loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + toPaise(payment.amount), 0), 0); return fromPaise(Math.max(0, contributionTotal * 2 - issued + principalRepayments)); }
function memberContributionCeiling(memberId) { return (state.contributions || []).filter((item) => item.memberId === memberId).reduce((total, item) => total + Number(item.amount), 0) * 2; }
function currentMember() { return state.members.find((member) => member.userId === currentUser?.id); }
function updateApplicationEligibility() { const member = currentMember(); const available = member ? memberLoanLimit(member.id) : 0; const ceiling = member ? memberContributionCeiling(member.id) : 0; const amount = Number($('#application-amount').value) || 0; const afterApplication = Math.max(0, available - amount); const remainingPercent = ceiling > 0 ? Math.max(0, (afterApplication / ceiling) * 100) : 0; const hasPending = member && state.loanApplications.some((application) => application.memberId === member.id && application.status === 'pending'); $('#application-eligibility').textContent = member ? `Available to apply: ${formatMoney(available)} (${ceiling > 0 ? `${((available / ceiling) * 100).toFixed(1)}%` : '0.0%'} of your 2× contribution limit)` : 'Your member account is not linked yet. Please contact an administrator.'; $('#application-remaining').textContent = hasPending ? 'You already have a pending application in the queue.' : amount > 0 ? `After this request, ${formatMoney(afterApplication)} (${remainingPercent.toFixed(1)}% of your 2× contribution limit) would remain.` : 'Enter an amount to see your remaining eligible percentage.'; const invalid = !member || hasPending || amount <= 0 || amount > available; $('#application-amount').setAttribute('aria-invalid', String(amount > available)); $('#application-submit').disabled = Boolean(invalid); return !invalid; }
function memberTotalBorrowed(memberId) { return state.loans.filter((loan) => loan.memberId === memberId).reduce((total, loan) => total + Number(loan.principal), 0); }
function memberLoanUsagePercent(memberId) { const limit = memberContributionCeiling(memberId); return limit > 0 ? (memberTotalBorrowed(memberId) / limit) * 100 : 0; }
function groupLoanUsagePercent(memberId) { const groupContributions = (state.contributions || []).reduce((total, item) => total + Number(item.amount), 0); return groupContributions > 0 ? (memberTotalBorrowed(memberId) / groupContributions) * 100 : 0; }
function memberLoanUsageClass(memberId) { const usagePercent = memberLoanUsagePercent(memberId); if (usagePercent <= 20) return 'loan-usage--green'; if (usagePercent <= 40) return 'loan-usage--yellow'; if (usagePercent <= 50) return 'loan-usage--orange'; return 'loan-usage--red'; }
function updateLoanEligibility() { const memberId = $('#loan-member').value; const limit = memberId ? memberLoanLimit(memberId) : 0; $('#loan-eligibility').textContent = memberId ? `Maximum eligible now: ${formatMoney(limit)}` : 'Select a member to see their maximum loan amount.'; const amount = Number($('#loan-amount').value); const error = $('#loan-limit-error'); const overLimit = $('#loan-amount').value !== '' && amount > limit; error.textContent = overLimit ? `Loan exceeds this member’s limit of ${formatMoney(limit)}.` : ''; error.hidden = !overLimit; $('#loan-amount').setAttribute('aria-invalid', String(overLimit)); return !overLimit; }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible'); window.setTimeout(() => toast.classList.remove('is-visible'), 2400); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }

function renderSummary() { const contributions = (state.contributions || []).reduce((total, item) => total + Number(item.amount), 0); const issued = state.loans.reduce((total, loan) => total + Number(loan.principal), 0); const principalReceived = state.loans.reduce((total, loan) => total + loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0), 0); const interestReceived = state.loans.reduce((total, loan) => total + loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0), 0); const interestRate = contributions > 0 ? (interestReceived / contributions) * 100 : 0; const repayments = principalReceived + interestReceived; const outstandingPrincipal = state.loans.reduce((total, loan) => total + loanTotals(loan).principalDue, 0); const activeLoans = state.loans.filter((loan) => loanTotals(loan).totalDue > 0).length; $('#available-fund').textContent = formatMoney(contributions + repayments - issued); $('#contribution-total').textContent = formatMoney(contributions); $('#principal-received').textContent = formatMoney(principalReceived); $('#interest-received').textContent = formatMoney(interestReceived); $('#interest-rate').textContent = `${interestRate.toFixed(2)}% of contributions`; $('#member-count').textContent = state.members.filter((member) => member.active !== false).length; $('#loaned-fund').textContent = formatMoney(outstandingPrincipal); $('#loan-count').textContent = `${activeLoans} active loan${activeLoans === 1 ? '' : 's'}`; }
function renderMembers() { const list = $('#member-list'); list.replaceChildren(); const activeMembers = state.members.filter((member) => member.active !== false); $('#member-empty').hidden = activeMembers.length > 0; activeMembers.forEach((member) => { const loans = state.loans.filter((loan) => loan.memberId === member.id); const row = document.createElement('article'); row.className = 'member-row'; row.innerHTML = `<div class="member-details"><div class="member-identity"><strong>${escapeHtml(member.name)}</strong><button class="member-edit-button" type="button" data-admin-only data-edit-member="${member.id}" ${currentRole === 'admin' ? '' : 'hidden'} title="Edit member details" aria-label="Edit ${escapeHtml(member.name)} details">✎</button></div><small>${escapeHtml(member.phone)}</small></div><div class="member-row-actions"><span>${loans.length} loan${loans.length === 1 ? '' : 's'}</span><button class="text-button" type="button" data-whatsapp="${member.id}">WhatsApp</button><button class="text-button danger" type="button" data-admin-only data-delete-member="${member.id}" ${currentRole === 'admin' ? '' : 'hidden'}>Remove</button></div>`; list.append(row); }); }
function renderLoans() {
	const list = $('#loan-list');
	const historyList = $('#loan-history-list');
	list.replaceChildren();
	historyList.replaceChildren();
	const activeLoans = state.loans.filter((loan) => !isLoanClosed(loan));
	const closedLoans = state.loans.filter((loan) => isLoanClosed(loan));
	$('#loan-empty').hidden = activeLoans.length > 0;
	$('#loan-history-section').hidden = closedLoans.length === 0;
	const groups = new Map();

	activeLoans.forEach((loan) => {
		if (!groups.has(loan.memberId)) groups.set(loan.memberId, []);
		groups.get(loan.memberId).push(loan);
	});

	function renderLoanGroups(target, sourceLoans) {
		const groupedLoans = new Map();
		sourceLoans.forEach((loan) => {
			if (!groupedLoans.has(loan.memberId)) groupedLoans.set(loan.memberId, []);
			groupedLoans.get(loan.memberId).push(loan);
		});

		groupedLoans.forEach((loans, memberId) => {
		const group = document.createElement('section');
		group.className = 'loan-member-group';
		const memberDue = loans.reduce((total, loan) => total + loanTotals(loan).totalDue, 0);
		const isHistory = target === historyList;
		const memberUsageClass = memberLoanUsageClass(memberId);
		const usagePercent = memberLoanUsagePercent(memberId);
		const groupPercent = groupLoanUsagePercent(memberId);
		group.innerHTML = `<div class="loan-member-heading"><div><h3 class="loan-usage-name ${memberUsageClass}">${escapeHtml(memberName(memberId))}</h3><small>${usagePercent.toFixed(1)}% of personal eligible limit · ${groupPercent.toFixed(1)}% of group contributions · ${loans.length} ${isHistory ? 'closed' : 'active'} loan${loans.length === 1 ? '' : 's'}</small></div><strong>${formatMoney(memberDue)} total due</strong></div>`;

		loans.slice().reverse().forEach((loan) => {
			const totals = loanTotals(loan);
			const row = document.createElement('article');
			if (isHistory) {
				const closeDate = loan.payments.slice().sort((a, b) => b.date.localeCompare(a.date))[0]?.date || loan.date;
				row.className = 'loan-row closed-history-row';
				row.innerHTML = `<div class="loan-main"><strong>Loan taken ${formatDate(loan.date)}</strong><small>Closed ${formatDate(closeDate)}</small></div><div class="loan-figures"><span><small>Loan amount</small><strong>${formatMoney(loan.principal)}</strong></span><span><small>Total interest paid</small><strong class="due-value">${formatMoney(totals.interestCharged)}</strong></span></div><div class="row-actions"><span class="closed-label">Paid in full</span><button class="text-button" type="button" data-whatsapp-loan="${loan.id}">WhatsApp</button></div>`;
				group.append(row);
				return;
			}
			row.className = `loan-row${isLoanClosed(loan) ? ' is-closed' : ''}`;
			row.innerHTML = `<div class="loan-main"><strong>Loan issued ${formatDate(loan.date)}${isLoanClosed(loan) ? ' · Closed' : ''}</strong><button class="payment-history-toggle" type="button" data-payment-history="${loan.id}" aria-expanded="false">${loan.payments.length} payment${loan.payments.length === 1 ? '' : 's'} <span aria-hidden="true">⌄</span></button><div class="payment-history" data-payment-history-panel="${loan.id}" hidden>${loan.payments.slice().sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date)).map((payment) => `<div class="payment-history-row"><span><strong>${formatMoney(payment.amount)}</strong><small>${payment.type === 'principal' ? 'Principal' : payment.type === 'interest' ? 'Interest' : 'Payment'}</small></span><small>${formatDateTime(payment.createdAt || payment.date)}</small></div>`).join('')}</div></div><div class="loan-figures"><span><small>Principal due</small><strong>${formatMoney(totals.principalDue)}</strong></span><span><small>Interest due</small><strong>${formatMoney(totals.interestDue)}</strong></span><span><small>Total due</small><strong class="due-value">${formatMoney(totals.totalDue)}</strong></span></div><div class="row-actions">${isLoanClosed(loan) ? '<span class="closed-label">Paid in full</span>' : `<button class="secondary-button" data-admin-only type="button" data-payment="${loan.id}">Record payment</button>`}<button class="text-button" type="button" data-whatsapp-loan="${loan.id}">WhatsApp</button></div>`;
			group.append(row);
		});
		target.append(group);
		});
	}

	renderLoanGroups(list, activeLoans);
	renderLoanGroups(historyList, closedLoans);
}
function renderLoanApplications() {
	const list = $('#application-list');
	list.replaceChildren();
	const setupNotice = $('#application-setup-notice');
	setupNotice.hidden = !state.loanApplicationsLoadError;
	if (state.loanApplicationsLoadError) setupNotice.textContent = 'Loan applications are not set up in the database yet. An administrator must run the latest schema.sql in Supabase SQL Editor.';
	const applications = (state.loanApplications || []).slice().sort((a, b) => {
		if (a.status === 'pending' && b.status !== 'pending') return -1;
		if (a.status !== 'pending' && b.status === 'pending') return 1;
		return a.status === 'pending' ? new Date(a.submittedAt) - new Date(b.submittedAt) : new Date(b.submittedAt) - new Date(a.submittedAt);
	});
	$('#application-empty').hidden = applications.length > 0;
	applications.forEach((application, index) => {
		const member = state.members.find((item) => item.id === application.memberId);
		const ceiling = member ? memberContributionCeiling(member.id) : 0;
		const remainingPercent = ceiling > 0 ? (Number(application.eligibleLimit) / ceiling) * 100 : 0;
		const row = document.createElement('article');
		row.className = `application-row${application.status === 'pending' ? ' is-pending' : ''}`;
		const queuePosition = application.status === 'pending' ? `Queue #${index + 1}` : application.status;
		row.innerHTML = `<div class="application-main"><div class="application-title"><strong>${escapeHtml(memberName(application.memberId))}</strong><span class="application-status application-status--${application.status}">${escapeHtml(queuePosition)}</span></div><small>Requested ${formatMoney(application.amount)} · Eligible when submitted ${formatMoney(application.eligibleLimit)} (${remainingPercent.toFixed(1)}% of 2× contributions remained)</small>${application.purpose ? `<p>${escapeHtml(application.purpose)}</p>` : ''}<small>Applied ${escapeHtml(formatDateTime(application.submittedAt))}</small></div><div class="application-actions">${currentRole === 'admin' && application.status === 'pending' ? `<button class="primary-button" type="button" data-approve-application="${application.id}">Approve & issue loan</button><button class="danger-button" type="button" data-reject-application="${application.id}">Reject</button>` : application.status === 'approved' ? '<span class="closed-label">Loan issued</span>' : ''}</div>`;
		list.append(row);
	});
}
function renderAnalytics() {
	const yearSelect = $('#analytics-year');
	const currentYear = new Date().getFullYear();
	const years = new Set([currentYear]);
	state.loans.forEach((loan) => years.add(Number(String(loan.date).slice(0, 4))));
	state.loans.flatMap((loan) => loan.payments).forEach((payment) => years.add(Number(String(payment.date).slice(0, 4))));
	const selectedYear = Number(yearSelect.value) || Math.max(...years);
	const sortedYears = [...years].filter(Number.isFinite).sort((a, b) => b - a);
	if (yearSelect.options.length !== sortedYears.length || sortedYears.some((year, index) => Number(yearSelect.options[index]?.value) !== year)) {
		yearSelect.replaceChildren(...sortedYears.map((year) => new Option(String(year), String(year))));
	}
	if (!sortedYears.includes(selectedYear)) yearSelect.value = String(sortedYears[0]);
	else yearSelect.value = String(selectedYear);
	const year = Number(yearSelect.value);
	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const monthly = monthNames.map((month) => ({ month, principal: 0, interest: 0, loanCount: 0 }));
	state.loans.forEach((loan) => {
		const loanDate = new Date(`${loan.date}T00:00:00`);
		if (loanDate.getFullYear() === year) {
			const month = monthly[loanDate.getMonth()];
			month.principal += Number(loan.principal);
			month.loanCount += 1;
		}
		loan.payments.forEach((payment) => {
			if (payment.type !== 'interest' && payment.type !== 'auto') return;
			const paymentDate = new Date(`${payment.date}T00:00:00`);
			if (paymentDate.getFullYear() === year) monthly[paymentDate.getMonth()].interest += Number(payment.amount);
		});
	});
	const container = $('#analytics-monthly-chart');
	container.replaceChildren();
	const hasActivity = monthly.some((month) => month.principal > 0 || month.interest > 0 || month.loanCount > 0);
	$('#analytics-empty').hidden = hasActivity;

	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 920 490');
	svg.setAttribute('role', 'presentation');
	svg.setAttribute('focusable', 'false');
	const left = 104;
	const right = 804;
	const top = 68;
	const bottom = 398;
	const plotWidth = right - left;
	const plotHeight = bottom - top;
	const monthGap = plotWidth / 11;
	const groupContributionTotal = (state.contributions || []).reduce((total, item) => total + Number(item.amount), 0);
	const moneyMax = groupContributionTotal > 0 ? groupContributionTotal : Math.max(1, ...monthly.map((month) => Math.max(month.principal, month.interest)));
	const countMax = Math.max(1, ...monthly.map((month) => month.loanCount));
	const monthX = (index) => left + index * monthGap;
	const moneyY = (value) => bottom - (Math.min(value, moneyMax) / moneyMax) * plotHeight;
	const countY = (value) => bottom - (value / countMax) * plotHeight;
	const compactMoney = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });
	const addSvg = (tag, attrs, text) => {
		const element = document.createElementNS(ns, tag);
		Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
		if (text !== undefined) element.textContent = text;
		svg.append(element);
		return element;
	};
	for (let tick = 0; tick <= 4; tick += 1) {
		const y = bottom - (plotHeight * tick) / 4;
		const amount = (moneyMax * tick) / 4;
		addSvg('line', { x1: left, y1: y, x2: right, y2: y, class: 'analytics-grid-line' });
		addSvg('text', { x: left - 10, y: y + 4, class: 'analytics-axis-label', 'text-anchor': 'end' }, formatMoney(amount));
		addSvg('text', { x: right + 10, y: y + 4, class: 'analytics-axis-label analytics-count-axis-label', 'text-anchor': 'start' }, String(Math.round((countMax * tick) / 4)));
	}
	addSvg('text', { x: 18, y: (top + bottom) / 2, class: 'analytics-axis-title', transform: `rotate(-90 18 ${(top + bottom) / 2})`, 'text-anchor': 'middle' }, 'Amount (INR)');
	addSvg('text', { x: 900, y: (top + bottom) / 2, class: 'analytics-axis-title', transform: `rotate(90 900 ${(top + bottom) / 2})`, 'text-anchor': 'middle' }, 'Loan count');
	monthly.forEach((month, index) => {
		const x = monthX(index);
		addSvg('line', { x1: x, y1: top, x2: x, y2: bottom, class: 'analytics-month-grid' });
		addSvg('text', { x, y: bottom + 25, class: 'analytics-month-label', 'text-anchor': 'middle' }, month.month);
	});
	const drawSeries = (key, scale, className) => {
		const points = monthly.map((month, index) => `${monthX(index)},${scale(month[key])}`).join(' ');
		addSvg('polyline', { points, class: `analytics-line ${className}` });
		monthly.forEach((month, index) => {
			const value = month[key];
			const x = monthX(index);
			const y = scale(value);
			const circle = addSvg('circle', { cx: x, cy: y, r: 4.5, class: `analytics-point ${className}` });
			const title = document.createElementNS(ns, 'title');
			title.textContent = `${month.month}: ${key === 'loanCount' ? `${value} loans` : formatMoney(value)}`;
			circle.append(title);
			if (value > 0) {
				const isCount = key === 'loanCount';
				const labelX = x + (isCount ? -7 : 7);
				const labelY = Math.max(top - 6, Math.min(bottom + 13, y + (key === 'interest' ? 15 : -8)));
				addSvg('text', { x: labelX, y: labelY, class: `analytics-data-label ${className}`, 'text-anchor': isCount ? 'end' : 'start' }, isCount ? String(value) : compactMoney.format(value));
			}
		});
	};
	drawSeries('loanCount', countY, 'analytics-series-count');
	drawSeries('principal', moneyY, 'analytics-series-principal');
	drawSeries('interest', moneyY, 'analytics-series-interest');
	container.append(svg);
}
function renderActivity() { const items = [...(state.contributions || []).map((item) => ({ date: item.date, createdAt: item.createdAt, label: `${item.memberId ? memberName(item.memberId) : 'Group fund'} contributed ${formatMoney(item.amount)}` })), ...state.loans.map((loan) => ({ date: loan.date, createdAt: loan.createdAt, label: `${memberName(loan.memberId)} took a loan of ${formatMoney(loan.principal)}` })), ...state.loans.flatMap((loan) => loan.payments.map((payment) => ({ date: payment.date, createdAt: payment.createdAt, label: `${memberName(loan.memberId)} paid ${formatMoney(payment.amount)}` })))].sort((a, b) => recordTimestamp(b) - recordTimestamp(a)).slice(0, 8); const list = $('#activity-list'); list.replaceChildren(); $('#activity-empty').hidden = items.length > 0; items.forEach((item) => { const row = document.createElement('div'); row.className = 'activity-row'; row.innerHTML = `<span class="activity-dot"></span><div><strong>${escapeHtml(item.label)}</strong><small>${formatDateTime(item.createdAt || `${item.date}T00:00:00`)}</small></div>`; list.append(row); }); }
function renderContributions() { const list = $('#contribution-list'); list.replaceChildren(); const contributions = (state.contributions || []).slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a)); $('#contribution-empty').hidden = contributions.length > 0; contributions.forEach((item) => { const row = document.createElement('div'); row.className = 'contribution-row'; row.innerHTML = `<div><strong>${escapeHtml(item.memberId ? memberName(item.memberId) : 'Group fund')}</strong><small>${formatDateTime(item.createdAt || `${item.date}T00:00:00`)}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></div><strong class="contribution-amount">${formatMoney(item.amount)}</strong>`; list.append(row); }); }
function updateMemberOptions() { const selects = [$('#loan-member'), $('#contribution-member')]; selects.forEach((select) => { const selectedValue = select.value; select.replaceChildren(); state.members.filter((member) => member.active !== false).forEach((member) => { const option = document.createElement('option'); option.value = member.id; option.textContent = member.name; select.append(option); }); if (state.members.some((member) => member.id === selectedValue && member.active !== false)) select.value = selectedValue; }); updateLoanEligibility(); }
function render() { renderSummary(); renderMembers(); renderLoans(); renderLoanApplications(); renderAnalytics(); renderActivity(); renderContributions(); updateMemberOptions(); }
function updatePaymentLimit() {
	const loan = state.loans.find((item) => item.id === $('#payment-loan-id').value);
	const amountInput = $('#payment-amount');
	if (!loan) return;
	const totals = loanTotals(loan);
	const type = $('#payment-type').value;
	const limit = type === 'principal' ? totals.principalDue : totals.interestDue;
	amountInput.max = String(limit);
	amountInput.value = '';
	$('#payment-limit').textContent = `Maximum allowed: ${formatMoney(limit)}`;
	$('#payment-error').hidden = true;
	amountInput.removeAttribute('aria-invalid');
	}
function validatePaymentAmount() {
	const loan = state.loans.find((item) => item.id === $('#payment-loan-id').value);
	if (!loan) return false;
	const amount = Number($('#payment-amount').value);
	const totals = loanTotals(loan);
	const limit = $('#payment-type').value === 'principal' ? totals.principalDue : totals.interestDue;
	const error = $('#payment-error');
	if (amount > limit) {
		error.textContent = `Amount is too high. Enter ${formatMoney(limit)} or less.`;
		error.hidden = false;
		$('#payment-amount').setAttribute('aria-invalid', 'true');
		return false;
	}
	error.hidden = true;
	$('#payment-amount').removeAttribute('aria-invalid');
	return amount > 0;
}
function openModal(id) { const modal = $(`#${id}`); if (id === 'loan-modal') { $('#loan-date').value = today(); $('#loan-amount').value = ''; updateLoanEligibility(); } if (id === 'payment-modal') { $('#payment-date').value = today(); $('#payment-type').value = 'interest'; updatePaymentLimit(); } if (id === 'contribution-modal') $('#contribution-date').value = today(); if (id === 'application-modal') { $('#application-form').reset(); $('#application-error').hidden = true; updateApplicationEligibility(); } modal.showModal(); }
function whatsappUrl(phone, message) { return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`; }
function memberMessage(memberId) { const member = state.members.find((item) => item.id === memberId); const due = state.loans.filter((loan) => loan.memberId === memberId).reduce((total, loan) => total + loanTotals(loan).totalDue, 0); return `Hello ${member.name}, your current Samriddhi Community Fund balance due is ${formatMoney(due)}.`; }
function loanMessage(loan) { const totals = loanTotals(loan); return `Samriddhi Community Fund update for ${memberName(loan.memberId)}: total amount due is ${formatMoney(totals.totalDue)} (${formatMoney(totals.principalDue)} principal + ${formatMoney(totals.interestDue)} interest).`; }
document.addEventListener('click', async (event) => {
	const target = event.target;
	const open = target.closest('[data-open-modal]');
	const close = target.closest('[data-close-modal]');
	const tab = target.closest('[data-tab]');
	const payment = target.closest('[data-payment]');
	const historyToggle = target.closest('[data-payment-history]');
	const shareReport = target.closest('#share-fund-report');
	const refreshArchives = target.closest('#refresh-archives');
	const downloadArchive = target.closest('[data-download-archive]');
	const memberWhatsApp = target.closest('[data-whatsapp]');
	const loanWhatsApp = target.closest('[data-whatsapp-loan]');
	const edit = target.closest('[data-edit-member]');
	const remove = target.closest('[data-delete-member]');
	if (open) openModal(open.dataset.openModal);
	if (close) $(`#${close.dataset.closeModal}`).close();
	if (tab) {
		document.querySelectorAll('.tab, .tab-panel').forEach((element) => element.classList.remove('is-active'));
		tab.classList.add('is-active');
		$(`[data-panel="${tab.dataset.tab}"]`).classList.add('is-active');
		if (tab.dataset.tab === 'archives') loadLedgerArchives();
	}
	if (refreshArchives) loadLedgerArchives();
	if (downloadArchive) {
		try {
			const { data, error } = await supabaseClient.from('ledger_archives').select('*').eq('id', downloadArchive.dataset.downloadArchive).single();
			if (error) throw error;
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = `samriddhi-ledger-archive-${data.archived_at.slice(0, 10)}.json`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) { showDataError(error); }
	}
	if (payment) {
		$('#payment-loan-id').value = payment.dataset.payment;
		openModal('payment-modal');
	}
	if (historyToggle) {
		const panel = $(`[data-payment-history-panel="${historyToggle.dataset.paymentHistory}"]`);
		const expanded = historyToggle.getAttribute('aria-expanded') === 'true';
		historyToggle.setAttribute('aria-expanded', String(!expanded));
		panel.hidden = expanded;
	}
	if (shareReport) {
		renderFundReportPreview();
		$('#fund-report-modal').showModal();
	}
	if (edit) {
		const member = state.members.find((item) => item.id === edit.dataset.editMember);
		if (member) {
			$('#edit-member-id').value = member.id;
			$('#edit-member-name').value = member.name;
			$('#edit-member-phone').value = member.phone === 'Not provided' ? '' : member.phone;
			openModal('edit-member-modal');
		}
	}
	if (memberWhatsApp) {
		const member = state.members.find((item) => item.id === memberWhatsApp.dataset.whatsapp);
		if (member) window.open(whatsappUrl(member.phone, memberMessage(member.id)), '_blank', 'noopener');
	}
	if (loanWhatsApp) {
		const loan = state.loans.find((item) => item.id === loanWhatsApp.dataset.whatsappLoan);
		const member = state.members.find((item) => item.id === loan?.memberId);
		if (loan && member) window.open(whatsappUrl(member.phone, loanMessage(loan)), '_blank', 'noopener');
	}
	if (remove && window.confirm('Remove this member? Existing loan records will remain.')) {
		try {
			if (supabaseClient) await removeMember(remove.dataset.deleteMember);
			else {
				state.members = state.members.filter((member) => member.id !== remove.dataset.deleteMember);
				saveLocalState();
				render();
			}
		} catch (error) {
			showDataError(error);
		}
	}
});
function buildFundReport() { const contributions = state.contributions || []; const totalContributions = contributions.reduce((total, item) => total + Number(item.amount), 0); const loansIssued = state.loans.reduce((total, loan) => total + Number(loan.principal), 0); const principalReceived = state.loans.reduce((total, loan) => total + loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0), 0); const interestReceived = state.loans.reduce((total, loan) => total + loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0), 0); const outstandingPrincipal = state.loans.reduce((total, loan) => total + loanTotals(loan).principalDue, 0); const currentDue = state.loans.reduce((total, loan) => total + loanTotals(loan).totalDue, 0); const availableFund = totalContributions + principalReceived + interestReceived - loansIssued; const lines = [`SAMRIDDHI COMMUNITY FUND`, `Report: ${formatDateTime(new Date().toISOString())}`, '', `FUND SUMMARY`, `Total contributions: ${formatMoney(totalContributions)}`, `Loans issued: ${formatMoney(loansIssued)}`, `Principal repaid: ${formatMoney(principalReceived)}`, `Interest received: ${formatMoney(interestReceived)}`, `Outstanding principal: ${formatMoney(outstandingPrincipal)}`, `Total amount due (incl. interest): ${formatMoney(currentDue)}`, `Available fund: ${formatMoney(availableFund)}`, '', `CONTRIBUTIONS`]; const orderedContributions = contributions.slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a)); if (orderedContributions.length) orderedContributions.forEach((item) => lines.push(`${item.memberId ? memberName(item.memberId) : 'Group fund'}: ${formatMoney(item.amount)} · ${formatDateTime(item.createdAt || `${item.date}T00:00:00`)}${item.note ? ` · ${item.note}` : ''}`)); else lines.push('No contributions recorded.'); lines.push('', 'LOAN RECORDS'); const orderedLoans = state.loans.slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a)); if (orderedLoans.length) orderedLoans.forEach((loan) => { const totals = loanTotals(loan); const loanPrincipalPaid = loan.payments.filter((payment) => payment.type === 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0); const loanInterestPaid = loan.payments.filter((payment) => payment.type !== 'principal').reduce((sum, payment) => sum + Number(payment.amount), 0); lines.push(`${memberName(loan.memberId)} · Loan ${formatMoney(loan.principal)} · ${formatDate(loan.date)}`); lines.push(`Principal repaid ${formatMoney(loanPrincipalPaid)} · Interest paid ${formatMoney(loanInterestPaid)} · Principal due ${formatMoney(totals.principalDue)} · Interest due ${formatMoney(totals.interestDue)}`); loan.payments.slice().sort((a, b) => recordTimestamp(b) - recordTimestamp(a)).forEach((payment) => lines.push(`  ${payment.type === 'principal' ? 'Principal' : 'Interest'} payment ${formatMoney(payment.amount)} · ${formatDateTime(payment.createdAt || `${payment.date}T00:00:00`)}`)); }); else lines.push('No loans recorded.'); return lines.join('\n'); }

document.addEventListener('click', async (event) => { const approve = event.target.closest('[data-approve-application]'); const reject = event.target.closest('[data-reject-application]'); if (approve) { const application = state.loanApplications.find((item) => item.id === approve.dataset.approveApplication); if (!application || !window.confirm(`Approve ${memberName(application.memberId)}’s ${formatMoney(application.amount)} application and issue the loan?`)) return; approve.disabled = true; try { await decideLoanApplication(application.id, 'approve'); showToast('Application approved and loan issued'); } catch (error) { showDataError(error); approve.disabled = false; } } if (reject) { const application = state.loanApplications.find((item) => item.id === reject.dataset.rejectApplication); if (!application || !window.confirm(`Reject ${memberName(application.memberId)}’s loan application?`)) return; reject.disabled = true; try { await decideLoanApplication(application.id, 'reject'); showToast('Application rejected'); } catch (error) { showDataError(error); reject.disabled = false; } } });
$('#application-amount').addEventListener('input', updateApplicationEligibility);
$('#application-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!updateApplicationEligibility()) return; const submitButton = $('#application-submit'); const errorElement = $('#application-error'); submitButton.disabled = true; errorElement.hidden = true; try { await submitLoanApplication(Number($('#application-amount').value), $('#application-purpose').value.trim()); event.target.closest('dialog').close(); event.target.reset(); showToast('Application submitted in the queue'); } catch (error) { errorElement.textContent = error.message || 'Could not submit loan application'; errorElement.hidden = false; updateApplicationEligibility(); } finally { submitButton.disabled = false; } });
$('#auth-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!supabaseClient) return; const { error } = await supabaseClient.auth.signInWithPassword({ email: $('#auth-email').value, password: $('#auth-password').value }); $('#auth-error').textContent = error?.message || ''; $('#auth-error').hidden = !error; });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!supabaseClient) return; const errorElement = $('#password-error'); errorElement.hidden = true; if (!currentUser) { errorElement.textContent = 'Your invitation session has expired. Ask the administrator to send a new invitation.'; errorElement.hidden = false; return; } if ($('#new-password').value !== $('#confirm-password').value) { errorElement.textContent = 'Passwords do not match.'; errorElement.hidden = false; return; } const { error } = await supabaseClient.auth.updateUser({ password: $('#new-password').value }); if (error) { errorElement.textContent = error.message; errorElement.hidden = false; return; } sessionStorage.removeItem(AUTH_ACTION_KEY); await supabaseClient.auth.signOut(); window.location.replace(window.location.pathname); });
$('#forgot-password').addEventListener('click', () => { authMode = 'reset'; $('#reset-email').value = $('#auth-email').value; $('#auth-error').hidden = true; applyAuthState(); });
$('#back-to-sign-in').addEventListener('click', () => { authMode = 'sign-in'; $('#reset-error').hidden = true; $('#password-error').hidden = true; applyAuthState(); });
$('#reset-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!supabaseClient) return; const errorElement = $('#reset-error'); errorElement.hidden = true; const redirectTo = `${window.location.origin}${window.location.pathname}`; const { error } = await supabaseClient.auth.resetPasswordForEmail($('#reset-email').value, { redirectTo }); errorElement.textContent = error?.message || 'Reset email sent. Check your inbox.'; errorElement.hidden = false; if (!error) event.target.reset(); });
$('#sign-out').addEventListener('click', () => supabaseClient?.auth.signOut());
$('#reset-ledger').addEventListener('click', async () => { if (!window.confirm('Save a complete archive, then clear contributions, loans, payments, and loan applications? Members and login accounts will remain.')) return; try { const result = await resetLedger(); showToast(`Ledger reset. Archive ${result.archiveId?.slice(0, 8) || 'saved'} is available in Archives.`); } catch (error) { showDataError(error); } });
$('#invite-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!supabaseClient) return; const errorElement = $('#invite-error'); errorElement.hidden = true; try { await inviteMember({ name: $('#invite-name').value.trim(), phone: $('#invite-phone').value.trim(), email: $('#invite-email').value.trim() }); event.target.closest('dialog').close(); event.target.reset(); showToast('Invitation sent'); } catch (error) { errorElement.textContent = error.message || 'Could not send invitation'; errorElement.hidden = false; } });
$('#edit-member-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const id = $('#edit-member-id').value; const record = { name: $('#edit-member-name').value.trim(), phone: $('#edit-member-phone').value.trim() }; if (supabaseClient) { const { error } = await supabaseClient.from('members').update(record).eq('id', id); if (error) throw error; await refreshRemoteState(); } else { const member = state.members.find((item) => item.id === id); if (member) Object.assign(member, record); saveLocalState(); render(); } event.target.closest('dialog').close(); event.target.reset(); showToast('Member details updated'); } catch (error) { showDataError(error); } });
$('#contribution-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const record = { member_id: $('#contribution-member').value, amount: Math.round(Number($('#contribution-amount').value)), contribution_date: $('#contribution-date').value, note: $('#contribution-note').value.trim() || null }; if (supabaseClient) await saveRecord('contributions', record); else { state.contributions = state.contributions || []; state.contributions.push({ id: id(), memberId: record.member_id, amount: record.amount, date: record.contribution_date, createdAt: new Date().toISOString(), note: record.note || '' }); saveLocalState(); render(); } event.target.closest('dialog').close(); event.target.reset(); showToast('Contribution recorded'); } catch (error) { showDataError(error); } });
$('#loan-member').addEventListener('change', updateLoanEligibility);
$('#loan-amount').addEventListener('input', updateLoanEligibility);
$('#loan-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!updateLoanEligibility()) return; try { const memberId = $('#loan-member').value; const record = { member_id: memberId, principal: Number($('#loan-amount').value), eligible_limit: memberLoanLimit(memberId), loan_date: $('#loan-date').value }; if (supabaseClient) await saveRecord('loans', record); else { state.loans.push({ id: id(), memberId: record.member_id, principal: record.principal, eligibleLimit: record.eligible_limit, date: record.loan_date, createdAt: new Date().toISOString(), payments: [] }); saveLocalState(); render(); } event.target.closest('dialog').close(); event.target.reset(); showToast('Loan recorded'); } catch (error) { showDataError(error); } });
$('#payment-type').addEventListener('change', updatePaymentLimit);
$('#payment-amount').addEventListener('input', validatePaymentAmount);
$('#payment-form').addEventListener('submit', async (event) => { event.preventDefault(); const loan = state.loans.find((item) => item.id === $('#payment-loan-id').value); if (!loan || !validatePaymentAmount()) return; const amount = Number($('#payment-amount').value); const type = $('#payment-type').value; try { if (supabaseClient) await saveRecord('payments', { loan_id: loan.id, amount, payment_type: type, payment_date: $('#payment-date').value }); else { loan.payments.push({ id: id(), amount, type, date: $('#payment-date').value, createdAt: new Date().toISOString() }); saveLocalState(); render(); } event.target.closest('dialog').close(); event.target.reset(); showToast('Payment recorded'); } catch (error) { showDataError(error); } });
$('#analytics-year').addEventListener('change', renderAnalytics);
function applyTheme(theme) { document.documentElement.dataset.theme = theme; const dark = theme === 'dark'; $('#theme-toggle').textContent = dark ? 'Light mode' : 'Dark mode'; $('#theme-toggle').setAttribute('aria-pressed', String(dark)); }
$('#theme-toggle').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem(THEME_KEY, next); applyTheme(next); });
applyTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light');
render();
loadAuthState();
