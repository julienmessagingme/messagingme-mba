/**
 * Par quelle PORTE nos appels MBA passent-ils ? Les endpoints `agent_config/*` acceptent « any of the
 * following » : la capability fournisseur `bizai_wa_enterprise_api_3p_access`, OU la simple permission
 * `whatsapp_business_messaging`. Savoir laquelle nous ouvre la porte change tout : la première est un
 * statut de Tech Provider, la seconde est un droit délégué par le client via l'Embedded Signup.
 *
 * Lecture seule. Le token d'application ({appId}|{appSecret}) est le seul autorisé à inspecter un token.
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const PN = process.argv[2];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null }>(
  `select w.business_token_enc from phone_numbers p join waba_credentials w on w.waba_id = p.waba_id
    where p.id = $1 limit 1`,
  [PN],
);
const token = cred.rows[0]?.business_token_enc
  ? decryptSecret(cred.rows[0].business_token_enc, process.env.ENCRYPTION_KEY ?? '')
  : (process.env.META_ACCESS_TOKEN ?? '');

const APP_ID = process.env.META_APP_ID ?? '';
const APP_SECRET = process.env.META_APP_SECRET ?? '';
const V = process.env.META_GRAPH_VERSION ?? 'v21.0';

// debug_token exige un token d'APPLICATION (leçon du 2026-08-17 sur l'Embedded Signup).
const res = await fetch(
  `https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${APP_ID}|${APP_SECRET}`)}`,
);
const info = (await res.json()) as {
  data?: {
    type?: string;
    application?: string;
    app_id?: string;
    scopes?: string[];
    granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
    expires_at?: number;
    data_access_expires_at?: number;
  };
};
console.log(`debug_token -> HTTP ${res.status}`);
const d = info.data ?? {};
console.log(`  application : ${d.application ?? '?'} (${d.app_id ?? '?'})`);
console.log(`  type        : ${d.type ?? '?'}`);
console.log(`  expiration  : ${d.expires_at === 0 ? 'jamais' : new Date((d.expires_at ?? 0) * 1000).toISOString()}`);
console.log(`  scopes      : ${(d.scopes ?? []).join(', ') || '(aucun)'}`);
for (const g of d.granular_scopes ?? []) {
  console.log(`  granulaire  : ${g.scope} -> ${(g.target_ids ?? []).join(', ') || '(sans cible)'}`);
}

// La capability fournisseur est-elle presente ?
const CAP = 'bizai_wa_enterprise_api_3p_access';
const tout = JSON.stringify(info);
console.log(`\ncapability fournisseur « ${CAP} » : ${tout.includes(CAP) ? 'PRESENTE' : 'ABSENTE'}`);
console.log(`permission whatsapp_business_messaging : ${tout.includes('whatsapp_business_messaging') ? 'PRESENTE' : 'ABSENTE'}`);

await pool.end();
