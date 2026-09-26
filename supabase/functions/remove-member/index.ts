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

  const { memberId } = await request.json();
  if (!memberId) return json({ error: 'Member id is required' }, 400);
  const { data: member, error: memberError } = await adminClient.from('members').select('user_id').eq('id', memberId).maybeSingle();
  if (memberError) return json({ error: memberError.message }, 400);
  if (!member) return json({ error: 'Member not found' }, 404);
  if (member.user_id === user.id) return json({ error: 'The administrator account cannot be removed here' }, 400);

  const { error: memberUpdateError } = await adminClient.from('members').update({ active: false }).eq('id', memberId);
  if (memberUpdateError) return json({ error: memberUpdateError.message }, 400);
  if (member.user_id) {
    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(member.user_id);
    if (deleteUserError) return json({ error: deleteUserError.message }, 400);
  }

  return json({ success: true });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}