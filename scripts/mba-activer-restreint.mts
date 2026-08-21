/**
 * Allume un agent MBA en le RESTREIGNANT à une liste de numéros autorisés. Sert à tester en conditions
 * réelles sans exposer le numéro à tout le monde.
 *
 * Ordre volontaire : l'allowlist est remplie AVANT le basculement, et `ai_audience` passe à ALLOWLISTED_ONLY
 * dans le MÊME PUT que l'activation. À aucun moment l'agent n'est allumé en EVERYONE.
 *
 * ⚠️ `agent_config/settings` est une ressource en REMPLACEMENT COMPLET. Ce script relit l'objet existant et
 * ne modifie que deux clés : tout le reste (`never_say_phrases`, `followup`, `handoff`, et les champs que
 * Meta ajouterait demain) est repassé TEL QUEL. Un modèle typé fermé les effacerait en silence.
 *
 * Extinction : `npx tsx scripts/mba-activer-restreint.mts <pn> --off` (repasse rollout.enabled à false,
 * sans toucher à l'allowlist).
 *
 * ⚠️ `--tous` allume SANS restreindre : `ai_audience` est laissé tel quel, donc l'agent répond à tout le
 * monde si le numéro était déjà en EVERYONE. À n'utiliser que sur un numéro dont on assume l'exposition.
 * C'est un choix à faire explicitement, jamais un défaut : sans ce drapeau, le script exige des numéros.
 *
 * Usage :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/mba-activer-restreint.mts:/app/scripts/mba-activer-restreint.mts \
 *     mba-api npx tsx scripts/mba-activer-restreint.mts <phone_number_id> +33612345678 [...]
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const [, , PN, ...reste] = process.argv;
const ETEINDRE = reste.includes('--off');
const SANS_RESTRICTION = reste.includes('--tous');
const NUMEROS = reste.filter((a) => a !== '--off' && a !== '--tous');
if (!PN || (!ETEINDRE && !SANS_RESTRICTION && NUMEROS.length === 0)) {
  console.error('usage: npx tsx scripts/mba-activer-restreint.mts <phone_number_id> <+E164...> | --tous | --off');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null }>(
  `select w.business_token_enc from phone_numbers p join waba_credentials w on w.waba_id = p.waba_id
    where p.id = $1 limit 1`,
  [PN],
);
const token = cred.rows[0]?.business_token_enc
  ? decryptSecret(cred.rows[0].business_token_enc, process.env.ENCRYPTION_KEY ?? '')
  : (process.env.META_ACCESS_TOKEN ?? '');

const entetes = { Authorization: `Bearer ${token}`, 'X-API-Version': '2.0.0', 'Content-Type': 'application/json' };
const BASE = `https://api.facebook.com/${PN}/agent_config`;

async function json(methode: string, url: string, corps?: unknown): Promise<unknown> {
  const res = await fetch(url, { method: methode, headers: entetes, ...(corps ? { body: JSON.stringify(corps) } : {}) });
  const txt = await res.text();
  console.log(`${methode} ${url.replace('https://api.facebook.com/', '')} -> HTTP ${res.status}`);
  if (res.status >= 400) console.log('   ', txt); // message complet : Meta y met parfois l'URL exacte a suivre
  try { return JSON.parse(txt); } catch { return txt; }
}

// --- 1. Allowlist AVANT toute activation.
if (!ETEINDRE) {
  const deja = (await json('GET', `${BASE}/allowlist`)) as Array<{ consumer_phone_number?: string }>;
  const connus = new Set((Array.isArray(deja) ? deja : []).map((e) => (e.consumer_phone_number ?? '').replace(/\D/g, '')));
  for (const n of NUMEROS) {
    if (connus.has(n.replace(/\D/g, ''))) { console.log(`   ${n} deja dans l'allowlist`); continue; }
    await json('POST', `${BASE}/allowlist`, { consumer_phone_number: n });
  }
}

// --- 2. Réglages : lecture, modification de DEUX clés, réécriture complète.
const lus = (await json('GET', `${BASE}/settings`)) as Array<Record<string, unknown>>;
const courant = Array.isArray(lus) && lus[0] ? lus[0] : {};
console.log('\nreglages AVANT :', JSON.stringify(courant));

const voulu: Record<string, unknown> = {
  ...courant, // tout le reste est repassé tel quel, y compris ce que nous ne connaissons pas
  rollout: { ...(courant.rollout as object ?? {}), enabled: !ETEINDRE },
  // `ai_audience` n'est touché QUE dans le mode restreint : `--tous` et `--off` laissent au numéro l'audience
  // qu'il avait, plutôt que de la changer au passage sans que personne l'ait demandé.
  ...(ETEINDRE || SANS_RESTRICTION ? {} : { ai_audience: 'ALLOWLISTED_ONLY' }),
};
// ⚠️ `agent_id` et `channel` sont dans la réponse du GET mais PAS dans le schéma de requête : les renvoyer
// tels quels expose à un 400. `agent_id` repart en query, où Meta l'attend (sinon le PUT bascule en
// « create-or-fetch » et on ne sait plus quelle configuration on écrit).
const agentId = typeof courant.agent_id === 'string' ? courant.agent_id : '';
delete voulu.agent_id;
delete voulu.channel;
await json('PUT', `${BASE}/settings${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, voulu);

const apres = (await json('GET', `${BASE}/settings`)) as unknown;
console.log('\nreglages APRES :', JSON.stringify(apres));
console.log('allowlist      :', JSON.stringify(await json('GET', `${BASE}/allowlist`)));

await pool.end();
