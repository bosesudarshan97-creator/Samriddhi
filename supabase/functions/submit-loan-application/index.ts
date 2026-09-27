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
  const { data: profile, error: profileError } = await adminClient.from('profiles').select('id').eq('id', user.id).maybeSingle();
  if (profileError || !profile) return json({ error: 'This account is not approved for Samriddhi.' }, 403);
  const { data: member, error: memberError } = await adminClient.from('members').select('id, active').eq('user_id', user.id).maybeSingle();
  if (memberError || !member || member.active === false) return json({ error: 'Your active member profile was not found. Please sign in again or contact an administrator.' }, 403);

  const body = await request.json();
  const requestedAmount = Number(body.amount);
  const purpose = String(body.purpose || '').trim().slice(0, 500);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return json({ error: 'Enter a valid loan amount.' }, 400);

  const { data: pending, error: pendingError } = await adminClient.from('loan_applications').select('id').eq('member_id', member.id).eq('status', 'pending').limit(1);
  if (pendingError) return json({ error: pendingError.message }, 400);
  if (pending?.length) return json({ error: 'You already have a pending loan application.' }, 409);

  const { data: contributions, error: contributionError } = await adminClient.from('contributions').select('amount').eq('member_id', member.id);
  if (contributionError) return json({ error: contributionError.message }, 400);
  const contributionTotal = (contributions || []).reduce((sum, item) => sum + Number(item.amount), 0);
  const { data: loans, error: loansError } = await adminClient.from('loans').select('id, principal').eq('member_id', member.id);
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
  if (requestedAmount > availableLimit + 0.005) return json({ error: `Requested amount exceeds your current eligible balance of ₹${availableLimit.toFixed(2)}.` }, 400);

  const { data: application, error: insertError } = await adminClient.from('loan_applications').insert({ member_id: member.id, requested_amount: requestedAmount, eligible_limit: availableLimit, purpose }).select('id, submitted_at').single();
  if (insertError?.code === '23505') return json({ error: 'You already have a pending loan application.' }, 409);
  if (insertError) return json({ error: insertError.message }, 400);
  return json({ success: true, applicationId: application.id, submittedAt: application.submitted_at, availableLimit });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
