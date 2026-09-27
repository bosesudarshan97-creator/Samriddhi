import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Authentication required' }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: profile, error: profileError } = await adminClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profileError || profile?.role !== 'admin') return json({ error: 'Administrator access required' }, 403);

  const body = await request.json();
  const applicationId = String(body.applicationId || '');
  const decision = String(body.decision || '');
  if (!applicationId || !['approve', 'reject'].includes(decision)) return json({ error: 'Choose an application and a valid decision.' }, 400);

  const { data: application, error: applicationError } = await adminClient.from('loan_applications').select('*').eq('id', applicationId).maybeSingle();
  if (applicationError) return json({ error: applicationError.message }, 400);
  if (!application) return json({ error: 'Loan application not found.' }, 404);
  if (application.status !== 'pending') return json({ error: 'This application has already been decided.' }, 409);

  if (decision === 'reject') {
    const { error } = await adminClient.from('loan_applications').update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: user.id }).eq('id', applicationId).eq('status', 'pending');
    if (error) return json({ error: error.message }, 400);
    return json({ success: true, status: 'rejected' });
  }

  const { data: contributions, error: contributionError } = await adminClient.from('contributions').select('amount').eq('member_id', application.member_id);
  if (contributionError) return json({ error: contributionError.message }, 400);
  const contributionTotal = (contributions || []).reduce((sum, item) => sum + Number(item.amount), 0);
  const { data: loans, error: loansError } = await adminClient.from('loans').select('id, principal').eq('member_id', application.member_id);
  if (loansError) return json({ error: loansError.message }, 400);
  const loanIds = (loans || []).map((loan) => loan.id);
  let principalRepaid = 0;
  if (loanIds.length) {
    const { data: payments, error: paymentError } = await adminClient.from('payments').select('amount').in('loan_id', loanIds).eq('payment_type', 'principal');
    if (paymentError) return json({ error: paymentError.message }, 400);
    principalRepaid = (payments || []).reduce((sum, payment) => sum + Number(payment.amount), 0);
  }
  const totalPrincipalIssued = (loans || []).reduce((sum, loan) => sum + Number(loan.principal), 0);
  const availableLimit = Math.max(0, contributionTotal * 2 - totalPrincipalIssued + principalRepaid);
  if (Number(application.requested_amount) > availableLimit + 0.005) return json({ error: `Cannot approve: current eligible balance is ₹${availableLimit.toFixed(2)}, less than the requested amount.` }, 409);

  const { data: loan, error: loanError } = await adminClient.from('loans').insert({ member_id: application.member_id, principal: application.requested_amount, eligible_limit: availableLimit, loan_date: new Date().toISOString().slice(0, 10) }).select('id').single();
  if (loanError) return json({ error: loanError.message }, 400);
  const { data: decided, error: decisionError } = await adminClient.from('loan_applications').update({ status: 'approved', decided_at: new Date().toISOString(), decided_by: user.id, loan_id: loan.id }).eq('id', applicationId).eq('status', 'pending').select('id').maybeSingle();
  if (decisionError || !decided) {
    await adminClient.from('loans').delete().eq('id', loan.id);
    return json({ error: decisionError?.message || 'This application was already decided.' }, decisionError ? 400 : 409);
  }
  return json({ success: true, status: 'approved', loanId: loan.id });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
