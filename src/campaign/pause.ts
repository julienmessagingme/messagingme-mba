import type { RaisonDePause } from '../meta/errors';

/**
 * Pourquoi une campagne est en pause. `debit` et `qualite` viennent de Meta (`RaisonDePause`) ;
 * `hors_horaires` (la fenêtre d'envoi du client s'est refermée) et `numero_delie` (un administrateur a délié
 * le numéro) sont les nôtres.
 *
 * Les nôtres n'entrent pas dans `RaisonDePause`, qui se dérive d'une erreur Meta (`raisonDePause(err)`).
 * `numero_delie` n'a jamais d'échéance : seul le geste « Relier » le lève, le balayage de reprise ne le voit
 * pas (`reprendreCampagnesDues`, index `campaigns_reprise_idx`).
 */
export type MotifDePause = RaisonDePause | 'hors_horaires' | 'numero_delie' | 'numero_suspendu';

/**
 * Tous les motifs, tenus par le compilateur. Le CHECK `campaigns_pause_reason_check` doit les porter tous
 * (un test le vérifie) : un motif refusé par la base ferait échouer la mise en pause en pleine campagne.
 */
const MOTIFS: Record<MotifDePause, true> = { debit: true, qualite: true, hors_horaires: true, numero_delie: true, numero_suspendu: true };
export const MOTIFS_DE_PAUSE = Object.keys(MOTIFS) as MotifDePause[];

/**
 * Quand une campagne mise en pause par un plafond Meta peut être reprise. Trop tôt, on retape sur un plafond
 * pas retombé et on aggrave la note du numéro ; trop tard, la campagne dort pour rien.
 */

/** Bornes du délai de reprise. Meta peut envoyer un `Retry-After` fantaisiste, dans les deux sens. */
export const REPRISE_MIN_MS = 60_000;
export const REPRISE_MAX_MS = 60 * 60_000;
/** Sans `Retry-After`, Meta ne dit rien : quinze minutes est un compromis, ni du harcèlement ni de l'oubli. */
export const REPRISE_DEFAUT_MS = 15 * 60_000;

/**
 * L'instant de reprise, ou `null` quand il ne doit pas y en avoir.
 *
 * Toujours `null` pour la qualité : Meta juge le numéro, relancer sans rien changer peut le coûter, la décision
 * reste humaine. Pour le débit, on suit le `Retry-After` de Meta, borné contre un en-tête absurde.
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

/** Ce que l'opérateur lit à l'écran. Le message dit si la reprise est automatique : c'est ce qui lui dit
 *  s'il doit revenir. */
export function messageDePause(raison: MotifDePause, reprise: Date | null, code: number | undefined): string {
  if (raison === 'numero_delie') {
    // Dire qui peut la relancer, sinon « Reprendre » la remet aussitôt en pause sans qu'on comprenne pourquoi.
    // Pas « aucun destinataire perdu » : un étage « message et scénario » a pu envoyer son message sans
    // démarrer le scénario. La phrase dit ce qui attend, rien de plus.
    return 'Numéro WhatsApp délié de cet espace : campagne mise en pause. Les destinataires qui n’avaient encore rien reçu '
      + 'restent en attente, et elle reprendra quand un administrateur reliera le numéro depuis l’Accueil.';
  }
  if (raison === 'numero_suspendu') {
    // Lot 4 : la campagne reprend d'elle-même au paiement, personne n'a à la relancer.
    return 'Abonnement du numéro WhatsApp impayé ou terminé : campagne mise en pause. Les destinataires qui n’avaient encore '
      + 'rien reçu restent en attente, et elle reprendra d’elle-même dès que l’abonnement sera renouvelé.';
  }
  if (raison === 'hors_horaires') {
    // Le client l'a demandé : le dire, sinon la pause ressemble à une panne et l'opérateur relance contre sa
    // propre consigne.
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
