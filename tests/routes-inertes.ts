import type { AuditSink } from '../src/audit/journal';
import type { AccountRouteDeps } from '../src/http/account';
import type { AgentKnowledgeRouteDeps } from '../src/http/agent-knowledge';
import type { AgentRequetesRouteDeps } from '../src/http/agent-requetes';
import type { AgentSetupRouteDeps } from '../src/http/agent-setup';
import type { AgentTestRouteDeps } from '../src/http/agent-test';
import type { AgentsRouteDeps } from '../src/http/agents';
import type { AideRouteDeps } from '../src/http/aide';
import type { CampagnesDep, CampaignRouteDeps } from '../src/http/campaigns';
import type { CampaignRepoLike } from '../src/campaign/create';
import type { ContactsDep, ContactsRouteDeps } from '../src/http/contacts';
import type { EmbeddedSignupRouteDeps, MetaInscriptionDep } from '../src/http/embedded-signup';
import type { FieldsRouteDeps } from '../src/http/fields';
import type { InboxDep, InboxRouteDeps } from '../src/http/inbox';
import type { LiensDep } from '../src/http/links';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import type { MbaRouteDeps } from '../src/http/mba';
import type { ExploitationOps, OpsRouteDeps } from '../src/http/ops';
import type { RcsCallbackRouteDeps } from '../src/http/rcs-callback';
import type { ReglagesDep, SettingsRouteDeps } from '../src/http/settings';
import type { AnalysesDep, StatsRouteDeps } from '../src/http/stats';
import type { SupportRouteDeps } from '../src/http/support';
import type { TemplateRouteDeps } from '../src/http/templates';
import type { MembresDep, UsersRouteDeps } from '../src/http/users';
import type { ScenariosDep, WorkflowRouteDeps } from '../src/http/workflows';
import type { DepsMcp } from '../src/mcp/outils';
import { MODELES_CHOISIS } from '../src/agent/modeles';
import { SANS_PLAFOND } from '../src/campaign/pacing';
import { PLAFOND_DESTINATAIRES_DEFAUT } from '../src/campaign/plafond';
import { creerTravauxEnVol } from '../src/lib/en-vol';

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

export const essaiAgentInerte: Pick<AgentTestRouteDeps, 'essais' | 'credits' | 'debiter'> = {
  // Absent : liste vide à la lecture, rien d'écrit après un essai.
  essais: { lister: async () => [], ecrire: async () => {}, purger: async () => 0 },
  credits: { solde: soldeIllimite },
  debiter: sansDebit,
};

export const agentsInertes: Pick<AgentsRouteDeps, 'credits' | 'sessions' | 'etatPourLint' | 'modelesProposes'> = {
  credits: { solde: async () => 0, historique: async () => [] },
  sessions: {
    consommation: neDevraitPasEtreAppelee('consommation'),
    messagesTenus: async () => 0,
  },
  // Pas d'état = « agent introuvable » : un test qui ACTIVE un agent fournit le sien.
  etatPourLint: async () => null,
  // Absente : nos modèles, SANS tarif. C'est exactement ce que la route rendait.
  modelesProposes: async () => MODELES_CHOISIS.map((m) => ({ ...m, prixEntree: null, prixSortie: null })),
};

export const campagnesInertes: Pick<CampaignRouteDeps,
  'getMessagingLimitTier' | 'drafts' | 'contacts' | 'identifiantsDeTousLesContacts' | 'plafondDestinataires'
  | 'rcs' | 'emailTemplateBelongsToTenant' | 'webhookUsableByTenant' | 'defaultRatePerMinute' | 'plafondLePlusBas'> = {
  // Absent : aucun palier connu, donc aucun avertissement.
  getMessagingLimitTier: async () => null,
  drafts: {
    list: async () => [],
    create: neDevraitPasEtreAppelee('drafts.create'),
    update: async () => false,
    remove: async () => false,
  },
  contacts: { contactIdsForTarget: async () => [] },
  // Absente : « tous les contacts » n'était pas résolu ici. Une liste vide est lue de la même façon en aval
  // (`createCampaignWithRecipients` la traite comme « tous »), et ne dépasse aucun plafond.
  identifiantsDeTousLesContacts: async () => [],
  plafondDestinataires: PLAFOND_DESTINATAIRES_DEFAUT,
  // Absentes : aucune campagne RCS, e-mail ou au fil de l'eau n'était créable. Refuser dit la même chose.
  rcs: { belongsToTenant: async () => false, listForTenant: async () => [] },
  emailTemplateBelongsToTenant: async () => false,
  webhookUsableByTenant: async () => false,
  defaultRatePerMinute: 0,
  plafondLePlusBas: SANS_PLAFOND,
};

export const campagnesRepoInerte: Pick<CampagnesDep, 'stopWebhookCampaign' | 'pauseCampaign' | 'resumeCampaign'> = {
  // Absente : 404 « non arrêtable ». `false` produit le même 404.
  stopWebhookCampaign: async () => false,
  pauseCampaign: async () => false,
  // Absente : la levée de pause était sautée. `false` = rien n'était en pause, même effet.
  resumeCampaign: async () => false,
};
/** La création de campagne, qu'aucun test de ce montage n'atteint. */
export const creationInerte: CampaignRepoLike = {
  listContactsForBuild: neDevraitPasEtreAppelee('listContactsForBuild'),
  listContactsForBuildByIds: neDevraitPasEtreAppelee('listContactsForBuildByIds'),
  createWithRecipients: neDevraitPasEtreAppelee('createWithRecipients'),
};

export const contactsInertes: Pick<ContactsRouteDeps,
  'audit' | 'journal' | 'erreurs' | 'ensureSocleField' | 'createOneContact' | 'getBilanContact' | 'emitTagAdded' | 'listeDeLAgent' | 'enVol'> = {
  audit: journalMuet,
  journal: { list: async () => [] },
  erreurs: { lister: async () => [], listerEchecsSysteme: async () => [] },
  // Absente : le champ socle n'était pas créé, d'où le refus « champ inconnu ». Ne rien créer le garde.
  ensureSocleField: async () => {},
  createOneContact: neDevraitPasEtreAppelee('createOneContact'),
  getBilanContact: async () => null,
  // Absente : aucune émission.
  emitTagAdded: async () => {},
  // Aucun contact purgé n'est sur la liste de l'agent de Meta : rien à y retirer (la purge y est d'ailleurs inerte).
  listeDeLAgent: { oublierChezMeta: async () => {} },
  // Un vrai registre : le retrait d'après la purge y est suivi, et rien ne l'attend dans ces tests.
  enVol: creerTravauxEnVol(),
};

export const contactsDepInerte: Pick<ContactsDep,
  'setBlocked' | 'listBlocked' | 'listeDesabonnes' | 'messagesARelire' | 'purgeMany' | 'contactIdsForTarget'> = {
  setBlocked: neDevraitPasEtreAppelee('setBlocked'),
  listBlocked: async () => [],
  listeDesabonnes: async () => [],
  messagesARelire: async () => ({ scannes: 0, messages: [] }),
  purgeMany: neDevraitPasEtreAppelee('purgeMany'),
  contactIdsForTarget: async () => [],
};

export const historiqueContactInerte: Pick<ContactsRouteDeps['contactHistory'], 'resumeContact'> = {
  resumeContact: async () => null,
};

export const signupInerte: Pick<EmbeddedSignupRouteDeps, 'audit'> = {
  audit: journalMuet,
};

export const metaInscriptionInerte: Pick<MetaInscriptionDep, 'wabasForToken' | 'listPhones'> = {
  wabasForToken: async () => [],
  listPhones: async () => [],
};

export const champsInertes: Pick<FieldsRouteDeps, 'tenantCode' | 'contacts'> = {
  // Absent : réponse sans `tenantCode`. Une chaîne vide produit la même réponse.
  tenantCode: async () => '',
  // Absente : relevé vide.
  contacts: { fieldUsage: async () => ({ total: 0, parChamp: {} }) },
};

/** `takeControl` absente : l'état local du fil ne bougeait pas. */
export const priseDeFilSansEffet = async (): Promise<void> => {};

/** `compterConversations` absente : la route rendait ces zéros. */
export const COMPTEURS_VIDES = { tout: 0, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] };

export const inboxInerte: Pick<InboxRouteDeps,
  'audit' | 'lireMediaMessage' | 'agentsPeuventPrendre' | 'takeControl' | 'reprendreLaMain' | 'releaseControl'
  | 'resolveTemplateParams' | 'sendRcsFromInbox' | 'categorieDuModele' | 'prepareCarousel' | 'startWorkflow'> = {
  audit: journalMuet,
  lireMediaMessage: async () => null,
  // Absente : `false`, le comportement d'avant le réglage.
  agentsPeuventPrendre: async () => false,
  // Absentes : l'état local du fil ne bougeait pas, et « Reprendre la main » réussissait sans rien écrire.
  takeControl: priseDeFilSansEffet,
  reprendreLaMain: async () => 'pris',
  releaseControl: neDevraitPasEtreAppelee('releaseControl'),
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

export const inboxDepInerte: Pick<InboxDep,
  'effacerMessages' | 'ouvrirConversationDuContact' | 'countUnread' | 'countATraiter' | 'compterConversations'
  | 'archiverConversation' | 'signalerConversation' | 'marquerTraitee' | 'getAssignee' | 'setAssignee'
  | 'prendreSiLibre' | 'membresPourAffectation' | 'markConversationRead' | 'getControlOwner' | 'detailConversation'> = {
  effacerMessages: neDevraitPasEtreAppelee('effacerMessages'),
  ouvrirConversationDuContact: async () => null,
  // Absents : 0, la pastille ne s'affichait pas.
  countUnread: async () => 0,
  countATraiter: async () => 0,
  compterConversations: async () => COMPTEURS_VIDES,
  archiverConversation: async () => false,
  signalerConversation: async () => false,
  marquerTraitee: async () => false,
  // Absente : personne n'était considéré comme affecté, tout le monde écrivait. `undefined` (conversation
  // inconnue) est précisément le cas où `refusAffectation` ne se prononce pas.
  getAssignee: async () => undefined,
  setAssignee: neDevraitPasEtreAppelee('setAssignee'),
  prendreSiLibre: async () => false,
  membresPourAffectation: async () => [],
  markConversationRead: async () => {},
  // Absente : `app_workflow`, l'état d'une conversation dont personne n'a pris le contrôle.
  getControlOwner: async () => 'app_workflow',
  // Absente : la route n'existait pas, l'écran repliait le panneau. `null` rend le même 404.
  detailConversation: async () => null,
};

/** `campagneVivante` absente : aucune garde, donc aucune campagne au fil de l'eau n'était vue. */
export const aucuneCampagneVivante = async (): Promise<string | null> => null;

export const liensInertes: Pick<LiensDep, 'contactParJeton'> = {
  // Absente : les clics restaient anonymes.
  contactParJeton: async () => null,
};

export const relaisMbaInerte: Pick<MbaRelaisDeps, 'journaliserForme'> = {
  journaliserForme: () => {},
};

export const mbaInerte: Pick<MbaRouteDeps, 'journaliserSuppression' | 'reglages' | 'stats' | 'attendre'> = {
  journaliserSuppression: async () => {},
  reglages: { setMbaEnabled: neDevraitPasEtreAppelee('setMbaEnabled') },
  stats: { messagesEcritsParMba: async () => 0 },
  // Sans attente : la seconde relecture de l'audience à l'allumage part tout de suite.
  attendre: async () => {},
};

export const opsInerte: Pick<OpsRouteDeps,
  'deposerJetonPub' | 'lireGrillePrix' | 'reglages' | 'verrouillerEspace' | 'observerTenant'
  | 'file' | 'heartbeat' | 'soldeAgent' | 'rechargerAgent' | 'etatPoolInstantane' | 'attentesPool'
  | 'balayerRisque' | 'reinitialiserMfa'> = {
  deposerJetonPub: neDevraitPasEtreAppelee('deposerJetonPub'),
  lireGrillePrix: neDevraitPasEtreAppelee('lireGrillePrix'),
  reglages: { setGrillePrixGlobale: neDevraitPasEtreAppelee('reglages.setGrillePrixGlobale') },
  verrouillerEspace: neDevraitPasEtreAppelee('verrouillerEspace'),
  observerTenant: async () => null,
  file: { enqueue: neDevraitPasEtreAppelee('file.enqueue') },
  // Absent : `worker: null`.
  heartbeat: { get: async () => null },
  soldeAgent: async () => null,
  rechargerAgent: neDevraitPasEtreAppelee('rechargerAgent'),
  // Absente : `poolInstantane: null`. Aucun état ne dit « rien » ; un pool vide est le plus proche.
  etatPoolInstantane: () => ({ process: 'test', total: 0, libres: 0, enAttente: 0, max: 0, maxMsDepuisDemarrage: 0 }),
  attentesPool: { lireDernieresMinutes: async () => [] },
  balayerRisque: async () => null,
  reinitialiserMfa: async () => null,
};

export const exploitationInerte: Pick<ExploitationOps,
  'getQueueLoadParGroupe' | 'getQueueLatence' | 'listerJobsMorts' | 'oublierJobsMorts'> = {
  // Absentes : l'écran rendait ces listes vides.
  getQueueLoadParGroupe: async () => [],
  getQueueLatence: async () => [],
  listerJobsMorts: async () => [],
  oublierJobsMorts: neDevraitPasEtreAppelee('exploitation.oublierJobsMorts'),
};

export const rappelsRcsInertes: Pick<RcsCallbackRouteDeps['agents'], 'noterRappel'> = {
  // Absente : aucune trace du corps reçu.
  noterRappel: async () => {},
};

export const reglagesInertes: Pick<SettingsRouteDeps, 'rcs' | 'applyMbaHandoffEnabled' | 'listerRequetesConnecteur' | 'agents'> = {
  // Absente : `false`, briques éteintes.
  rcs: { hasAgent: async () => false },
  // Absente : rien n'était appliqué chez Meta (`appliqueChezMeta: false`). Un échec produit ce même `false`.
  applyMbaHandoffEnabled: async () => { throw new Error('valeur inerte : passage de main non appliqué chez Meta'); },
  listerRequetesConnecteur: async () => [],
  // Absente : liste vide.
  agents: { listerPourConformite: async () => [] },
};

/** Les écritures de réglages qu'aucun test de ce montage ne devrait atteindre. */
export const reglagesDepInertes: Pick<ReglagesDep,
  'setOptoutRequestId' | 'setMentionIaFrequence' | 'setAgentTransfertMode' | 'setAgentsPeuventPrendre' | 'setHubspotActif'> = {
  setOptoutRequestId: neDevraitPasEtreAppelee('setOptoutRequestId'),
  setMentionIaFrequence: neDevraitPasEtreAppelee('setMentionIaFrequence'),
  setAgentTransfertMode: neDevraitPasEtreAppelee('setAgentTransfertMode'),
  setAgentsPeuventPrendre: neDevraitPasEtreAppelee('setAgentsPeuventPrendre'),
  setHubspotActif: neDevraitPasEtreAppelee('setHubspotActif'),
};

export const statsInertes: Pick<StatsRouteDeps,
  'getErrorContacts' | 'getCoutParCampagne' | 'getCoutMessages' | 'getCoutIa' | 'getDetailCoutCampagne'
  | 'getWorkflowNodeCounts' | 'getPerformance'> = {
  getErrorContacts: async () => [],
  getCoutParCampagne: neDevraitPasEtreAppelee('getCoutParCampagne'),
  getCoutMessages: neDevraitPasEtreAppelee('getCoutMessages'),
  getCoutIa: neDevraitPasEtreAppelee('getCoutIa'),
  getPerformance: neDevraitPasEtreAppelee('getPerformance'),
  getDetailCoutCampagne: async () => null,
  getWorkflowNodeCounts: async () => [],
};

export const analysesInertes: Pick<AnalysesDep, 'getNuageQualitatif' | 'joursAnalyse'> = {
  getNuageQualitatif: neDevraitPasEtreAppelee('getNuageQualitatif'),
  joursAnalyse: async () => [],
};

export const supportInerte: Pick<SupportRouteDeps, 'getUserEmail'> = {
  // Absente : pas de reply-to.
  getUserEmail: async () => null,
};

export const modelesInertes: Pick<TemplateRouteDeps, 'getPublishedFlow' | 'indices' | 'tracking'> = {
  // Absente : pas de pré-check, donc « publié ».
  getPublishedFlow: async () => true,
  // Absents : propagation désactivée.
  indices: {
    save: async () => {},
    get: async () => [],
    removeByName: async () => {},
  },
  /**
   * Absent : le template partait avec les liens SAISIS. Une réservation qui LÈVE produit exactement ce
   * repli (`preparerLiens` l'avale), et une table de destinations vide ne ré-habille rien.
   */
  tracking: {
    allocate: async () => { throw new Error('valeur inerte : traçage des liens éteint'); },
    liens: { confirm: async () => {} },
    lienDe: (code: string) => code,
    destinations: async () => new Map(),
  },
};

/** `listActiveCampaignsForTemplate` absente : pas de garde-fou, donc aucune campagne active. */
export const aucuneCampagneActive = async (): Promise<[]> => [];

export const membresInertes: Pick<UsersRouteDeps, 'audit' | 'createInviteToken' | 'getInviterName' | 'mfa' | 'appUrl'> = {
  audit: journalMuet,
  createInviteToken: neDevraitPasEtreAppelee('createInviteToken'),
  // Absente : phrase générique dans l'e-mail d'invitation.
  getInviterName: async () => null,
  mfa: { reinitialiserDansEspace: neDevraitPasEtreAppelee('reinitialiserDansEspace') },
  // Absente : aucun e-mail d'invitation ne partait. Une adresse vide produit le même saut.
  appUrl: '',
};

export const membresDepInertes: Pick<MembresDep, 'createPending' | 'setName' | 'getTenantName' | 'setTenantName'> = {
  createPending: neDevraitPasEtreAppelee('createPending'),
  setName: neDevraitPasEtreAppelee('setName'),
  // Absente : phrase générique dans l'e-mail d'invitation.
  getTenantName: async () => null,
  setTenantName: neDevraitPasEtreAppelee('setTenantName'),
};

export const scenariosDepInerte: Pick<ScenariosDep, 'publish' | 'ensureTestToken'> = {
  publish: async () => null,
  ensureTestToken: async () => null,
};

export const scenariosInertes: Pick<WorkflowRouteDeps, 'audit' | 'declareTags' | 'getDisplayPhoneNumber'> = {
  audit: journalMuet,
  // Absente : aucune déclaration.
  declareTags: async () => {},
  // Absente : aucun numéro, donc lien wa.me sans numéro.
  getDisplayPhoneNumber: async () => null,
};

export const mcpInerte: Pick<DepsMcp['inbox'], 'getControlOwner' | 'getAssignee' | 'setAssignee'> = {
  getControlOwner: async () => 'app_workflow',
  getAssignee: async () => undefined,
  setAssignee: neDevraitPasEtreAppelee('setAssignee'),
};
