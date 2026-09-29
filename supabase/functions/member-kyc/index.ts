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
    const memberIds = [...new Set((records || []).map((record) => record.member_id).filter(Boolean))];
    const { data: members, error: membersError } = memberIds.length
      ? await adminClient.from('members').select('id, phone').in('id', memberIds)
      : { data: [], error: null };
    if (membersError) return json({ error: membersError.message }, 400);
    const memberMap = new Map((members || []).map((member) => [member.id, member]));
    return json({ records: (records || []).map((record) => ({ ...record, member: memberMap.get(record.member_id) || null })) });
  }

  if (action === 'status') {
    const { data, error } = await adminClient.from('member_kyc').select('id, submitted_at').eq('user_id', user.id).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    let { data: member, error: memberError } = await adminClient.from('members').select('id, user_id, email, active').eq('user_id', user.id).maybeSingle();
    if (memberError) return json({ error: memberError.message }, 400);
    if (!member && user.email) {
      const { data: emailMember, error: emailError } = await adminClient.from('members').select('id, user_id, email, active').ilike('email', user.email.toLowerCase()).maybeSingle();
      if (emailError) return json({ error: emailError.message }, 400);
      if (emailMember && !emailMember.user_id) {
        const { data: linkedMember, error: linkError } = await adminClient.from('members').update({ user_id: user.id }).eq('id', emailMember.id).is('user_id', null).select('id, user_id, email, active').maybeSingle();
        if (linkError) return json({ error: linkError.message }, 400);
        member = linkedMember;
      } else if (emailMember?.user_id === user.id) {
        member = emailMember;
      }
    }
    if (member) {
      const shouldBeActive = Boolean(data);
      if (member.active !== shouldBeActive) {
        const { error: activeError } = await adminClient.from('members').update({ active: shouldBeActive }).eq('id', member.id);
        if (activeError) return json({ error: activeError.message }, 400);
      }
    }
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

  const { data: existingKyc, error: kycLookupError } = await adminClient.from('member_kyc').select('id').eq('user_id', user.id).maybeSingle();
  if (kycLookupError) return json({ error: kycLookupError.message }, 400);
  const { data: existingMember, error: memberLookupError } = await adminClient.from('members').select('id').eq('user_id', user.id).maybeSingle();
  if (memberLookupError) return json({ error: memberLookupError.message }, 400);

  const kycRecord = { member_id: existingMember?.id || null, user_id: user.id, full_name: fullName, account_number: accountNumber, ifsc_code: ifscCode, bank_name: bankName, branch };
  const saveResult = existingKyc
    ? await adminClient.from('member_kyc').update({ ...kycRecord, updated_at: new Date().toISOString() }).eq('id', existingKyc.id)
    : await adminClient.from('member_kyc').insert(kycRecord);
  const saveError = saveResult.error;
  if (saveError) return json({ error: saveError.message }, 400);

  let memberId = existingMember?.id;
  if (memberId) {
    const { error } = await adminClient.from('members').update({ name: fullName, active: true }).eq('id', memberId);
    if (error) return json({ error: error.message }, 400);
  } else {
    const phone = String(user.user_metadata?.phone || user.phone || 'Not provided').trim();
    const { data: newMember, error } = await adminClient.from('members').insert({ user_id: user.id, email: user.email?.toLowerCase() || null, name: fullName, phone, active: true }).select('id').single();
    if (error) return json({ error: error.message }, 400);
    memberId = newMember.id;
  }
  const { error: linkError } = await adminClient.from('member_kyc').update({ member_id: memberId }).eq('user_id', user.id);
  if (linkError) return json({ error: linkError.message }, 400);
  return json({ success: true });
  } catch (error) {
    console.error('member-kyc error:', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected KYC service error.' }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
