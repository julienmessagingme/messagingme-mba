import { config } from '../config';
import { DROITS, type Fonction, type Limites, type Offre } from './offres';
import { refus, type Refus } from '../lib/issue';

/**
 * LES REFUS DE L'OFFRE (lot 6, spec § 8). Statut 402 pour les deux : il ne se confond pas avec le 403 d'un droit de clé
 * manquant (`missing_scope`), qui ne se règle pas en payant. La phrase dit quoi faire, pour que l'assistant d'un
 * développeur la relaie telle quelle ; `upgradeUrl` mène à la page de l'offre de la console.
 */
export const STATUT_REFUS_OFFRE = 402;

/** Les limites qu'un geste peut atteindre (les autres se lisent sans refuser). */
export type NomLimite = Extract<keyof Limites, 'utilisateurs' | 'admins' | 'contacts' | 'envoisModelesMois' | 'automations' | 'suppressionsJour' | 'adressesWebhook' | 'stockageOctets'>;

/** Une limite de l'offre est atteinte : levée par le magasin ou la fabrique, traduite en 402 par l'appelant. */
export class LimiteOffreError extends Error {
  constructor(readonly tenantId: string, readonly limite: NomLimite, readonly max: number) {
    super(phraseLimite(limite, max));
    this.name = 'LimiteOffreError';
  }
}

const LIBELLE_FONCTION: Record<Fonction, string> = {
  inbox: 'l’Inbox', scenarios: 'le constructeur de scénarios', statistiques: 'les statistiques',
  agent_meta: 'l’agent de Meta', aide: 'l’assistant d’aide', assistants: 'les assistants de configuration',
  analyse: 'l’analyse des conversations', publicites: 'les publicités', email: 'l’e-mail', chaines: 'les chaînes',
  crm: 'les connecteurs CRM', rcs: 'le RCS', performance_lab: 'le Performance Lab', console: 'la console complète',
};

const LIBELLE_LIMITE: Record<NomLimite, (max: number) => string> = {
  utilisateurs: (m) => `${m} utilisateur${m > 1 ? 's' : ''}`,
  admins: (m) => `${m} administrateur${m > 1 ? 's' : ''}`,
  contacts: (m) => `${m} contacts créés (ceux qui vous écrivent ne comptent pas)`,
  envoisModelesMois: (m) => `${m} envois de modèles par mois (les réponses dans les 24 h ne comptent pas)`,
  automations: (m) => `${m} automations`,
  suppressionsJour: (m) => `${m} suppressions de contacts par jour`,
  adressesWebhook: (m) => `${m} adresse${m > 1 ? 's' : ''} de webhook sortant actives`,
  stockageOctets: (m) => `${Math.round(m / (1024 * 1024))} Mo de fichiers dans la médiathèque`,
};

/** La page de l'offre dans la console. */
export function adresseOffre(): string {
  return `${config.APP_URL.replace(/\/+$/, '')}/offre`;
}

/** Les offres, de la moins chère à la plus chère, et leur nom public. */
const ORDRE: readonly Offre[] = ['base', 'pro', 'entreprise'];
const NOM_OFFRE: Record<Offre, string> = { base: 'Free', pro: 'Pro', entreprise: 'Entreprise' };

/**
 * L'offre qui lève une limite (spec offres v2) : la première, après celle dont c'est la limite dans la grille, qui va plus
 * haut. Le refus ne connaît pas l'offre de l'espace, mais la grille la dit : 100 contacts est la limite de la Free, 3
 * utilisateurs celle du Pro. `null` pour une limite qui n'est pas dans la grille (une Entreprise réglée sur devis).
 */
function offreQuiLeve(limite: NomLimite, max: number): Offre | null {
  const i = ORDRE.findIndex((o) => DROITS[o].limites[limite] === max);
  if (i < 0) return null;
  return ORDRE.slice(i + 1).find((o) => {
    const v = DROITS[o].limites[limite];
    return v === null || v > max;
  }) ?? null;
}

export function phraseLimite(limite: NomLimite, max: number): string {
  // Le Pro a lui-même un quota de stockage : « passez en Pro » serait faux pour lui. Ce qui libère, c'est de supprimer.
  if (limite === 'stockageOctets') {
    return `Limite de votre offre atteinte : ${LIBELLE_LIMITE[limite](max)}. Supprimez des fichiers inutilisés, ou changez d’offre : ${adresseOffre()}`;
  }
  const o = offreQuiLeve(limite, max);
  const suite = o === null ? 'Contactez-nous pour la relever' : `Passez en ${NOM_OFFRE[o]} pour la lever`;
  return `Limite de votre offre atteinte : ${LIBELLE_LIMITE[limite](max)}. ${suite} : ${adresseOffre()}`;
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

export function corpsRefusLimite(e: LimiteOffreError): { error: string; code: 'plan_limit_reached'; limite: NomLimite; max: number; upgradeUrl: string } {
  return { error: e.message, code: 'plan_limit_reached', limite: e.limite, max: e.max, upgradeUrl: adresseOffre() };
}
