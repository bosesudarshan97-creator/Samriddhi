import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);
  const accessToken = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return json({ error: 'Authentication required' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser(accessToken);
  if (userError || !user) return json({ error: 'Your sign-in session is missing or expired. Sign out, sign in again, and resubmit KYC.' }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: profile, error: profileError } = await adminClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profileError || !profile) return json({ error: 'This account is not approved for Samriddhi.' }, 403);

  const body = await request.json().catch(() => ({}));
  const action = String(body.action || 'status');
  if (action === 'list') {
    if (profile.role !== 'admin') return json({ error: 'Administrator access required.' }, 403);
    const { data: records, error } = await adminClient.from('member_kyc').select('*').order('submitted_at', { ascending: false });
    if (error) return json({ error: error.message }, 400);
    const memberIds = [...new Set((records || []).map((record) => record.member_id))];
    const { data: members, error: membersError } = memberIds.length
      ? await adminClient.from('members').select('id, phone').in('id', memberIds)
      : { data: [], error: null };
    if (membersError) return json({ error: membersError.message }, 400);
    const memberMap = new Map((members || []).map((member) => [member.id, member]));
    return json({ records: (records || []).map((record) => ({ ...record, member: memberMap.get(record.member_id) || null })) });
  }

  const { data: member, error: memberError } = await adminClient.from('members').select('id, active').eq('user_id', user.id).eq('active', true).maybeSingle();
  if (memberError || !member) return json({ error: 'Your active member profile was not found. Please contact an administrator.' }, 403);
  if (action === 'status') {
    const { data, error } = await adminClient.from('member_kyc').select('id, submitted_at').eq('member_id', member.id).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ complete: Boolean(data), submittedAt: data?.submitted_at || null });
  }
  if (action !== 'submit') return json({ error: 'Unsupported action.' }, 400);

  const fullName = String(body.fullName || '').trim().slice(0, 120);
  const accountNumber = String(body.accountNumber || '').replace(/\s+/g, '').slice(0, 34);
  const ifscCode = String(body.ifscCode || '').trim().toUpperCase();
  const bankName = String(body.bankName || '').trim().slice(0, 120);
  const branch = String(body.branch || '').trim().slice(0, 120);
  if (!fullName || !accountNumber || !ifscCode || !bankName || !branch) return json({ error: 'Complete all KYC fields before submitting.' }, 400);
  if (!/^[0-9]{6,34}$/.test(accountNumber)) return json({ error: 'Account number must contain 6 to 34 digits.' }, 400);
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) return json({ error: 'Enter a valid 11-character IFSC code.' }, 400);

  const { error: saveError } = await adminClient.from('member_kyc').upsert({ member_id: member.id, user_id: user.id, full_name, account_number: accountNumber, ifsc_code: ifscCode, bank_name: bankName, branch }, { onConflict: 'member_id' });
  if (saveError) return json({ error: saveError.message }, 400);
  const { error: updateMemberError } = await adminClient.from('members').update({ name: fullName }).eq('id', member.id);
  if (updateMemberError) return json({ error: updateMemberError.message }, 400);
  return json({ success: true });
  } catch (error) {
    console.error('member-kyc error:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected KYC service error.' }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
