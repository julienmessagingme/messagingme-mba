/**
 * LE BLOC « CANAUX ET SERVICES » DE L'ACCUEIL, en décisions pures (plan du 2026-09-25, design validé par Julien).
 *
 * Une ligne par canal ou service : un interrupteur, son état en une phrase, le lien vers son écran. Éteindre
 * demande une confirmation qui dit ce qui s'arrête ; rallumer ne demande rien. Chaque interrupteur est branché
 * sur un geste qui EXISTE déjà (ou sur l'un des deux neufs, délier le numéro et débrancher la chaîne) : ce module
 * ne décide que QUEL geste, jamais comment il se fait.
 *
 * 🔴 CHAQUE LIGNE TOLÈRE UNE API QUI NE CONNAÎT PAS ENCORE SON GESTE. Vercel publie la console à chaque `git
 * push`, l'API attend son déploiement : un champ absent n'est donc jamais lu comme « éteint », il donne une
 * ligne SANS interrupteur (`allume: null`), et l'écran le dit.
 */

/** Ce que fait l'interrupteur d'une ligne quand on l'actionne. */
export type Geste =
  | 'delier_numero' | 'relier_numero' | 'connecter_numero'
  | 'activer_rcs' | 'couper_rcs'
  | 'ouvrir_chaine' | 'debrancher_chaine'
  | 'ouvrir_publicites' | 'deconnecter_publicites'
  | 'allumer_hubspot' | 'eteindre_hubspot';

/** Les gestes qui ÉTEIGNENT : les seuls qui passent par une confirmation. */
const EXTINCTIONS: ReadonlySet<Geste> = new Set<Geste>(['delier_numero', 'couper_rcs', 'debrancher_chaine', 'deconnecter_publicites', 'eteindre_hubspot']);

export function demandeConfirmation(g: Geste): boolean {
  return EXTINCTIONS.has(g);
}

export interface Ligne {
  /** L'interrupteur : `true`/`false`. `null` = on ne sait pas (lecture en cours, échouée, ou API plus ancienne) : pas d'interrupteur. */
  allume: boolean | null;
  /** Le geste de l'interrupteur. `null` = aucun geste possible maintenant : l'interrupteur est grisé, la raison est dite. */
  geste: Geste | null;
}

const SANS_INTERRUPTEUR: Ligne = { allume: null, geste: null };

/**
 * NUMÉRO WHATSAPP. Relié : l'éteindre le délie. Délié : le rallumer le relie d'un clic. Aucun numéro : le
 * rallumer ouvre la connexion actuelle (la fenêtre Meta), si elle est disponible sur cette instance.
 *
 * ⚠️ `delieLe` ABSENT (API d'avant la migration 0180) : le numéro est lu comme RELIÉ, ce qu'il était forcément
 * puisque rien ne pouvait le délier. L'extinction est proposée, et une API qui ne connaît pas encore la route
 * le dira par un 404, que l'écran traduit.
 */
export function ligneNumero(p: {
  compte: { hasNumber: boolean; delieLe?: string | null } | null;
  connexionDisponible: boolean;
}): Ligne {
  if (p.compte === null) return SANS_INTERRUPTEUR;
  if (!p.compte.hasNumber) return { allume: false, geste: p.connexionDisponible ? 'connecter_numero' : null };
  if (typeof p.compte.delieLe === 'string') return { allume: false, geste: 'relier_numero' };
  return { allume: true, geste: 'delier_numero' };
}

/** CANAL RCS. Actif : l'éteindre le coupe. Inactif : le rallumer ouvre l'activation actuelle (la clé du canal). */
export function ligneRcs(etat: { active?: unknown } | null): Ligne {
  if (etat === null) return SANS_INTERRUPTEUR;
  return etat.active === true ? { allume: true, geste: 'couper_rcs' } : { allume: false, geste: 'activer_rcs' };
}

/**
 * CHAÎNE. Branchée : l'éteindre la débranche (les identifiants sont oubliés, les publications restent).
 * Débranchée : le rallumer ouvre l'écran Chaîne, où se saisissent les identifiants.
 *
 * ⚠️ Une réponse sans la clé `connection` (forme inattendue) ne dit RIEN : pas d'interrupteur, plutôt qu'un
 * « débranchée » qu'on n'a pas lu.
 */
export function ligneChaine(connexion: { connection?: unknown } | null): Ligne {
  if (connexion === null || !('connection' in connexion) || connexion.connection === undefined) return SANS_INTERRUPTEUR;
  return connexion.connection !== null ? { allume: true, geste: 'debrancher_chaine' } : { allume: false, geste: 'ouvrir_chaine' };
}

/**
 * COMPTE PUBLICITAIRE. Connecté : l'éteindre le déconnecte (le geste actuel de l'écran Publicités). Non connecté :
 * le rallumer ouvre l'écran Publicités, où se fait la connexion (fenêtre Meta, puis choix du compte et de la Page).
 * `absent` (la route n'existe pas encore) ou fonctionnalité non configurée sur l'instance : pas d'interrupteur.
 */
export function lignePublicites(etat: { configure?: unknown; connexion?: unknown } | 'absent' | null): Ligne {
  if (etat === null || etat === 'absent' || etat.configure !== true || etat.connexion === undefined) return SANS_INTERRUPTEUR;
  return etat.connexion !== null ? { allume: true, geste: 'deconnecter_publicites' } : { allume: false, geste: 'ouvrir_publicites' };
}

/**
 * HUBSPOT : l'interrupteur de l'espace (migration 0179). 🔴 L'extinction est REFUSÉE tant qu'un portail est
 * relié, comme dans Paramètres > Intégrations et comme le serveur (409) : l'interrupteur est alors grisé, et
 * l'écran dit de faire d'abord la « Déconnexion complète ». Réglage inconnu (API plus ancienne) : pas
 * d'interrupteur.
 */
export function ligneHubspot(p: { actif: boolean | undefined; portailRelie: boolean | undefined }): Ligne {
  if (p.actif === undefined) return SANS_INTERRUPTEUR;
  if (!p.actif) return { allume: false, geste: 'allumer_hubspot' };
  return { allume: true, geste: p.portailRelie === true ? null : 'eteindre_hubspot' };
}

/**
 * Cette erreur dit-elle que l'API DÉPLOYÉE ne connaît pas encore la route ? C'est le 404 du routeur (corps
 * `error: 'Not Found'`), à distinguer d'un 404 que la route écrit elle-même avec sa raison (« aucun numéro
 * rattaché », « canal RCS non activé »), qui doit s'afficher tel quel.
 */
export function routeInconnue(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: unknown; corps?: unknown };
  const corps = e.corps as { error?: unknown } | null | undefined;
  return e.status === 404 && corps?.error === 'Not Found';
}

/**
 * Le nombre de publications, ou `null` quand on ne le sait pas. Une réponse sans tableau n'est pas « zéro » :
 * ce serait dire qu'une chaîne qui publie n'a jamais rien publié.
 */
export function nombreDePublications(r: { posts?: unknown } | null): number | null {
  return r !== null && Array.isArray(r.posts) ? r.posts.length : null;
}
