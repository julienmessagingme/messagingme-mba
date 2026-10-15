/**
 * Le corps à poser chez 360dialog pour qu'un numéro nous envoie ses webhooks (`src/webhooks/receiver-360dialog.ts`) :
 * l'adresse et le Basic propre au numéro, dérivé de `D360_WEBHOOK_SECRET`. N'appelle rien, n'écrit rien.
 *
 *   npx tsx scripts/webhook-360dialog.mts <phone_number_id> [https://api.messagingme.app]
 *
 * Le secret se lit dans l'environnement, donc là où il vit (le conteneur de l'API), jamais recopié à la main. La
 * sortie CONTIENT un secret : elle va dans `POST https://waba-v2.360dialog.io/v1/configs/webhook` (un seul webhook)
 * ou dans `/multi_webhook` (en plus de ceux qui existent), avec la clé d'API du numéro, et nulle part ailleurs.
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
