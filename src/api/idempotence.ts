import { sha256Hex } from '../lib/signature';

/**
 * L'idempotence d'un envoi par l'API : quelle clé, et quelle empreinte.
 *
 * La clé se donne en en-tête (`Idempotency-Key`) ou dans le corps (`idempotencyKey`) : un outil qui appelle
 * une adresse par contact remplit son corps, pas forcément ses en-têtes. Les deux présentes et différentes :
 * refus, jamais un choix silencieux. L'empreinte du corps est gardée avec la clé : la même clé avec un autre
 * corps est refusée au lieu de rejouer le rapport du premier envoi.
 */

/**
 * La durée de vie d'une clé : 24 h, écrite une fois (claim, purge du worker, message du 422). La purge ne
 * descend jamais dessous (voir `sweepOlderThan`).
 */
export const DUREE_CLE_IDEMPOTENCE_MS = 24 * 60 * 60 * 1000;

/**
 * Au-delà de cette durée, une clé EN COURS (posée, jamais scellée) est abandonnée : le traitement qui l'a posée
 * est mort (copie tuée, crash) et ne la libérera jamais. `claim` la retire alors, et la clé redevient libre.
 *
 * 🔴 CE N'EST PAS ELLE QUI EMPÊCHE LE DOUBLE ENVOI, c'est le jeton de garde (`api_idempotency.jeton`) : un
 * traitement lent qui dépasserait la borne ne peut plus ni sceller ni libérer la clé reprise, donc sa campagne
 * n'est jamais lancée. La borne décide seulement combien de temps une clé abandonnée bloque son client (avant
 * elle : 24 h, mesuré par le second banc du 2026-10-03). Un envoi légitime prend quelques secondes
 * (au plus `MAX_RECIPIENTS` destinataires) : cinq minutes laissent une marge large sans faire attendre longtemps.
 */
export const DUREE_CLE_EN_COURS_MAX_MS = 5 * 60 * 1000;

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
  // Un caractère de contrôle ne peut venir que du corps, et Postgres refuse l'octet nul dans un `text` : sans
  // ce refus, un 500 au lieu d'un 400.
  if (/[\u0000-\u001f\u007f]/.test(cle)) {
    return { ok: false, code: 'invalid_body', message: 'clé d’idempotence : caractères de contrôle interdits' };
  }
  if (cle.length > CLE_IDEMPOTENCE_MAX) {
    return { ok: false, code: 'invalid_body', message: `clé d’idempotence : ${CLE_IDEMPOTENCE_MAX} caractères au plus` };
  }
  return { ok: true, cle };
}

/** Sérialisation canonique : clés d'objet triées, récursivement. L'ordre d'un tableau est gardé : il a un sens. */
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
 * L'empreinte d'un corps d'envoi : ce qui dit « c'est la même demande ». `idempotencyKey` est retirée avant
 * le calcul : la clé en en-tête ou dans le corps doit donner la même empreinte.
 */
export function empreinteCorps(corps: unknown): string {
  const sansCle = corps !== null && typeof corps === 'object' && !Array.isArray(corps)
    ? Object.fromEntries(Object.entries(corps).filter(([k]) => k !== 'idempotencyKey'))
    : corps;
  return sha256Hex(JSON.stringify(canonique(sansCle) ?? null));
}
