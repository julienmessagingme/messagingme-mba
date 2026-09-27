import type { AuditSink } from '../src/audit/journal';
import type { AccountRouteDeps } from '../src/http/account';
import type { AgentKnowledgeRouteDeps } from '../src/http/agent-knowledge';
import type { AgentRequetesRouteDeps } from '../src/http/agent-requetes';
import type { AgentSetupRouteDeps } from '../src/http/agent-setup';
import type { AgentTestRouteDeps } from '../src/http/agent-test';
import type { AgentsRouteDeps } from '../src/http/agents';
import type { AideRouteDeps } from '../src/http/aide';
import type { CampaignRouteDeps } from '../src/http/campaigns';
import type { ContactsRouteDeps } from '../src/http/contacts';
import type { EmbeddedSignupRouteDeps } from '../src/http/embedded-signup';
import type { FieldsRouteDeps } from '../src/http/fields';
import type { InboxRouteDeps } from '../src/http/inbox';
import type { LinksRouteDeps } from '../src/http/links';
import type { MbaAssistantDeps } from '../src/http/mba-assistant';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import type { MbaRouteDeps } from '../src/http/mba';
import type { OpsRouteDeps } from '../src/http/ops';
import type { RcsCallbackRouteDeps } from '../src/http/rcs-callback';
import type { SettingsRouteDeps } from '../src/http/settings';
import type { StatsRouteDeps } from '../src/http/stats';
import type { SupportRouteDeps } from '../src/http/support';
import type { TemplateRouteDeps } from '../src/http/templates';
import type { UsersRouteDeps } from '../src/http/users';
import type { WorkflowRouteDeps } from '../src/http/workflows';
import type { DepsMcp } from '../src/mcp/outils';
import { MODELES_CHOISIS } from '../src/agent/modeles';
import { SANS_PLAFOND } from '../src/campaign/pacing';
import { PLAFOND_DESTINATAIRES_DEFAUT } from '../src/campaign/plafond';

/**
 * LES DÉPENDANCES DE ROUTES DEVENUES REQUISES, EN VALEURS INERTES NOMMÉES (lot 3 de l'audit ponytail, 2026-09-26).
 *
 * 🔴 POURQUOI ELLES EXISTENT. Ces membres étaient OPTIONNELS « pour les câblages de test », alors que le
 * câblage de production (`src/index.ts`) les fournit TOUS, sans condition (prouvé en retirant les `?` : le
 * compilateur n'y a rien trouvé à redire). Chaque `if (!deps.X) return 503` était donc une branche morte en
 * production, et un câblage qui en oubliait une compilait en silence. C'est le motif déjà payé avec
 * `estDesabonne` (`tests/consentement.ts`) : elles sont requises, et les fixtures DISENT leur hypothèse.
 *
 * ⚠️ DEUX FAMILLES, ET LA DIFFÉRENCE COMPTE.
 * - Quand l'absence produisait un COMPORTEMENT (aucun refus, aucune trace, une liste vide, « la fenêtre est
 *   fermée »), la valeur inerte le REPRODUIT EXACTEMENT : c'est ce qui permet de ne toucher aucune assertion.
 * - Quand l'absence produisait un 503 « indisponible sur cette instance », il n'y a plus rien à reproduire :
 *   ce 503 n'existe plus. Les LECTURES rendent alors le vide et les ÉCRITURES LÈVENT, comme `aucunePubDeRoute`
 *   (`tests/pubs-fixtures.ts`) : un test qui les atteindrait a changé de sujet sans le savoir, et mieux vaut
 *   qu'il le dise bruyamment que de passer au vert sur un succès inventé.
 *
 * 🔴 CE FICHIER EST DANS `tests/`, JAMAIS DANS `src/` (même règle que `tests/gardes.ts`).
 */

/** Une écriture qu'aucun test de ce montage ne devrait atteindre. */
const neDevraitPasEtreAppelee = (nom: string) => (): never => {
  throw new Error(`valeur inerte : ${nom} ne devrait pas être appelée`);
};

/** `audit` absent : le journal d'actions restait muet. */
export const journalMuet: AuditSink = async () => {};

export const compteInerte: Pick<AccountRouteDeps, 'photoNumero'> = {
  // Absente : pas de pastille.
  photoNumero: async () => null,
};

export const aideInerte: Pick<AideRouteDeps, 'recap'> = {
  recap: { calculer: neDevraitPasEtreAppelee('recap.calculer') },
};

export const connaissanceInerte: Pick<AgentKnowledgeRouteDeps, 'journaliserSuppression'> = {
  // Absente : aucune ligne d'historique.
  journaliserSuppression: async () => {},
};

/** `brancheeSurConsentement` absente : aucun refus, seul le compteur `outils` protégeait. */
export const jamaisBrancheeSurConsentement = async (): Promise<boolean> => false;

export const requetesInertes: Pick<AgentRequetesRouteDeps, 'brancheeSurConsentement'> = {
  brancheeSurConsentement: jamaisBrancheeSurConsentement,
};

export const assistantAgentInerte: Pick<AgentSetupRouteDeps,
  'emailsDesMembres' | 'depenses' | 'plafondEuros' | 'tauxEurParDollar' | 'ecrireFichesDocument' | 'entretiens' | 'modeleVision'> = {
  // Absente : « auteur inconnu » partout, c'est-à-dire aucune adresse résolue.
  emailsDesMembres: async () => ({}),
  // Absent : pas de plafond. Un plafond à 0 dit la même chose, et le compteur n'est alors jamais lu.
  depenses: { lire: async () => 0, ajouter: async () => {} },
  plafondEuros: 0,
  // Absent : le repli était 1.
  tauxEurParDollar: 1,
  ecrireFichesDocument: neDevraitPasEtreAppelee('ecrireFichesDocument'),
  entretiens: {
    lire: async () => null,
    ecrire: neDevraitPasEtreAppelee('entretiens.ecrire'),
    effacer: neDevraitPasEtreAppelee('entretiens.effacer'),
  },
  // Absent : aucun modèle de vision, les images sont refusées.
  modeleVision: '',
};

/** `solde` absent : l'essai ne coûtait rien, aucun refus pour solde épuisé. */
export const soldeIllimite = async (): Promise<number> => Number.POSITIVE_INFINITY;
/** `debiter` absent : rien n'était débité. */
export const sansDebit = async (): Promise<void> => {};

export const essaiAgentInerte: Pick<AgentTestRouteDeps, 'essais' | 'solde' | 'debiter'> = {
  // Absent : liste vide à la lecture, rien d'écrit après un essai.
  essais: { lister: async () => [], ecrire: async () => {}, purger: async () => 0 },
  solde: soldeIllimite,
  debiter: sansDebit,
};

export const agentsInertes: Pick<AgentsRouteDeps,
  'soldeAgent' | 'consommationAgent' | 'messagesAgent' | 'etatPourLint' | 'modelesProposes'> = {
  soldeAgent: async () => 0,
  consommationAgent: neDevraitPasEtreAppelee('consommationAgent'),
  messagesAgent: async () => 0,
  // Pas d'état = « agent introuvable » : un test qui ACTIVE un agent fournit le sien.
  etatPourLint: async () => null,
  // Absente : nos modèles, SANS tarif. C'est exactement ce que la route rendait.
  modelesProposes: async () => MODELES_CHOISIS.map((m) => ({ ...m, prixEntree: null, prixSortie: null })),
};

export const campagnesInertes: Pick<CampaignRouteDeps,
  'getMessagingLimitTier' | 'drafts' | 'contactIdsForTarget' | 'identifiantsDeTousLesContacts' | 'plafondDestinataires'
  | 'rcsAgentBelongsToTenant' | 'listRcsAgents' | 'emailTemplateBelongsToTenant' | 'webhookUsableByTenant'
  | 'stopWebhookCampaign' | 'pauseCampaign' | 'resumeCampaign' | 'defaultRatePerMinute' | 'plafondLePlusBas'> = {
  // Absent : aucun palier connu, donc aucun avertissement.
  getMessagingLimitTier: async () => null,
  drafts: {
    list: async () => [],
    create: neDevraitPasEtreAppelee('drafts.create'),
    update: async () => false,
    remove: async () => false,
  },
  contactIdsForTarget: async () => [],
  // Absente : « tous les contacts » n'était pas résolu ici. Une liste vide est lue de la même façon en aval
  // (`createCampaignWithRecipients` la traite comme « tous »), et ne dépasse aucun plafond.
  identifiantsDeTousLesContacts: async () => [],
  plafondDestinataires: PLAFOND_DESTINATAIRES_DEFAUT,
  // Absentes : aucune campagne RCS, e-mail ou au fil de l'eau n'était créable. Refuser dit la même chose.
  rcsAgentBelongsToTenant: async () => false,
  listRcsAgents: async () => [],
  emailTemplateBelongsToTenant: async () => false,
  webhookUsableByTenant: async () => false,
  // Absente : 404 « non arrêtable ». `false` produit le même 404.
  stopWebhookCampaign: async () => false,
  pauseCampaign: async () => false,
  // Absente : la levée de pause était sautée. `false` = rien n'était en pause, même effet.
  resumeCampaign: async () => false,
  defaultRatePerMinute: 0,
  plafondLePlusBas: SANS_PLAFOND,
};

export const contactsInertes: Pick<ContactsRouteDeps,
  'setBlocked' | 'listBlocked' | 'listeDesabonnes' | 'messagesARelire' | 'purgeMany' | 'contactIdsForTarget' | 'audit'
  | 'listAudit' | 'listErreursSysteme' | 'listErreursLivraison' | 'ensureSocleField' | 'createOneContact'
  | 'getResumeContact' | 'getBilanContact' | 'emitTagAdded'> = {
  setBlocked: neDevraitPasEtreAppelee('setBlocked'),
  listBlocked: async () => [],
  listeDesabonnes: async () => [],
  messagesARelire: async () => ({ scannes: 0, messages: [] }),
  purgeMany: neDevraitPasEtreAppelee('purgeMany'),
  contactIdsForTarget: async () => [],
  audit: journalMuet,
  listAudit: async () => [],
  listErreursSysteme: async () => [],
  listErreursLivraison: async () => [],
  // Absente : le champ socle n'était pas créé, d'où le refus « champ inconnu ». Ne rien créer le garde.
  ensureSocleField: async () => {},
  createOneContact: neDevraitPasEtreAppelee('createOneContact'),
  getResumeContact: async () => null,
  getBilanContact: async () => null,
  // Absente : aucune émission.
  emitTagAdded: async () => {},
};

export const signupInerte: Pick<EmbeddedSignupRouteDeps, 'audit' | 'wabasForToken' | 'listPhones'> = {
  audit: journalMuet,
  wabasForToken: async () => [],
  listPhones: async () => [],
};

export const champsInertes: Pick<FieldsRouteDeps, 'tenantCode' | 'fieldUsage'> = {
  // Absent : réponse sans `tenantCode`. Une chaîne vide produit la même réponse.
  tenantCode: async () => '',
  // Absente : relevé vide.
  fieldUsage: async () => ({ total: 0, parChamp: {} }),
};

/** `takeControl` absente : l'état local du fil ne bougeait pas. */
export const priseDeFilSansEffet = async (): Promise<void> => {};

/** `compterConversations` absente : la route rendait ces zéros. */
export const COMPTEURS_VIDES = { tout: 0, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] };

export const inboxInerte: Pick<InboxRouteDeps,
  'effacerMessages' | 'audit' | 'ouvrirConversationDuContact' | 'countUnread' | 'countATraiter' | 'compterConversations'
  | 'archiverConversation' | 'signalerConversation' | 'marquerTraitee' | 'lireMediaMessage' | 'getAssignee'
  | 'setAssignee' | 'prendreSiLibre' | 'agentsPeuventPrendre' | 'membresPourAffectation' | 'markConversationRead'
  | 'takeControl' | 'prendreLeFil' | 'releaseControl' | 'getControlOwner' | 'resolveTemplateParams'
  | 'sendRcsFromInbox' | 'categorieDuModele' | 'prepareCarousel' | 'startWorkflow'> = {
  effacerMessages: neDevraitPasEtreAppelee('effacerMessages'),
  audit: journalMuet,
  ouvrirConversationDuContact: async () => null,
  // Absents : 0, la pastille ne s'affichait pas.
  countUnread: async () => 0,
  countATraiter: async () => 0,
  compterConversations: async () => COMPTEURS_VIDES,
  archiverConversation: async () => false,
  signalerConversation: async () => false,
  marquerTraitee: async () => false,
  lireMediaMessage: async () => null,
  // Absente : personne n'était considéré comme affecté, tout le monde écrivait. `undefined` (conversation
  // inconnue) est précisément le cas où `refusAffectation` ne se prononce pas.
  getAssignee: async () => undefined,
  setAssignee: neDevraitPasEtreAppelee('setAssignee'),
  prendreSiLibre: async () => false,
  // Absente : `false`, le comportement d'avant le réglage.
  agentsPeuventPrendre: async () => false,
  membresPourAffectation: async () => [],
  markConversationRead: async () => {},
  // Absentes : l'état local du fil ne bougeait pas.
  takeControl: priseDeFilSansEffet,
  prendreLeFil: async () => {},
  releaseControl: neDevraitPasEtreAppelee('releaseControl'),
  // Absente : `app_workflow`, l'état d'une conversation dont personne n'a pris le contrôle.
  getControlOwner: async () => 'app_workflow',
  // Absente : des champs vides à remplir à la main.
  resolveTemplateParams: async () => ({ values: [], labels: [] }),
  // Absente : 422 « canal RCS non disponible ». Le même refus, par la même porte.
  sendRcsFromInbox: async () => ({ refus: 'canal RCS non disponible' }),
  // Absente : catégorie inconnue, donc refus par prudence sur un contact désabonné.
  categorieDuModele: async () => null,
  // Absente : aucun carousel.
  prepareCarousel: async () => null,
  startWorkflow: async () => null,
};

/** `campagneVivante` absente : aucune garde, donc aucune campagne au fil de l'eau n'était vue. */
export const aucuneCampagneVivante = async (): Promise<string | null> => null;

export const liensInertes: Pick<LinksRouteDeps, 'contactParJeton'> = {
  // Absente : les clics restaient anonymes.
  contactParJeton: async () => null,
};

export const assistantMbaInerte: Pick<MbaAssistantDeps, 'pieces'> = {
  // Absent : tout jeton de pièce jointe était mort, et le dépôt refusé.
  pieces: {
    deposer: neDevraitPasEtreAppelee('pieces.deposer'),
    reprendre: () => null,
    contient: () => false,
  },
};

export const relaisMbaInerte: Pick<MbaRelaisDeps, 'journaliserForme'> = {
  journaliserForme: () => {},
};

export const mbaInerte: Pick<MbaRouteDeps, 'journaliserSuppression' | 'numeroDuTenant' | 'ecrireDrapeauMba' | 'messagesEcrits'> = {
  journaliserSuppression: async () => {},
  numeroDuTenant: async () => null,
  ecrireDrapeauMba: neDevraitPasEtreAppelee('ecrireDrapeauMba'),
  messagesEcrits: async () => 0,
};

export const opsInerte: Pick<OpsRouteDeps,
  'deposerJetonPub' | 'lireGrillePrix' | 'ecrireGrillePrix' | 'verrouillerEspace' | 'observerTenant'
  | 'getQueueLoadParGroupe' | 'getQueueLatence' | 'listerJobsMorts' | 'reenfiler' | 'oublierJobsMorts'
  | 'getWorkerHeartbeat' | 'soldeAgent' | 'rechargerAgent' | 'etatPoolInstantane' | 'lireAttentesPool'
  | 'balayerRisque' | 'reinitialiserMfa'> = {
  deposerJetonPub: neDevraitPasEtreAppelee('deposerJetonPub'),
  lireGrillePrix: neDevraitPasEtreAppelee('lireGrillePrix'),
  ecrireGrillePrix: neDevraitPasEtreAppelee('ecrireGrillePrix'),
  verrouillerEspace: neDevraitPasEtreAppelee('verrouillerEspace'),
  observerTenant: async () => null,
  // Absentes : l'écran rendait ces listes vides et `worker: null`.
  getQueueLoadParGroupe: async () => [],
  getQueueLatence: async () => [],
  listerJobsMorts: async () => [],
  reenfiler: neDevraitPasEtreAppelee('reenfiler'),
  oublierJobsMorts: neDevraitPasEtreAppelee('oublierJobsMorts'),
  getWorkerHeartbeat: async () => null,
  soldeAgent: async () => null,
  rechargerAgent: neDevraitPasEtreAppelee('rechargerAgent'),
  // Absente : `poolInstantane: null`. Aucun état ne dit « rien » ; un pool vide est le plus proche.
  etatPoolInstantane: () => ({ process: 'test', total: 0, libres: 0, enAttente: 0, max: 0, maxMsDepuisDemarrage: 0 }),
  lireAttentesPool: async () => [],
  balayerRisque: async () => null,
  reinitialiserMfa: async () => null,
};

export const rappelsRcsInertes: Pick<RcsCallbackRouteDeps, 'noterRappel'> = {
  // Absente : aucune trace du corps reçu.
  noterRappel: async () => {},
};

export const reglagesInertes: Pick<SettingsRouteDeps,
  'rcsEnabledFor' | 'applyMbaHandoffEnabled' | 'listerRequetesConnecteur' | 'setOptoutRequestId'
  | 'setMentionIaFrequence' | 'setAgentTransfertMode' | 'setAgentsPeuventPrendre' | 'setHubspotActif'
  | 'listerAgentsPourConformite'> = {
  // Absente : `false`, briques éteintes.
  rcsEnabledFor: async () => false,
  // Absente : rien n'était appliqué chez Meta (`appliqueChezMeta: false`). Un échec produit ce même `false`.
  applyMbaHandoffEnabled: async () => { throw new Error('valeur inerte : passage de main non appliqué chez Meta'); },
  listerRequetesConnecteur: async () => [],
  setOptoutRequestId: neDevraitPasEtreAppelee('setOptoutRequestId'),
  setMentionIaFrequence: neDevraitPasEtreAppelee('setMentionIaFrequence'),
  setAgentTransfertMode: neDevraitPasEtreAppelee('setAgentTransfertMode'),
  setAgentsPeuventPrendre: neDevraitPasEtreAppelee('setAgentsPeuventPrendre'),
  setHubspotActif: neDevraitPasEtreAppelee('setHubspotActif'),
  // Absente : liste vide.
  listerAgentsPourConformite: async () => [],
};

export const statsInertes: Pick<StatsRouteDeps,
  'getErrorContacts' | 'getCoutParCampagne' | 'getCoutMessages' | 'getCoutIa' | 'getDetailCoutCampagne'
  | 'getNuageQualitatif' | 'getJoursAnalyse' | 'getWorkflowNodeCounts'> = {
  getErrorContacts: async () => [],
  getCoutParCampagne: neDevraitPasEtreAppelee('getCoutParCampagne'),
  getCoutMessages: neDevraitPasEtreAppelee('getCoutMessages'),
  getCoutIa: neDevraitPasEtreAppelee('getCoutIa'),
  getDetailCoutCampagne: async () => null,
  getNuageQualitatif: neDevraitPasEtreAppelee('getNuageQualitatif'),
  getJoursAnalyse: async () => [],
  getWorkflowNodeCounts: async () => [],
};

export const supportInerte: Pick<SupportRouteDeps, 'getUserEmail'> = {
  // Absente : pas de reply-to.
  getUserEmail: async () => null,
};

export const modelesInertes: Pick<TemplateRouteDeps,
  'getPublishedFlow' | 'listActiveCampaignsForTemplate' | 'saveParamHints' | 'getParamHints' | 'removeParamHints' | 'tracking'> = {
  // Absente : pas de pré-check, donc « publié ».
  getPublishedFlow: async () => true,
  // Absente : pas de garde-fou, donc aucune campagne active.
  listActiveCampaignsForTemplate: async () => [],
  // Absents : propagation désactivée.
  saveParamHints: async () => {},
  getParamHints: async () => [],
  removeParamHints: async () => {},
  /**
   * Absent : le template partait avec les liens SAISIS. Une réservation qui LÈVE produit exactement ce
   * repli (`preparerLiens` l'avale), et une table de destinations vide ne ré-habille rien.
   */
  tracking: {
    allocate: async () => { throw new Error('valeur inerte : traçage des liens éteint'); },
    confirm: async () => {},
    lienDe: (code: string) => code,
    destinations: async () => new Map(),
  },
};

export const membresInertes: Pick<UsersRouteDeps,
  'audit' | 'createPendingUser' | 'setUserName' | 'createInviteToken' | 'getInviterName' | 'getWorkspaceName'
  | 'renommerEspace' | 'reinitialiserMfa' | 'appUrl'> = {
  audit: journalMuet,
  createPendingUser: neDevraitPasEtreAppelee('createPendingUser'),
  setUserName: neDevraitPasEtreAppelee('setUserName'),
  createInviteToken: neDevraitPasEtreAppelee('createInviteToken'),
  // Absentes : phrase générique dans l'e-mail d'invitation.
  getInviterName: async () => null,
  getWorkspaceName: async () => null,
  renommerEspace: neDevraitPasEtreAppelee('renommerEspace'),
  reinitialiserMfa: neDevraitPasEtreAppelee('reinitialiserMfa'),
  // Absente : aucun e-mail d'invitation ne partait. Une adresse vide produit le même saut.
  appUrl: '',
};

export const scenariosInertes: Pick<WorkflowRouteDeps,
  'publishWorkflow' | 'audit' | 'declareTags' | 'ensureTestToken' | 'getDisplayPhoneNumber'> = {
  publishWorkflow: async () => null,
  audit: journalMuet,
  // Absente : aucune déclaration.
  declareTags: async () => {},
  ensureTestToken: async () => null,
  // Absente : aucun numéro, donc lien wa.me sans numéro.
  getDisplayPhoneNumber: async () => null,
};

export const mcpInerte: Pick<DepsMcp, 'getControlOwner' | 'getAssignee' | 'setAssignee'> = {
  getControlOwner: async () => 'app_workflow',
  getAssignee: async () => undefined,
  setAssignee: neDevraitPasEtreAppelee('setAssignee'),
};
