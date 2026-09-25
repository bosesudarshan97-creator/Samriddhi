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

  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { full_name: name },
  });
  if (inviteError) return json({ error: inviteError.message }, 400);

  const { error: profileInsertError } = await adminClient.from('profiles').insert({ id: invited.user.id, role: 'member' });
  if (profileInsertError) {
    await adminClient.auth.admin.deleteUser(invited.user.id);
    return json({ error: profileInsertError.message }, 400);
  }

  const { error: memberInsertError } = await adminClient.from('members').insert({ name, phone, active: true });
  if (memberInsertError) {
    await adminClient.from('profiles').delete().eq('id', invited.user.id);
    await adminClient.auth.admin.deleteUser(invited.user.id);
    return json({ error: memberInsertError.message }, 400);
  }

  return json({ success: true });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
