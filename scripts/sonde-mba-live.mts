/**
 * Sonde LIVE de la surface Meta Business Agent sur un numéro réel : éligibilité, réglages de l'agent et
 * état de sa base de connaissance. Lecture seule, aucun envoi, rien d'activé.
 *
 * Sert à répondre à « MBA est-il ouvert sur ce numéro, et où en est sa configuration ? » sans passer par
 * l'interface Meta, et à mesurer les écarts avec `messagingme-pilot/docs/META-BUSINESS-AGENT-API.md`.
 *
 * ⚠️ MBA ne vit PAS sur `graph.facebook.com` : ces routes y répondent « Unknown path components » (mesuré le
 * 2026-08-18). C'est `api.facebook.com`, SANS version dans le chemin, la version passant par `X-API-Version`.
 *
 * Usage (le token n'est jamais affiché, seulement sa longueur) :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/sonde-mba-live.mts:/app/scripts/sonde-mba-live.mts \
 *     mba-api npx tsx scripts/sonde-mba-live.mts <phone_number_id>
 * Le token est celui du WABA du numéro (déchiffré comme en prod) ; à défaut, META_ACCESS_TOKEN.
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const PN = process.argv[2];
if (!PN) {
  console.error('usage: npx tsx scripts/sonde-mba-live.mts <phone_number_id>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ waba_id: string; business_token_enc: string | null; token_status: string }>(
  `select w.waba_id, w.business_token_enc, w.token_status
     from phone_numbers p join waba_credentials w on w.waba_id = p.waba_id
    where p.id = $1 limit 1`,
  [PN],
);

let token = process.env.META_ACCESS_TOKEN ?? '';
let source = 'token global (META_ACCESS_TOKEN)';
const ligne = cred.rows[0];
if (ligne?.business_token_enc) {
  token = decryptSecret(ligne.business_token_enc, process.env.ENCRYPTION_KEY ?? '');
  source = `token du WABA ${ligne.waba_id} (statut ${ligne.token_status})`;
}
console.log(`source du token : ${source} | longueur ${token.length}`);

async function lire(chemin: string): Promise<void> {
  const res = await fetch(`https://api.facebook.com/${chemin}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-API-Version': '2.0.0' },
  });
  const txt = await res.text();
  console.log(`\n--- ${chemin} -> HTTP ${res.status}`);
  console.log(txt.slice(0, 1200));
}

await lire(`${PN}/agent_eligibility`);
await lire(`${PN}/agent_config/settings`);
await lire(`${PN}/agent_config/business_info`);
await lire(`${PN}/agent_config/faq`);
await lire(`${PN}/agent_config/skills`);
await lire(`${PN}/agent_config/websites`);
await lire(`${PN}/agent_config/files`);
await lire(`${PN}/agent_config/allowlist`);
await lire(`${PN}/agent_connectors`);

await pool.end();
