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

  const tableNames = ['members', 'contributions', 'loans', 'payments', 'loan_applications'] as const;
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tableNames) {
    const rows: unknown[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await adminClient.from(table).select('*').range(offset, offset + pageSize - 1);
      if (error) return json({ error: `Archive cancelled: could not read ${table}: ${error.message}` }, 400);
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    snapshot[table] = rows;
  }

  const { data: archive, error: archiveError } = await adminClient.from('ledger_archives').insert({
    archived_by: user.id,
    reason: 'Before app data reset',
    snapshot,
  }).select('id, archived_at').single();
  if (archiveError) return json({ error: `Reset cancelled because the archive could not be saved: ${archiveError.message}` }, 400);

  for (const table of ['payments', 'loan_applications', 'contributions', 'loans']) {
    const { error } = await adminClient.from(table).delete().not('id', 'is', null);
    if (error) return json({ error: `Archive ${archive.id} was saved, but clearing ${table} failed: ${error.message}`, archiveId: archive.id }, 400);
  }

  return json({ success: true, archiveId: archive.id, archivedAt: archive.archived_at, archivedRows: Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length])) });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}