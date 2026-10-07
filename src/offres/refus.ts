import { config } from '../config';
import type { Fonction, Limites } from './offres';
import { refus, type Refus } from '../lib/issue';

/**
 * LES REFUS DE L'OFFRE (lot 6, spec § 8). Statut 402 pour les deux : il ne se confond pas avec le 403 d'un droit de clé
 * manquant (`missing_scope`), qui ne se règle pas en payant. La phrase dit quoi faire, pour que l'assistant d'un
 * développeur la relaie telle quelle ; `upgradeUrl` mène à la page de l'offre de la console.
 */
export const STATUT_REFUS_OFFRE = 402;

/** Les limites qu'un geste peut atteindre (les autres se lisent sans refuser). */
export type NomLimite = Extract<keyof Limites, 'utilisateurs' | 'admins' | 'contacts' | 'envoisModelesMois' | 'automations' | 'suppressionsJour'>;

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
  crm: 'les connecteurs CRM', rcs: 'le RCS', performance_lab: 'le Performance Lab',
};

const LIBELLE_LIMITE: Record<NomLimite, (max: number) => string> = {
  utilisateurs: (m) => `${m} utilisateur${m > 1 ? 's' : ''}`,
  admins: (m) => `${m} administrateur${m > 1 ? 's' : ''}`,
  contacts: (m) => `${m} contacts créés (ceux qui vous écrivent ne comptent pas)`,
  envoisModelesMois: (m) => `${m} envois de modèles par mois (les réponses dans les 24 h ne comptent pas)`,
  automations: (m) => `${m} automations`,
  suppressionsJour: (m) => `${m} suppressions de contacts par jour`,
};

/** La page de l'offre dans la console. */
export function adresseOffre(): string {
  return `${config.APP_URL.replace(/\/+$/, '')}/offre`;
}

export function phraseLimite(limite: NomLimite, max: number): string {
  return `Limite de votre offre atteinte : ${LIBELLE_LIMITE[limite](max)}. Passez en Pro pour la lever : ${adresseOffre()}`;
}

export function corpsRefusFonction(fonction: Fonction): { error: string; code: 'plan_feature_unavailable'; fonction: Fonction; upgradeUrl: string } {
  return {
    error: `Votre offre ne comprend pas ${LIBELLE_FONCTION[fonction]}. Passez en Pro : ${adresseOffre()}`,
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

export function corpsRefusLimite(e: LimiteOffreError): { error: string; code: 'plan_limit_reached'; limite: NomLimite; max: number; upgradeUrl: string } {
  return { error: e.message, code: 'plan_limit_reached', limite: e.limite, max: e.max, upgradeUrl: adresseOffre() };
}
