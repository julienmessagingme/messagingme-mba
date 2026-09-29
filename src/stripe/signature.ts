import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * La signature d'un webhook Stripe (`Stripe-Signature: t=<secondes>,v1=<hex>[,v1=<hex>]...`).
 *
 * Stripe signe `<t>.<corps brut>` en HMAC SHA-256 avec le secret de la destination (`whsec_...`). Trois règles :
 *   - 🔴 sur le CORPS BRUT, tel que reçu : un JSON relu puis réécrit n'a plus les mêmes octets ;
 *   - comparaison à temps constant, contre CHAQUE `v1` de l'en-tête (Stripe en envoie deux pendant la rotation
 *     d'un secret) ; les `v0` (anciens) sont ignorés ;
 *   - la fraîcheur (`t`) est vérifiée APRÈS la signature, sur cinq minutes dans les deux sens : un horodatage non
 *     signé ne dit rien, et la vérifier avant ouvrirait un canal de temps sur un en-tête forgé.
 * La fenêtre borne le rejeu sans l'empêcher : le webhook est idempotent par session (migration 0191).
 */

/** Tolérance de Stripe sur l'horodatage, en secondes (la valeur de ses propres bibliothèques). */
export const TOLERANCE_SIGNATURE_S = 300;

export function verifierSignatureStripe(
  brut: Buffer,
  entete: string | undefined,
  secret: string,
  maintenantMs: number,
  toleranceS: number = TOLERANCE_SIGNATURE_S,
): boolean {
  // Un secret vide signerait avec une clé que tout le monde connaît : refus, jamais une vérification.
  if (!secret || !entete) return false;
  let t: string | null = null;
  const signatures: string[] = [];
  for (const morceau of entete.split(',')) {
    const i = morceau.indexOf('=');
    if (i <= 0) continue;
    const cle = morceau.slice(0, i).trim();
    const valeur = morceau.slice(i + 1).trim();
    if (cle === 't') t = valeur;
    else if (cle === 'v1') signatures.push(valeur);
  }
  if (t === null || !/^\d{1,15}$/.test(t) || signatures.length === 0) return false;

  const attendue = createHmac('sha256', secret).update(`${t}.`, 'utf8').update(brut).digest();
  const valide = signatures.some((s) => /^[0-9a-f]{64}$/i.test(s) && timingSafeEqual(Buffer.from(s, 'hex'), attendue));
  if (!valide) return false;

  const ecartS = maintenantMs / 1000 - Number(t);
  return Math.abs(ecartS) <= toleranceS;
}
