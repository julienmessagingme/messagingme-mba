import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../lib/signature';
import { DUREE_CODE_MS } from '../campaign/confirmation';

/**
 * LE CODE DE CONFIRMATION D'UNE SUPPRESSION EN MASSE DEPUIS CLAUDE (plan
 * `docs/superpowers/plans/2026-10-26-free-au-dela-de-100-contacts.md`) : `prepare_contacts_deletion` le rend avec
 * l'aperçu, `delete_contacts` l'exige avec la même sélection. Comme celui d'une campagne (`src/campaign/confirmation.ts`),
 * il garantit que l'effacement porte sur EXACTEMENT les fiches montrées ; à sa différence, il n'est gardé nulle part
 * (aucune table, donc aucune migration) : c'est une signature, par une clé dérivée d'`AUTH_SECRET` pour ce seul usage, de
 * l'espace, de l'échéance et de l'empreinte des fiches désignées.
 *  - 30 minutes, comme une campagne (`DUREE_CODE_MS`) ;
 *  - lié à l'espace : un code d'un autre espace ne se vérifie pas ;
 *  - lié aux fiches : `delete_contacts` re-résout la sélection, et une fiche ajoutée, retirée ou effacée depuis l'aperçu
 *    change l'empreinte ;
 *  - à usage unique PAR CONSTRUCTION : une fiche effacée n'est plus jamais rendue par une sélection, donc la même
 *    sélection, rejouée après l'effacement, n'a plus la même empreinte. ⚠️ Deux appels SIMULTANÉS peuvent passer tous les
 *    deux : le second n'efface rien de plus (la purge saute une fiche déjà anonymisée).
 * La sélection elle-même n'entre pas dans la signature : deux sélections qui désignent les mêmes fiches effacent la même
 * chose, celle que la personne a vue.
 */

const USAGE = 'mcp:suppression-contacts:v1';
/** 128 bits de HMAC-SHA256 : 22 caractères à recopier, hors de portée d'un essai au hasard. */
const OCTETS_SIGNATURE = 16;
const FORME = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/;

/** L'empreinte d'une liste de fiches, indépendante de son ordre. */
export function empreinteDesFiches(ids: readonly string[]): string {
  return sha256Hex([...ids].map((id) => id.toLowerCase()).sort().join(','));
}

function signature(secret: string, tenantId: string, echeanceSec: number, empreinte: string): Buffer {
  const cle = createHmac('sha256', secret).update(USAGE, 'utf8').digest();
  return createHmac('sha256', cle).update(`${tenantId}.${echeanceSec}.${empreinte}`, 'utf8').digest().subarray(0, OCTETS_SIGNATURE);
}

/** Le code d'une sélection, et son échéance. Un secret vide est refusé : il signerait avec une clé connue de tous. */
export function codeDeSuppression(secret: string, tenantId: string, empreinte: string, maintenantMs: number): { code: string; expireLe: Date } {
  if (!secret) throw new Error('suppression de contacts : secret absent');
  const echeanceSec = Math.floor((maintenantMs + DUREE_CODE_MS) / 1000);
  return {
    code: `${echeanceSec.toString(36)}.${signature(secret, tenantId, echeanceSec, empreinte).toString('base64url')}`,
    expireLe: new Date(echeanceSec * 1000),
  };
}

/** A-t-il la forme d'un code ? Pour refuser une saisie bancale avant toute lecture en base. */
export function codeBienForme(code: string): boolean {
  return FORME.test(code);
}

/**
 * `invalide` : mal formé, signé pour un autre espace ou d'autres fiches, ou avec un autre secret. `expire` : bien signé,
 * mais l'échéance est passée. La signature se vérifie avant l'échéance, en temps constant.
 */
export function verifierCodeDeSuppression(
  secret: string, code: string, tenantId: string, empreinte: string, maintenantMs: number,
): 'ok' | 'invalide' | 'expire' {
  const m = FORME.exec(code);
  if (!secret || !m) return 'invalide';
  const echeanceSec = parseInt(m[1]!, 36);
  const attendue = signature(secret, tenantId, echeanceSec, empreinte);
  const recue = Buffer.from(m[2]!, 'base64url');
  if (recue.length !== attendue.length || !timingSafeEqual(recue, attendue)) return 'invalide';
  return echeanceSec * 1000 < maintenantMs ? 'expire' : 'ok';
}
