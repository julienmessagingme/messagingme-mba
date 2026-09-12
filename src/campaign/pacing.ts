/**
 * Débit EFFECTIF d'un run de campagne : le rate posé sur la campagne prime ; à défaut, le défaut serveur.
 * Renvoie un nombre où <= 0 signifie « aucun frein » (opt-out). Un `stored` <= 0 est traité comme non posé.
 *
 * Utilisé aux DEUX endroits qui doivent voir le MÊME débit : le throttle réel (run-job) et l'estimation de
 * durée (campaignJobExpireSeconds). Les résoudre séparément désaligne pacing et run-job -> expireInSeconds
 * sous-dimensionné pour un défaut < 30 -> pg-boss rejoue le job en parallèle. D'où ce point unique.
 */
export function resolveRatePerMinute(stored: number | null, serverDefault: number, plafond: number): number {
  const voulu = stored && stored > 0 ? stored : (serverDefault > 0 ? serverDefault : 0);
  // ⚠️ `0` VEUT DIRE « AUCUN FREIN », PAS « DÉBIT DE ZÉRO », et le plafond ne doit donc pas le réveiller :
  // le plafonner à 60 transformerait un opt-out explicite (celui qui sert à reproduire un incident) en une
  // cadence de 60/min. Même convention pour le plafond lui-même : <= 0 = aucun plafond.
  if (voulu <= 0 || plafond <= 0) return voulu;
  return Math.min(voulu, plafond);
}

/**
 * « Aucun plafond », à passer quand le canal n'entre pas en jeu (estimation pure, test de résolution).
 *
 * 🔴 IL EST NOMMÉ PLUTÔT QUE D'ÊTRE UN TROISIÈME PARAMÈTRE OPTIONNEL, et la différence n'est pas
 * cosmétique : un paramètre optionnel se serait fait oublier sur les six appels existants, qui auraient
 * continué à compiler en ne plafonnant rien. C'est le défaut exact que le dépôt a déjà payé (« une flèche
 * à deux paramètres est assignable à un contrat qui en déclare trois, et le troisième est avalé en
 * silence »). Obligatoire, chaque appelant doit DIRE quel plafond s'applique, quitte à dire « aucun ».
 */
export const SANS_PLAFOND = 0;

/**
 * Le plafond de débit du canal, en messages par minute.
 *
 * 🔴 C'EST LE DÉFAUT QUE CE LOT CORRIGE : `PHONE_RATE_PER_MINUTE_MAX` vaut 80 parce que c'est ce que Meta
 * tolère pour un NUMÉRO WhatsApp, et une campagne RCS ne passe par aucun numéro Meta. Faire tenir la
 * cadence d'un canal par la contrainte d'un autre a deux effets, tous deux invisibles : le RCS est bridé
 * par une limite qui ne le concerne pas, et le jour où l'un des deux chiffres bouge, l'autre bouge avec.
 *
 * ⚠️ Un canal ABSENT est du WhatsApp : `campaigns.channel` est `not null default 'whatsapp'` (migration
 * 0056) et `Campaign.channel` est optionnel côté type. Les deux lectures doivent dire la même chose.
 *
 * ⚠️ Il prend la CONFIGURATION en paramètre plutôt que de l'importer : `pacing.ts` est un module pur,
 * utilisé par des tests qui n'ont pas d'environnement, et c'est ce qui permet d'exercer les deux plafonds
 * avec des valeurs choisies au lieu de celles de la machine.
 */
export function plafondDuCanal(
  canal: 'whatsapp' | 'rcs' | undefined,
  config: { PHONE_RATE_PER_MINUTE_MAX: number; RCS_RATE_PER_MINUTE_MAX: number },
): number {
  return canal === 'rcs' ? config.RCS_RATE_PER_MINUTE_MAX : config.PHONE_RATE_PER_MINUTE_MAX;
}

/**
 * Plafond DUR de l'expiration d'un job. pg-boss refuse toute expiration ATTEIGNANT 24 h, et l'assert est
 * STRICT (`expireInSeconds / 60 / 60 < 24`, pg-boss/dist/attorney.js:403) : 86400 pile échoue aussi. Sans ce
 * plafond, l'enfilement LÈVE et la campagne ne part JAMAIS. En lancement immédiat c'est un 500 que Cloudflare
 * remplace par sa page d'erreur ; en programmé, le balayage attrape par campagne et se contente d'un log, donc
 * la campagne reste `scheduled` et se retente toutes les 60 s À VIE. Seuils réels : 954 destinataires à 1/min,
 * 4767 à 5/min, 28600 à 30/min. 23 h et non 86399 s : une valeur ronde, une heure de marge sous l'assert, et
 * le plafond reste vrai si une version de pg-boss rendait la comparaison inclusive.
 *
 * CONTREPARTIE ASSUMÉE : un run dont la durée RÉELLE dépasse 23 h (au-delà d'environ 1380 x débit
 * destinataires) expire pendant qu'il envoie encore, et pg-boss le rejoue en parallèle du run vivant. Le claim
 * atomique par destinataire (store.pg.ts:761) empêche le double envoi, mais chaque run a son propre limiteur
 * (run-job.ts:84) : le débit réel double pendant le chevauchement. On préfère ce risque, borné aux très
 * grosses campagnes à débit très bas, à une campagne qui ne part jamais. Le vrai remède est le découpage du
 * run en tranches, c'est un autre chantier.
 */
const MAX_EXPIRE_SEC = 23 * 3600;

/**
 * Dimensionnement du timeout (expireInSeconds) d'un job `campaign-run`.
 *
 * Un run de campagne throttlé (débit ajustable) tourne EN LIGNE, séquentiellement, dans un seul job pg-boss.
 * Si le job dépasse son `expireInSeconds`, pg-boss le considère expiré et le REJOUE en parallèle -> deux runs
 * de la MÊME campagne tournent en même temps : le débit réel double (défait le slider bas, risque réputation
 * du numéro) et un run peut marquer la campagne `completed` alors que l'autre envoie encore. Un timeout FIXE
 * ne suffit pas (7200 s ne couvre que ~120 destinataires à 1/min). On dimensionne donc le timeout PAR JOB sur
 * le travail réel : durée estimée = destinataires / débit, + marge. Généreux par construction (jamais
 * sous-dimensionné = jamais de rejeu parasite) ; le claim atomique reste le garde anti-double-envoi.
 *
 * ⚠️ `resolvedRatePerMinute` DOIT être le débit résolu (resolveRatePerMinute), pas le rate brut de la
 * campagne : sinon un défaut serveur < 30 ferait tourner run-job plus lentement que ce que pacing estime.
 */
export function campaignJobExpireSeconds(recipientCount: number, resolvedRatePerMinute: number | null): number {
  const n = Math.max(0, Math.floor(recipientCount));
  // Rate résolu <= 0 = opt-out (aucun throttle) : le run part au max (latence Meta), on prend un PLANCHER
  // prudent de 30/min pour l'estimation, ce qui donne un timeout généreux même si Meta nous ralentit. Le
  // plancher ne s'applique QU'À l'opt-out, jamais par-dessus un débit positif < 30 (qui, lui, est plus lent).
  const effectiveRate = resolvedRatePerMinute && resolvedRatePerMinute > 0 ? resolvedRatePerMinute : 30;
  const durationSec = Math.ceil((n / effectiveRate) * 60);
  // Plancher 15 min (petites campagnes) ; sinon 1,5x la durée estimée + 10 min de marge, plafonné à 23 h.
  return Math.min(MAX_EXPIRE_SEC, Math.max(900, Math.ceil(durationSec * 1.5) + 600));
}

/**
 * Le plus BAS des plafonds de canal, pour les appelants qui ne savent pas de quel canal ils parlent.
 *
 * 🔴 IL EST RÉSERVÉ À L'ESTIMATION DE DURÉE, JAMAIS AU FREIN RÉEL, et la raison tient en une asymétrie.
 * Un `expireInSeconds` dimensionné sur un débit PLUS ÉLEVÉ que le débit réel est trop court : le job
 * expire pendant qu'il envoie encore, pg-boss le rejoue, deux runs de la même campagne tournent, chacun
 * avec SON limiteur, et le débit réel double. Dimensionné sur un débit plus BAS, il est simplement plus
 * long que nécessaire, ce qui ne coûte qu'un retard de reprise sur un run réellement bloqué. Ce module
 * choisit donc l'erreur qui ne casse rien, comme il le fait déjà avec son plancher de 30 et son
 * coefficient de 1,5.
 *
 * ⚠️ CE N'EST PAS UN CONTOURNEMENT DE L'IGNORANCE DU CANAL, c'est une borne sûre quel qu'il soit. Le
 * VRAI plafond, celui qui bride l'envoi, est posé dans `run-job.ts`, qui lit `campaign.channel` sur la
 * campagne qu'il est en train d'exécuter et n'a donc rien à deviner.
 */
export function plafondLePlusBas(
  config: { PHONE_RATE_PER_MINUTE_MAX: number; RCS_RATE_PER_MINUTE_MAX: number },
): number {
  return Math.min(config.PHONE_RATE_PER_MINUTE_MAX, config.RCS_RATE_PER_MINUTE_MAX);
}
