/**
 * Le corps à poser chez 360dialog pour qu'un numéro nous envoie ses webhooks (`src/webhooks/receiver-360dialog.ts`) :
 * l'adresse et le Basic propre au numéro, dérivé de `D360_WEBHOOK_SECRET`. N'appelle rien, n'écrit rien.
 *
 *   D360_WEBHOOK_SECRET=... npx tsx scripts/webhook-360dialog.mts <phone_number_id> [https://api.messagingme.app]
 *
 * ⚠️ `scripts/` n'est PAS dans l'image de l'API (`Dockerfile`), et le secret ne vit que dans son `.env.prod`. Pour
 * ne jamais le recopier à la main, on calcule DANS le conteneur avec le module de la route, qui y est (le
 * `< /dev/null` compte : sans lui, `exec -T` avale l'entrée d'un `ssh ... 'bash -s'` et la suite du script ne
 * s'exécute pas, sans erreur) :
 *
 *   sudo docker compose exec -T mba-api npx tsx -e "import { enteteDuNumero } from './src/webhooks/receiver-360dialog.ts';
 *     console.log(enteteDuNumero(process.env.D360_WEBHOOK_SECRET ?? '', '<phone_number_id>'))" < /dev/null
 *
 * La sortie CONTIENT un secret : elle va dans `POST https://waba-v2.360dialog.io/v1/configs/webhook` (un seul webhook)
 * ou dans `/multi_webhook` (`enabled: true` et TOUTES les destinations, celle du logiciel déjà branché comprise), avec
 * la clé d'API du numéro, et nulle part ailleurs. Fait ainsi le 2026-10-15 pour le premier numéro, à côté de UChat.
 */
import { enteteDuNumero } from '../src/webhooks/receiver-360dialog';

const [phoneNumberId, base = 'https://api.messagingme.app'] = process.argv.slice(2);
const secret = process.env['D360_WEBHOOK_SECRET'] ?? '';
if (!phoneNumberId || !/^\d+$/.test(phoneNumberId)) {
  console.error('usage : npx tsx scripts/webhook-360dialog.mts <phone_number_id> [base de l’API]');
  process.exit(1);
}
if (secret === '') {
  console.error('D360_WEBHOOK_SECRET est vide : la route n’est pas montée, aucun webhook ne passerait.');
  process.exit(1);
}
console.log(JSON.stringify({
  url: `${base.replace(/\/$/, '')}/webhooks/360dialog/${phoneNumberId}`,
  headers: { Authorization: enteteDuNumero(secret, phoneNumberId) },
}, null, 2));
