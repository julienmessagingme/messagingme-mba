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
  'crm', 'rcs', 'performance_lab',
] as const;
export type FonctionOffre = (typeof FONCTIONS_OFFRE)[number];

export const NOMS_OFFRES = ['base', 'pro', 'entreprise'] as const;
export type NomOffre = (typeof NOMS_OFFRES)[number];

/** Les clés des limites (`Limites`, `src/offres/offres.ts`). `null` = sans limite. */
export const LIMITES_NOMBRE = [
  'utilisateurs', 'admins', 'contacts', 'envoisModelesMois', 'automations', 'suppressionsJour', 'adressesWebhook',
  'journalWebhooksJours',
] as const;
export type LimiteNombre = (typeof LIMITES_NOMBRE)[number];

export interface LimitesOffre extends Record<LimiteNombre, number | null> {
  conservationJours: number;
  commissionPct: number;
  badge: boolean;
  numeroInclus: boolean;
}

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
  grille: Record<NomOffre, { fonctions: ReadonlySet<FonctionOffre>; limites: LimitesOffre }>;
  /** Les prix HT du Pro, en centimes (lot 6, B1). `null` : une API plus ancienne qui ne les porte pas encore. */
  prixPro: { moisCentimes: number; anCentimes: number } | null;
  upgradeUrl: string;
}

type Objet = Record<string, unknown>;
const estObjet = (v: unknown): v is Objet => typeof v === 'object' && v !== null && !Array.isArray(v);
const entierOuNul = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
const entier = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const estFonction = (v: unknown): v is FonctionOffre => typeof v === 'string' && (FONCTIONS_OFFRE as readonly string[]).includes(v);
const estOffre = (v: unknown): v is NomOffre => typeof v === 'string' && (NOMS_OFFRES as readonly string[]).includes(v);

/** Une fonction inconnue (un serveur plus récent) est ignorée : elle n'a de toute façon aucun écran ici. */
function lireFonctions(v: unknown): ReadonlySet<FonctionOffre> | null {
  return Array.isArray(v) ? new Set(v.filter(estFonction)) : null;
}

function lireLimites(v: unknown): LimitesOffre | null {
  if (!estObjet(v)) return null;
  if (!LIMITES_NOMBRE.every((k) => entierOuNul(v[k]))) return null;
  if (!entier(v.conservationJours) || !entier(v.commissionPct)) return null;
  if (typeof v.badge !== 'boolean' || typeof v.numeroInclus !== 'boolean') return null;
  return {
    ...(Object.fromEntries(LIMITES_NOMBRE.map((k) => [k, v[k]])) as Record<LimiteNombre, number | null>),
    conservationJours: v.conservationJours, commissionPct: v.commissionPct, badge: v.badge, numeroInclus: v.numeroInclus,
  };
}

/**
 * La réponse du serveur, VÉRIFIÉE et non castée. `null` quand la forme n'y est pas : une API plus ancienne (la route
 * rend 404), un proxy, ou le repli `{}` des e2e. 🔴 `null` veut dire « offre inconnue », donc TOUT RESTE OUVERT : une
 * console qui grisait tout faute de savoir couperait un client Entreprise de ses écrans sur une simple panne.
 */
export function lireVueOffre(brut: unknown): VueOffre | null {
  if (!estObjet(brut) || !estOffre(brut.offre) || typeof brut.upgradeUrl !== 'string') return null;
  const fonctions = lireFonctions(brut.fonctions);
  const limites = lireLimites(brut.limites);
  if (fonctions === null || limites === null) return null;
  const u = brut.usage;
  if (!estObjet(u) || !entierOuNul(u.envoisModelesMois) || !entier(u.contacts) || !entier(u.automations) || !entier(u.membres)) return null;
  const g = brut.grille;
  if (!estObjet(g)) return null;
  const grille: Partial<VueOffre['grille']> = {};
  for (const o of NOMS_OFFRES) {
    const ligne = g[o];
    if (!estObjet(ligne)) return null;
    const f = lireFonctions(ligne.fonctions);
    const l = lireLimites(ligne.limites);
    if (f === null || l === null) return null;
    grille[o] = { fonctions: f, limites: l };
  }
  return {
    offre: brut.offre, fonctions, limites,
    usage: { envoisModelesMois: u.envoisModelesMois, contacts: u.contacts, automations: u.automations, membres: u.membres },
    grille: grille as VueOffre['grille'],
    prixPro: lirePrixPro(brut.prixPro),
    upgradeUrl: brut.upgradeUrl,
  };
}

/** Des prix illisibles ou absents ne rendent pas la vue illisible : ils sont inconnus. */
function lirePrixPro(v: unknown): VueOffre['prixPro'] {
  if (!estObjet(v) || !entier(v.moisCentimes) || !entier(v.anCentimes)) return null;
  return { moisCentimes: v.moisCentimes, anCentimes: v.anCentimes };
}

/** L'offre la moins chère de la grille qui ouvre cette fonction (« Pro » ou « Entreprise »), `null` si aucune. */
export function offreQuiOuvre(vue: VueOffre, f: FonctionOffre): NomOffre | null {
  return NOMS_OFFRES.find((o) => vue.grille[o].fonctions.has(f)) ?? null;
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
  return o === 'base' ? t('Base', 'Base') : o === 'pro' ? t('Pro', 'Pro') : t('Entreprise', 'Enterprise');
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
