/**
 * Sonde LIVE de l'état d'un WABA côté facturation et vérification : ce qui conditionne l'ajout d'un moyen
 * de paiement, et donc l'allumage d'un agent MBA (« messages are not delivered unless your Business Agent
 * account has a payment method attached »).
 *
 * Lecture seule. Le token n'est jamais affiché, seulement sa longueur.
 *
 * Usage :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/sonde-waba-billing.mts:/app/scripts/sonde-waba-billing.mts \
 *     mba-api npx tsx scripts/sonde-waba-billing.mts <waba_id>
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const WABA = process.argv[2];
if (!WABA) {
  console.error('usage: npx tsx scripts/sonde-waba-billing.mts <waba_id>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null; token_status: string }>(
  'select business_token_enc, token_status from waba_credentials where waba_id = $1 limit 1',
  [WABA],
);

let token = process.env.META_ACCESS_TOKEN ?? '';
let source = 'token global (META_ACCESS_TOKEN)';
if (cred.rows[0]?.business_token_enc) {
  token = decryptSecret(cred.rows[0].business_token_enc, process.env.ENCRYPTION_KEY ?? '');
  source = `token du WABA (statut ${cred.rows[0].token_status})`;
}
console.log(`source du token : ${source} | longueur ${token.length}`);

const V = process.env.META_GRAPH_VERSION ?? 'v21.0';
async function lire(chemin: string, base = `https://graph.facebook.com/${V}`): Promise<void> {
  const res = await fetch(`${base}/${chemin}`, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await res.text();
  console.log(`\n--- ${chemin} -> HTTP ${res.status}`);
  console.log(txt.slice(0, 1000));
}

// Le WABA lui-même : statut de revue, vérification d'entreprise, propriétaire, mode de facturation.
await lire(`${WABA}?fields=id,name,account_review_status,business_verification_status,country,currency,timezone_id,owner_business_info,on_behalf_of_business_info,primary_funding_id,purchase_order_number`);
// Ce que le token peut voir du portefeuille propriétaire.
await lire(`${WABA}?fields=owner_business{id,name,verification_status,payment_methods{id}}`);
// Rattachement de crédit (partage de ligne de crédit BSP -> client).
// Le portefeuille proprietaire (business_id lu dans l'URL de WhatsApp Manager).
const BM = process.env.BUSINESS_ID ?? '';
if (BM) {
  await lire(`${BM}?fields=id,name,verification_status,is_disabled_for_integrations`);
  await lire(`${BM}/system_users`);
}
// Ce que le token est autorisé à faire (portées accordées).
await lire('me/permissions');

await pool.end();
