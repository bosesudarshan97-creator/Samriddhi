import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication required' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Authentication required' }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: profile, error: profileError } = await adminClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profileError || profile?.role !== 'admin') return json({ error: 'Administrator access required' }, 403);

  const body = await request.json();
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (!name || !phone || !email) return json({ error: 'Name, phone, and email are required' }, 400);

  const { data: existingMember, error: memberLookupError } = await adminClient
    .from('members')
    .select('id, user_id')
    .ilike('email', email)
    .maybeSingle();
  if (memberLookupError) return json({ error: memberLookupError.message }, 400);
  if (existingMember?.user_id) {
    return json({ error: 'This email already belongs to a linked member account. Remove or update that account before inviting it again.' }, 409);
  }

  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { full_name: name, phone },
  });
  if (inviteError) return json({ error: inviteError.message }, 400);

  const { error: profileInsertError } = await adminClient.from('profiles').insert({ id: invited.user.id, role: 'member' });
  if (profileInsertError) {
    await adminClient.auth.admin.deleteUser(invited.user.id);
    return json({ error: profileInsertError.message }, 400);
  }

  return json({ success: true, memberCreated: false, message: 'Invitation sent. The member record will be created after the invitee accepts and signs in.' });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
