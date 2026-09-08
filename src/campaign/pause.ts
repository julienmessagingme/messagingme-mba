import type { RaisonDePause } from '../meta/errors';

/**
 * Pourquoi une campagne est en pause.
 *
 * Les deux premiers motifs viennent de META (`RaisonDePause` : un plafond de cadence, ou une qualité de
 * numéro dégradée). Le troisième est LE NÔTRE : la fenêtre d'envoi que le client a réglée s'est refermée.
 *
 * ⚠️ Il n'entre PAS dans `RaisonDePause`, et c'est voulu : ce type-là répond à « quel plafond Meta avons-nous
 * touché ? », il est dérivé d'une erreur Meta (`raisonDePause(err)`). Y glisser un motif qu'aucune erreur ne
 * produit rendrait cette dérivation fausse pour tout lecteur.
 */
export type MotifDePause = RaisonDePause | 'hors_horaires';

/**
 * QUAND une campagne mise en pause par un plafond Meta peut être reprise.
 *
 * Fonction PURE et à part, parce que c'est ici que se joue la seule décision délicate du lot : combien de
 * temps attendre. Trop court, on retape sur un plafond qui n'est pas retombé et on aggrave la note du
 * numéro ; trop long, une campagne dort une heure pour rien.
 */

/** Bornes du délai de reprise. Meta peut envoyer un `Retry-After` fantaisiste, dans les deux sens. */
export const REPRISE_MIN_MS = 60_000;
export const REPRISE_MAX_MS = 60 * 60_000;
/** Sans `Retry-After`, Meta ne dit rien : quinze minutes est un compromis, ni du harcèlement ni de l'oubli. */
export const REPRISE_DEFAUT_MS = 15 * 60_000;

/**
 * L'instant de reprise, ou `null` quand il ne doit PAS y en avoir.
 *
 * 🔴 `null` pour la qualité, toujours. Meta juge alors le numéro, pas la cadence : relancer sans rien changer
 * aggrave le problème et peut coûter le numéro. C'est une décision humaine, et la rendre automatique serait
 * confondre « la limite va retomber » avec « le problème va se régler ».
 *
 * Pour le débit, on suit le `Retry-After` de Meta quand il existe, parce que c'est lui qui sait. On le BORNE
 * quand même : un en-tête absurde (deux secondes, ou douze heures) ne doit pas décider seul du comportement
 * d'une campagne.
 */
export function instantDeReprise(
  raison: RaisonDePause,
  retryAfterMs: number | undefined,
  maintenant: number,
): Date | null {
  if (raison === 'qualite') return null;
  const brut = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : REPRISE_DEFAUT_MS;
  return new Date(maintenant + Math.min(Math.max(brut, REPRISE_MIN_MS), REPRISE_MAX_MS));
}

/** Ce que l'opérateur lit à l'écran. Le message DIT si la reprise est automatique, parce que c'est la seule
 *  chose qu'il ait besoin de savoir pour décider s'il doit revenir. */
export function messageDePause(raison: MotifDePause, reprise: Date | null, code: number | undefined): string {
  if (raison === 'hors_horaires') {
    // Ni Meta ni un incident : le client l'a demandé. Le message doit le DIRE, sinon une campagne en pause
    // ressemble à une panne et l'opérateur va cliquer « Reprendre » contre sa propre consigne.
    return reprise
      ? `Hors des heures d'ouverture : l'envoi est suspendu, aucun destinataire perdu. Reprise automatique prévue vers ${reprise.toISOString()}.`
      : `Hors des heures d'ouverture : l'envoi est suspendu, aucun destinataire perdu. Aucun jour d'ouverture n'est réglé dans l'onglet Paramètres, `
        + `donc AUCUNE reprise automatique n'est possible : réglez les horaires, ou relancez la campagne à la main.`;
  }
  const quoi = `plafond Meta atteint sur le numéro${code !== undefined ? ` (${code})` : ''}`;
  if (raison === 'qualite') {
    return `${quoi} : Meta signale une qualité dégradée. Campagne mise en pause, aucun destinataire perdu. `
      + `La reprise n'est PAS automatique : vérifiez la qualité du numéro avant de relancer.`;
  }
  return `${quoi} : campagne mise en pause, aucun destinataire perdu. `
    + `Reprise automatique prévue${reprise ? ` vers ${reprise.toISOString()}` : ''}.`;
}
