import { sha256Hex } from '../lib/signature';

/**
 * L'IDEMPOTENCE D'UN ENVOI PAR L'API : quelle clé, et quelle empreinte (spec 2026-09-24, § 3).
 *
 * 🔴 LA CLÉ SE DONNE EN EN-TÊTE (`Idempotency-Key`) OU DANS LE CORPS (`idempotencyKey`). Un outil qui appelle
 * une adresse PAR CONTACT remplit son corps avec les données du contact, et rien ne garantit qu'il en fasse
 * autant pour ses en-têtes : exiger l'en-tête lui interdirait une clé par contact. Les deux présentes et
 * différentes : refus, jamais un choix silencieux entre les deux.
 *
 * 🔴 L'EMPREINTE DU CORPS EST GARDÉE AVEC LA CLÉ (`api_idempotency.request_hash`) : la même clé avec un AUTRE
 * corps est refusée au lieu de rejouer en silence le rapport du premier envoi.
 */

/** La borne d'une clé : de quoi porter un identifiant, une étape et une date, pas un document. */
export const CLE_IDEMPOTENCE_MAX = 255;

export type CleIdempotence =
  | { ok: true; cle: string }
  | { ok: false; code: 'idempotency_key_required' | 'invalid_body'; message: string };

export function cleIdempotence(entete: string | string[] | undefined, corps: unknown): CleIdempotence {
  const brute = Array.isArray(entete) ? entete[0] : entete;
  const enTete = typeof brute === 'string' && brute.trim() !== '' ? brute.trim() : null;
  const valeur = corps !== null && typeof corps === 'object' && 'idempotencyKey' in corps ? corps.idempotencyKey : undefined;
  if (valeur !== undefined && typeof valeur !== 'string') {
    return { ok: false, code: 'invalid_body', message: 'idempotencyKey : texte attendu' };
  }
  const dansCorps = typeof valeur === 'string' && valeur.trim() !== '' ? valeur.trim() : null;
  if (enTete !== null && dansCorps !== null && enTete !== dansCorps) {
    return { ok: false, code: 'invalid_body', message: 'la clé d’idempotence de l’en-tête et celle du corps diffèrent : n’en donner qu’une, ou la même' };
  }
  const cle = enTete ?? dansCorps;
  if (cle === null) {
    return { ok: false, code: 'idempotency_key_required', message: 'clé d’idempotence requise : en-tête Idempotency-Key ou champ idempotencyKey du corps' };
  }
  // Un caractère de contrôle ne peut venir que du corps (un en-tête HTTP ne le porte pas), et l'octet nul est
  // refusé par Postgres dans un `text` : sans ce refus, la clé finissait en 500 au lieu d'un 400.
  if (/[\u0000-\u001f\u007f]/.test(cle)) {
    return { ok: false, code: 'invalid_body', message: 'clé d’idempotence : caractères de contrôle interdits' };
  }
  if (cle.length > CLE_IDEMPOTENCE_MAX) {
    return { ok: false, code: 'invalid_body', message: `clé d’idempotence : ${CLE_IDEMPOTENCE_MAX} caractères au plus` };
  }
  return { ok: true, cle };
}

/** Sérialisation CANONIQUE : clés d'objet triées, récursivement. L'ordre d'un tableau est gardé : il a un sens. */
function canonique(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonique);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonique(x)]),
    );
  }
  return v;
}

/**
 * L'EMPREINTE d'un corps d'envoi : ce qui dit « c'est la MÊME demande ».
 *
 * ⚠️ `idempotencyKey` est RETIRÉE avant le calcul : la même demande passée une fois avec la clé en en-tête, une
 * fois avec la clé dans le corps, doit avoir la même empreinte, sinon le rejeu légitime serait refusé.
 */
export function empreinteCorps(corps: unknown): string {
  const sansCle = corps !== null && typeof corps === 'object' && !Array.isArray(corps)
    ? Object.fromEntries(Object.entries(corps).filter(([k]) => k !== 'idempotencyKey'))
    : corps;
  return sha256Hex(JSON.stringify(canonique(sansCle) ?? null));
}
