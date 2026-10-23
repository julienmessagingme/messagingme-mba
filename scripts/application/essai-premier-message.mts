/**
 * ESSAI DU PREMIER MESSAGE SUR UN NUMÉRO RELIÉ PAR QR CODE (plan `docs/superpowers/plans/2026-10-23-shopify-numero-qr.md`,
 * tâche 1, point d'arrêt). Demande au service de connexions si un numéro est sur WhatsApp (ce qui retient son identifiant
 * masqué), puis, si un texte est donné, lui envoie ce texte comme le fera la porte « écrire en premier ».
 *
 * À viser : un téléphone qui n'a JAMAIS écrit au numéro du compte. Le message doit s'afficher sur son mobile ET sur son
 * ordinateur, jamais « En attente de ce message ». Rien n'est écrit dans les conversations de l'espace.
 *
 * La vérification dit aussi l'ADRESSE que prendra l'envoi (`lid` ou `numero`) : un « En attente » avec `numero` dit que
 * WhatsApp n'a pas donné l'identifiant masqué ; avec `lid`, que l'identifiant n'a pas suffi.
 *
 * ⚠️ L'image `mba-api` doit être construite depuis ce lot (elle ne copie pas `scripts/`, et `client.verifier` doit être
 * dans son `src/`), et le service de connexions aussi. Le script n'applique ni STOP ni consentement : un essai vers un
 * téléphone de Julien, rien d'autre. Si le destinataire répond, sa réponse entre dans l'espace, et son répondeur (l'agent
 * IA de l'espace de test) peut lui répondre.
 *
 * Usage, sur le VPS (un conteneur jetable de l'API, sur le réseau du service) :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/application/essai-premier-message.mts:/app/scripts/application/essai-premier-message.mts \
 *     mba-api npx tsx scripts/application/essai-premier-message.mts <tenantId> <numéro en chiffres> ["texte"]
 */
import { Pool } from 'pg';
import { creerClientApplication } from '../../src/application/client';
import { PgComptesApplication } from '../../src/application/comptes.pg';
import { jidDuWaId } from '../../src/application/message';
import { pgSsl } from '../../src/db/ssl';

const [tenantId, numero, texte] = process.argv.slice(2);
if (!tenantId || !numero || !/^[0-9]{8,15}$/.test(numero)) {
  console.error('usage : npx tsx scripts/application/essai-premier-message.mts <tenantId> <numéro en chiffres> ["texte"]');
  process.exit(1);
}
const url = process.env.APPLICATION_SERVICE_URL ?? '';
const secret = process.env.APPLICATION_SERVICE_SECRET ?? '';
if (!url || !secret) {
  console.error('APPLICATION_SERVICE_URL et APPLICATION_SERVICE_SECRET sont requis');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSsl(), max: 1 });
try {
  const compte = await new PgComptesApplication(pool).parEspace(tenantId);
  if (!compte) {
    console.error(`aucun compte de l'application pour l'espace ${tenantId}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ compte: compte.id, statut: compte.statut }));
    const client = creerClientApplication({ url, secret });
    const verification = await client.verifier(compte.id, numero);
    console.log(JSON.stringify({ verification }));
    if (verification.ok && verification.present && texte) {
      const envoi = await client.envoyer(compte.id, jidDuWaId(numero) ?? numero, texte);
      console.log(JSON.stringify({ envoi }));
    }
  }
} finally {
  await pool.end();
}
