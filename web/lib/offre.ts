/**
 * L'OFFRE DE L'ESPACE, CÔTÉ CONSOLE (lot 6, tâche 7).
 *
 * 🔴 LES VALEURS DE LA GRILLE NE SONT JAMAIS RECOPIÉES ICI : elles arrivent par `GET /tenants/:tenantId/offre`
 * (`src/offres/vue.ts`), grille des trois offres comprise. Seuls les NOMS sont recopiés (des fonctions, des offres et des
 * limites), parce que la console ne peut pas importer le serveur ; leur parité est tenue par
 * `tests/offres-console-parite.test.ts`.
 *
 * ⚠️ C'EST UN CONFORT, PAS UN CONTRÔLE : la barrière est l'étape d'offre du serveur (statut 402). Griser un menu évite
 * seulement d'ouvrir un écran dont chaque geste serait refusé.
 */

export const FONCTIONS_OFFRE = [
  'inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines',
  'crm', 'rcs', 'performance_lab', 'console',
] as const;
export type FonctionOffre = (typeof FONCTIONS_OFFRE)[number];

/**
 * Les noms PUBLICS (`offrePublique`, `src/offres/vue.ts`) : l'offre gratuite s'appelle `free` depuis le 2026-10-08. Une
 * API d'avant ce renommage rend encore `base` : `lireVueOffre` le ramène à `free` (`NOM_D_AVANT`). Le Business (spec du
 * 2026-10-27) manque à la grille d'une API d'avant lui : sa ligne est alors absente (`GrilleOffre`), jamais illisible.
 */
export const NOMS_OFFRES = ['free', 'pro', 'business', 'entreprise'] as const;
export type NomOffre = (typeof NOMS_OFFRES)[number];

/** Les clés des limites (`Limites`, `src/offres/offres.ts`). `null` = sans limite. */
export const LIMITES_NOMBRE = [
  'utilisateurs', 'admins', 'contacts', 'envoisModelesMois', 'automations', 'suppressionsJour', 'adressesWebhook',
  'journalWebhooksJours',
] as const;
export type LimiteNombre = (typeof LIMITES_NOMBRE)[number];

/**
 * Les limites qu'une API plus ancienne ne porte pas encore : absentes, elles ne rendent pas la vue illisible (la console est
 * publiée avant l'API), la ligne est seulement masquée. Le quota de la médiathèque (spec médias du 2026-10-14) en est une,
 * comme toutes les limites de l'API (spec offres v2). 🔴 Une limite neuve va ICI, jamais dans `LIMITES_NOMBRE` : absente
 * d'une API plus ancienne, elle rendrait la vue illisible, donc tout ouvert, Free comprise.
 */
export const LIMITES_TOLERANTES = ['stockageOctets', 'clesApi', 'appelsMinute', 'appelsHeure', 'modelesJour', 'reponsesJour'] as const;
type LimiteTolerante = (typeof LIMITES_TOLERANTES)[number];

/**
 * 🔴 Sans la commission sur le crédit IA : la vue du serveur ne la montre plus (décision de Julien du 2026-10-27, « on ne
 * parle jamais de notre marge »). Une API d'avant la porte encore : elle est ignorée.
 */
export interface LimitesOffre extends Record<LimiteNombre, number | null>, Partial<Record<LimiteTolerante, number | null>> {
  conservationJours: number;
  badge: boolean;
  numeroInclus: boolean;
  /** En octets. `undefined` : une API qui ne le porte pas encore. */
  stockageOctets?: number | null;
  /** Les clés d'API actives que l'offre permet, `null` sans limite. `undefined` : une API qui ne le porte pas encore. */
  clesApi?: number | null;
}

/** Une ligne de la grille : ce qu'une offre ouvre et permet. */
export interface LigneOffre {
  fonctions: ReadonlySet<FonctionOffre>;
  limites: LimitesOffre;
}

/** La grille : le Business y manque sur une API d'avant lui (la console est publiée avant l'API). */
export type GrilleOffre = Record<Exclude<NomOffre, 'business'>, LigneOffre> & { business?: LigneOffre };

export interface UsageOffre {
  envoisModelesMois: number | null;
  contacts: number;
  automations: number;
  membres: number;
}

export interface VueOffre {
  offre: NomOffre;
  fonctions: ReadonlySet<FonctionOffre>;
  limites: LimitesOffre;
  usage: UsageOffre;
  /**
   * Ce que compte la limite de contacts, tel que le serveur le décide (`contactsToutesOrigines`, 2026-10-25) : vrai en Free,
   * où ceux qui écrivent les premiers comptent aussi. Faux sur une API plus ancienne, qui ne les comptait pas.
   */
  contactsToutesOrigines: boolean;
  /**
   * Les contacts comptés au-delà de la limite (2026-10-26), tels que le serveur les compte : ce qu'il faut supprimer pour
   * y revenir. 0 sous la limite, et sur une API plus ancienne qui ne le porte pas (la page n'en dit alors rien).
   */
  contactsEnTrop: number;
  grille: GrilleOffre;
  /** Les prix HT du Pro, en centimes (lot 6, B1). `null` : une API plus ancienne qui ne les porte pas encore. */
  prixPro: { moisCentimes: number; anCentimes: number } | null;
  /**
   * La suite du numéro fourni que le Pro annonce (lot 6, B2b) : la fin prévue du Pro (ISO, `null` sans fin) et le choix de
   * le rendre. `null` sans Pro vivant, sans numéro fourni, ou sur une API plus ancienne.
   */
  suiteDuNumero: { finPrevueLe: string | null; rendreNumero: boolean } | null;
  /**
   * L'essai du Pro (spec offres v2, livraison 6) : sa durée, s'il est possible, la fin de l'essai en cours (ISO). `null` sur
   * une API plus ancienne : la page ne parle alors pas d'essai.
   */
  essai: { jours: number; possible: boolean; finLe: string | null } | null;
  /**
   * Les sièges du Pro vivant (spec offres v2, livraison 7) : les utilisateurs inclus, ceux achetés en plus, la formule.
   * `null` hors Pro, ou sur une API plus ancienne.
   */
  sieges: { inclus: number; achetes: number; periodicite: 'mois' | 'an' } | null;
  /** Le prix HT d'un siège, en centimes ; `null` tant que les sièges ne sont pas en vente, ou sur une API plus ancienne. */
  prixSiege: { moisCentimes: number; anCentimes: number } | null;
  /**
   * L'abonnement Pro dit en clair (2026-10-26) : statut, souscription, renouvellement ou fin, essai, tels que le serveur les
   * calcule (`statutDuPro`, `src/offres/vue.ts`). `null` sans Pro, vivant ou fini, ou sur une API plus ancienne : la page
   * garde alors son ancien bloc d'abonnement.
   */
  abonnement: AbonnementPro | null;
  upgradeUrl: string;
}

export type StatutAbonnementPro = 'termine' | 'en_retard' | 'resiliation_programmee' | 'essai' | 'actif';

export interface AbonnementPro {
  statut: StatutAbonnementPro;
  periodicite: 'mois' | 'an';
  debutLe: string;
  prochaineEcheanceLe: string | null;
  finPrevueLe: string | null;
  essaiFinLe: string | null;
  finiLe: string | null;
  finRaison: 'resiliation' | 'impaye' | null;
}

type Objet = Record<string, unknown>;
const estObjet = (v: unknown): v is Objet => typeof v === 'object' && v !== null && !Array.isArray(v);
const entierOuNul = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
const entier = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const estFonction = (v: unknown): v is FonctionOffre => typeof v === 'string' && (FONCTIONS_OFFRE as readonly string[]).includes(v);
const estOffre = (v: unknown): v is NomOffre => typeof v === 'string' && (NOMS_OFFRES as readonly string[]).includes(v);
/** L'ancien nom de l'offre gratuite, rendu par une API d'avant le 2026-10-08 (la console est publiée avant l'API). */
const NOM_D_AVANT = 'base';
/** L'offre lue, l'ancien nom ramené au nouveau. */
const lireNom = (v: unknown): NomOffre | null => (v === NOM_D_AVANT ? 'free' : estOffre(v) ? v : null);

/** Une fonction inconnue (un serveur plus récent) est ignorée : elle n'a de toute façon aucun écran ici. */
function lireFonctions(v: unknown): ReadonlySet<FonctionOffre> | null {
  return Array.isArray(v) ? new Set(v.filter(estFonction)) : null;
}

function lireLimites(v: unknown): LimitesOffre | null {
  if (!estObjet(v)) return null;
  if (!LIMITES_NOMBRE.every((k) => entierOuNul(v[k]))) return null;
  if (!entier(v.conservationJours)) return null;
  if (typeof v.badge !== 'boolean' || typeof v.numeroInclus !== 'boolean') return null;
  return {
    ...(Object.fromEntries(LIMITES_NOMBRE.map((k) => [k, v[k]])) as Record<LimiteNombre, number | null>),
    conservationJours: v.conservationJours, badge: v.badge, numeroInclus: v.numeroInclus,
    ...Object.fromEntries(LIMITES_TOLERANTES.filter((k) => entierOuNul(v[k])).map((k) => [k, v[k]])),
  };
}

/**
 * La réponse du serveur, VÉRIFIÉE et non castée. `null` quand la forme n'y est pas : une API plus ancienne (la route
 * rend 404), un proxy, ou le repli `{}` des e2e. 🔴 `null` veut dire « offre inconnue », donc TOUT RESTE OUVERT : une
 * console qui grisait tout faute de savoir couperait un client Entreprise de ses écrans sur une simple panne.
 */
export function lireVueOffre(brut: unknown): VueOffre | null {
  if (!estObjet(brut)) return null;
  const offre = lireNom(brut.offre);
  if (offre === null || typeof brut.upgradeUrl !== 'string') return null;
  const fonctions = lireFonctions(brut.fonctions);
  const limites = lireLimites(brut.limites);
  if (fonctions === null || limites === null) return null;
  const u = brut.usage;
  if (!estObjet(u) || !entierOuNul(u.envoisModelesMois) || !entier(u.contacts) || !entier(u.automations) || !entier(u.membres)) return null;
  const g = brut.grille;
  if (!estObjet(g)) return null;
  const grille: Partial<Record<NomOffre, LigneOffre>> = {};
  for (const o of NOMS_OFFRES) {
    // Une API d'avant le Business n'a pas sa ligne : elle reste absente, la vue reste lisible (`GrilleOffre`).
    if (o === 'business' && g.business === undefined) continue;
    const ligne = o === 'free' && g.free === undefined ? g[NOM_D_AVANT] : g[o];
    if (!estObjet(ligne)) return null;
    const f = lireFonctions(ligne.fonctions);
    const l = lireLimites(ligne.limites);
    if (f === null || l === null) return null;
    grille[o] = { fonctions: f, limites: l };
  }
  const presentes = NOMS_OFFRES.filter((o) => grille[o] !== undefined);
  // 🔴 Une API qui ne connaît pas encore la fonction `console` (aucune offre de sa grille ne la porte) : la console est
  // publiée avant l'API, et sans cette parade elle se fermerait à tout le monde, Pro et Entreprise compris.
  const apiSansConsole = !presentes.some((o) => grille[o]!.fonctions.has('console'));
  const ouvrir = (f: ReadonlySet<FonctionOffre>): ReadonlySet<FonctionOffre> => (apiSansConsole ? new Set([...f, 'console' as const]) : f);
  for (const o of presentes) grille[o] = { ...grille[o]!, fonctions: ouvrir(grille[o]!.fonctions) };
  return {
    offre, fonctions: ouvrir(fonctions), limites,
    usage: { envoisModelesMois: u.envoisModelesMois, contacts: u.contacts, automations: u.automations, membres: u.membres },
    contactsToutesOrigines: brut.contactsToutesOrigines === true,
    contactsEnTrop: entier(brut.contactsEnTrop) ? brut.contactsEnTrop : 0,
    grille: grille as VueOffre['grille'],
    prixPro: lirePrixPro(brut.prixPro),
    suiteDuNumero: lireSuiteDuNumero(brut.suiteDuNumero),
    essai: lireEssai(brut.essai),
    sieges: lireSieges(brut.sieges),
    prixSiege: lirePrixPro(brut.prixSiege),
    abonnement: lireAbonnement(brut.abonnement),
    upgradeUrl: brut.upgradeUrl,
  };
}

const estPeriodicite = (v: unknown): v is 'mois' | 'an' => v === 'mois' || v === 'an';

const STATUTS_PRO: readonly StatutAbonnementPro[] = ['termine', 'en_retard', 'resiliation_programmee', 'essai', 'actif'];
const dateOuNulle = (v: unknown): v is string | null => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

/** Un abonnement absent ou illisible ne rend pas la vue illisible : la page garde son ancien bloc. */
function lireAbonnement(v: unknown): VueOffre['abonnement'] {
  if (!estObjet(v) || !(STATUTS_PRO as readonly unknown[]).includes(v.statut) || !estPeriodicite(v.periodicite)) return null;
  if (typeof v.debutLe !== 'string' || Number.isNaN(Date.parse(v.debutLe))) return null;
  if (![v.prochaineEcheanceLe, v.finPrevueLe, v.essaiFinLe, v.finiLe].every(dateOuNulle)) return null;
  if (v.finRaison !== null && v.finRaison !== 'resiliation' && v.finRaison !== 'impaye') return null;
  return {
    statut: v.statut as StatutAbonnementPro, periodicite: v.periodicite, debutLe: v.debutLe,
    prochaineEcheanceLe: v.prochaineEcheanceLe as string | null, finPrevueLe: v.finPrevueLe as string | null,
    essaiFinLe: v.essaiFinLe as string | null, finiLe: v.finiLe as string | null, finRaison: v.finRaison,
  };
}

/** Des sièges absents ou illisibles ne rendent pas la vue illisible : la page n'en parle pas. */
function lireSieges(v: unknown): VueOffre['sieges'] {
  if (!estObjet(v) || !entier(v.inclus) || !entier(v.achetes) || !estPeriodicite(v.periodicite)) return null;
  return { inclus: v.inclus, achetes: v.achetes, periodicite: v.periodicite };
}

/** Le siège qu'un refus d'invitation propose d'acheter (livraison 7) : le nombre visé, la formule et le prix HT. */
export interface SiegeRequis {
  cible: number;
  periodicite: 'mois' | 'an';
  prixHtCentimes: number;
}

/**
 * Le siège proposé par le 402 d'une invitation refusée à la limite d'utilisateurs d'un Pro ; `null` pour tout autre corps
 * (une Free, la limite d'administrateurs, des sièges pas en vente) : l'écran affiche alors la phrase du serveur seule.
 */
export function lireSiegeRequis(corps: unknown): SiegeRequis | null {
  if (!estObjet(corps) || corps.code !== 'plan_limit_reached' || corps.limite !== 'utilisateurs') return null;
  const s = corps.siege;
  if (!estObjet(s) || !entier(s.cible) || s.cible < 1 || !estPeriodicite(s.periodicite) || !entier(s.prixHtCentimes)) return null;
  return { cible: s.cible, periodicite: s.periodicite, prixHtCentimes: s.prixHtCentimes };
}

/** Un essai absent ou illisible ne rend pas la vue illisible : la page n'en parle pas. */
function lireEssai(v: unknown): VueOffre['essai'] {
  if (!estObjet(v) || !entier(v.jours) || typeof v.possible !== 'boolean') return null;
  if (v.finLe !== null && typeof v.finLe !== 'string') return null;
  return { jours: v.jours, possible: v.possible, finLe: v.finLe };
}

/** Une suite absente ou illisible ne rend pas la vue illisible : il n'y a rien à annoncer. */
function lireSuiteDuNumero(v: unknown): VueOffre['suiteDuNumero'] {
  if (!estObjet(v) || typeof v.rendreNumero !== 'boolean') return null;
  if (v.finPrevueLe !== null && typeof v.finPrevueLe !== 'string') return null;
  return { finPrevueLe: v.finPrevueLe, rendreNumero: v.rendreNumero };
}

/** Des prix illisibles ou absents ne rendent pas la vue illisible : ils sont inconnus. */
function lirePrixPro(v: unknown): VueOffre['prixPro'] {
  if (!estObjet(v) || !entier(v.moisCentimes) || !entier(v.anCentimes)) return null;
  return { moisCentimes: v.moisCentimes, anCentimes: v.anCentimes };
}

/** L'offre la moins chère de la grille qui ouvre cette fonction (« Pro », « Business »...), `null` si aucune. */
export function offreQuiOuvre(vue: VueOffre, f: FonctionOffre): NomOffre | null {
  return NOMS_OFFRES.find((o) => vue.grille[o]?.fonctions.has(f)) ?? null;
}

/** La raison d'un écran ou d'une carte fermés : « Inclus dans l'offre Pro. », d'après la grille du serveur. */
export function phraseInclusDans(vue: VueOffre, f: FonctionOffre, t: (fr: string, en: string) => string): string {
  const o = offreQuiOuvre(vue, f);
  return o
    ? t(`Inclus dans l’offre ${nomDeLOffre(o, t)}.`, `Included in the ${nomDeLOffre(o, t)} plan.`)
    : t('Pas dans votre offre.', 'Not in your plan.');
}

/** Le nom de l'offre, tel que l'écran le montre. */
export function nomDeLOffre(o: NomOffre, t: (fr: string, en: string) => string): string {
  return o === 'free' ? t('Free', 'Free') : o === 'pro' ? t('Pro', 'Pro') : o === 'business' ? t('Business', 'Business') : t('Entreprise', 'Enterprise');
}

/** Ce que la fonction ouvre, tel que l'écran le montre (la grille de `/offre`, la raison d'un menu grisé). */
export function libelleFonction(f: FonctionOffre, t: (fr: string, en: string) => string): string {
  const libelles: Record<FonctionOffre, [string, string]> = {
    inbox: ['Inbox', 'Inbox'],
    scenarios: ['Scénarios et formulaires', 'Scenarios and forms'],
    statistiques: ['Statistiques', 'Statistics'],
    agent_meta: ['Agent de Meta (MBA)', 'Meta agent (MBA)'],
    aide: ['Assistant d’aide', 'Help assistant'],
    assistants: ['Assistants de configuration', 'Setup assistants'],
    analyse: ['Analyse des conversations', 'Conversation analysis'],
    publicites: ['Publicités', 'Ads'],
    email: ['E-mail', 'Email'],
    chaines: ['Chaînes', 'Channels'],
    crm: ['Connecteurs CRM', 'CRM connectors'],
    rcs: ['RCS', 'RCS'],
    performance_lab: ['Performance Lab', 'Performance Lab'],
    console: ['Console complète', 'Full console'],
  };
  const [fr, en] = libelles[f];
  return t(fr, en);
}

/**
 * LE REFUS D'UNE OFFRE, émis par `lib/http.ts` sur chaque 402 qui porte un code d'offre, et écouté par `AppShell`, qui
 * affiche la phrase du serveur avec un lien vers `/offre`. Un écran affiche déjà la phrase dans son encart d'erreur ;
 * le bandeau ajoute le lien cliquable, sans retoucher les écrans un par un.
 */
export const OFFRE_REFUSEE_EVENT = 'mba:offre-refusee';

export interface RefusOffre {
  code: 'plan_feature_unavailable' | 'plan_limit_reached';
  phrase: string;
}

/**
 * La phrase du serveur sans l'adresse qu'il écrit à la fin (« … Passez en Pro : https://… »), utile à un client de l'API
 * mais redondante dans le bandeau, qui porte son bouton vers `/offre`.
 */
export function phraseSansAdresse(phrase: string): string {
  return phrase.replace(/\s*:\s*https?:\/\/\S+\s*$/, '.');
}

/**
 * L'ACCÈS SUSPENDU D'UN MEMBRE EN TROP (lot 6, B2a) : la garde du serveur refuse CHAQUE requête d'un membre au-delà des
 * limites de l'offre (402 `plan_limit_reached` avec `acces: 'suspendu'`). Émis par `lib/http.ts` sur toute requête,
 * lecture comprise, et écouté par `AppShell`, qui remplace la page entière : un bandeau sur un écran dont chaque lecture
 * échoue ne dirait rien d'utile.
 */
export const ACCES_SUSPENDU_EVENT = 'mba:acces-suspendu';

/** Le refus de la garde à un membre en trop ; `null` pour tout autre corps, une invitation refusée comprise. */
export function estAccesSuspendu(corps: unknown): RefusOffre | null {
  if (!estObjet(corps) || corps.acces !== 'suspendu') return null;
  const refus = lireRefusOffre(corps);
  return refus?.code === 'plan_limit_reached' ? refus : null;
}

/** Le corps d'un 402 d'offre, vérifié ; `null` pour tout autre corps. */
export function lireRefusOffre(corps: unknown): RefusOffre | null {
  if (!estObjet(corps) || typeof corps.error !== 'string') return null;
  if (corps.code !== 'plan_feature_unavailable' && corps.code !== 'plan_limit_reached') return null;
  return { code: corps.code, phrase: corps.error };
}
