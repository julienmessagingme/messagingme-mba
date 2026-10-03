import type { LatenceHttpRow } from './api';

/**
 * La lecture de la latence HTTP par route sur `/ops` : ce qui passe en rouge, et dans quel ordre. À part du composant
 * pour se tester sans navigateur.
 */

/**
 * Le haut de la fourchette de l'audit du 2026-10-02 (p95 de l'Inbox au-delà de 500 à 800 ms). 800 est une borne de
 * tranche du serveur (`BORNES_LATENCE_MS`), donc la comparaison est exacte.
 */
export const SEUIL_P95_MS = 800;

/** Un p95 sur trois requêtes ne veut rien dire : en dessous, ni rouge ni tête de liste. */
export const EFFECTIF_MIN = 20;

/** Les autres routes sont nombreuses : les plus lentes seulement, et le compte de ce qui ne s'affiche pas. */
export const AUTRES_MAX = 15;

/** Une requête abandonnée par le client avant sa réponse (`CODE_ABANDON` côté serveur). */
export const CODE_ABANDON = 499;

/**
 * Une route qui DOIT être rapide : tout webhook entrant (un tiers attend l'accusé), et les lectures de l'Inbox. Pas
 * ses écritures ni ses médias, lents par nature (envoi chez Meta, traduction ou transcription par un modèle,
 * téléchargement d'un média), qui crieraient au loup sans que le serveur soit en cause.
 */
export function doitEtreRapide(l: LatenceHttpRow): boolean {
  if (l.groupe === 'webhooks') return true;
  return l.groupe === 'inbox' && l.methode === 'GET' && !l.route.endsWith('/media');
}

export function enAlerte(l: LatenceHttpRow): boolean {
  return doitEtreRapide(l) && l.requetes >= EFFECTIF_MIN && (l.p95Ms ?? 0) > SEUIL_P95_MS;
}

export interface GroupeAffiche {
  cle: LatenceHttpRow['groupe'];
  lignes: LatenceHttpRow[];
  /** Les lignes du groupe qui ne s'affichent pas (les autres routes au-delà de `AUTRES_MAX`). */
  cachees: number;
  requetes: number;
  erreurs: number;
  abandons: number;
}

const ORDRE: LatenceHttpRow['groupe'][] = ['webhooks', 'inbox', 'v1', 'autres'];

/**
 * Les groupes dans l'ordre de l'audit, vides retirés. Dans chacun : d'abord les lignes qui ont l'effectif pour qu'un
 * p95 compte, la plus lente en tête, puis les autres.
 */
export function ordonnerLatences(lignes: LatenceHttpRow[]): GroupeAffiche[] {
  const significative = (l: LatenceHttpRow): number => (l.requetes >= EFFECTIF_MIN ? 0 : 1);
  const ordre = (a: LatenceHttpRow, b: LatenceHttpRow): number =>
    significative(a) - significative(b) || (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || b.requetes - a.requetes;
  return ORDRE.flatMap((cle) => {
    const toutes = lignes.filter((l) => l.groupe === cle).sort(ordre);
    if (toutes.length === 0) return [];
    const montrees = cle === 'autres' ? toutes.slice(0, AUTRES_MAX) : toutes;
    const somme = (garder: (l: LatenceHttpRow) => boolean): number => toutes.filter(garder).reduce((n, l) => n + l.requetes, 0);
    return [{
      cle,
      lignes: montrees,
      cachees: toutes.length - montrees.length,
      requetes: somme(() => true),
      erreurs: somme((l) => l.code >= 500),
      abandons: somme((l) => l.code === CODE_ABANDON),
    }];
  });
}
