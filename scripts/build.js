const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'dist');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Build requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables.');
  process.exit(1);
}

let parsedUrl;
try {
  parsedUrl = new URL(supabaseUrl);
} catch {
  console.error('SUPABASE_URL must be a valid HTTPS URL.');
  process.exit(1);
}

let keyRole = '';
if (supabaseAnonKey.split('.').length === 3) {
  try {
    keyRole = JSON.parse(Buffer.from(supabaseAnonKey.split('.')[1], 'base64url').toString()).role || '';
  } catch {
    keyRole = '';
  }
}

if (parsedUrl.protocol !== 'https:' || supabaseAnonKey.startsWith('sb_secret_') || keyRole === 'service_role') {
  console.error('Use an HTTPS Supabase URL and a publishable/anon key, never a service-role key.');
  process.exit(1);
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

for (const file of ['index.html', 'app.js', 'fund-report.js', 'style.css']) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(outputDirectory, file));
}
fs.cpSync(path.join(projectRoot, 'assets'), path.join(outputDirectory, 'assets'), { recursive: true });

const runtimeConfig = `window.SUPABASE_CONFIG = ${JSON.stringify({ url: parsedUrl.origin, anonKey: supabaseAnonKey })};\n`;
fs.writeFileSync(path.join(outputDirectory, 'supabase-config.js'), runtimeConfig);
console.log(`Built static app for Supabase project ${parsedUrl.hostname}.`);