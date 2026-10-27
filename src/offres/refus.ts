import { config } from '../config';
import { DROITS, contactsToutesOrigines, type Fonction, type Limites, type Offre } from './offres';
import { refus, type Refus } from '../lib/issue';

/**
 * LES REFUS DE L'OFFRE (lot 6, spec § 8). Statut 402 pour les deux : il ne se confond pas avec le 403 d'un droit de clé
 * manquant (`missing_scope`), qui ne se règle pas en payant. La phrase dit quoi faire, pour que l'assistant d'un
 * développeur la relaie telle quelle ; `upgradeUrl` mène à la page de l'offre de la console.
 */
export const STATUT_REFUS_OFFRE = 402;

/** Les limites qu'un geste peut atteindre (les autres se lisent sans refuser). */
export type NomLimite = Extract<keyof Limites, 'utilisateurs' | 'admins' | 'contacts' | 'envoisModelesMois' | 'automations' | 'suppressionsJour' | 'adressesWebhook' | 'stockageOctets' | 'clesApi'>;

/**
 * Le siège à acheter pour lever la limite d'utilisateurs d'un Pro (spec offres v2, livraison 7) : le nombre de sièges visé
 * et le prix HT de la formule du Pro. Le refus d'une invitation le porte : la console propose l'achat, Claude le redit.
 */
export interface SiegeRequis {
  cible: number;
  periodicite: 'mois' | 'an';
  prixHtCentimes: number;
}

/**
 * Ce que le refus sait de l'espace, quand l'appelant le sait : son offre (la grille ne suffit plus à la deviner dès qu'un
 * Pro a des sièges, 4 utilisateurs n'étant la limite d'aucune offre), et le siège qui la lève.
 */
export interface ContexteLimite {
  offre?: Offre;
  siege?: SiegeRequis;
}

/** Une limite de l'offre est atteinte : levée par le magasin ou la fabrique, traduite en 402 par l'appelant. */
export class LimiteOffreError extends Error {
  constructor(readonly tenantId: string, readonly limite: NomLimite, readonly max: number, readonly contexte: ContexteLimite = {}) {
    super(phraseLimite(limite, max, contexte));
    this.name = 'LimiteOffreError';
  }
}

const LIBELLE_FONCTION: Record<Fonction, string> = {
  inbox: 'l’Inbox', scenarios: 'le constructeur de scénarios', statistiques: 'les statistiques',
  agent_meta: 'l’agent de Meta', aide: 'l’assistant d’aide', assistants: 'les assistants de configuration',
  analyse: 'l’analyse des conversations', publicites: 'les publicités', email: 'l’e-mail', chaines: 'les chaînes',
  crm: 'les connecteurs CRM', rcs: 'le RCS', performance_lab: 'le Performance Lab', console: 'la console complète',
};

/** Un nombre écrit à la française (« 5 000 contacts ») : la phrase est lue par une personne, ou redite par Claude. */
const nb = (m: number): string => m.toLocaleString('fr-FR');

const LIBELLE_LIMITE: Record<NomLimite, (max: number, contexte: ContexteLimite) => string> = {
  utilisateurs: (m) => `${m} utilisateur${m > 1 ? 's' : ''}`,
  admins: (m) => `${m} administrateur${m > 1 ? 's' : ''}`,
  // Ce qui compte dépend de l'offre (`contactsToutesOrigines`) : celle que le refus connaît, sinon celle dont c'est la limite
  // dans la grille ; une limite hors grille (une Entreprise réglée sur devis) ne compte pas ceux qui écrivent.
  contacts: (m, c) => (contactsToutesOrigines(c.offre ?? offreDeLaLimite('contacts', m) ?? 'entreprise')
    ? `${nb(m)} contacts, ceux qui vous écrivent compris`
    : `${nb(m)} contacts créés (ceux qui vous écrivent ne comptent pas)`),
  envoisModelesMois: (m) => `${nb(m)} envois de modèles par mois (les réponses dans les 24 h ne comptent pas)`,
  automations: (m) => `${nb(m)} automations`,
  suppressionsJour: (m) => `${nb(m)} suppressions de contacts par jour`,
  adressesWebhook: (m) => `${m} adresse${m > 1 ? 's' : ''} de webhook sortant actives`,
  stockageOctets: (m) => `${Math.round(m / (1024 * 1024))} Mo de fichiers dans la médiathèque`,
  clesApi: (m) => `${m} clés d’API actives (révoquez-en une pour en créer une autre ; la clé de l’agent de Meta ne compte pas)`,
};

/** La page de l'offre dans la console. */
export function adresseOffre(): string {
  return `${config.APP_URL.replace(/\/+$/, '')}/offre`;
}

/** Les offres, de la moins chère à la plus chère, et leur nom public. */
const ORDRE: readonly Offre[] = ['base', 'pro', 'business', 'entreprise'];
const NOM_OFFRE: Record<Offre, string> = { base: 'Free', pro: 'Pro', business: 'Business', entreprise: 'Entreprise' };

/** L'offre dont c'est la limite dans la grille, la moins chère d'abord ; `null` pour une valeur hors grille (un devis). */
function offreDeLaLimite(limite: NomLimite, max: number): Offre | null {
  return ORDRE.find((o) => DROITS[o].limites[limite] === max) ?? null;
}

/**
 * L'offre qui lève une limite (spec offres v2) : la première, après celle dont c'est la limite dans la grille, qui va plus
 * haut. Le refus ne connaît pas l'offre de l'espace, mais la grille la dit : 100 contacts est la limite de la Free, 3
 * utilisateurs celle du Pro. `null` pour une limite qui n'est pas dans la grille (une Entreprise réglée sur devis).
 */
function offreQuiLeve(limite: NomLimite, max: number): Offre | null {
  const de = offreDeLaLimite(limite, max);
  if (de === null) return null;
  return ORDRE.slice(ORDRE.indexOf(de) + 1).find((o) => {
    const v = DROITS[o].limites[limite];
    return v === null || v > max;
  }) ?? null;
}

export function phraseLimite(limite: NomLimite, max: number, contexte: ContexteLimite = {}): string {
  // Le Pro a lui-même un quota de stockage : « passez en Pro » serait faux pour lui. Ce qui libère, c'est de supprimer.
  if (limite === 'stockageOctets') {
    return `Limite de votre offre atteinte : ${LIBELLE_LIMITE[limite](max, contexte)}. Supprimez des fichiers inutilisés, ou changez d’offre : ${adresseOffre()}`;
  }
  // Les utilisateurs d'un Pro (livraison 7) : un siège les lève, au prix de sa formule ; sans siège en vente, l'Entreprise.
  if (limite === 'utilisateurs' && contexte.offre === 'pro') {
    const s = contexte.siege;
    const suite = s
      ? `Ajoutez un utilisateur (${nb(s.prixHtCentimes / 100)} € HT par ${s.periodicite}) en invitant le membre depuis « Compte & équipe », ou passez en Entreprise`
      : 'Passez en Entreprise pour la lever';
    return `Limite de votre offre atteinte : ${LIBELLE_LIMITE[limite](max, contexte)}. ${suite} : ${adresseOffre()}`;
  }
  const o = offreQuiLeve(limite, max);
  const suite = o === null ? 'Contactez-nous pour la relever' : `Passez en ${NOM_OFFRE[o]} pour la lever`;
  return `Limite de votre offre atteinte : ${LIBELLE_LIMITE[limite](max, contexte)}. ${suite} : ${adresseOffre()}`;
}

export function corpsRefusFonction(fonction: Fonction): { error: string; code: 'plan_feature_unavailable'; fonction: Fonction; upgradeUrl: string } {
  // L'offre la moins chère qui ouvre la fonction : le CRM n'est qu'en Entreprise, « passez en Pro » y serait faux.
  const o = ORDRE.find((x) => DROITS[x].fonctions.has(fonction)) ?? 'pro';
  return {
    error: `Votre offre ne comprend pas ${LIBELLE_FONCTION[fonction]}. Passez en ${NOM_OFFRE[o]} : ${adresseOffre()}`,
    code: 'plan_feature_unavailable',
    fonction,
    upgradeUrl: adresseOffre(),
  };
}

/**
 * Le même refus, en `Refus` d'une fonction partagée entre la route et l'outil MCP (`src/lib/issue.ts`) : la route le
 * traduit en 402 avec le corps de `corpsRefusFonction`, l'outil en refus lisible avec la même phrase (lot 6, B2a).
 */
export function refusFonction(fonction: Fonction): Refus {
  const c = corpsRefusFonction(fonction);
  return refus(STATUT_REFUS_OFFRE, c.error, { code: c.code, fonction: c.fonction, upgradeUrl: c.upgradeUrl });
}

/**
 * Ce qu'un AGENT lit quand un outil est refusé hors offre (lot 6, B2a) : l'agent de Meta comme un agent IA peuvent redire
 * leur raison au contact final, qui n'a pas à apprendre l'abonnement de la marque. Ni offre, ni prix, ni lien.
 */
export const INDISPONIBLE_POUR_LE_MODELE = 'ce contenu n’est pas disponible en ce moment : continue la conversation sans lui';

/**
 * Le corps d'un 402 de limite. `siege` (livraison 7) : seulement quand un siège lève la limite d'utilisateurs d'un Pro ; le
 * code reste `plan_limit_reached`, le contrat que l'API et Claude connaissent.
 */
export function corpsRefusLimite(e: LimiteOffreError): {
  error: string; code: 'plan_limit_reached'; limite: NomLimite; max: number; upgradeUrl: string; siege?: SiegeRequis;
} {
  return {
    error: e.message, code: 'plan_limit_reached', limite: e.limite, max: e.max, upgradeUrl: adresseOffre(),
    ...(e.contexte.siege ? { siege: e.contexte.siege } : {}),
  };
}
