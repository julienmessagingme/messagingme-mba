/**
 * Teste un agent MBA dans le bac à sable `agent_test` : messages joués contre le pipeline complet, SANS
 * numéro consommateur réel et SANS activer l'agent. Meta l'écrit deux fois dans sa doc : « Tokens consumed
 * while testing through this endpoint are not billed. »
 *
 * Sert à vérifier qu'une configuration (FAQ + skills) produit les réponses attendues, et surtout que
 * l'agent REFUSE d'inventer ce qu'il ne sait pas.
 *
 * Usage :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/mba-test-agent.mts:/app/scripts/mba-test-agent.mts \
 *     mba-api npx tsx scripts/mba-test-agent.mts <phone_number_id>
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const PN = process.argv[2];
if (!PN) {
  console.error('usage: npx tsx scripts/mba-test-agent.mts <phone_number_id>');
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

/** Ce qu'on veut voir : une réponse utile, et AUCUNE information inventée. */
const MESSAGES = [
  'Bonjour, à quelle heure passe le prochain bus de la ligne 3 à la gare ?',
  'Combien coûte un ticket à l’unité ?',
  'J’ai laissé mon sac dans le bus ce matin.',
  'Je veux parler à un conseiller.',
];

let conversationId: string | undefined;
for (const msg of MESSAGES) {
  const res = await fetch(`https://api.facebook.com/${PN}/agent_test`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-API-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_msg: msg, ...(conversationId ? { conversation_id: conversationId } : {}) }),
  });
  const txt = await res.text();
  console.log(`\n👤 ${msg}`);
  console.log(`   HTTP ${res.status}`);
  try {
    const j = JSON.parse(txt) as {
      agent_response?: string;
      conversation_id?: string;
      handoff_reason?: string;
      no_response_reason?: string;
      quick_replies?: unknown[];
    };
    if (j.conversation_id) conversationId = j.conversation_id;
    console.log(`🤖 ${j.agent_response ?? '(aucune réponse)'}`);
    if (j.handoff_reason) console.log(`   ↪ handoff_reason : ${j.handoff_reason}`);
    if (j.no_response_reason) console.log(`   ↪ no_response_reason : ${j.no_response_reason}`);
    if (j.quick_replies?.length) console.log(`   ↪ quick_replies : ${JSON.stringify(j.quick_replies)}`);
  } catch {
    console.log(txt.slice(0, 500));
  }
}

await pool.end();
