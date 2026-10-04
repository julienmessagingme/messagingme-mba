import type { ConversationSummary, ConversationMessage, ListConversationsOptions, ControlOwner } from '../inbox/store.pg';
import type { AnalyseEtResume, ContactRow, ContactFilters } from '../crm/contact-store.pg';
import { repondreDansLaFenetre, type ConversationsRepondre, type DepsRepondre } from '../inbox/repondre';
import { parCause, type AuteurDuChangement } from '../inbox/evenements';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE } from '../meta/numero-delie';
import { e164DepuisSaisie } from '../crm/phone';
import {
  DEBUT_AVATAR, MAX_AVATAR_URL, MAX_LIBELLE_WIDGET, MAX_NOM_WIDGET, MAX_PAR_HEURE_WIDGET, MAX_PHRASE_WIDGET,
  MOTIF_COULEUR, POSITIONS_WIDGET, LIMITE_WIDGETS_PAR_ESPACE,
  creerWidget, listerEnVue, miseEnVue, modifierWidget,
  type ChampWidget, type DepsWidgets,
} from '../widgets/gestion';
import type { WorkflowResumeRow } from '../workflow/store.pg';
import type { PlafondPartage } from '../auth/plafond-partage';
import { RefusOutil, entierBorne, texteObligatoire, valeurOuRefus } from './saisie';
import { OUTILS_AGENT, type DepsAgentMcp } from './outils-agent';

export { RefusOutil } from './saisie';

/**
 * Le catalogue d'outils exposé aux agents tiers par le serveur MCP.
 *
 * 🔴 Un outil n'a jamais de logique métier à lui : il appelle la fonction que la console appelle
 * (`reply_in_open_window` passe par `repondreDansLaFenetre`, les outils des widgets par `src/widgets/gestion.ts`).
 * Une seconde implémentation dériverait, et sur une surface d'écriture ce serait un agent qui écrit avec d'autres
 * garde-fous (fenêtre de 24 h, prise du fil, journal, phrase d'un widget).
 * Lecture d'abord, écriture étroite : pas d'envoi de template ni de campagne, un mégaphone facturé sur un numéro
 * dont Meta note la qualité.
 * 🔴 Aucun outil n'émet d'événement d'automation : un agent qui boucle sur 500 conversations déclencherait 500
 * automations facturées. Un tag posé ici ne réveille rien, et la description le dit.
 */

/** Le scope de clé d'API qu'un outil exige. Deux seulement : lire, et écrire. */
export type ScopeMcp = 'mcp:read' | 'mcp:write';

export interface DepsMcp extends DepsRepondre {
  inbox: ConversationsRepondre & {
    listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
    /** Les `n` plus récents, dans l'ordre chronologique : le MCP ne lit jamais le DÉBUT d'un fil. */
    getDerniersMessages(conversationId: string, n: number): Promise<ConversationMessage[]>;
    getControlOwner(tenantId: string, waId: string): Promise<ControlOwner>;
    getAssignee(tenantId: string, conversationId: string): Promise<string | null | undefined>;
    setAssignee(tenantId: string, conversationId: string, assignee: string | null, par: AuteurDuChangement): Promise<boolean>;
  };
  contacts: {
    /** Recherche de contacts (le même moteur de filtres que le mini-CRM). */
    query(tenantId: string, filtres: ContactFilters, limit: number, offset: number): Promise<ContactRow[]>;
    findByPhone(tenantId: string, phoneE164: string): Promise<ContactRow | null>;
    addTagsByPhoneReturningNew(tenantId: string, waId: string, tags: string[]): Promise<{ touched: number; added: string[] }>;
    /** La dernière analyse et son résumé pour une page de fiches, en une requête filtrée sur l'espace. */
    analysesEtResumes(tenantId: string, contactIds: readonly string[]): Promise<Map<string, AnalyseEtResume>>;
  };
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
  /**
   * 🔴 Le plafond des opérations coûteuses de la console, la MÊME instance que celle des routes, comptée par espace
   * sous la même clé : sans lui, le serveur MCP serait la porte qui contourne les dix opérations lourdes par minute
   * (un import de site, un essai facturé, un paiement). Posé par `buildServer` au montage, jamais par le câblage
   * (`CablageMcp`), parce que c'est là qu'il est construit.
   */
  couteux: Pick<PlafondPartage, 'consommer'>;
}

/** Ce que le câblage fournit : tout, sauf le plafond coûteux, que `buildServer` ajoute (voir `couteux`). */
export type CablageMcp = Omit<DepsMcp, 'couteux'>;

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
 * 🔴 Une ÉCRITURE déclare `destructiveHint` et `idempotentHint`, et le type l'exige : absentes, la spécification fait
 * supposer `destructiveHint: true` et `idempotentHint: false`, donc un client demanderait confirmation pour poser un
 * tag. `openWorldHint` : l'outil touche-t-il quelqu'un hors de l'espace (un message part chez une personne) ?
 */
export type AnnotationsMcp = { title: string; openWorldHint: boolean } & (
  | { readOnlyHint: true }
  | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean }
);

/** La personne qui a autorisé un jeton OAuth (migration 0204). Une clé d'API n'en a pas. */
export interface PersonneMcp {
  userId: string;
}

export interface OutilMcp {
  nom: string;
  description: string;
  scope: ScopeMcp;
  annotations: AnnotationsMcp;
  entree: SchemaEntree;
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
    description: 'Le nom du widget, pour s’y retrouver dans la console. Le visiteur ne le voit jamais.',
  },
  phrase: {
    type: 'string', minLength: 1, maxLength: MAX_PHRASE_WIDGET,
    description: 'Le message pré-rempli que le VISITEUR enverra lui-même en cliquant la bulle (exemple : « Bonjour, je '
      + 'viens de la page tarifs »). C’est lui qui reconnaît les conversations du widget, donc il lui est propre : '
      + 'refusé s’il contient, ou s’il est contenu dans, celui d’un autre widget ou d’un lien de chaîne, ou s’il '
      + 'apparaît déjà dans des conversations ordinaires. La casse, les accents et la ponctuation finale ne '
      + 'distinguent pas deux phrases.',
  },
  devenir: {
    type: ['string', 'null'], enum: ['mba', 'scenario', null],
    description: 'Qui répond aux conversations du widget. null (défaut) : comme les autres conversations, le réglage '
      + 'de l’espace décide. « mba » : l’agent de Meta, s’il est allumé. « scenario » : un scénario démarre à '
      + 'l’arrivée du message, il exige workflowId. Confier à un agent IA n’est pas encore possible.',
  },
  workflowId: {
    type: ['string', 'null'], format: 'uuid',
    description: 'Avec devenir « scenario » seulement : l’identifiant d’un scénario de l’espace qui a une version '
      + 'PUBLIÉE (list_scenarios, publie = true).',
  },
  couleur: {
    type: 'string', pattern: MOTIF_COULEUR,
    description: 'La couleur de la bulle, six chiffres hexadécimaux (défaut #25d366, le vert de WhatsApp).',
  },
  position: {
    type: 'string', enum: [...POSITIONS_WIDGET],
    description: 'Le coin de l’écran où la bulle se pose (défaut bas_droite).',
  },
  libelle: {
    type: ['string', 'null'], maxLength: MAX_LIBELLE_WIDGET,
    description: 'Un texte court affiché à côté de la bulle, ou null pour aucun.',
  },
  avatarUrl: {
    type: ['string', 'null'], maxLength: MAX_AVATAR_URL, pattern: `^${DEBUT_AVATAR}`,
    description: 'L’adresse https:// d’une image affichée dans la bulle, ou null pour aucune.',
  },
  actif: {
    type: 'boolean',
    description: 'false éteint la bulle sans qu’il faille retirer la balise du site ; true la rallume (défaut true).',
  },
  maxParHeure: {
    type: ['integer', 'null'], minimum: 1, maximum: MAX_PAR_HEURE_WIDGET,
    description: 'Le nombre de scénarios que ce widget peut démarrer par heure (la phrase est publique, n’importe '
      + 'qui peut l’envoyer en rafale), ou null pour le plafond de l’instance.',
  },
} satisfies Record<ChampWidget, ProprieteEntree>;

/** L'identifiant de conversation, tel que cinq outils le lisent (`texteObligatoire(args, 'conversation_id', 100)`). */
const CONVERSATION_ID: ProprieteEntree = {
  type: 'string', minLength: 1, maxLength: 100, description: 'Identifiant rendu par list_conversations.',
};

/**
 * Le nombre de messages que `get_messages` rend, au plus et par défaut : les plus RÉCENTS. Décision de Julien du
 * 2026-10-03, « c'est déjà bien assez ». Exportée pour que le test des bornes la lise.
 */
export const MAX_MESSAGES_MCP = 50;

/** Les annotations d'une lecture : rien n'est touché, ni dans l'espace ni au-dehors. */
const lecture = (title: string): AnnotationsMcp => ({ title, readOnlyHint: true, openWorldHint: false });

export const OUTILS: OutilMcp[] = [
  {
    nom: 'list_conversations',
    /**
     * Les conversations archivées sont exclues, comme dans l'Inbox, et la description le dit : sinon un agent
     * conclurait qu'une conversation rangée n'existe pas.
     */
    description:
      'Liste les conversations WhatsApp de l’espace, la plus récemment active en premier. Utilise `a_traiter` '
      + 'pour ne voir que celles dont le scénario ne s’occupe plus et qui attendent une réponse humaine '
      + '(une conversation qu’un opérateur a marquée « Traité » n’y figure plus, jusqu’au prochain message du contact). '
      + 'Les conversations ARCHIVÉES depuis l’Inbox ne sont pas listées : elles existent toujours, elles '
      + 'sont simplement rangées, et un message du contact les fait revenir.',
    scope: 'mcp:read',
    annotations: lecture('Lister les conversations'),
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Nombre de conversations (1 à 200, défaut 50).' },
        a_traiter: { type: 'boolean', description: 'Ne garder que les conversations à traiter.' },
      },
    },
    async executer(deps, tenantId, args) {
      const conversations = await deps.inbox.listConversations(tenantId, {
        limit: entierBorne(args, 'limit', 50, 1, 200),
        ...(args.a_traiter === true ? { aTraiter: true } : {}),
      });
      return {
        conversations: conversations.map((c) => ({
          conversation_id: c.id,
          contact: c.profileName ?? c.waId,
          phone: c.waId,
          last_message_at: c.lastMessageAt,
          last_preview: c.lastPreview,
          unread: c.unread,
          handled_by: c.controlOwner,
          assigned_to: c.assignedToName ?? c.assignedTo,
        })),
      };
    },
  },
  {
    nom: 'get_conversation',
    description:
      'Détail d’une conversation : le contact, qui la tient, à qui elle est confiée, et surtout si la '
      + 'fenêtre de service de 24 h est OUVERTE. Hors de cette fenêtre, WhatsApp interdit tout message libre : '
      + 'appelle cet outil avant d’essayer de répondre.',
    scope: 'mcp:read',
    annotations: lecture('Lire une conversation'),
    entree: {
      type: 'object',
      properties: { conversation_id: CONVERSATION_ID },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const ctx = await contexteOuRefus(deps, tenantId, id);
      const [owner, assignee] = await Promise.all([
        deps.inbox.getControlOwner(tenantId, ctx.waId),
        deps.inbox.getAssignee(tenantId, id),
      ]);
      return {
        conversation_id: id,
        phone: ctx.waId,
        window_open: ctx.windowOpen,
        last_inbound_at: ctx.lastInboundAt,
        handled_by: owner ?? null,
        assigned_to: assignee ?? null,
      };
    },
  },
  {
    nom: 'get_messages',
    description:
      `Les messages les plus RÉCENTS d’une conversation, ${MAX_MESSAGES_MCP} au plus, rendus du plus ancien au plus `
      + `récent. tronque = vrai : le fil a des messages plus anciens que ceux rendus ; au-delà des ${MAX_MESSAGES_MCP} `
      + 'derniers, cet outil ne les lit pas.',
    scope: 'mcp:read',
    annotations: lecture('Lire les derniers messages'),
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_MESSAGES_MCP,
          description: `Nombre de messages les plus récents à rendre (1 à ${MAX_MESSAGES_MCP}, défaut ${MAX_MESSAGES_MCP}).`,
        },
      },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      await contexteOuRefus(deps, tenantId, id); // garde d'espace avant de lire les messages
      const limit = entierBorne(args, 'limit', MAX_MESSAGES_MCP, 1, MAX_MESSAGES_MCP);
      // Un de plus que rendu : c'est lui qui dit s'il en reste avant, sans compter le fil entier.
      const lus = await deps.inbox.getDerniersMessages(id, limit + 1);
      return {
        conversation_id: id,
        messages: lus.slice(-limit).map((m) => ({
          direction: m.direction,
          type: m.type,
          body: m.body,
          at: m.createdAt,
        })),
        tronque: lus.length > limit,
      };
    },
  },
  {
    nom: 'search_contacts',
    description:
      'Cherche des contacts par nom ou par numéro. Une requête composée de chiffres est comprise comme une '
      + 'recherche de numéro, sinon comme une recherche de nom. Chaque contact porte sa dernière analyse '
      + '(last_analysis : intention, sentiment, satisfaction et urgence sur 10, résolue, sujet ; null s’il n’a jamais '
      + 'été analysé), sans le résumé : get_contact le rend.',
    scope: 'mcp:read',
    annotations: lecture('Chercher des contacts'),
    entree: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120, description: 'Nom (ou fragment) ou suite de chiffres du numéro.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Nombre de contacts (1 à 100, défaut 20).' },
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
    nom: 'get_contact',
    description: 'La fiche d’un contact à partir de son numéro : international avec ou sans « + » (+33612345678, 33612345678), ou national (06 12 34 56 78). '
      + 'Elle porte la dernière analyse de ses conversations et son résumé (last_analysis, null s’il n’a jamais été analysé).',
    scope: 'mcp:read',
    annotations: lecture('Lire la fiche d’un contact'),
    entree: {
      type: 'object',
      properties: { phone: { type: 'string', minLength: 1, maxLength: 32, description: 'Numéro au format E.164, avec l’indicatif.' } },
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
    nom: 'list_members',
    description:
      'Les membres de l’espace, avec leur identifiant. À appeler avant assign_conversation, qui a besoin de '
      + 'cet identifiant et non du nom.',
    scope: 'mcp:read',
    annotations: lecture('Lister les membres'),
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Nombre de membres (1 à 200, défaut 100).' },
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
    nom: 'reply_in_open_window',
    description:
      'Envoie un message texte dans une conversation, UNIQUEMENT si la fenêtre de service de 24 h est '
      + 'ouverte (le contact a écrit récemment). Hors fenêtre, l’appel est refusé : WhatsApp exige alors un '
      + 'template approuvé, qui n’est pas exposé ici. Envoyer PREND le fil : le scénario cesse d’avancer sur '
      + 'ce contact tant qu’un opérateur ne rend pas la main.',
    scope: 'mcp:write',
    // Le monde ouvert : un message part chez une personne, et ne se reprend pas. Destructrice : l'envoi PREND le fil,
    // le scénario cesse d'avancer, ce qui n'est pas un simple ajout.
    annotations: { title: 'Répondre dans la fenêtre de 24 h', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        text: { type: 'string', minLength: 1, maxLength: 4096, description: 'Le message, tel que le contact le lira.' },
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
      let res: Awaited<ReturnType<typeof repondreDansLaFenetre>>;
      try {
        res = await repondreDansLaFenetre(deps, tenantId, id, texte, personne?.userId ?? null, 'mcp');
      } catch (err) {
        if (err instanceof NumeroDelieError) throw new RefusOutil(MESSAGE_NUMERO_DELIE);
        throw err;
      }
      if ('refus' in res) {
        if (res.refus.motif === 'conversation_inconnue') throw new RefusOutil('conversation inconnue dans cet espace');
        if (res.refus.motif === 'aucun_numero') throw new RefusOutil('aucun numéro WhatsApp rattaché à cet espace');
        // 🔴 Une machine ne parle pas à quelqu'un qui a dit STOP. Le message donne la raison et l'issue (un
        // opérateur peut encore répondre), sinon l'agent conclurait à une panne et réessaierait.
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
      return { message_id: res.messageId, conversation_id: id };
    },
  },
  {
    nom: 'tag_conversation',
    description:
      'Pose un ou plusieurs tags sur le contact d’une conversation. ⚠️ Les automations qui écoutent la pose '
      + 'de tag ne sont PAS déclenchées par cet outil : un tag posé ici classe, il n’envoie rien.',
    scope: 'mcp:write',
    // Ajouter n'écrase rien, et reposer un tag déjà là ne change rien.
    annotations: { title: 'Poser des tags', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        tags: {
          type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 10,
          description: 'Les tags à ajouter (1 à 10).',
        },
      },
      required: ['conversation_id', 'tags'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const bruts = Array.isArray(args.tags) ? args.tags : [args.tags];
      const tags = [...new Set(bruts.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter((s) => s !== ''))].slice(0, 10);
      if (tags.length === 0) throw new RefusOutil('paramètre « tags » requis (au moins un tag non vide)');
      const ctx = await contexteOuRefus(deps, tenantId, id);
      const { added } = await deps.contacts.addTagsByPhoneReturningNew(tenantId, ctx.waId, tags);
      // On rend ce qui a réellement changé : un agent qui repose un tag déjà là doit le voir, sinon il boucle.
      return { conversation_id: id, tags_ajoutes: added, deja_presents: tags.filter((t) => !added.includes(t)) };
    },
  },
  {
    nom: 'assign_conversation',
    description:
      'Confie une conversation à un membre de l’espace, ou la libère avec member_id = null. L’identifiant '
      + 'de membre vient de list_members.',
    scope: 'mcp:write',
    // Destructrice : elle REMPLACE l'assignation en place, qui n'est gardée nulle part ailleurs.
    annotations: { title: 'Confier une conversation', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        conversation_id: CONVERSATION_ID,
        member_id: { type: ['string', 'null'], description: 'Identifiant du membre, ou null pour libérer la conversation.' },
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
  /**
   * LES WIDGETS WHATSAPP (lot 5 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md). Créer une bulle depuis
   * Claude Code est le cas d'usage : l'assistant qui travaille sur le site du client y pose aussi la balise. Ce que
   * l'écran de la console réserve aux administrateurs, une clé d'API ou un jeton OAuth l'ouvre : leurs droits sont
   * donnés par un administrateur, la création de clé et l'autorisation OAuth leur étant réservées (le rôle de la
   * personne d'un jeton est relu à chaque appel).
   */
  {
    nom: 'list_widgets',
    description:
      `Les widgets WhatsApp de l’espace (${LIMITE_WIDGETS_PAR_ESPACE} au plus) : des bulles posées sur un site, qui `
      + 'ouvrent WhatsApp avec un message pré-rempli. Chacun porte son identifiant (id, pour update_widget), son nom, '
      + 'sa phrase, qui répond (devenir, workflowId), s’il est actif, la balise à coller sur le site (balise) et '
      + 'l’adresse de son script, le lien wa.me de la bulle (waMeUrl ; null = la bulle s’affiche grisée, aucun '
      + 'numéro WhatsApp n’est relié), et scenarioSupprime (vrai = son scénario a été supprimé, il ne démarre plus '
      + 'rien : en désigner un autre avec update_widget).',
    scope: 'mcp:read',
    annotations: lecture('Lister les widgets'),
    entree: { type: 'object', properties: {} },
    async executer(deps, tenantId) {
      return listerEnVue(deps.widgets, tenantId);
    },
  },
  {
    nom: 'list_scenarios',
    description:
      'Les scénarios de l’espace, le plus récent en premier : identifiant (id), nom, et publie (vrai = il a une '
      + 'version publiée, donc il peut démarrer). Un widget au devenir « scenario » ne peut désigner qu’un scénario '
      + 'publié : create_widget et update_widget refusent les autres.',
    scope: 'mcp:read',
    annotations: lecture('Lister les scénarios'),
    entree: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Nombre de scénarios (1 à 200, défaut 100).' } },
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
    nom: 'create_widget',
    description:
      'Crée un widget WhatsApp : une bulle à poser sur un site, qui ouvre WhatsApp avec la phrase déjà écrite. Le '
      + 'visiteur clique, puis ENVOIE lui-même la phrase : c’est lui qui ouvre la conversation, sans modèle approuvé, '
      + 'et la phrase dit qu’il vient de ce widget (son contact reçoit l’étiquette widget-<code>, devenir décide qui '
      + 'répond). Rend le widget, dont sa balise (balise) : la coller dans le code HTML du site, juste avant la balise '
      + 'fermante </body>, sur chaque page où la bulle doit apparaître. Elle se charge sans ralentir la page et ne '
      + `change jamais. ${LIMITE_WIDGETS_PAR_ESPACE} widgets au plus par espace. Les contrôles sont ceux de l’écran `
      + 'de la console : un refus dit sa raison.',
    scope: 'mcp:write',
    // Ni destructrice ni idempotente : chaque appel qui réussit crée un widget de plus.
    annotations: { title: 'Créer un widget', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    entree: { type: 'object', properties: CHAMPS_WIDGET, required: ['nom', 'phrase'], additionalProperties: false },
    async executer(deps, tenantId, args) {
      // La vue AVANT l'écriture, comme la route : une panne de la lecture du numéro après coup rendrait une erreur
      // sur un widget créé, et l'assistant qui réessaierait se ferait refuser sa propre phrase.
      const vue = await miseEnVue(deps.widgets, tenantId);
      return { widget: vue(valeurOuRefus(await creerWidget(deps.widgets.gestion, tenantId, args))) };
    },
  },
  {
    nom: 'update_widget',
    description:
      'Modifie un widget : seuls les champs fournis changent, null efface un champ facultatif. Son code, donc la '
      + 'balise déjà posée sur le site, ne change jamais. Les contrôles sont ceux de la création. Un widget dont le '
      + 'scénario a été supprimé reste modifiable sans en choisir un autre.',
    scope: 'mcp:write',
    // Destructrice : elle écrase les champs fournis, et `actif: false` éteint une bulle publique.
    annotations: { title: 'Modifier un widget', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        widget_id: {
          type: 'string', format: 'uuid', minLength: 1, maxLength: 100,
          description: 'L’identifiant (id) rendu par list_widgets ou create_widget.',
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
  // L'agent IA, sa connaissance et le crédit (lot 8a) : leur fichier, `src/mcp/outils-agent.ts`.
  ...OUTILS_AGENT,
];

/**
 * Les outils qu'un appel a le droit de voir et d'appeler : ceux de ses scopes, moins ceux qui exigent une personne
 * quand il n'en a pas (une clé d'API). `tools/list` et `tools/call` passent par ici tous les deux : un outil écarté
 * n'est pas listé, et son appel est refusé comme celui d'un outil qui n'existe pas.
 */
export function outilsPour(ctx: { scopes: readonly string[]; personne: PersonneMcp | null }): OutilMcp[] {
  return OUTILS.filter((o) => ctx.scopes.includes(o.scope) && (o.exigePersonne !== true || ctx.personne != null));
}
