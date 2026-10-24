import { ficheOutilMcp, MAX_MESSAGES_MCP as LIMITE_MESSAGES_MCP, type ScopeMcp } from '../../web/lib/partage/catalogue-mcp';
import type { ConversationSummary, ConversationMessage, ListConversationsOptions, ControlOwner } from '../inbox/store.pg';
import type { AnalyseEtResume, BulkEdits, BulkTarget, ContactRow, ContactFilters, IssueActionEnMasse } from '../crm/contact-store.pg';
import { repondreAvecUnMessage, repondreDansLaFenetre, type ConversationsRepondre, type DepsRepondre, type ResultatReponse } from '../inbox/repondre';
import { PHRASE_FORMAT_APPLICATION, phraseApplicationIndisponible } from '../application/envoi';
import { apercuDuMessage, corpsPourMeta, schemaContenuMeta } from '../api/message-meta';
import { messageDeForme } from '../api/forme';
import { MetaApiError } from '../meta/errors';
import { parCause, type AuteurDuChangement } from '../inbox/evenements';
import { NumeroBloqueError } from '../meta/numero-delie';
import { e164DepuisSaisie } from '../crm/phone';
import { LONGUEUR_MAX_ETIQUETTE, nettoyerEtiquettes, type PoseEtiquette } from '../crm/poser-etiquette';
import {
  DEBUT_AVATAR, MAX_AVATAR_URL, MAX_LIBELLE_WIDGET, MAX_NOM_WIDGET, MAX_PAR_HEURE_WIDGET, MAX_PHRASE_WIDGET,
  MOTIF_COULEUR, POSITIONS_WIDGET, LIMITE_WIDGETS_PAR_ESPACE,
  creerWidget, listerEnVue, miseEnVue, modifierWidget,
  type ChampWidget, type DepsWidgets,
} from '../widgets/gestion';
import type { WorkflowResumeRow } from '../workflow/store.pg';
import type { PlafondPartage } from '../auth/plafond-partage';
import { RefusOutil, dateAvecFuseau, entierBorne, texteObligatoire, valeurOuRefus } from './saisie';
import { decoderCurseur, encoderCurseur, idPublic, type DepotConversationsV1 } from '../api/conversations-v1';
import type { ControleDuFil, IssueRendreLaMain } from '../inbox/fil';
import { modeEffectif, sousLOffre } from '../repondeur/mode';
import { OUTILS_AGENT, signataire, type DepsAgentMcp } from './outils-agent';
import { estUuid } from '../http/scope';
import { OUTILS_OFFRE, type DepsOffreMcp } from './outils-offre';
import type { DepsCreationCle } from '../auth/creer-cle';
import { OUTILS_EVENEMENTS, type DepsEvenementsMcp } from './outils-evenements';
import { OUTILS_CHIFFRES, type DepsChiffresMcp } from './outils-chiffres';
import { OUTILS_NUMERO, type DepsNumeroMcp } from './outils-numero';
import { OUTILS_MODELES, type DepsModelesMcp } from './outils-modeles';
import { OUTILS_CAMPAGNES, type DepsCampagnesMcp } from './outils-campagnes';
import { OUTILS_CHAMPS, type DepsChampsMcp } from './outils-champs';
import { OUTILS_SHOPIFY } from './outils-shopify';
import type { DepsGestionShopify } from '../shopify/gestion';
import type { ResultatEnvoiPublic } from '../api/envoi-public';
import type { VueOffre } from '../offres/vue';
import type { SourceOffres } from '../offres/offre.pg';
import type { Fonction } from '../offres/offres';
import { OUTILS_DE_L_ETAPE, lireMiseEnService } from './mise-en-service';

export { RefusOutil } from './saisie';
// Les bornes d'un fichier d'outils que `tests/mcp-serveur.test.ts` relit dans les schémas : exportées d'ici.
export { MAX_CONTACTS_TROUVES, LONGUEUR_MAX_NOM_MODELE, LONGUEUR_MAX_LANGUE, LONGUEUR_MAX_NOM_CAMPAGNE, LONGUEUR_MAX_CODE } from './outils-campagnes';
export { LONGUEUR_MAX_LIBELLE_CHAMP, LONGUEUR_MAX_CLE_CHAMP, LONGUEUR_MAX_VALEUR_CHAMP } from './outils-champs';

/**
 * Le catalogue d'outils exposé aux agents tiers par le serveur MCP.
 *
 * 🔴 Un outil n'a jamais de logique métier à lui : il appelle la fonction que la console appelle
 * (`reply_in_open_window` passe par `repondreDansLaFenetre`, les outils des widgets par `src/widgets/gestion.ts`).
 * Une seconde implémentation dériverait, et sur une surface d'écriture ce serait un agent qui écrit avec d'autres
 * garde-fous (fenêtre de 24 h, prise du fil, journal, phrase d'un widget).
 * Lecture d'abord, écriture étroite. Un modèle part vers UNE personne à la fois (`send_template_to_contact`), et une
 * campagne, mégaphone facturé sur un numéro dont Meta note la qualité, ne part que préparée en brouillon puis lancée
 * avec le code de son récapitulatif (`prepare_campaign`, `launch_campaign`), par une personne connectée.
 * 🔴 Aucun outil n'émet d'événement d'automation : un agent qui boucle sur 500 conversations déclencherait 500
 * automations facturées. Un tag posé ici ne réveille rien (la pose est appelée SANS publier), et la description le
 * dit.
 */

/** Le scope de clé d'API qu'un outil exige. Deux seulement : lire, et écrire. */
export type { ScopeMcp } from '../../web/lib/partage/catalogue-mcp';

/** Les actions d'agent IA rendues par `get_conversation` : les plus récentes, la conversation en porte peu. */
export const ACTIONS_DE_LA_CONVERSATION = 10;

export interface DepsMcp extends DepsRepondre, DepsChampsMcp {
  /** L'offre de l'espace (`OffresEnCache`, lot 6, B2a) : la fonction de chaque outil s'y vérifie avant de l'exécuter. */
  offres: SourceOffres;
  inbox: ConversationsRepondre & {
    listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
    /** Les `n` plus récents, dans l'ordre chronologique : le MCP ne lit jamais le DÉBUT d'un fil. */
    getDerniersMessages(conversationId: string, n: number, avant?: { at: string; id: string }): Promise<ConversationMessage[]>;
    getControlOwner(tenantId: string, waId: string): Promise<ControlOwner>;
    getAssignee(tenantId: string, conversationId: string): Promise<string | null | undefined>;
    setAssignee(tenantId: string, conversationId: string, assignee: string | null, par: AuteurDuChangement): Promise<boolean>;
    /** Les fiches de conversations désignées par l'assistant (`tag_contacts`), dans l'espace seulement. */
    contactIdsDesConversations(tenantId: string, conversationIds: string[]): Promise<string[]>;
  };
  contacts: {
    /** Recherche de contacts (le même moteur de filtres que le mini-CRM). */
    query(tenantId: string, filtres: ContactFilters, limit: number, offset: number): Promise<ContactRow[]>;
    /** Le nombre de contacts d'une cible (`find_contacts`), le même compte que la liste des contacts. */
    count(tenantId: string, filtres: ContactFilters): Promise<number>;
    /** Les identifiants d'une cible dans l'espace (`lireCibleMcp`) : la même résolution que l'action en masse. */
    contactIdsForTarget(tenantId: string, target: BulkTarget, limite?: number): Promise<string[]>;
    /** L'action en masse du mini-CRM (`tag_contacts`) : la MÊME écriture que la route, qui n'émet rien. */
    applyEditsMany(tenantId: string, target: BulkTarget, edits: BulkEdits): Promise<IssueActionEnMasse>;
    findByPhone(tenantId: string, phoneE164: string): Promise<ContactRow | null>;
    /**
     * Bloquer ou débloquer (`block_contact`) : le MÊME geste que la fiche du contact (`PATCH .../blocked`), signé de la
     * personne. `false` : aucune fiche vivante de ce nom dans l'espace.
     */
    setBlocked(tenantId: string, contactId: string, bloque: boolean, parUserId: string | null): Promise<boolean>;
    /** Le contact de ce fil est-il bloqué ? `control_conversation` ne rend pas la main sur lui. */
    isBlockedByWaId(tenantId: string, waId: string): Promise<boolean>;
    /** La dernière analyse et son résumé pour une page de fiches, en une requête filtrée sur l'espace. */
    analysesEtResumes(tenantId: string, contactIds: readonly string[]): Promise<Map<string, AnalyseEtResume>>;
  };
  /**
   * La pose d'étiquettes sur un contact (`src/crm/poser-etiquette.ts`), le MÊME module que la fiche de la console et
   * l'agent : nettoyage, pose, déclaration dans le référentiel de l'espace. Appelée SANS publier (voir l'en-tête).
   */
  etiquettes: Pick<PoseEtiquette, 'poser'>;
  /**
   * La main du fil (`control_conversation`) : les deux boutons du fil de la console, le MÊME contrôle
   * (`src/inbox/fil.ts`). L'outil y ajoute la garde d'espace, des refus lisibles là où la console rend un 409, et la garde
   * du consentement à la remise : il rend la main par `rendreLaMainSousConsentement`, jamais par le geste sans garde.
   */
  fil: Pick<ControleDuFil, 'reprendreLaMain' | 'rendreLaMainSousConsentement'>;
  /** Membres de l'espace, pour qu'un agent puisse confier une conversation à quelqu'un de nommé. */
  listerMembres(tenantId: string): Promise<Array<{ id: string; name: string | null; email: string; role: string }>>;
  /**
   * Les widgets WhatsApp : la gestion et la mise en vue de l'écran de la console, le MÊME objet (`src/index.ts`).
   * Les outils n'y ajoutent aucun contrôle : un refus de la gestion devient un `RefusOutil`, avec sa phrase.
   */
  widgets: DepsWidgets;
  /** Les scénarios de l'espace (`PgWorkflowStore.listResume`), pour qu'un assistant sache lequel un widget peut démarrer. */
  scenarios: { listResume(tenantId: string): Promise<Array<Pick<WorkflowResumeRow, 'id' | 'name' | 'nodeCount'>>> };
  /**
   * L'agent IA, sa connaissance, son bac à sable et le crédit (lot 8a) : les MÊMES objets que les routes de la
   * console (`src/index.ts`). Les outils n'y ajoutent aucun contrôle.
   */
  agentIa: DepsAgentMcp;
  /** La connexion du numéro depuis Claude Code (lot 3c) : le lien signé et l'état, la MÊME lecture que la page. */
  numero: DepsNumeroMcp;
  /** Les webhooks sortants (lot 12) : la MÊME gestion que la route de la console (`src/index.ts`), et son audit. */
  evenements: DepsEvenementsMcp;
  /** Les chiffres de l'espace (2026-10-13) : les MÊMES fonctions que la route des statistiques de la console. */
  chiffres: DepsChiffresMcp;
  /**
   * L'offre de l'espace (lot 6) : la MÊME vue que la console (`GET /tenants/:tenantId/offre`), pour `get_plan`, et le MÊME
   * paiement du Pro que `POST /offre/paiement`, pour `subscribe_pro` (spec offres v2).
   */
  offre: { vue(tenantId: string): Promise<VueOffre>; pro: DepsOffreMcp };
  /** La création d'une clé d'API (spec offres v2) : la MÊME fonction que la route de la console, pour `create_api_key`. */
  cles: DepsCreationCle;
  /** Un message par son identifiant public (lot 13) : la MÊME lecture que `GET /v1/messages/{id}`, pour `get_message_status`. */
  messagesApi: Pick<DepotConversationsV1, 'message'>;
  /** L'envoi au format de Meta (lot 13, domaine 2) : le MÊME que `POST /v1/messages`, pour `send_message`. */
  envoyerMessage(tenantId: string, phoneNumberId: string, to: string, corps: Record<string, unknown>): Promise<string>;
  /** Les modèles (lot 13, domaine 3) : la MÊME création et le MÊME suivi que `POST /v1/templates`, et la liste du catalogue. */
  modeles: DepsModelesMcp;
  /** Le connecteur Shopify : la MÊME gestion que la carte de la console. */
  shopify: DepsGestionShopify;
  /**
   * Les campagnes depuis l'assistant (2026-10-20) : le câblage de la route des campagnes, la lecture des modèles de
   * `POST /v1/sends` et les codes de confirmation (`src/mcp/outils-campagnes.ts`).
   */
  campagnes: DepsCampagnesMcp['campagnes'];
  /**
   * L'envoi d'un modèle (lot 13, domaine 3, livraison B) : le même cycle d'envoi public que `POST /v1/sends`, lié
   * à ses dépendances par le câblage. `compter` est appelé où la route compte ; il rend `true` ou lève.
   */
  envoyerModele(tenantId: string, corps: unknown, compter: (unites: number) => Promise<boolean>): Promise<ResultatEnvoiPublic>;
  /**
   * Le quota QUOTIDIEN d'envois de l'espace (`src/api/quotas.ts`), le même que `POST /v1/sends` (opération
   * `sends.create`) : sans lui, Claude enverrait jusqu'à dix modèles par minute toute la journée. Posé par la route
   * `/mcp` à chaque requête, parce qu'il compte sous la clé ou le jeton de l'appel ; jamais par le câblage.
   */
  quotaEnvois(tenantId: string, unites: number): Promise<{ accepte: boolean; raison?: string }>;
  /**
   * 🔴 Le plafond des opérations coûteuses de la console, la MÊME instance que celle des routes, comptée par espace
   * sous la même clé : sans lui, le serveur MCP serait la porte qui contourne les dix opérations lourdes par minute
   * (un import de site, un essai facturé, un paiement). Posé par `buildServer` au montage, jamais par le câblage
   * (`CablageMcp`), parce que c'est là qu'il est construit.
   */
  couteux: Pick<PlafondPartage, 'consommer'>;
}

/**
 * Ce que le câblage fournit : tout, sauf le plafond coûteux, que `buildServer` ajoute (voir `couteux`), et le quota
 * d'envois, que la route `/mcp` pose à chaque requête (voir `quotaEnvois`).
 */
export type CablageMcp = Omit<DepsMcp, 'couteux' | 'quotaEnvois'>;

/**
 * Une propriété d'un schéma d'entrée. 🔴 Toute borne que l'outil applique s'y annonce (longueur, motif, énumération,
 * intervalle) : un modèle ne respecte que ce qu'on lui a dit, et une borne tue ne se découvre qu'au refus.
 */
export interface ProprieteEntree {
  type: string | string[];
  description: string;
  enum?: Array<string | null>;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** Le schéma d'un élément, pour une liste : sans lui, un `array` ne dit pas ce qu'il contient. */
  items?: Omit<ProprieteEntree, 'description'>;
  minItems?: number;
  maxItems?: number;
  /** Les champs d'un objet (un élément de liste qui en est un : une fiche, un message, une règle d'arrêt). */
  properties?: Record<string, ProprieteEntree>;
  required?: string[];
  additionalProperties?: false;
}

/** Un schéma JSON d'entrée, tel que MCP l'attend (sous-ensemble volontairement pauvre : objet et propriétés). */
export interface SchemaEntree {
  type: 'object';
  properties: Record<string, ProprieteEntree>;
  required?: string[];
  /** `false` quand l'outil REFUSE une clé inconnue (la saisie d'un widget est `.strict()`) : le modèle le sait. */
  additionalProperties?: false;
}

/**
 * Les annotations MCP d'un outil (spécification 2025-06-18), rendues par `tools/list` : un client y lit s'il peut
 * appeler sans demander. `readOnlyHint` vaut « le scope est `mcp:read` » (tenu par `tests/mcp-serveur.test.ts`).
 * 🔴 Une ÉCRITURE déclare `destructiveHint: true`, et le type l'exige : c'est la règle du répertoire de Claude
 * (« destructiveHint: true for tools that modify or delete data », décision de Julien du 2026-10-14,
 * `tests/mcp-repertoire.test.ts`), et dans claude.ai chaque écriture demande donc une confirmation, poser un tag
 * compris. `idempotentHint` reste décidé outil par outil. `openWorldHint` : l'outil touche-t-il quelqu'un hors de
 * l'espace (un message part chez une personne) ?
 */
export type AnnotationsMcp = { title: string; openWorldHint: boolean } & (
  | { readOnlyHint: true }
  | { readOnlyHint: false; destructiveHint: true; idempotentHint: boolean }
);

/** La personne qui a autorisé un jeton OAuth (migration 0204). Une clé d'API n'en a pas. */
export interface PersonneMcp {
  userId: string;
}

export interface OutilMcp {
  nom: string;
  /**
   * La fonction de l'offre que l'outil exige (lot 6, B2a, spec § 4) ; `null` = ouvert à toutes les offres. REQUISE : un
   * outil ajouté demain doit dire s'il est payant. Hors offre, il RESTE listé et refuse avec la phrase et le lien de
   * l'offre (`traiterMessage`) : à la différence d'un droit de clé, l'assistant peut l'expliquer.
   */
  fonction: Fonction | null;
  description: string;
  scope: ScopeMcp;
  annotations: AnnotationsMcp;
  entree: SchemaEntree;
  /**
   * Ce que l'instance change à la description et au schéma rendus par `tools/list` (les offres de `buy_credit` dont le
   * prix est configuré). Absent : l'outil est décrit tel qu'écrit, comme dans la documentation publique et le plugin.
   */
  selonInstance?(deps: DepsMcp): Pick<OutilMcp, 'description' | 'entree'>;
  /**
   * 🔴 L'outil agit au nom d'une personne nommée : il n'est ni listé ni appelable avec une clé d'API (`outilsPour`),
   * seulement avec un jeton OAuth, dont la personne est un admin relu à chaque appel. Une clé `mcp:write` peut être
   * branchée comme connecteur d'un agent qui lit des messages de clients : une injection y pourrait sinon modifier un
   * agent ou ouvrir un paiement (spec du lot 8a, section 2).
   */
  exigePersonne?: true;
  /**
   * Rend l'objet à sérialiser pour l'agent, ou lève `RefusOutil` pour un refus explicable. `personne` : qui signe
   * une écriture faite avec un jeton OAuth, `null` avec une clé. Seuls les outils qui écrivent au nom de quelqu'un
   * la déclarent.
   */
  executer(deps: DepsMcp, tenantId: string, args: Record<string, unknown>, personne: PersonneMcp | null): Promise<unknown>;
}

/**
 * Le curseur de `list_conversations` : celui de l'API (`encoderCurseur`, instant à la microseconde et identifiant),
 * précédé du rang d'urgence, que seul « À traiter » lit (`ListConversationsOptions.before`). Opaque pour l'assistant,
 * qui le renvoie tel quel ; forgé ou abîmé, il est refusé avant toute lecture.
 */
function curseurDeListe(at: string, id: string, urgente: boolean): string {
  return `${urgente ? 'u' : 'n'}.${encoderCurseur({ at, id })}`;
}
function lireCurseurDeListe(brut: unknown): { at: string; id: string; urgente: boolean } {
  const m = typeof brut === 'string' ? /^([un])\.(.+)$/.exec(brut) : null;
  const reprise = m ? decoderCurseur(m[2]!) : null;
  if (!m || !reprise) throw new RefusOutil('paramètre « cursor » illisible : renvoyez le next_cursor de la page précédente tel quel');
  return { ...reprise, urgente: m[1] === 'u' };
}

/** 🔴 La conversation, ou un refus : garde d'espace partagée. `getConversationContext` rend `null` pour une
 *  conversation d'un autre espace, donc un identifiant deviné ne dit rien de plus qu'un inexistant. */
async function contexteOuRefus(deps: DepsMcp, tenantId: string, conversationId: string) {
  const ctx = await deps.inbox.getConversationContext(conversationId, tenantId);
  if (ctx === null) throw new RefusOutil('conversation inconnue dans cet espace');
  return ctx;
}

/**
 * Un contact rendu à l'agent : on choisit les champs, jamais tout `ContactRow`. `last_analysis` : la dernière
 * analyse recopiée sur la fiche, `null` si le contact n'a jamais été analysé. Le résumé de la même analyse
 * (décision 15 : il sort par le MCP, pas par l'API publique) ne part qu'avec `get_contact` : vingt résumés de
 * 800 caractères dépasseraient les 16 Ko qu'un outil d'agent rend, et la recherche arriverait tronquée.
 * `analyses` à `null` (lecture ratée) : la clé manque, plutôt qu'un `null` qui dirait « jamais analysé ».
 */
function contactPublic(c: ContactRow, analyses: Map<string, AnalyseEtResume> | null, avecResume: boolean): Record<string, unknown> {
  return {
    id: c.id,
    phone: c.phoneE164,
    name: c.profileName,
    opt_in: c.optInStatus,
    // Un contact bloqué n'apparaît plus dans la console hors de son écran : c'est ici que Claude le retrouve.
    blocked: Boolean(c.blockedAt),
    tags: c.tags,
    fields: c.fields,
    ...(analyses === null ? {} : { last_analysis: analysePublique(analyses.get(c.id), avecResume) }),
    created_at: c.createdAt,
  };
}

function analysePublique(ar: AnalyseEtResume | undefined, avecResume: boolean): Record<string, unknown> | null {
  const a = ar?.analyse ?? null;
  if (a === null) return null;
  return {
    intent: a.intention, sentiment: a.sentiment, satisfaction: a.satisfaction, urgency: a.urgence, resolved: a.resolue,
    topic: a.sujet, handled_by: a.traiteePar, action_suggestion: a.action, analyzed_at: a.analyseLe.toISOString(),
    ...(avecResume ? { summary: ar?.resume ?? null } : {}),
  };
}

/** La dernière analyse d'une page de fiches, en une lecture ; `null` si elle échoue : les fiches partent quand même. */
async function analysesOuRien(deps: DepsMcp, tenantId: string, ids: string[]): Promise<Map<string, AnalyseEtResume> | null> {
  try {
    return await deps.contacts.analysesEtResumes(tenantId, ids);
  } catch (e) {
    console.warn('mcp: dernière analyse illisible, fiches rendues sans elle:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Les champs d'un widget, tels que `create_widget` et `update_widget` les annoncent. Les mêmes NOMS que la route de
 * la console, parce que la saisie passe telle quelle à la gestion, qui refuse une clé qu'elle ne connaît pas ; et les
 * mêmes BORNES, lues dans `src/widgets/gestion.ts`, jamais recopiées. `satisfies` sur `ChampWidget` : un champ ajouté
 * à la saisie sans être annoncé ici ne compile pas, et `tests/mcp-widgets.test.ts` vérifie que chaque borne de Zod y
 * figure avec la même valeur.
 */
const CHAMPS_WIDGET = {
  nom: {
    type: 'string', minLength: 1, maxLength: MAX_NOM_WIDGET,
    description: 'The widget name, to find it in the console. Visitors never see it.',
  },
  phrase: {
    type: 'string', minLength: 1, maxLength: MAX_PHRASE_WIDGET,
    description: 'The prefilled message the VISITOR sends themselves by clicking the bubble (example: "Hello, I come '
      + 'from the pricing page"). It is what identifies the widget\'s conversations, so it is unique to it: refused if '
      + 'it contains, or is contained in, the phrase of another widget or of a WhatsApp Channel link, or if it already '
      + 'appears in ordinary conversations. Case, accents and final punctuation do not distinguish two phrases.',
  },
  devenir: {
    type: ['string', 'null'], enum: ['mba', 'scenario', null],
    description: 'Who answers the widget\'s conversations. null (default): as for other conversations, the workspace '
      + 'setting decides. "mba": the workspace\'s automatic responder, the one set_default_responder chose (Meta '
      + 'Business Agent, AI agent, scenario or team). "scenario": a scenario starts when the message arrives; it '
      + 'requires workflowId. An AI agent answers a widget\'s conversations by being the workspace\'s responder, not '
      + 'through this field.',
  },
  workflowId: {
    type: ['string', 'null'], format: 'uuid',
    description: 'With devenir "scenario" only: the id of a workspace scenario that has a PUBLISHED version '
      + '(list_scenarios, publie = true).',
  },
  couleur: {
    type: 'string', pattern: MOTIF_COULEUR,
    description: 'The bubble color, six hexadecimal digits (default #25d366, the WhatsApp green).',
  },
  position: {
    type: 'string', enum: [...POSITIONS_WIDGET],
    description: 'The screen corner where the bubble sits (default bas_droite).',
  },
  libelle: {
    type: ['string', 'null'], maxLength: MAX_LIBELLE_WIDGET,
    description: 'A short text shown next to the bubble, or null for none.',
  },
  avatarUrl: {
    type: ['string', 'null'], maxLength: MAX_AVATAR_URL, pattern: `^${DEBUT_AVATAR}`,
    description: 'The https:// address of an image shown in the bubble, or null for none.',
  },
  actif: {
    type: 'boolean',
    description: 'false turns the bubble off without removing the tag from the site; true turns it back on (default true).',
  },
  maxParHeure: {
    type: ['integer', 'null'], minimum: 1, maximum: MAX_PAR_HEURE_WIDGET,
    description: 'How many scenarios this widget can start per hour (the phrase is public, anyone can send it in '
      + 'bursts), or null for the instance cap.',
  },
} satisfies Record<ChampWidget, ProprieteEntree>;

/** L'identifiant de conversation, tel que cinq outils le lisent (`texteObligatoire(args, 'conversation_id', 100)`). */
const CONVERSATION_ID: ProprieteEntree = {
  type: 'string', minLength: 1, maxLength: 100, description: 'The id returned by list_conversations.',
};

/**
 * Le nombre de messages que `get_messages` rend, au plus et par défaut : les plus RÉCENTS. Décision de Julien du
 * 2026-10-03, « c'est déjà bien assez ». La borne vient du catalogue partagé.
 */
export const MAX_MESSAGES_MCP = LIMITE_MESSAGES_MCP;

/** Les annotations d'une lecture : rien n'est touché, ni dans l'espace ni au-dehors. */
const lecture = (title: string): AnnotationsMcp => ({ title, readOnlyHint: true, openWorldHint: false });

export const OUTILS: OutilMcp[] = [
  {
    ...ficheOutilMcp('list_conversations'),
    // Lire les fils est ouvert dans toutes les offres (décision de Julien du 2026-10-08, lot 13) : seul l'écran Inbox,
    // et les outils qui ÉCRIVENT dans un fil, restent dans l'offre de l'Inbox.
    fonction: null,
    /**
     * Les conversations archivées sont exclues, comme dans l'Inbox, et la description le dit : sinon un agent
     * conclurait qu'une conversation rangée n'existe pas.
     */
    description:
      'Lists the workspace\'s WhatsApp conversations, most recently active first. `a_traiter` keeps only those the '
      + 'scenario no longer handles and that await a human reply (a conversation an operator marked "Done" leaves '
      + 'this list until the contact\'s next message; those the team marked urgent come first). '
      + 'Conversations ARCHIVED from the Inbox are not listed: they still exist, they are only filed away, and a '
      + 'message from the contact brings them back. `since` and `until` keep the conversations whose LAST message '
      + 'falls in that period; to go through a whole period, pass `next_cursor` back as `cursor` until it is absent. '
      + 'Each conversation gives its `contact_id`, which `tag_contacts` accepts.',
    annotations: lecture('List conversations'),
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of conversations (1 to 200, default 50).' },
        a_traiter: { type: 'boolean', description: 'true keeps only the conversations to handle.' },
        since: { type: 'string', description: 'ISO 8601 date WITH its time zone (e.g. 2026-10-13T00:00:00+02:00): last message at or after it.' },
        until: { type: 'string', description: 'ISO 8601 date WITH its time zone: last message strictly before it.' },
        cursor: { type: 'string', description: 'The `next_cursor` of the previous page, unchanged.' },
      },
    },
    async executer(deps, tenantId, args) {
      const limit = entierBorne(args, 'limit', 50, 1, 200);
      const depuis = dateAvecFuseau(args, 'since');
      const jusqua = dateAvecFuseau(args, 'until');
      const before = args.cursor === undefined || args.cursor === null ? undefined : lireCurseurDeListe(args.cursor);
      const conversations = await deps.inbox.listConversations(tenantId, {
        limit,
        ...(args.a_traiter === true ? { aTraiter: true } : {}),
        ...(depuis ? { depuis: depuis.toISOString() } : {}),
        ...(jusqua ? { jusqua: jusqua.toISOString() } : {}),
        ...(before ? { before } : {}),
      });
      // Une page pleine peut avoir une suite ; une page incomplète est la dernière, et l'absence de curseur le dit.
      const dernier = conversations.length === limit ? conversations[conversations.length - 1] : undefined;
      return {
        conversations: conversations.map((c) => ({
          conversation_id: c.id,
          contact_id: c.contactId ?? null,
          contact: c.profileName ?? c.waId,
          phone: c.waId,
          last_message_at: c.lastMessageAt,
          last_preview: c.lastPreview,
          unread: c.unread,
          handled_by: c.controlOwner,
          assigned_to: c.assignedToName ?? c.assignedTo,
        })),
        ...(dernier?.curseur ? { next_cursor: curseurDeListe(dernier.curseur, dernier.id, dernier.urgente === true) } : {}),
      };
    },
  },
  {
    ...ficheOutilMcp('get_conversation'),
    fonction: null,
    description:
      'Details of a conversation: the contact, who handles it, who it is assigned to, and above all whether the '
      + '24-hour customer service window is OPEN. Outside this window, WhatsApp forbids any free-form message: this '
      + 'tool tells whether a reply can go out, before one is attempted. agent_actions: the latest actions an AI agent '
      + `triggered in it (${ACTIONS_DE_LA_CONVERSATION} at most, most recent first), with the collected fields.`,
    annotations: lecture('Read a conversation'),
    entree: {
      type: 'object',
      properties: { conversation_id: CONVERSATION_ID },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const ctx = await contexteOuRefus(deps, tenantId, id);
      const [owner, assignee, actions, filiere] = await Promise.all([
        deps.inbox.getControlOwner(tenantId, ctx.waId),
        deps.inbox.getAssignee(tenantId, id),
        deps.agentIa.actions.listerDeLaConversation(tenantId, id, ACTIONS_DE_LA_CONVERSATION),
        deps.application.filiere(tenantId),
      ]);
      return {
        conversation_id: id,
        phone: ctx.waId,
        // Sur l'application WhatsApp Business, la fenêtre de 24 h n'existe pas : un champ qui le dit, plutôt qu'un
        // `window_open: true` qui mentirait sur la règle (spec du 2026-10-22).
        ...(filiere === 'application'
          ? { window: 'not_applicable', note: 'WhatsApp Business app number: the 24-hour window does not apply, a reply can always be sent.' }
          : { window_open: ctx.windowOpen }),
        last_inbound_at: ctx.lastInboundAt,
        handled_by: owner ?? null,
        assigned_to: assignee ?? null,
        agent_actions: actions.map((a) => ({ action_id: a.actionId, name: a.nom, at: a.at, fields: a.champs })),
      };
    },
  },
  {
    ...ficheOutilMcp('get_messages'),
    fonction: null,
    description:
      `The MOST RECENT messages of a conversation, ${MAX_MESSAGES_MCP} at most, returned from oldest to newest, each with `
      + 'its message_id (the one get_message_status reads). tronque = true: the thread has messages older than those '
      + 'returned, and before reads them (the returned before value, passed back, goes up one page).',
    annotations: lecture('Read the latest messages'),
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_MESSAGES_MCP,
          description: `Number of most recent messages to return (1 to ${MAX_MESSAGES_MCP}, default ${MAX_MESSAGES_MCP}).`,
        },
        before: {
          type: 'string', minLength: 1, maxLength: 200,
          description: 'The before returned by the previous call, unchanged: the messages EARLIER than that page.',
        },
      },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      await contexteOuRefus(deps, tenantId, id); // garde d'espace avant de lire les messages
      const limit = entierBorne(args, 'limit', MAX_MESSAGES_MCP, 1, MAX_MESSAGES_MCP);
      const brut = args.before === undefined || args.before === null ? null : texteObligatoire(args, 'before', 200);
      const avant = brut === null ? null : decoderCurseur(brut);
      if (brut !== null && avant === null) throw new RefusOutil('before illisible : repassez tel quel le before rendu par l’appel précédent');
      // Un de plus que rendu : c'est lui qui dit s'il en reste avant, sans compter le fil entier.
      const lus = await deps.inbox.getDerniersMessages(id, limit + 1, avant ?? undefined);
      const rendus = lus.slice(-limit);
      const premier = rendus[0];
      const tronque = lus.length > limit;
      return {
        conversation_id: id,
        messages: rendus.map((m) => ({
          // L'identifiant PUBLIC, celui de `GET /v1/messages/{id}` : `get_message_status` le lit tel quel.
          message_id: idPublic(m.metaMessageId ?? null, m.id),
          direction: m.direction,
          type: m.type,
          body: m.body,
          at: m.createdAt,
        })),
        tronque,
        // Le point d'où remonter : le plus ancien message rendu, à la microseconde (`curseur`, jamais `createdAt`).
        before: tronque && premier?.curseur ? encoderCurseur({ at: premier.curseur, id: premier.id }) : null,
      };
    },
  },
  {
    ...ficheOutilMcp('get_message_status'),
    fonction: null,
    description:
      'The delivery status of a SENT message, by its Meta id (wamid..., the one the send returns): sent, delivered, '
      + 'read or failed; null as long as no receipt has arrived, and always null for a received message. On failure, '
      + 'Meta\'s code and reason.',
    annotations: lecture('Read a message status'),
    entree: {
      type: 'object',
      properties: {
        message_id: { type: 'string', minLength: 1, maxLength: 200, description: 'The message id: wamid... (Meta\'s) or msg_... (for a message without a Meta id).' },
      },
      required: ['message_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'message_id', 200);
      // Le dépôt filtre sur l'espace : un message d'un autre espace est inconnu, comme un message qui n'existe pas.
      const m = await deps.messagesApi.message(tenantId, id);
      if (!m) throw new RefusOutil('message inconnu de cet espace');
      return {
        message_id: m.id, conversation_id: m.conversationId, direction: m.direction,
        status: m.status, status_at: m.statusAt, error: m.error,
      };
    },
  },
  {
    ...ficheOutilMcp('search_contacts'),
    fonction: null,
    description:
      'Searches contacts by name or by number. A query made of digits is read as a number search, otherwise as a '
      + 'name search. Each contact carries its latest analysis (last_analysis: intent, sentiment, satisfaction and '
      + 'urgency out of 10, resolved, topic; null if it was never analyzed), without the summary: get_contact returns it.',
    annotations: lecture('Search contacts'),
    entree: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120, description: 'A name (or part of one) or a sequence of digits of the number.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of contacts (1 to 100, default 20).' },
      },
      required: ['query'],
    },
    async executer(deps, tenantId, args) {
      const q = texteObligatoire(args, 'query', 120);
      // On tranche sur ce que la requête contient plutôt que d'exiger un paramètre de plus, que le modèle oublierait.
      const chiffres = q.replace(/[^0-9]/g, '');
      const filtres: ContactFilters = chiffres.length >= 4 && /^[0-9\s+.()-]+$/.test(q)
        ? { phoneContains: chiffres }
        : { nameSearch: q };
      const contacts = await deps.contacts.query(tenantId, filtres, entierBorne(args, 'limit', 20, 1, 100), 0);
      // UNE lecture pour toute la page.
      const analyses = await analysesOuRien(deps, tenantId, contacts.map((c) => c.id));
      return { contacts: contacts.map((c) => contactPublic(c, analyses, false)) };
    },
  },
  {
    ...ficheOutilMcp('get_contact'),
    fonction: null,
    description: 'A contact\'s record from their number: international with or without "+" (+33612345678, 33612345678), '
      + 'or national (06 12 34 56 78). It carries the latest analysis of their conversations and its summary '
      + '(last_analysis, null if they were never analyzed).',
    annotations: lecture('Read a contact record'),
    entree: {
      type: 'object',
      properties: { phone: { type: 'string', minLength: 1, maxLength: 32, description: 'Number in E.164 format, with the country code.' } },
      required: ['phone'],
    },
    async executer(deps, tenantId, args) {
      // Ramené au format de la fiche : l'agent de Meta pose l'identifiant WhatsApp, sans « + », et une recherche du
      // texte tel quel ne trouvait jamais la fiche (2026-10-02).
      const phone = e164DepuisSaisie(texteObligatoire(args, 'phone', 32));
      if (phone === null) throw new RefusOutil('numéro illisible : donnez-le au format international (+33612345678)');
      const c = await deps.contacts.findByPhone(tenantId, phone);
      if (!c) throw new RefusOutil('aucun contact avec ce numéro dans cet espace');
      return contactPublic(c, await analysesOuRien(deps, tenantId, [c.id]), true);
    },
  },
  {
    ...ficheOutilMcp('block_contact'),
    // Le geste de la fiche, ouvert dans toutes les offres (plan du 2026-10-22, la marche arrière) : en Free, sans fiche
    // dans la console, un importun faisait répondre l'agent IA à chaque message, donc consommait le crédit.
    fonction: null,
    description:
      'Blocks or unblocks a contact, like the contact record in the console, ONLY at the person\'s explicit request. A '
      + 'blocked contact receives nothing from the workspace anymore (campaigns, scenarios, automations, AI agent), no '
      + 'robot is handed its conversation, and the conversation leaves the Inbox; its incoming messages are still '
      + 'recorded, so a cancellation or a complaint is never lost. get_contact and search_contacts tell whether a contact is blocked '
      + '(blocked), which is how to find one to unblock. Designate the contact by phone (with the country code: '
      + '+33612345678) or contact_id.',
    // Destructrice : elle coupe la relation avec un client. Idempotente : bloquer un bloqué ne change rien. Rien chez un tiers.
    annotations: { title: 'Block or unblock a contact', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$', description: 'The number with the country code. Or contact_id.' },
        contact_id: { type: 'string', format: 'uuid', minLength: 36, maxLength: 36, description: 'The id of a contact record. Or phone.' },
        blocked: { type: 'boolean', description: 'true blocks, false unblocks.' },
      },
      required: ['blocked'],
      additionalProperties: false,
    },
    async executer(deps, tenantId, args, personne) {
      const phone = typeof args.phone === 'string' ? args.phone : undefined;
      const fiche = typeof args.contact_id === 'string' ? args.contact_id : undefined;
      if ((phone === undefined) === (fiche === undefined)) throw new RefusOutil('désignez le contact par phone OU par contact_id, pas les deux');
      const bloque = args.blocked;
      if (typeof bloque !== 'boolean') throw new RefusOutil('blocked : true pour bloquer, false pour débloquer');
      // Un identifiant qui n'est pas un uuid finirait en cast SQL : refusé avant toute lecture.
      if (fiche !== undefined && !estUuid(fiche)) throw new RefusOutil('contact_id : l’identifiant d’une fiche (un uuid)');
      let id = fiche;
      if (phone !== undefined) {
        const e164 = e164DepuisSaisie(phone);
        if (e164 === null) throw new RefusOutil('numéro illisible : donnez-le au format international (+33612345678)');
        id = (await deps.contacts.findByPhone(tenantId, e164))?.id;
      }
      if (id === undefined || !(await deps.contacts.setBlocked(tenantId, id, bloque, signataire(personne)))) {
        throw new RefusOutil('contact inconnu dans cet espace');
      }
      return { contact_id: id, blocked: bloque };
    },
  },
  {
    ...ficheOutilMcp('list_members'),
    fonction: null,
    description:
      'The workspace members, with their id. assign_conversation takes this id, not the name.',
    annotations: lecture('List members'),
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of members (1 to 200, default 100).' },
      },
    },
    /**
     * Borné comme ses voisins, et `tronque` est rendu : sans lui, un modèle qui reçoit exactement `limit` membres
     * conclurait qu'il les a tous.
     */
    async executer(deps, tenantId, args) {
      const limit = entierBorne(args, 'limit', 100, 1, 200);
      const tous = await deps.listerMembres(tenantId);
      return { members: tous.slice(0, limit), tronque: tous.length > limit };
    },
  },
  {
    ...ficheOutilMcp('reply_in_open_window'),
    // Répondre dans la fenêtre de 24 h est ouvert dans toutes les offres (décision de Julien du 2026-10-08), comme
    // `POST /v1/messages/whatsapp` : seuls étiqueter et affecter, gestes d'équipe, restent dans l'offre de l'Inbox.
    fonction: null,
    description:
      'Sends a text message in a conversation, ONLY while the 24-hour customer service window is open (the contact '
      + 'wrote recently). Outside the window, the call is refused: WhatsApp then requires an approved template, which '
      + 'this tool does not send. Sending TAKES OVER the conversation: no scenario, AI agent or Meta Business Agent '
      + 'answers this contact until it is handed back (control_conversation, hand_back), or until the workspace\'s '
      + 'takeover delay runs out when it has one; a conversation escalated to the team waits for a reply signed by a '
      + 'person (OAuth) before that delay runs.',
    // Le monde ouvert : un message part chez une personne, et ne se reprend pas. Destructrice : l'envoi PREND le fil,
    // le scénario cesse d'avancer, ce qui n'est pas un simple ajout.
    annotations: { title: 'Reply in the 24-hour window', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        text: { type: 'string', minLength: 1, maxLength: 4096, description: 'The message, as the contact will read it.' },
      },
      required: ['conversation_id', 'text'],
    },
    async executer(deps, tenantId, args, personne) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const texte = texteObligatoire(args, 'text', 4096);
      // Deux champs, deux questions : `auteur` (la personne qui a autorisé le jeton OAuth signe ; avec une clé,
      // personne, donc pas de pastille dans l'inbox) et `origine = 'mcp'` (un agent tiers l'a écrit, dans les deux
      // cas). Les déduire l'un de l'autre écrit une valeur fausse en base.
      // Le numéro délié sort en exception : traduit en refus, sinon l'agent lirait une panne et réessaierait en
      // consommant le plafond de l'espace.
      const res = await reponseOuRefus(() => repondreDansLaFenetre(deps, tenantId, id, texte, personne?.userId ?? null, 'mcp'));
      return resultatEnvoiMcp(res, id);
    },
  },
  {
    ...ficheOutilMcp('send_message'),
    // Comme `reply_in_open_window` : une réponse dans la fenêtre de 24 h, ouverte dans toutes les offres.
    fonction: null,
    description:
      'Sends a message in a conversation in META\'S FORMAT (the Cloud API message object, without recipient): text, '
      + 'image, video, audio, document (media through a public https URL, link), location, reaction, or interactive '
      + '(button: 3 reply buttons at most; list; cta_url: one link button). ONLY within the 24-hour window '
      + '(get_conversation tells whether it is open). For plain text, reply_in_open_window is enough. Sending TAKES '
      + 'OVER the conversation, as with reply_in_open_window.',
    annotations: { title: 'Send a message in Meta\'s format', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        message: {
          type: 'object',
          description: 'Meta\'s message object without recipient, for example { "type": "image", "image": { "link": '
            + '"https://...", "caption": "..." } }. The limits are Meta\'s (text 4,096 characters, caption 1,024, button '
            + 'title 20, 10 list rows); an unknown field is refused.',
        },
      },
      required: ['conversation_id', 'message'],
    },
    async executer(deps, tenantId, args, personne) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const lu = schemaContenuMeta.safeParse(args.message);
      if (!lu.success) throw new RefusOutil(`message invalide : ${messageDeForme(lu.error)}`);
      const message = { corps: corpsPourMeta(lu.data), trace: apercuDuMessage(lu.data), type: lu.data.type };
      const res = await reponseOuRefus(() => repondreAvecUnMessage(deps, deps.envoyerMessage, tenantId, id, message, personne?.userId ?? null, 'mcp'));
      return resultatEnvoiMcp(res, id);
    },
  },
  {
    ...ficheOutilMcp('tag_conversation'),
    fonction: 'inbox',
    description:
      'Adds one or more tags to the contact of a conversation, and adds them to the workspace\'s tag list. '
      + '⚠️ Automations that listen for a tag being added are NOT triggered by this tool: a tag added here '
      + 'classifies, it sends nothing.',
    // Ajouter n'écrase rien, et reposer un tag déjà là ne change rien (idempotente). Destructrice pour la règle du
    // répertoire de Claude (voir `AnnotationsMcp`) : elle écrit sur la fiche.
    annotations: { title: 'Add tags', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        tags: {
          type: 'array', items: { type: 'string', minLength: 1, maxLength: LONGUEUR_MAX_ETIQUETTE }, minItems: 1, maxItems: 10,
          description: 'The tags to add (1 to 10, 64 characters at most each).',
        },
      },
      required: ['conversation_id', 'tags'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const bruts = Array.isArray(args.tags) ? args.tags : [args.tags];
      // Le nettoyage de toute pose (espaces, 64 caractères, vides et doublons), puis la borne de CET outil : dix.
      const tags = nettoyerEtiquettes(bruts.filter((x): x is string => typeof x === 'string'), 10);
      if (tags.length === 0) throw new RefusOutil('paramètre « tags » requis (au moins un tag non vide)');
      const ctx = await contexteOuRefus(deps, tenantId, id);
      // 🔴 `publier: false` : un tag posé par un assistant classe, il ne réveille aucune automation (voir l'en-tête).
      const { nouvelles } = await deps.etiquettes.poser(tenantId, ctx.waId, tags, { publier: false });
      // On rend ce qui a réellement changé : un agent qui repose un tag déjà là doit le voir, sinon il boucle.
      return { conversation_id: id, tags_ajoutes: nouvelles, deja_presents: tags.filter((t) => !nouvelles.includes(t)) };
    },
  },
  {
    ...ficheOutilMcp('assign_conversation'),
    fonction: 'inbox',
    description:
      'Assigns a conversation to a workspace member, or releases it with member_id = null. The member id comes from '
      + 'list_members.',
    // Destructrice : elle REMPLACE l'assignation en place, qui n'est gardée nulle part ailleurs.
    annotations: { title: 'Assign a conversation', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        member_id: { type: ['string', 'null'], description: 'The member id, or null to release the conversation.' },
      },
      required: ['conversation_id', 'member_id'],
    },
    async executer(deps, tenantId, args, personne) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const brut = args.member_id;
      // `null` explicite = libérer. Toute autre forme qu'une chaîne non vide est refusée, l'absence comprise : une
      // valeur bancale ou oubliée ne doit pas devenir une libération silencieuse, qui rouvre le fil à tout le monde.
      if (brut !== null && (typeof brut !== 'string' || brut.trim() === '')) {
        throw new RefusOutil('paramètre « member_id » invalide (identifiant de membre, ou null pour libérer)');
      }
      const membre = typeof brut === 'string' ? brut.trim() : null;
      // Avec un jeton OAuth, la personne qui l'a autorisé est l'acteur. Avec une clé, pas un collaborateur : un
      // agent tiers. `assigned_by` reste nul, et la frise du panneau Détail le dit par sa cause au lieu d'afficher
      // « ancien collaborateur ».
      const par = personne ? { collaborateur: personne.userId } : parCause('agent tiers (MCP)');
      const ok = await deps.inbox.setAssignee(tenantId, id, membre, par);
      if (!ok) throw new RefusOutil('conversation inconnue, ou membre étranger à cet espace');
      return { conversation_id: id, assigned_to: membre };
    },
  },
  {
    ...ficheOutilMcp('control_conversation'),
    // Les deux boutons du fil de la console, ouverts dans toutes les offres (plan du 2026-10-22, la marche arrière) : en
    // Free, sans Inbox, c'est le seul chemin pour qu'un répondeur reprenne un fil après une réponse de Claude. Sans
    // personne exigée, comme `reply_in_open_window`, qui prend déjà le fil : une clé qui peut répondre peut rendre la main.
    fonction: null,
    description:
      'Takes over or hands back a conversation, like the two buttons of the console\'s thread. take_over: the team holds '
      + 'the thread, nothing is written to the contact, and no scenario, AI agent or Meta Business Agent answers it until '
      + 'it is handed back or the workspace\'s takeover delay runs out. hand_back: the workspace\'s automatic responder (a '
      + 'scenario, the AI agent or the Meta Business Agent) takes the thread again and answers the contact\'s NEXT '
      + 'message, not the ones already received. hand_back is refused for a contact who said STOP or is blocked, except '
      + 'when nobody answers automatically (responder mode "equipe"): there, hand_back takes the conversation out of "To '
      + 'handle" for any contact, and the result says that no responder will answer (repondeur, a_savoir). reply_in_open_window '
      + 'and send_message take over by themselves: call hand_back once the reply is done if the responder should answer '
      + 'again. handled_by tells who holds the thread afterwards.',
    // Destructrice : elle REMPLACE qui tient le fil. Idempotente : rejouer le même geste laisse le même détenteur. Monde
    // ouvert : le geste peut retirer le contact de la liste de l'agent de Meta, ou l'y remettre, chez Meta.
    annotations: { title: 'Take over or hand back a conversation', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        action: {
          type: 'string', enum: ['take_over', 'hand_back'],
          description: 'take_over: the team holds the thread. hand_back: the automatic responder takes it again.',
        },
      },
      required: ['conversation_id', 'action'],
    },
    async executer(deps, tenantId, args, personne) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const action = args.action;
      if (action !== 'take_over' && action !== 'hand_back') throw new RefusOutil('paramètre « action » : take_over ou hand_back');
      const ctx = await contexteOuRefus(deps, tenantId, id);
      // Le même auteur qu'`assign_conversation` : la personne du jeton OAuth, sinon un agent tiers derrière une clé.
      const par = personne ? { collaborateur: personne.userId } : parCause('agent tiers (MCP)');
      if (action === 'take_over') {
        // La console rend 409 sur ce refus de Meta : rien n'est écrit. Écrire au contact prendrait le fil, mais c'est un
        // message qui part : à la personne d'en décider, le refus ne le conseille pas.
        if ((await deps.fil.reprendreLaMain(tenantId, ctx.waId, par)) === 'refuse') {
          throw new RefusOutil('Meta n’a pas cédé la conversation : son agent peut encore répondre, et rien n’a changé de '
            + 'notre côté. Réessayez dans un instant ; si la personne veut répondre au contact maintenant, sa réponse '
            + '(reply_in_open_window) prendra aussi la conversation.');
        }
        return { conversation_id: id, handled_by: 'app_human' };
      }
      // Le mode « équipe » (lu sous l'offre, comme le fait le contrôle du fil) : aucun répondeur automatique. Le geste
      // reste utile (il sort la conversation d'« À traiter », et rend un parcours qui attendait le contact), mais aucun
      // robot ne répondra au message suivant : le résultat le dit plutôt que de laisser croire le contraire.
      const reglage = sousLOffre(await deps.agentIa.repondeur.reglages.get(tenantId), (await deps.offres.offreDe(tenantId)).droits.fonctions);
      const sansRepondeur = modeEffectif(reglage) === 'equipe';
      // 🔴 « Rendre la main » de la console confie à l'agent de Meta sans la garde du consentement : un geste humain,
      // délibéré (`rendreLaMain`, `src/inbox/fil.ts`). Cet outil s'ouvre aussi derrière une clé d'API : un contact qui a
      // dit STOP, ou bloqué, n'est rendu à aucun robot, comme dans toute remise automatique. En mode « équipe » (lot 4,
      // décision de Julien), il n'y a aucun robot à qui le rendre, et le geste sort la conversation d'« À traiter »,
      // seul moyen d'une Free. Deux gardes tiennent le reste : `rendreLaMainSousConsentement` refuse de confier un tel
      // contact à l'agent de Meta sur le mode qu'il relit lui-même (si le mode passe à `mba` après la lecture d'ici,
      // lot 5), et les robots relisent STOP ou bloqué avant d'écrire (`machineSeTaitParWaId`). Le `estDesabonne` d'ici ne
      // lit que le STOP, d'où la lecture du blocage à côté.
      const stop = await deps.estDesabonne(tenantId, ctx.waId);
      if (stop && !sansRepondeur) {
        throw new RefusOutil('ce contact a demandé à ne plus recevoir de messages (STOP) : aucun robot ne reprendra sa '
          + 'conversation');
      }
      const bloque = !stop && await deps.contacts.isBlockedByWaId(tenantId, ctx.waId);
      if (bloque && !sansRepondeur) {
        throw new RefusOutil('ce contact est bloqué : aucun robot ne reprendra sa conversation. Une personne connectée peut '
          + 'le débloquer d’abord (block_contact, blocked false), si c’est sa décision');
      }
      let detenteur: IssueRendreLaMain | 'contact_muet';
      try {
        detenteur = await deps.fil.rendreLaMainSousConsentement(tenantId, ctx.waId, par);
      } catch (err) {
        // Comme la route de la console : Meta a refusé de reprendre le contact, et notre état n'a pas bougé.
        console.error(`mcp: control_conversation, Meta n’a pas repris la conversation (${tenantId}/${id}):`, err instanceof Error ? err.message : err);
        throw new RefusOutil('Meta n’a pas repris la conversation : elle reste à l’équipe, réessayez dans un instant.');
      }
      if (detenteur === 'contact_muet') {
        // Le fil a refusé de confier ce contact à l'agent de Meta : le mode est passé à `mba` entre les deux lectures, ou
        // le contact a dit STOP ou a été bloqué entre-temps. Rien n'a changé.
        throw new RefusOutil('ce contact a dit STOP ou est bloqué : la conversation n’est confiée à aucun robot, rien n’a '
          + 'changé.');
      }
      if (detenteur === 'aucun_numero') {
        throw new RefusOutil('Aucun numéro WhatsApp n’est connecté : l’agent de Meta ne peut pas reprendre la conversation, '
          + 'elle reste à l’équipe.');
      }
      // L'agent de Meta tient le fil : le fil a relu `mba` après la lecture d'ici (le mode a changé entre-temps). Aucune
      // phrase sur le mode « équipe », qui ne vaut plus.
      if (!sansRepondeur || detenteur === 'mba') return { conversation_id: id, handled_by: detenteur };
      // Nos robots (scénario, agent IA) relisent STOP ou bloqué avant d'écrire ; l'agent de Meta, lui, répond chez Meta à un
      // contact resté sur sa liste, d'où la phrase limitée à nos robots.
      const contact = stop
        ? ' Ce contact a dit STOP : aucun scénario ni agent IA ne lui écrit de lui-même, quel que soit le répondeur.'
        : bloque ? ' Ce contact est bloqué : aucun scénario ni agent IA ne lui écrit de lui-même, quel que soit le répondeur.' : '';
      return {
        conversation_id: id,
        handled_by: detenteur,
        repondeur: 'equipe',
        a_savoir: 'Aucun répondeur automatique dans cet espace (mode « équipe ») : la conversation sort d’« À traiter », '
          + 'mais personne ne répondra seul au prochain message du contact, qui reviendra à l’équipe. Une personne '
          + `connectée choisit qui répond (set_default_responder).${contact}`,
      };
    },
  },
  /**
   * LES WIDGETS WHATSAPP (lot 5 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md). Créer une bulle depuis
   * Claude Code est le cas d'usage : l'assistant qui travaille sur le site du client y pose aussi la balise. Ce que
   * l'écran de la console réserve aux administrateurs, une clé d'API ou un jeton OAuth l'ouvre : leurs droits sont
   * donnés par un administrateur, la création de clé et l'autorisation OAuth leur étant réservées (le rôle de la
   * personne d'un jeton est relu à chaque appel).
   */
  {
    ...ficheOutilMcp('list_widgets'),
    fonction: null,
    description:
      `The workspace's WhatsApp widgets (${LIMITE_WIDGETS_PAR_ESPACE} at most): chat bubbles placed on a site, which `
      + 'open WhatsApp with a prefilled message. Each one carries its id (for update_widget), its name, its phrase, who '
      + 'answers (devenir, workflowId), whether it is active, the tag to paste on the site (balise) and the address of '
      + 'its script, the bubble\'s wa.me link (waMeUrl; null = the bubble shows greyed out, no WhatsApp number is '
      + 'connected), and scenarioSupprime (true = its scenario was deleted, it no longer starts anything; update_widget '
      + 'designates another one).',
    annotations: lecture('List widgets'),
    entree: { type: 'object', properties: {} },
    async executer(deps, tenantId) {
      return listerEnVue(deps.widgets, tenantId);
    },
  },
  {
    ...ficheOutilMcp('list_scenarios'),
    fonction: null,
    description:
      'The workspace scenarios, most recent first: id, name (nom), and publie (true = it has a published version, so '
      + 'it can start). A widget with devenir "scenario" can only designate a published scenario: create_widget and '
      + 'update_widget refuse the others.',
    annotations: lecture('List scenarios'),
    entree: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of scenarios (1 to 200, default 100).' } },
    },
    /** Borné comme `list_members`, et pour la même raison : `tronque` dit qu'il en reste. */
    async executer(deps, tenantId, args) {
      const limit = entierBorne(args, 'limit', 100, 1, 200);
      const tous = await deps.scenarios.listResume(tenantId);
      return {
        // `nodeCount` compte les blocs du graphe PUBLIÉ (en SQL) : la lecture d'`etatDuScenario`, qui décide du refus.
        scenarios: tous.slice(0, limit).map((s) => ({ id: s.id, nom: s.name, publie: s.nodeCount > 0 })),
        tronque: tous.length > limit,
      };
    },
  },
  {
    ...ficheOutilMcp('create_widget'),
    fonction: null,
    description:
      'Creates a WhatsApp widget: a bubble to place on a site, which opens WhatsApp with the phrase already written. '
      + 'The visitor clicks, then SENDS the phrase themselves: the visitor opens the conversation, with no approved '
      + 'template, and the phrase tells that they come from this widget (their contact gets the tag widget-<code>, '
      + 'devenir decides who answers). Returns the widget, including its tag (balise): it goes in the site\'s HTML '
      + 'code, just before the closing </body> tag, on every page where the bubble should appear. It loads without '
      + `slowing the page down and never changes. ${LIMITE_WIDGETS_PAR_ESPACE} widgets at most per workspace. The `
      + 'checks are those of the console screen: a refusal states its reason.',
    // Non idempotente : chaque appel qui réussit crée un widget de plus. Destructrice pour la règle du répertoire de
    // Claude (voir `AnnotationsMcp`).
    annotations: { title: 'Create a widget', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    entree: { type: 'object', properties: CHAMPS_WIDGET, required: ['nom', 'phrase'], additionalProperties: false },
    async executer(deps, tenantId, args) {
      // La vue AVANT l'écriture, comme la route : une panne de la lecture du numéro après coup rendrait une erreur
      // sur un widget créé, et l'assistant qui réessaierait se ferait refuser sa propre phrase.
      const vue = await miseEnVue(deps.widgets, tenantId);
      return { widget: vue(valeurOuRefus(await creerWidget(deps.widgets.gestion, tenantId, args))) };
    },
  },
  {
    ...ficheOutilMcp('update_widget'),
    fonction: null,
    description:
      'Edits a widget: only the fields provided change, null clears an optional field. Its code, and so the tag '
      + 'already placed on the site, never changes. The checks are those of creation. A widget whose scenario was '
      + 'deleted stays editable without choosing another one.',
    // Destructrice : elle écrase les champs fournis, et `actif: false` éteint une bulle publique.
    annotations: { title: 'Edit a widget', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        widget_id: {
          type: 'string', format: 'uuid', minLength: 1, maxLength: 100,
          description: 'The id returned by list_widgets or create_widget.',
        },
        ...CHAMPS_WIDGET,
      },
      required: ['widget_id'],
      additionalProperties: false,
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'widget_id', 100);
      // Le reste est la saisie de la route, telle quelle : une clé inconnue y est refusée, `tenantId` compris.
      const corps = Object.fromEntries(Object.entries(args).filter(([cle]) => cle !== 'widget_id'));
      const vue = await miseEnVue(deps.widgets, tenantId);
      return { widget: vue(valeurOuRefus(await modifierWidget(deps.widgets.gestion, tenantId, id, corps))) };
    },
  },
  {
    ...ficheOutilMcp('get_plan'),
    fonction: null,
    description:
      'The workspace plan (free, pro or entreprise): the features it includes, its limits (null = no limit) and what '
      + 'is used of them (contacts created, automations on, members, templates sent this month), plus the upgradeUrl '
      + 'link to the Pro plan, and the Pro trial (essai: whether the 14-day trial is possible, and the end of a running one). '
      + 'A Pro includes 3 users; sieges gives the extra users it pays for and prixSiege the price of one more, offered to the '
      + 'admin when an invitation goes beyond (in the console). '
      + 'It explains an action refused with plan_limit_reached or plan_feature_unavailable; '
      + 'replies within the 24-hour window are never limited.',
    annotations: lecture('Read the plan'),
    entree: { type: 'object', properties: {} },
    async executer(deps, tenantId) {
      return deps.offre.vue(tenantId);
    },
  },
  /**
   * OÙ EN EST LA MISE EN SERVICE (lot 10) : la première lecture de la skill de mise en service du plugin Claude Code,
   * et de tout client qui reprend une session coupée. La règle de l'étape suivante est dans `./mise-en-service`.
   */
  {
    ...ficheOutilMcp('get_setup_state'),
    fonction: null,
    description:
      'Where the workspace setup stands, in one call: the starting point to set up a workspace or to resume an '
      + 'interrupted setup. Returns the plan (offre), the AI credit (credit_eur), the WhatsApp number (connecte, '
      + 'a_activer, chiffres, fourni, abonnement), the AI agents (actifs, a_completer with nb_manques, desactives), who '
      + 'answers the customer (repondeur.mode, as the plan lets it act), the bubbles (actives, total), and '
      + 'etape_suivante with outils_suggeres: '
      + Object.entries(OUTILS_DE_L_ETAPE).map(([e, o]) => (o.length ? `${e} (${o.join(', ')})` : e)).join(', ') + '. '
      + 'activer_numero: the number is connected but Meta has not activated it; this is finished in the console Home '
      + '("Activate the number"). A responder already chosen (repondeur.mode_choisi: Meta Business Agent, scenario, '
      + 'application) skips the AI agent and responder steps: it is the person\'s choice, and only their request changes '
      + 'it. avertissements: numero_a_activer, credit_epuise (an AI agent no longer answers: buy_credit), '
      + 'repondeur_gele_par_l_offre (the chosen responder is frozen by the current plan), carte_meta_a_regler (Meta '
      + 'blocks the account over its card; etapes_carte_meta gives the steps to follow), lecture_manquee:<source> (this '
      + 'part could not be read: the step it would have given is skipped). The tool only reads.',
    annotations: lecture('Read the setup state'),
    entree: { type: 'object', properties: {} },
    async executer(deps, tenantId) {
      return lireMiseEnService(deps, tenantId);
    },
  },
  // L'agent IA, sa connaissance et le crédit (lot 8a) : leur fichier, `src/mcp/outils-agent.ts`.
  ...OUTILS_AGENT,
  // La connexion du numéro depuis Claude Code (lot 3c) : leur fichier, `src/mcp/outils-numero.ts`.
  ...OUTILS_NUMERO,
  // Les webhooks sortants (lot 12) : leur fichier, `src/mcp/outils-evenements.ts`.
  ...OUTILS_EVENEMENTS,
  // Les modèles (lot 13, domaine 3) : leur fichier, `src/mcp/outils-modeles.ts`.
  ...OUTILS_MODELES,
  // Les campagnes depuis l'assistant (2026-10-20) : leur fichier, `src/mcp/outils-campagnes.ts`.
  ...OUTILS_CAMPAGNES,
  // Les champs depuis l'assistant (2026-10-20) : `src/mcp/outils-champs.ts`.
  ...OUTILS_CHAMPS,
  // Le connecteur Shopify (2026-10-21) : `src/mcp/outils-shopify.ts`.
  ...OUTILS_SHOPIFY,
  // Les chiffres de l'espace, pour les graphiques de Claude (2026-10-13) : leur fichier, `src/mcp/outils-chiffres.ts`.
  ...OUTILS_CHIFFRES,
  // La clé de l'application et le paiement du Pro, depuis Claude (spec offres v2) : leur fichier, `src/mcp/outils-offre.ts`.
  ...OUTILS_OFFRE,
];

/**
 * Les outils qu'un appel a le droit de voir et d'appeler : ceux de ses scopes, moins ceux qui exigent une personne
 * quand il n'en a pas (une clé d'API). `tools/list` et `tools/call` passent par ici tous les deux : un outil écarté
 * n'est pas listé, et son appel est refusé comme celui d'un outil qui n'existe pas.
 */
export function outilsPour(ctx: { scopes: readonly string[]; personne: PersonneMcp | null }): OutilMcp[] {
  return OUTILS.filter((o) => ctx.scopes.includes(o.scope) && (o.exigePersonne !== true || ctx.personne != null));
}

/**
 * La réponse dans la fenêtre de 24 h, ou son refus en `RefusOutil` lisible : le numéro délié ou suspendu (exception du
 * point d'envoi), la conversation inconnue, l'espace sans numéro, le STOP, la fenêtre fermée. Sans cela, l'agent lirait
 * une panne et réessaierait en consommant le plafond de l'espace.
 */
async function reponseOuRefus(envoi: () => Promise<ResultatReponse>): Promise<Extract<ResultatReponse, { messageId: string }>> {
  let res: ResultatReponse;
  try {
    res = await envoi();
  } catch (err) {
    if (err instanceof NumeroBloqueError) throw new RefusOutil(err.message);
    // Meta refuse le contenu : un refus lisible, sinon l'agent lirait une panne et renverrait le même message.
    if (err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500 && !err.retryable) {
      throw new RefusOutil(`Meta a refusé le message : ${(err.userMessage ?? err.message).slice(0, 300)}`);
    }
    throw err;
  }
  if (!('refus' in res)) return res;
  if (res.refus.motif === 'conversation_inconnue') throw new RefusOutil('conversation inconnue dans cet espace');
  if (res.refus.motif === 'aucun_numero') throw new RefusOutil('aucun numéro WhatsApp rattaché à cet espace');
  if (res.refus.motif === 'application_indisponible') throw new RefusOutil(phraseApplicationIndisponible(res.refus.raison));
  if (res.refus.motif === 'format_non_pris_en_charge') throw new RefusOutil(`${PHRASE_FORMAT_APPLICATION} : utilisez reply_in_open_window`);
  // 🔴 Une machine ne parle pas à quelqu'un qui a dit STOP. Le message donne la raison et l'issue (un opérateur peut
  // encore répondre), sinon l'agent conclurait à une panne et réessaierait.
  if (res.refus.motif === 'contact_desabonne') {
    throw new RefusOutil(
      'ce contact a demandé à ne plus recevoir de messages (opt-out) : aucun envoi automatique ne lui '
      + 'est adressé. Un opérateur peut encore lui répondre à la main depuis la console.',
    );
  }
  throw new RefusOutil(
    'fenêtre de 24 h fermée : le contact n’a pas écrit récemment, WhatsApp refuse le message libre. '
    + 'Il faut un template approuvé, envoyé depuis la console.',
  );
}

function resultatEnvoiMcp(res: Extract<ResultatReponse, { messageId: string }>, conversationId: string) {
  return {
    message_id: res.messageId,
    conversation_id: conversationId,
    journal: res.journal,
    ...(res.journal === 'unrecorded'
      ? { warning: 'The provider accepted this message, but its Inbox record could not be confirmed. Do not send it again.' }
      : {}),
  };
}
