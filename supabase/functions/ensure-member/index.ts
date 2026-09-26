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
  if (profileError || !profile) return json({ error: 'This account is not approved for Samriddhi.' }, 403);

  const email = user.email?.trim().toLowerCase() || '';
  const name = String(user.user_metadata?.full_name || email.split('@')[0] || 'Fund member').trim();
  const phone = String(user.user_metadata?.phone || user.phone || 'Not provided').trim();
  const { data: linked, error: linkedError } = await adminClient.from('members').select('id').eq('user_id', user.id).maybeSingle();
  if (linkedError) return json({ error: linkedError.message }, 400);
  if (linked) return json({ success: true, memberId: linked.id, created: false });

  if (email) {
    const { data: existing, error: emailError } = await adminClient.from('members').select('id, user_id').ilike('email', email).maybeSingle();
    if (emailError) return json({ error: emailError.message }, 400);
    if (existing?.user_id && existing.user_id !== user.id) return json({ error: 'This email is linked to a different member account.' }, 409);
    if (existing) {
      const { error } = await adminClient.from('members').update({ user_id: user.id, active: true }).eq('id', existing.id);
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, memberId: existing.id, created: false });
    }
  }

  const { data: member, error: insertError } = await adminClient.from('members').insert({ user_id: user.id, email, name, phone, active: true }).select('id').single();
  if (insertError?.code === '23505') {
    const { data: racedMember, error: raceLookupError } = await adminClient.from('members').select('id').eq('user_id', user.id).maybeSingle();
    if (!raceLookupError && racedMember) return json({ success: true, memberId: racedMember.id, created: false });
  }
  if (insertError) return json({ error: insertError.message }, 400);
  return json({ success: true, memberId: member.id, created: true });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}