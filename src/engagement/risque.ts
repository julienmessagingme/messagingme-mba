/**
 * LE RISQUE DE DÉSENGAGEMENT D'UN CONTACT (spec du 2026-09-24, § 19, cadrée avec Julien le 2026-09-25).
 *
 * Ce n'est pas un « churn rate » (un taux sur une base entière, que seul le CRM du client connaît) : c'est, pour
 * UNE fiche, un risque de partir, tiré des signaux conversationnels qui précèdent le départ. Des RÈGLES
 * TRANSPARENTES, pas un modèle appris : aucune issue réelle ne permet de calibrer un modèle (mesuré le
 * 2026-09-25, la production porte 18 contacts dont 4 sollicités sur 90 jours).
 *
 * 🔴 MODULE PUR : aucune lecture, aucune horloge. Les faits arrivent tout faits (`src/engagement/risque.pg.ts`),
 * la date du calcul aussi, et les seuils se passent en paramètre POUR LES TESTS (l'essai réel ne peut pas
 * attendre 30 jours de silence). La production n'en passe jamais : `SEUILS_PAR_DEFAUT`.
 *
 * ⚠️ LIMITE ASSUMÉE DE LA V1 (spec § 19) : la livraison et la lecture ne se mesurent que sur les envois de
 * CAMPAGNE, seuls à porter un statut par destinataire. Un message libre ou un bloc de scénario ne compte que par
 * la réponse qu'il reçoit.
 */

export const NIVEAUX_RISQUE = ['inconnu', 'faible', 'moyen', 'eleve'] as const;
export type NiveauRisque = (typeof NIVEAUX_RISQUE)[number];

/**
 * Les codes des raisons, courts et stables : ils partent tels quels chez l'outil du client (`em_risk_reasons`) et
 * dans l'API publique (`engagementRisk.reasons`), et la console les traduit. Ce sont des IDENTIFIANTS.
 */
export const RAISONS_RISQUE = [
  'stop', 'bloque', 'silence_60j', 'silence_30j', 'sans_reponse', 'non_lu', 'reclamation', 'negatif', 'insatisfait', 'injoignable',
] as const;
export type RaisonRisque = (typeof RAISONS_RISQUE)[number];

/**
 * LA GRILLE, validée telle quelle par Julien le 2026-09-25. L'ORDRE DES CLÉS EST CELUI DE LA SPEC, et il sert :
 * à points égaux, une raison plus haute dans la grille passe devant (`raisonsLesPlusLourdes`).
 *
 * `stop` et `bloque` n'y sont pas : ils ne s'ajoutent pas, ils donnent 100 d'office.
 */
export const GRILLE_RISQUE = {
  silence_60j: 40,
  silence_30j: 25,
  sans_reponse: 15,
  non_lu: 15,
  reclamation: 20,
  negatif: 10,
  insatisfait: 10,
  injoignable: 10,
} as const satisfies Record<Exclude<RaisonRisque, 'stop' | 'bloque'>, number>;

/** A répondu ou cliqué récemment : ces points se RETIRENT, plancher 0. */
export const ALLEGEMENT_POINTS = 25;
export const SCORE_MAX = 100;
/** `faible` de 0 à 29, `moyen` de 30 à 59, `eleve` de 60 à 100. */
export const SEUIL_MOYEN = 30;
export const SEUIL_ELEVE = 60;
/** « Les 3 derniers messages délivrés » (`sans_reponse`, `non_lu`). */
export const DERNIERS_DELIVRES = 3;
/** Une satisfaction de 3 sur 10 ou moins. */
export const SATISFACTION_BASSE = 3;
/** Un silence ne se juge qu'après au moins deux messages délivrés restés sans signe de vie. */
export const MIN_DELIVRES_SILENCE = 2;
/** Les trois contributions les plus lourdes (un texte de 300 caractères au plus chez l'outil). */
export const MAX_RAISONS = 3;

export interface SeuilsRisque {
  /** La fenêtre d'observation, en jours : rien de plus ancien ne compte. */
  fenetreJours: number;
  /** « Aucun signe de vie depuis plus de N jours » : `silence_30j`. */
  silenceJours: number;
  /** Idem, le plus fort : `silence_60j`. */
  silenceFortJours: number;
  /** « A répondu ou cliqué dans les N derniers jours » : l'allègement. */
  allegementJours: number;
}

export const SEUILS_PAR_DEFAUT: Readonly<SeuilsRisque> = Object.freeze({
  fenetreJours: 90,
  silenceJours: 30,
  silenceFortJours: 60,
  allegementJours: 14,
});

const JOUR_MS = 86_400_000;

/** Le début de la fenêtre d'observation : la lecture en base et les règles bornent au MÊME instant. */
export function debutFenetre(maintenant: Date, seuils: SeuilsRisque = SEUILS_PAR_DEFAUT): Date {
  return new Date(maintenant.getTime() - seuils.fenetreJours * JOUR_MS);
}

/** Un message de campagne DÉLIVRÉ au contact (statut `delivered` ou `read`). */
export interface MessageDelivre {
  envoyeLe: Date;
  /** Meta (ou le fournisseur RCS) a renvoyé « lu ». */
  lu: boolean;
  /** Quand il a été lu, si on le sait. */
  luLe: Date | null;
}

/** La dernière conversation analysée du contact. `satisfaction` à `null` veut dire « pas de mesure », jamais 0. */
export interface AnalyseRisque {
  intent: string;
  sentiment: string;
  resolved: boolean;
  satisfaction: number | null;
  le: Date;
}

/** Tout ce que les règles lisent d'un contact. */
export interface FaitsRisque {
  /** STOP : le consentement WhatsApp retiré, ou un STOP dit sur le RCS. */
  desabonne: boolean;
  bloque: boolean;
  /** Les messages de campagne délivrés (dans n'importe quel ordre : les règles trient). */
  delivres: readonly MessageDelivre[];
  /** La dernière RÉPONSE (tout message entrant) ou le dernier CLIC attribué. La lecture n'en est pas une. */
  derniereReactionLe: Date | null;
  derniereAnalyse: AnalyseRisque | null;
  /** La joignabilité CONNUE sur chaque canal : `null` = inconnue, jamais « injoignable ». */
  joignableWhatsapp: boolean | null;
  joignableRcs: boolean | null;
}

export interface Risque {
  niveau: NiveauRisque;
  /** `null` pour `inconnu`, et seulement pour lui. */
  score: number | null;
  raisons: RaisonRisque[];
}

/** Le niveau d'un score MESURÉ. */
export function niveauDuScore(score: number): Exclude<NiveauRisque, 'inconnu'> {
  if (score >= SEUIL_ELEVE) return 'eleve';
  if (score >= SEUIL_MOYEN) return 'moyen';
  return 'faible';
}

const ORDRE_GRILLE = Object.keys(GRILLE_RISQUE) as Array<keyof typeof GRILLE_RISQUE>;

/** Les contributions les plus lourdes, à points égaux dans l'ordre de la grille, `MAX_RAISONS` au plus. */
function raisonsLesPlusLourdes(presentes: ReadonlyArray<keyof typeof GRILLE_RISQUE>): RaisonRisque[] {
  return [...presentes]
    .sort((a, b) => GRILLE_RISQUE[b] - GRILLE_RISQUE[a] || ORDRE_GRILLE.indexOf(a) - ORDRE_GRILLE.indexOf(b))
    .slice(0, MAX_RAISONS);
}

const plusTard = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a > b ? a : b);

/**
 * Le risque d'un contact, à l'instant `maintenant`.
 *
 * Les règles, dans l'ordre où elles s'appliquent :
 *
 * 1. 🔴 STOP ou blocage : `eleve` à 100, MÊME SANS HISTORIQUE. Ils ne s'additionnent pas, ils décident.
 * 2. 🔴 Aucun message délivré sur la fenêtre : `inconnu`, SANS score. On ne dit pas qu'un contact est fidèle ou
 *    perdu sans l'avoir observé ; un contact qu'on n'a jamais sollicité n'est pas « faible ».
 * 3. Le SIGNE DE VIE est la plus récente d'une réponse, d'un clic ou d'une lecture, sur la fenêtre.
 *    - Le SILENCE se compte depuis ce signe, ou, s'il n'y en a pas, depuis le premier message délivré de la
 *      fenêtre : c'est là que l'observation commence. Deux messages délivrés cette semaine sans réponse ne
 *      font pas « 60 jours de silence ».
 *    - Il ne compte qu'avec au moins deux messages délivrés APRÈS ce signe : un contact à qui l'on n'écrit plus
 *      depuis sa dernière réponse n'est pas silencieux, c'est nous qui le sommes.
 *    - `silence_60j` et `silence_30j` sont EXCLUSIFS : le plus fort s'applique.
 * 4. `sans_reponse` : les trois derniers délivrés, et ni réponse ni clic depuis le plus ancien des trois.
 * 5. 🔴 `non_lu` : les trois derniers délivrés, aucun lu, et SEULEMENT si le contact lit d'habitude (au moins
 *    un « lu » sur la fenêtre). Un contact qui répond sans jamais renvoyer « lu » a coupé ses accusés de
 *    lecture : la lecture ne dit rien de lui, et le pénaliser pour ça serait faux.
 * 6. La dernière analyse de la fenêtre : `reclamation` (réclamation NON résolue), `negatif`, `insatisfait`
 *    (3 sur 10 ou moins ; une note absente n'est pas une note basse).
 * 7. `injoignable` : un canal connu injoignable, et AUCUN canal connu joignable. Un contact joint en RCS après
 *    l'échec de son WhatsApp (chaîne de repli) a bien reçu le dernier envoi.
 * 8. L'allègement : une réponse ou un clic dans les derniers jours retire 25 points, plancher 0.
 * 9. Le total est plafonné à 100 ; les raisons sont les trois contributions les plus lourdes (l'allègement n'en
 *    est pas une). ⚠️ Plafond et plancher commutent : avec une réaction récente, aucun silence n'est possible,
 *    et le reste de la grille ne dépasse pas 80.
 */
export function calculerRisque(faits: FaitsRisque, maintenant: Date, seuils: SeuilsRisque = SEUILS_PAR_DEFAUT): Risque {
  if (faits.desabonne || faits.bloque) {
    const raisons: RaisonRisque[] = [];
    if (faits.desabonne) raisons.push('stop');
    if (faits.bloque) raisons.push('bloque');
    return { niveau: 'eleve', score: SCORE_MAX, raisons };
  }

  const debut = debutFenetre(maintenant, seuils).getTime();
  const fin = maintenant.getTime();
  const dansLaFenetre = (d: Date | null): Date | null => (d !== null && d.getTime() >= debut && d.getTime() <= fin ? d : null);
  // Du plus récent au plus ancien.
  const delivres = faits.delivres
    .filter((m) => dansLaFenetre(m.envoyeLe) !== null)
    .sort((a, b) => b.envoyeLe.getTime() - a.envoyeLe.getTime());
  if (delivres.length === 0) return { niveau: 'inconnu', score: null, raisons: [] };

  const reaction = dansLaFenetre(faits.derniereReactionLe);
  const lus = delivres.filter((m) => m.lu);
  const dernierLu = lus.reduce<Date | null>((acc, m) => plusTard(acc, dansLaFenetre(m.luLe ?? m.envoyeLe)), null);
  const signe = plusTard(reaction, dernierLu);

  const presentes: Array<keyof typeof GRILLE_RISQUE> = [];

  // 3. Le silence.
  const sansSigne = signe === null ? delivres : delivres.filter((m) => m.envoyeLe > signe);
  if (sansSigne.length >= MIN_DELIVRES_SILENCE) {
    const premier = delivres[delivres.length - 1]!.envoyeLe;
    const repere = signe ?? premier;
    const jours = (fin - repere.getTime()) / JOUR_MS;
    if (jours > seuils.silenceFortJours) presentes.push('silence_60j');
    else if (jours > seuils.silenceJours) presentes.push('silence_30j');
  }

  // 4 et 5. Les trois derniers délivrés.
  const trois = delivres.slice(0, DERNIERS_DELIVRES);
  if (trois.length === DERNIERS_DELIVRES) {
    const plusAncien = trois[DERNIERS_DELIVRES - 1]!.envoyeLe;
    if (reaction === null || reaction <= plusAncien) presentes.push('sans_reponse');
    if (lus.length > 0 && trois.every((m) => !m.lu)) presentes.push('non_lu');
  }

  // 6. La dernière analyse de la fenêtre.
  const analyse = faits.derniereAnalyse !== null && dansLaFenetre(faits.derniereAnalyse.le) !== null ? faits.derniereAnalyse : null;
  if (analyse !== null) {
    if (analyse.intent === 'reclamation' && !analyse.resolved) presentes.push('reclamation');
    if (analyse.sentiment === 'negatif') presentes.push('negatif');
    if (analyse.satisfaction !== null && analyse.satisfaction <= SATISFACTION_BASSE) presentes.push('insatisfait');
  }

  // 7. La joignabilité.
  const unInjoignable = faits.joignableWhatsapp === false || faits.joignableRcs === false;
  const unJoignable = faits.joignableWhatsapp === true || faits.joignableRcs === true;
  if (unInjoignable && !unJoignable) presentes.push('injoignable');

  // 8 et 9.
  const brut = presentes.reduce((s, r) => s + GRILLE_RISQUE[r], 0);
  const allege = reaction !== null && fin - reaction.getTime() <= seuils.allegementJours * JOUR_MS ? ALLEGEMENT_POINTS : 0;
  const score = Math.min(SCORE_MAX, Math.max(0, brut - allege));
  return { niveau: niveauDuScore(score), score, raisons: raisonsLesPlusLourdes(presentes) };
}

/**
 * Un contact PASSE-t-il en élevé ? C'est la seule transition qui déclenche une automation.
 *
 * ⚠️ `ancien` à `null` (jamais calculé) compte comme un passage : c'est le cas d'une fiche calculée pour la
 * première fois. Rester en élevé n'en est pas un, et c'est ce qui borne le déclencheur à UNE fois par passage.
 */
export function passeEnEleve(ancien: NiveauRisque | null, nouveau: NiveauRisque): boolean {
  return nouveau === 'eleve' && ancien !== 'eleve';
}
