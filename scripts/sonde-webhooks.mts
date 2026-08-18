/**
 * Quels champs de webhook notre app reçoit-elle sur un WABA ? Le handoff MBA dépend de `standby` et
 * `messaging_handovers` : sans abonnement, la bascule de contrôle serait invisible côté console.
 * Lecture seule.
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const WABA = process.argv[2];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null }>(
  'select business_token_enc from waba_credentials where waba_id = $1 limit 1', [WABA],
);
const token = cred.rows[0]?.business_token_enc
  ? decryptSecret(cred.rows[0].business_token_enc, process.env.ENCRYPTION_KEY ?? '')
  : (process.env.META_ACCESS_TOKEN ?? '');

const V = process.env.META_GRAPH_VERSION ?? 'v21.0';
for (const chemin of [`${WABA}/subscribed_apps`, `${WABA}?fields=id,name,message_template_namespace`]) {
  const res = await fetch(`https://graph.facebook.com/${V}/${chemin}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`\n--- ${chemin} -> HTTP ${res.status}`);
  console.log((await res.text()).slice(0, 800));
}
await pool.end();
