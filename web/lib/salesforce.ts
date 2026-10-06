/**
 * L'APP SALESFORCE, vue de la console (plan 2026-09-26, lot L1).
 *
 * Les décisions d'affichage vivent ici, en fonctions pures, pour être testées sans navigateur. La carte de
 * Paramètres > Intégrations et la page de connexion les appellent ; aucune ne refait le calcul à sa façon.
 */

export type EtatOrgSalesforce = 'connexion' | 'connectee' | 'en_pause' | 'coupee';

/** Les étapes du guide, ancres de la page tuto. Miroir de `ETAPES_GUIDE` (`src/salesforce/connexion.ts`), parité tenue par un test. */
export const ETAPES_GUIDE_SALESFORCE = ['adresse', 'package', 'utilisateur', 'run-as', 'droits', 'org'] as const;
export type EtapeGuideSalesforce = (typeof ETAPES_GUIDE_SALESFORCE)[number];

export interface ManqueSalesforce {
  etape: EtapeGuideSalesforce;
  message: string;
}

export interface OrgSalesforceVue {
  orgId: string;
  myDomain: string;
  sandbox: boolean;
  etat: EtatOrgSalesforce;
  motifCoupure: string | null;
  quota: { utilise: number; max: number; releveLe: string } | null;
  consentementLead: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  consentementContact: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  envoyerResume: boolean;
  proprietaireRepli: string | null;
  connecteeLe: string | null;
}

/** Ce que rend `GET /tenants/:t/integrations/salesforce`. */
export interface IntegrationSalesforceVue {
  actif: boolean;
  /** La clé d'app Salesforce est posée sur cette instance. Faux = fonctionnalité indisponible, rien à faire côté client. */
  cleAppPosee: boolean;
  chiffrementPret: boolean;
  /** Les liens d'installation du package, construits par le SERVEUR (jamais recomposés ici). `null` : pas encore publié. */
  liensInstallation: { production: string; sandbox: string } | null;
  org: OrgSalesforceVue | null;
}

/**
 * L'interrupteur, ou `undefined` quand l'API ne le rend pas.
 *
 * 🔴 `undefined` N'EST PAS `false` : la console se publie AVANT l'API. Mais pour une intégration NEUVE, l'inconnu
 * se traduit par « on ne montre rien » (voir `salesforceUtilisable`), jamais par un bouton vers une route absente.
 */
export function lireSalesforceActif(reglages: { salesforceActif?: unknown } | null | undefined): boolean | undefined {
  const v = reglages?.salesforceActif;
  return typeof v === 'boolean' ? v : undefined;
}

const ETATS: readonly string[] = ['connexion', 'connectee', 'en_pause', 'coupee'];

/**
 * Lecture DÉFENSIVE de la réponse de l'intégration. Un `{}` (route absente derrière un proxy, API plus ancienne)
 * n'est ni une panne ni « connectée » : `null`, et l'écran dit que le réglage est indisponible.
 */
export function lireIntegrationSalesforce(corps: unknown): IntegrationSalesforceVue | null {
  if (!corps || typeof corps !== 'object') return null;
  const c = corps as Record<string, unknown>;
  if (typeof c.actif !== 'boolean' || typeof c.cleAppPosee !== 'boolean' || typeof c.chiffrementPret !== 'boolean') return null;
  const org = c.org as Record<string, unknown> | null | undefined;
  const orgLisible = org === null || org === undefined
    ? null
    : typeof org.orgId === 'string' && typeof org.myDomain === 'string' && typeof org.etat === 'string' && ETATS.includes(org.etat)
      ? (org as unknown as OrgSalesforceVue)
      : undefined;
  if (orgLisible === undefined) return null;
  const liens = c.liensInstallation as Record<string, unknown> | null | undefined;
  const liensLisibles = liens && typeof liens.production === 'string' && typeof liens.sandbox === 'string'
    ? { production: liens.production, sandbox: liens.sandbox }
    : null;
  return { actif: c.actif, cleAppPosee: c.cleAppPosee, chiffrementPret: c.chiffrementPret, liensInstallation: liensLisibles, org: orgLisible };
}

/**
 * Ce que la carte de Paramètres > Intégrations permet.
 *
 * 🔴 L'EXTINCTION EST BLOQUÉE TANT QU'UNE ORG EST RELIÉE, quel que soit son état (le serveur rend 409) : l'écran le
 * dit AVANT le clic. Allumer n'est jamais bloqué. La page de connexion n'est proposée qu'allumé.
 */
export function etatCarteSalesforce(v: IntegrationSalesforceVue): { extinctionBloquee: boolean; proposerConnexion: boolean } {
  return {
    extinctionBloquee: v.actif && v.org !== null,
    proposerConnexion: v.actif && v.cleAppPosee,
  };
}

/** La phrase d'état de l'org, pour la carte et la page. */
export function phraseEtatOrg(org: OrgSalesforceVue | null, t: (fr: string, en: string) => string): string {
  if (!org) return t('Aucune org Salesforce reliée.', 'No Salesforce org connected.');
  const hote = org.myDomain.replace(/^https:\/\//, '');
  switch (org.etat) {
    case 'connectee': return t(`Reliée à ${hote}.`, `Connected to ${hote}.`);
    case 'connexion': return t(`Connexion à ${hote} inachevée : relancez « Connecter ».`, `Connection to ${hote} unfinished: run "Connect" again.`);
    case 'en_pause': return t(`Reliée à ${hote}, en pause.`, `Connected to ${hote}, paused.`);
    case 'coupee': return t(`Coupée : ${hote} refuse l'accès de Messaging Me. Reconnectez l'org.`, `Cut off: ${hote} refuses Messaging Me's access. Reconnect the org.`);
    default: {
      const inconnu: never = org.etat;
      return String(inconnu);
    }
  }
}

/** Le lien du guide pour une étape : chaque manque rendu par le serveur y renvoie. */
export const lienEtape = (etape: EtapeGuideSalesforce): string => `/tuto-salesforce#${etape}`;

/**
 * Lit le corps d'un refus de connexion (422) : des manques, ou une panne passagère. Un corps d'une autre forme
 * rend `null`, et l'écran affiche le message générique de l'erreur.
 */
export function lireRefusConnexion(corps: unknown): { manques: ManqueSalesforce[] } | { passager: string } | null {
  if (!corps || typeof corps !== 'object') return null;
  const c = corps as Record<string, unknown>;
  if (c.passager === true && typeof c.error === 'string') return { passager: c.error };
  if (!Array.isArray(c.manques)) return null;
  const manques = c.manques.filter((m): m is ManqueSalesforce =>
    !!m && typeof m === 'object' && typeof (m as ManqueSalesforce).message === 'string'
    && (ETAPES_GUIDE_SALESFORCE as readonly string[]).includes((m as ManqueSalesforce).etape));
  return manques.length > 0 ? { manques } : null;
}
