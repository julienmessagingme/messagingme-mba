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
import type { DepsReglageRepondeur } from '../src/repondeur/reglage';
import { MODELES_CHOISIS } from '../src/agent/modeles';
import { SANS_PLAFOND } from '../src/campaign/pacing';
import { PLAFOND_DESTINATAIRES_DEFAUT } from '../src/campaign/plafond';
import { creerTravauxEnVol } from '../src/lib/en-vol';
import { DROITS, FONCTIONS } from '../src/offres/offres';
import { grilleDesOffres } from '../src/offres/vue';
import type { StripeWebhookRouteDeps } from '../src/http/credit-stripe';
import { offresToutOuvert } from './gardes';

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

/**
 * Le répondeur de l'espace (lot 5, RC6), pour les montages qui n'en parlent pas : mode « Équipe », aucun agent ni
 * scénario, agent de Meta éteint (la lecture de `GET /agents`), et toute ÉCRITURE lève. Ses portes ont leurs propres
 * cas, `tests/repondeur-reglage.test.ts`.
 */
export const repondeurInerte: DepsReglageRepondeur = {
  agents: { complet: async () => null },
  scenarios: { getById: async () => null, listResume: async () => [] },
  reglages: {
    get: async () => ({ mbaEnabled: false, repondeurMode: 'equipe', repondeurAgentId: null, repondeurWorkflowId: null, repondeurAdresseId: null, repondeurDelaiScenarioS: 86400 }),
    setRepondeur: neDevraitPasEtreAppelee('setRepondeur'),
  },
  gatewayDisponible: false,
  activation: {
    numeroDuTenant: async () => null,
    eligible: neDevraitPasEtreAppelee('eligible'),
    ecrireChezMeta: neDevraitPasEtreAppelee('ecrireChezMeta'),
    ecrireDrapeau: neDevraitPasEtreAppelee('ecrireDrapeau'),
  },
  liste: { toutRetirer: neDevraitPasEtreAppelee('toutRetirer') },
  historique: { ecrire: neDevraitPasEtreAppelee('historique.ecrire') },
  fils: { reprendreLesFilsDeMeta: neDevraitPasEtreAppelee('reprendreLesFilsDeMeta') },
  offres: offresToutOuvert,
  adresses: { lire: async () => null, lister: async () => [] },
};

export const agentsInertes: Pick<AgentsRouteDeps, 'credits' | 'sessions' | 'etatPourLint' | 'modelesProposes' | 'historique' | 'oublierRepondeur' | 'repondeur'> = {
  credits: { solde: async () => 0, historique: async () => [] },
  sessions: {
    consommation: neDevraitPasEtreAppelee('consommation'),
    messagesTenus: async () => 0,
  },
  // Pas d'état = « agent introuvable » : un test qui ACTIVE un agent fournit le sien.
  etatPourLint: async () => null,
  // Absente : nos modèles, SANS tarif. C'est exactement ce que la route rendait.
  modelesProposes: async () => MODELES_CHOISIS.map((m) => ({ ...m, prixEntree: null, prixSortie: null })),
  // Absent : aucune modification de fiche n'était journalisée (lot 8a). Un journal muet dit la même chose.
  historique: { ecrire: async () => {} },
  // Avant le lot 5, rien n'était désigné répondeur : désactiver un agent n'en retirait aucun.
  oublierRepondeur: async () => false,
  repondeur: repondeurInerte,
};

export const campagnesInertes: Pick<CampaignRouteDeps,
  'getMessagingLimitTier' | 'drafts' | 'contacts' | 'identifiantsDeTousLesContacts' | 'plafondDestinataires'
  | 'rcs' | 'emailTemplateBelongsToTenant' | 'webhookUsableByTenant' | 'defaultRatePerMinute' | 'plafondLePlusBas'
  | 'modelesDuLancement' | 'offres'> = {
  // Absent : aucun palier connu, donc aucun avertissement.
  getMessagingLimitTier: async () => null,
  // Tout ouvert : une campagne à scénario est permise (lot 6, B2a).
  offres: offresToutOuvert,
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
  // Les modèles du mois sans limite (lot 6) : un espace Pro, l'hypothèse des tests qui ne parlent pas d'offre.
  modelesDuLancement: async () => null,
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
  'audit' | 'journal' | 'erreurs' | 'ensureSocleField' | 'createOneContact' | 'getBilanContact' | 'etiquettes' | 'listeDeLAgent' | 'enVol'
  | 'suppressionsDuJour'> = {
  audit: journalMuet,
  journal: { list: async () => [] },
  erreurs: { lister: async () => [], listerEchecsSysteme: async () => [] },
  // Absente : le champ socle n'était pas créé, d'où le refus « champ inconnu ». Ne rien créer le garde.
  ensureSocleField: async () => {},
  createOneContact: neDevraitPasEtreAppelee('createOneContact'),
  getBilanContact: async () => null,
  // Absente : ni déclaration ni émission. Les cas qui les observent montent le vrai module (`tests/contacts.test.ts`).
  etiquettes: { apresPose: async () => {} },
  // Aucun contact purgé n'est sur la liste de l'agent de Meta : rien à y retirer (la purge y est d'ailleurs inerte).
  listeDeLAgent: { oublierChezMeta: async () => {} },
  // Un vrai registre : le retrait d'après la purge y est suivi, et rien ne l'attend dans ces tests.
  enVol: creerTravauxEnVol(),
  // Les suppressions du jour sans limite (lot 6) : un espace Pro, l'hypothèse des tests qui ne parlent pas d'offre.
  suppressionsDuJour: { consommer: async () => ({ ok: true }) },
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
export const COMPTEURS_VIDES = { tout: 0, aTraiter: 0, urgentes: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] };

export const inboxInerte: Pick<InboxRouteDeps,
  'audit' | 'lireMediaMessage' | 'agentsPeuventPrendre' | 'takeControl' | 'filTenuParLApplication' | 'reprendreLaMain' | 'releaseControl'
  | 'resolveTemplateParams' | 'sendRcsFromInbox' | 'categorieDuModele' | 'prepareCarousel' | 'startWorkflow'> = {
  audit: journalMuet,
  lireMediaMessage: async () => null,
  // Absente : `false`, le comportement d'avant le réglage.
  agentsPeuventPrendre: async () => false,
  // Absentes : l'état local du fil ne bougeait pas, et « Reprendre la main » réussissait sans rien écrire.
  takeControl: priseDeFilSansEffet,
  // Absente : aucun espace en mode « mon application répond », la réponse prend le fil comme avant le lot 12.
  filTenuParLApplication: async () => false,
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
  | 'archiverConversation' | 'signalerConversation' | 'marquerUrgente' | 'marquerTraitee' | 'getAssignee' | 'setAssignee'
  | 'prendreSiLibre' | 'membresPourAffectation' | 'markConversationRead' | 'getControlOwner' | 'detailConversation'> = {
  effacerMessages: neDevraitPasEtreAppelee('effacerMessages'),
  ouvrirConversationDuContact: async () => null,
  // Absents : 0, la pastille ne s'affichait pas.
  countUnread: async () => 0,
  countATraiter: async () => 0,
  compterConversations: async () => COMPTEURS_VIDES,
  archiverConversation: async () => false,
  signalerConversation: async () => false,
  // Absente : la route n'existait pas ; `false` rend le 404 d'une conversation inconnue.
  marquerUrgente: async () => false,
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

export const liensInertes: Pick<LiensDep, 'contactParJeton' | 'champsParJeton'> = {
  // Absente : les clics restaient anonymes.
  contactParJeton: async () => null,
  // Aucune fiche : les champs d'une destination sont retirés (et une destination sans champ ne l'appelle jamais).
  champsParJeton: async () => null,
};

export const relaisMbaInerte: Pick<MbaRelaisDeps, 'journaliserForme' | 'resolveurMcp'> = {
  journaliserForme: () => {},
  resolveurMcp: neDevraitPasEtreAppelee('resolveurMcp'),
};

export const mbaInerte: Pick<MbaRouteDeps, 'journaliserSuppression' | 'reglages' | 'stats' | 'attendre' | 'formulaires'> = {
  journaliserSuppression: async () => {},
  formulaires: { estPublie: neDevraitPasEtreAppelee('formulaires.estPublie') },
  reglages: { setMbaEnabled: neDevraitPasEtreAppelee('setMbaEnabled') },
  stats: { messagesEcritsParMba: async () => 0 },
  // Sans attente : la seconde relecture de l'audience à l'allumage part tout de suite.
  attendre: async () => {},
};

export const opsInerte: Pick<OpsRouteDeps,
  'deposerJetonPub' | 'lireGrillePrix' | 'reglages' | 'verrouillerEspace' | 'observerTenant'
  | 'file' | 'heartbeat' | 'soldeAgent' | 'rechargerAgent' | 'etatPoolInstantane' | 'attentesPool' | 'latencesHttp'
  | 'mesuresTaches' | 'stockage'
  | 'balayerRisque' | 'reinitialiserMfa'> = {
  deposerJetonPub: neDevraitPasEtreAppelee('deposerJetonPub'),
  lireGrillePrix: neDevraitPasEtreAppelee('lireGrillePrix'),
  reglages: { setGrillePrixGlobale: neDevraitPasEtreAppelee('reglages.setGrillePrixGlobale') },
  verrouillerEspace: neDevraitPasEtreAppelee('verrouillerEspace'),
  observerTenant: async () => null,
  file: { enqueue: neDevraitPasEtreAppelee('file.enqueue') },
  // Absent : `worker: null`.
  heartbeat: { lister: async () => [] },
  soldeAgent: async () => null,
  rechargerAgent: neDevraitPasEtreAppelee('rechargerAgent'),
  // Absente : `poolInstantane: null`. Aucun état ne dit « rien » ; un pool vide est le plus proche.
  etatPoolInstantane: () => ({ process: 'test', total: 0, libres: 0, enAttente: 0, max: 0, maxMsDepuisDemarrage: 0 }),
  attentesPool: { lireDernieresMinutes: async () => [] },
  latencesHttp: { lire: async () => [] },
  mesuresTaches: { lire: async () => [] },
  // Une base vide : aucune famille, aucune table.
  stockage: { mesurer: async () => ({ baseOctets: 0, familles: [], tables: [], mesureLe: '1970-01-01T00:00:00.000Z' }) },
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
  'getErrorContacts' | 'getCoutParCampagne' | 'getCoutParPub' | 'getCoutMessages' | 'getCoutIa' | 'getDetailCoutCampagne'
  | 'getWorkflowNodeCounts' | 'getPerformance'> = {
  getErrorContacts: async () => [],
  getCoutParCampagne: neDevraitPasEtreAppelee('getCoutParCampagne'),
  getCoutParPub: neDevraitPasEtreAppelee('getCoutParPub'),
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

export const modelesInertes: Pick<TemplateRouteDeps, 'getPublishedFlow' | 'indices' | 'tracking' | 'champsDeclares'> = {
  // Absente : pas de pré-check, donc « publié ».
  getPublishedFlow: async () => true,
  // Aucun champ déclaré : seuls les champs de base (`prenom`, `nom`, `telephone`) passent dans une adresse.
  champsDeclares: async () => [],
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
    // Aucun lien en base : rien à remettre en l'état, rien de périmé.
    liens: { confirm: async () => {}, deconfirmer: async () => {}, listByTemplates: async () => [] },
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

/**
 * La pose d'étiquettes de `tag_conversation`, pour les montages qui ne posent rien : une ÉCRITURE, donc elle lève. Le
 * cas qui la regarde monte le vrai module (`tests/mcp-serveur.test.ts`).
 */
export const mcpEtiquettesInertes: Pick<DepsMcp, 'etiquettes'> = {
  etiquettes: { poser: neDevraitPasEtreAppelee('etiquettes.poser') },
};

/**
 * Les widgets et les scénarios du MCP (lot 5 du widget), pour les montages qui ne parlent pas des widgets : les
 * LECTURES rendent le vide, les ÉCRITURES lèvent. Leurs outils ont leur propre fichier, `tests/mcp-widgets.test.ts`.
 */
export const mcpWidgetsInertes: Pick<DepsMcp, 'widgets' | 'scenarios'> = {
  widgets: {
    gestion: {
      widgets: {
        lister: async () => [],
        creer: neDevraitPasEtreAppelee('widgets.creer'),
        modifier: neDevraitPasEtreAppelee('widgets.modifier'),
        supprimer: neDevraitPasEtreAppelee('widgets.supprimer'),
      },
      phrasesDesLiens: async () => [],
      messagesContenantLaPhrase: async () => 0,
      scenarioEtat: async () => 'inconnu',
offres: offresToutOuvert,
    },
    numero: async () => null,
    baseApi: 'https://api.inerte.test',
  },
  scenarios: { listResume: async () => [] },
};

/**
 * L'agent IA et le crédit du MCP (lot 8a), pour les montages qui n'en parlent pas : les LECTURES rendent le vide (aucun
 * agent, solde nul), les ÉCRITURES lèvent. Leurs outils ont leur propre fichier, `tests/mcp-agent.test.ts`.
 */
/**
 * La connexion du numéro du MCP (lot 3c), pour les montages qui n'en parlent pas : la LECTURE de l'état rend un espace
 * sans rien, la signature d'un lien lève. Ses outils ont leur propre fichier, `tests/mcp-numero.test.ts`.
 */
export const mcpNumeroInerte: Pick<DepsMcp, 'numero'> = {
  numero: {
    signerLien: neDevraitPasEtreAppelee('numero.signerLien'),
    etat: async () => ({ fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: false }),
    urlConsole: 'https://console.inerte.test',
    attendre: async () => {},
    maintenant: () => Date.now(),
    ouvrirPortail: neDevraitPasEtreAppelee('numero.ouvrirPortail'),
    // Lot 4 : aucun abonnement, donc aucun rappel dans les réponses d'outil.
    abonnement: async () => null,
    ouvrirAbonnement: neDevraitPasEtreAppelee('numero.ouvrirAbonnement'),
    // Lot 6, B2b : aucun Pro, donc aucune suite à rappeler ; rendre le numéro n'est pas le sujet de ces montages.
    suiteDuPro: async () => null,
    rendreLeNumero: neDevraitPasEtreAppelee('numero.rendreLeNumero'),
  },
};

/** L'offre du MCP (lot 6), pour les montages qui n'en parlent pas : un espace Entreprise, sans limite. */
export const mcpOffreInerte: Pick<DepsMcp, 'offre' | 'offres'> = {
  offres: offresToutOuvert,
  offre: {
    vue: async () => ({
      offre: 'entreprise', fonctions: [...FONCTIONS], limites: { ...DROITS.entreprise.limites },
      usage: { envoisModelesMois: null, contacts: 0, automations: 0, membres: 0 }, grille: grilleDesOffres(), prixPro: { moisCentimes: 4900, anCentimes: 49000 },
      suiteDuNumero: null, upgradeUrl: 'https://console.inerte.test/offre',
    }),
  },
};

export const mcpAgentInerte: Pick<DepsMcp, 'agentIa'> = {
  agentIa: {
    gestion: {
      agents: {
        listToutes: async () => [],
        complet: async () => null,
        create: neDevraitPasEtreAppelee('agents.create'),
        patch: neDevraitPasEtreAppelee('agents.patch'),
      },
      modeleParDefaut: 'modele-inerte',
      etatPourLint: async () => null,
      historique: { ecrire: neDevraitPasEtreAppelee('historique.ecrire') },
      oublierRepondeur: neDevraitPasEtreAppelee('oublierRepondeur'),
      credits: { solde: async () => 0, historique: async () => [] },
      modelesProposes: async () => [],
    },
    connaissance: {
      connaissance: {
        lister: async () => [],
        creer: neDevraitPasEtreAppelee('connaissance.creer'),
        modifier: neDevraitPasEtreAppelee('connaissance.modifier'),
        supprimer: neDevraitPasEtreAppelee('connaissance.supprimer'),
        remplacerSource: neDevraitPasEtreAppelee('connaissance.remplacerSource'),
      },
      journaliserSuppression: neDevraitPasEtreAppelee('journaliserSuppression'),
    },
    essai: {
      essais: { lister: async () => [], ecrire: neDevraitPasEtreAppelee('essais.ecrire'), purger: async () => 0 },
      disponible: false,
      credits: { solde: async () => 0 },
      debiter: neDevraitPasEtreAppelee('debiter'),
    },
    paiement: {
      stripe: null,
      clients: { clientDe: neDevraitPasEtreAppelee('clientDe'), retenirClient: neDevraitPasEtreAppelee('retenirClient') },
      payeurAutorise: async () => false,
    },
    outils: {
      listToutes: async () => [],
      ajouter: neDevraitPasEtreAppelee('outils.ajouter'),
      activer: neDevraitPasEtreAppelee('outils.activer'),
    },
    reglages: {
      get: async () => ({ agentTransfertMode: null }),
      setAgentTransfertMode: neDevraitPasEtreAppelee('setAgentTransfertMode'),
    },
    repondeur: repondeurInerte,
  },
};

/**
 * L'abonnement du numéro pour un webhook Stripe qui n'en reçoit pas (lot 6, B1) : un événement d'un autre produit qui y
 * tomberait le trouve inconnu (`null`), jamais enregistré ni réabonné.
 */
export const stripeNumeroInerte: StripeWebhookRouteDeps['numero'] = {
  enregistrer: neDevraitPasEtreAppelee('stripe.numero.enregistrer'),
  majStatut: async () => null,
  noterFinPrevue: async () => false,
  alerter: async () => {},
  reprendreCampagnes: neDevraitPasEtreAppelee('stripe.numero.reprendreCampagnes'),
};

/** Le Pro pour un webhook Stripe qui ne vend que le numéro et la recharge (lot 6, B1) : un événement du Pro y lèverait. */
export const stripeProInerte: StripeWebhookRouteDeps['pro'] = {
  enregistrer: neDevraitPasEtreAppelee('stripe.pro.enregistrer'),
  majStatut: neDevraitPasEtreAppelee('stripe.pro.majStatut'),
  modifier: neDevraitPasEtreAppelee('stripe.pro.modifier'),
  finir: neDevraitPasEtreAppelee('stripe.pro.finir'),
  invalider: neDevraitPasEtreAppelee('stripe.pro.invalider'),
  alerter: async () => {},
  // Une lecture : la fin d'un numéro seul demande si un Pro le couvre (B2b). Aucun Pro ici.
  vivant: async () => false,
  surPassageEnPro: neDevraitPasEtreAppelee('stripe.pro.surPassageEnPro'),
  surFinDuPro: neDevraitPasEtreAppelee('stripe.pro.surFinDuPro'),
};

/**
 * Le statut d'un message, l'envoi au format de Meta et les modèles (lot 13), pour les montages qui n'en parlent pas :
 * aucun message connu, aucun modèle, un espace sans compte WhatsApp, et chaque geste qui écrit LÈVE (un test qui envoie
 * ou crée le dit en passant les siens).
 */
export const mcpMessagesInertes: Pick<DepsMcp, 'messagesApi' | 'envoyerMessage' | 'modeles'> = {
  messagesApi: { message: async () => null },
  envoyerMessage: neDevraitPasEtreAppelee('envoyerMessage'),
  modeles: {
    lister: async () => [],
    modeles: {
      ...modelesInertes,
      meta: { templateClientForTenant: neDevraitPasEtreAppelee('templateClientForTenant') },
      repo: { getTenantWabaId: async () => null, listActiveCampaignsForTemplate: aucuneCampagneActive },
    },
    telechargerEntete: neDevraitPasEtreAppelee('telechargerEntete'),
    deposerEntete: neDevraitPasEtreAppelee('deposerEntete'),
    placesEntete: { prendre: neDevraitPasEtreAppelee('placesEntete.prendre') },
  },
};

/**
 * Les webhooks sortants du MCP (lot 12), pour les montages qui n'en parlent pas : toute ÉCRITURE lève, et les lectures
 * rendent un espace sans adresse.
 */
export const mcpEvenementsInertes: Pick<DepsMcp, 'evenements'> = {
  evenements: {
    gestion: {
      adresses: {
        lister: async () => [], lire: async () => null, existe: async () => false, compterActives: async () => 0,
        creer: neDevraitPasEtreAppelee('evenements.creer'), modifier: neDevraitPasEtreAppelee('evenements.modifier'),
        tourner: neDevraitPasEtreAppelee('evenements.tourner'), supprimer: neDevraitPasEtreAppelee('evenements.supprimer'),
        pourEnvoi: async () => null,
      },
      envois: {
        noterEssai: neDevraitPasEtreAppelee('evenements.noterEssai'), journal: async () => [],
        rejouer: async () => null, rejouerEchecs: async () => [],
      },
      limiteAdresses: async () => null,
      chiffrementPret: true,
      chiffrer: neDevraitPasEtreAppelee('evenements.chiffrer'),
      dechiffrer: neDevraitPasEtreAppelee('evenements.dechiffrer'),
      verifierAdresse: async () => ({ ok: true }),
      appeler: neDevraitPasEtreAppelee('evenements.appeler'),
      enfiler: neDevraitPasEtreAppelee('evenements.enfiler'),
      invaliderCache: () => {},
    },
    audit: async () => {},
  },
};
