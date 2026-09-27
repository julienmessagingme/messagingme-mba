/**
 * Débit effectif d'un run de campagne : le rate de la campagne prime, à défaut le défaut serveur, plafonné par
 * le canal. `<= 0` signifie « aucun frein » ; un `stored <= 0` est traité comme non posé.
 *
 * Point unique pour le throttle réel (run-job) et l'estimation de durée (campaignJobExpireSeconds) : résolus
 * séparément, ils se désalignent, l'expiration est sous-dimensionnée et pg-boss rejoue le job en parallèle.
 */
export function resolveRatePerMinute(stored: number | null, serverDefault: number, plafond: number): number {
  const voulu = stored && stored > 0 ? stored : (serverDefault > 0 ? serverDefault : 0);
  // `0` veut dire « aucun frein », pas « débit de zéro » : le plafond ne doit pas transformer un opt-out explicite
  // en cadence. Même convention pour le plafond : <= 0 = aucun plafond.
  if (voulu <= 0 || plafond <= 0) return voulu;
  return Math.min(voulu, plafond);
}

/**
 * « Aucun plafond », à passer quand le canal n'entre pas en jeu (estimation pure, test). Nommé plutôt
 * qu'optionnel : chaque appelant doit dire quel plafond s'applique, un paramètre optionnel se serait fait
 * oublier en compilant quand même.
 */
export const SANS_PLAFOND = 0;

/**
 * Le plafond de débit du canal, en messages par minute. `PHONE_RATE_PER_MINUTE_MAX` est la tolérance de Meta
 * pour un numéro WhatsApp ; une campagne RCS ne passe par aucun numéro Meta et a son propre plafond.
 *
 * Un canal absent est du WhatsApp (`campaigns.channel` vaut `'whatsapp'` par défaut). La configuration est
 * passée en paramètre : ce module est pur, testable sans environnement.
 */
export function plafondDuCanal(
  canal: 'whatsapp' | 'rcs' | undefined,
  config: { PHONE_RATE_PER_MINUTE_MAX: number; RCS_RATE_PER_MINUTE_MAX: number },
): number {
  return canal === 'rcs' ? config.RCS_RATE_PER_MINUTE_MAX : config.PHONE_RATE_PER_MINUTE_MAX;
}

/**
 * Plafond dur de l'expiration d'un job. pg-boss refuse toute expiration atteignant 24 h (assert strict, 86400
 * pile échoue aussi) : sans ce plafond, l'enfilement lève et la campagne ne part jamais (500 en lancement
 * immédiat, `scheduled` retentée à vie en programmé). 23 h laisse une heure de marge.
 *
 * Contrepartie : un run réel de plus de 23 h expire pendant qu'il envoie, et pg-boss le rejoue en parallèle.
 * Le claim atomique empêche le double envoi, mais le débit double pendant le chevauchement. On préfère ce
 * risque, borné aux très grosses campagnes à très bas débit, à une campagne qui ne part jamais.
 */
const MAX_EXPIRE_SEC = 23 * 3600;

/**
 * Dimensionnement du timeout (expireInSeconds) d'un job `campaign-run`.
 *
 * Un run throttlé tourne séquentiellement dans un seul job. S'il dépasse son expiration, pg-boss le rejoue en
 * parallèle : le débit réel double et un run peut marquer la campagne `completed` pendant que l'autre envoie.
 * On dimensionne donc sur le travail réel (destinataires / débit, plus marge), généreux par construction.
 *
 * `resolvedRatePerMinute` doit être le débit résolu (`resolveRatePerMinute`), pas le rate brut de la campagne.
 */
export function campaignJobExpireSeconds(recipientCount: number, resolvedRatePerMinute: number | null): number {
  const n = Math.max(0, Math.floor(recipientCount));
  // Rate <= 0 = opt-out, le run part au maximum : on estime avec un plancher prudent de 30/min. Le plancher ne
  // s'applique qu'à l'opt-out, jamais par-dessus un débit positif plus lent.
  const effectiveRate = resolvedRatePerMinute && resolvedRatePerMinute > 0 ? resolvedRatePerMinute : 30;
  const durationSec = Math.ceil((n / effectiveRate) * 60);
  // Plancher 15 min (petites campagnes) ; sinon 1,5x la durée estimée + 10 min de marge, plafonné à 23 h.
  return Math.min(MAX_EXPIRE_SEC, Math.max(900, Math.ceil(durationSec * 1.5) + 600));
}

/**
 * Le plus bas des plafonds de canal, pour les appelants qui ne connaissent pas le canal.
 *
 * Réservé à l'estimation de durée, jamais au frein réel (posé par `run-job`, qui lit le canal). Une expiration
 * calculée sur un débit trop haut est trop courte et provoque un rejeu parallèle ; sur un débit plus bas, elle
 * est seulement plus longue. On choisit l'erreur qui ne casse rien.
 */
export function plafondLePlusBas(
  config: { PHONE_RATE_PER_MINUTE_MAX: number; RCS_RATE_PER_MINUTE_MAX: number },
): number {
  return Math.min(config.PHONE_RATE_PER_MINUTE_MAX, config.RCS_RATE_PER_MINUTE_MAX);
}
