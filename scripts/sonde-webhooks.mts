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

/**
 * ⚠️ `subscribed_apps` liste les APPS abonnées au WABA, pas les CHAMPS qu'elles reçoivent. Or c'est la liste
 * des champs qui décide si `standby` et `messaging_handovers` nous parviennent : sans eux, la bascule de
 * contrôle serait invisible et on conclurait à tort que le passage de main n'existe pas.
 *
 * Cette liste vit sur l'APPLICATION, et sa lecture demande un jeton d'application (`{app_id}|{app_secret}`),
 * pas le jeton business : la ressource n'appartient pas au WABA.
 */
const APP_ID = process.env.META_APP_ID ?? '';
const APP_SECRET = process.env.META_APP_SECRET ?? '';
if (APP_ID === '' || APP_SECRET === '') {
  console.log('\n--- champs souscrits : ignoré (META_APP_ID / META_APP_SECRET absents de l\'environnement)');
} else {
  const res = await fetch(`https://graph.facebook.com/${V}/${APP_ID}/subscriptions?access_token=${APP_ID}|${APP_SECRET}`);
  console.log(`\n--- ${APP_ID}/subscriptions -> HTTP ${res.status}`);
  console.log((await res.text()).slice(0, 2000));
}
await pool.end();
