/**
 * Charge dans la base de connaissance d'un agent MBA les paires question/réponse RÉELLES du réseau
 * Keolis Auxerre, extraites de la base de connaissance du chatbot existant (`keolis-auxerre`).
 *
 * Pourquoi ce script existe : la première configuration de test posait des réponses génériques écrites
 * pour l'occasion. Or ce réseau a déjà 78 Q/R validées, en production dans son chatbot WhatsApp. Charger
 * le vrai contenu rend le test représentatif (l'agent répond ce qu'il répondrait vraiment) et évite de
 * poser des formulations que personne n'a validées.
 *
 * Le fichier d'entrée s'extrait ainsi (le conteneur porte la base SQLite) :
 *   sudo docker exec keolis-auxerre node -e "const D=require('better-sqlite3'); \
 *     const db=new D('/app/data/knowledge.db',{readonly:true}); \
 *     console.log(JSON.stringify(db.prepare(\"select question,answer from knowledge_items \
 *     where type='qa' and question is not null and answer is not null\").all()));" > auxerre-qa.json
 *
 * ⚠️ Idempotence : les FAQ déjà présentes sur l'agent (même question) sont SAUTÉES, pas dupliquées.
 * ⚠️ Aucune suppression : ce script n'efface jamais une FAQ existante.
 *
 * Usage :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/mba-charger-faq-auxerre.mts:/app/scripts/mba-charger-faq-auxerre.mts \
 *     -v /home/ubuntu/mba/auxerre-qa.json:/app/auxerre-qa.json \
 *     mba-api npx tsx scripts/mba-charger-faq-auxerre.mts <phone_number_id> auxerre-qa.json [max]
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const PN = process.argv[2];
const FICHIER = process.argv[3];
const MAX = Number(process.argv[4] ?? '0') || Infinity;
if (!PN || !FICHIER) {
  console.error('usage: npx tsx scripts/mba-charger-faq-auxerre.mts <phone_number_id> <fichier.json> [max]');
  process.exit(1);
}

const brut = readFileSync(FICHIER, 'utf8');
const debut = brut.indexOf('[');
const paires = JSON.parse(brut.slice(debut)) as Array<{ question: string; answer: string }>;
console.log(`${paires.length} paires lues dans ${FICHIER}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null }>(
  `select w.business_token_enc from phone_numbers p join waba_credentials w on w.waba_id = p.waba_id
    where p.id = $1 limit 1`,
  [PN],
);
const token = cred.rows[0]?.business_token_enc
  ? decryptSecret(cred.rows[0].business_token_enc, process.env.ENCRYPTION_KEY ?? '')
  : (process.env.META_ACCESS_TOKEN ?? '');

const entetes = {
  Authorization: `Bearer ${token}`,
  'X-API-Version': '2.0.0',
  'Content-Type': 'application/json',
};
const URL_FAQ = `https://api.facebook.com/${PN}/agent_config/faq`;

// Ce qui est déjà en place : on ne recharge pas ce qui y est.
const dejaRes = await fetch(URL_FAQ, { headers: entetes });
const deja = (await dejaRes.json()) as Array<{ question?: string }>;
const connues = new Set((Array.isArray(deja) ? deja : []).map((f) => (f.question ?? '').trim().toLowerCase()));
console.log(`${connues.size} FAQ deja presentes sur l'agent`);

let poses = 0;
let sautes = 0;
const echecs: Array<{ question: string; status: number; corps: string }> = [];

for (const p of paires) {
  if (poses >= MAX) break;
  const q = (p.question ?? '').trim();
  const a = (p.answer ?? '').trim();
  if (!q || !a) { sautes += 1; continue; }
  if (connues.has(q.toLowerCase())) { sautes += 1; continue; }

  const res = await fetch(URL_FAQ, { method: 'POST', headers: entetes, body: JSON.stringify({ question: q, answer: a }) });
  if (res.status >= 400) {
    echecs.push({ question: q, status: res.status, corps: (await res.text()).slice(0, 200) });
  } else {
    poses += 1;
    connues.add(q.toLowerCase());
  }
  await new Promise((r) => setTimeout(r, 150)); // on ne martèle pas l'API
}

console.log(`\nposees : ${poses} | sautees (deja la ou vides) : ${sautes} | echecs : ${echecs.length}`);
for (const e of echecs.slice(0, 5)) console.log(`  ECHEC ${e.status} sur « ${e.question.slice(0, 60)} » : ${e.corps}`);

const finRes = await fetch(URL_FAQ, { headers: entetes });
const fin = (await finRes.json()) as unknown[];
console.log(`total FAQ sur l'agent : ${Array.isArray(fin) ? fin.length : '?'}`);

await pool.end();
