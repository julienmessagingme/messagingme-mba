import { createHmac, randomBytes } from 'node:crypto';

/**
 * La signature des webhooks sortants, au format Standard Webhooks (standardwebhooks.com) :
 * `webhook-signature: v1,<base64(HMAC-SHA256(clé, id.horodatage.corps))>`, la clé étant le base64 qui suit `whsec_`.
 *
 * Choisi plutôt que `signRequest` (`src/lib/signature.ts`) : des bibliothèques de vérification existent dans tous les
 * langages, la rotation y est prévue (plusieurs signatures séparées par une espace), et le chemin n'entre pas dans la
 * préimage, ce qui casse derrière un proxy qui le réécrit. Tenu par le vecteur de test publié par la spécification
 * (`tests/evenements-signature.test.ts`).
 */
export const PREFIXE_SECRET = 'whsec_';

/** Un secret neuf : 32 octets aléatoires, en base64 derrière le préfixe. Montré une seule fois, chiffré au repos. */
export function genererSecret(): string {
  return PREFIXE_SECRET + randomBytes(32).toString('base64');
}

function cle(secret: string): Buffer {
  return Buffer.from(secret.startsWith(PREFIXE_SECRET) ? secret.slice(PREFIXE_SECRET.length) : secret, 'base64');
}

/** Une signature : `v1,` puis le HMAC en base64. `horodatage` en secondes. */
export function signer(o: { secret: string; id: string; horodatage: number; corps: string }): string {
  return 'v1,' + createHmac('sha256', cle(o.secret)).update(`${o.id}.${o.horodatage}.${o.corps}`).digest('base64');
}

/**
 * Les secrets qui signent maintenant : l'actuel, plus l'ancien tant que sa fenêtre de rotation court. Une application
 * qui n'a pas encore pris le nouveau secret vérifie avec l'ancien pendant ce temps.
 */
export function secretsQuiSignent(
  s: { actuel: string; precedent: string | null; precedentJusqua: Date | null },
  maintenant: Date,
): string[] {
  const avecAncien = s.precedent !== null && s.precedentJusqua !== null && s.precedentJusqua.getTime() > maintenant.getTime();
  return avecAncien ? [s.actuel, s.precedent!] : [s.actuel];
}

export interface EnTetesSignes {
  'content-type': string;
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/** Les en-têtes d'un envoi. L'horodatage est celui de la TENTATIVE (le standard borne l'écart accepté), l'id celui de l'événement. */
export function enTetesSignes(o: { secrets: readonly string[]; id: string; maintenant: Date; corps: string }): EnTetesSignes {
  const horodatage = Math.floor(o.maintenant.getTime() / 1000);
  return {
    'content-type': 'application/json',
    'webhook-id': o.id,
    'webhook-timestamp': String(horodatage),
    'webhook-signature': o.secrets.map((secret) => signer({ secret, id: o.id, horodatage, corps: o.corps })).join(' '),
  };
}
