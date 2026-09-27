import type { ConversationSummary, ConversationMessage, ListConversationsOptions, ControlOwner } from '../inbox/store.pg';
import type { ContactRow, ContactFilters } from '../crm/contact-store.pg';
import { repondreDansLaFenetre, type DepsRepondre } from '../inbox/repondre';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE } from '../meta/numero-delie';

/**
 * Le catalogue d'outils exposé aux agents tiers par le serveur MCP.
 *
 * 🔴 Un outil n'a jamais de logique métier à lui : il appelle la fonction que la console appelle
 * (`reply_in_open_window` passe par `repondreDansLaFenetre`). Une seconde implémentation dériverait, et sur une
 * surface d'écriture ce serait un agent qui envoie avec d'autres garde-fous (fenêtre de 24 h, prise du fil, journal).
 * Lecture d'abord, écriture étroite : pas d'envoi de template ni de campagne, un mégaphone facturé sur un numéro
 * dont Meta note la qualité.
 * 🔴 Aucun outil n'émet d'événement d'automation : un agent qui boucle sur 500 conversations déclencherait 500
 * automations facturées. Un tag posé ici ne réveille rien, et la description le dit.
 */

/** Le scope de clé d'API qu'un outil exige. Deux seulement : lire, et écrire. */
export type ScopeMcp = 'mcp:read' | 'mcp:write';

export interface DepsMcp extends DepsRepondre {
  listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
  getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]>;
  getControlOwner(tenantId: string, waId: string): Promise<ControlOwner>;
  getAssignee(tenantId: string, conversationId: string): Promise<string | null | undefined>;
  setAssignee(tenantId: string, conversationId: string, assignee: string | null, parUserId: string | null): Promise<boolean>;
  /** Recherche de contacts (le même moteur de filtres que le mini-CRM). */
  chercherContacts(tenantId: string, filtres: ContactFilters, limit: number, offset: number): Promise<ContactRow[]>;
  contactParTelephone(tenantId: string, phoneE164: string): Promise<ContactRow | null>;
  ajouterTags(tenantId: string, waId: string, tags: string[]): Promise<{ touched: number; added: string[] }>;
  /** Membres de l'espace, pour qu'un agent puisse confier une conversation à quelqu'un de nommé. */
  listerMembres(tenantId: string): Promise<Array<{ id: string; name: string | null; email: string; role: string }>>;
}

/** Un schéma JSON d'entrée, tel que MCP l'attend (sous-ensemble volontairement pauvre : objet et propriétés). */
interface SchemaEntree {
  type: 'object';
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required?: string[];
}

export interface OutilMcp {
  nom: string;
  description: string;
  scope: ScopeMcp;
  entree: SchemaEntree;
  /** Rend l'objet à sérialiser pour l'agent, ou lève `RefusOutil` pour un refus explicable. */
  executer(deps: DepsMcp, tenantId: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Refus métier d'un outil (fenêtre fermée, conversation inconnue), par opposition à une panne. MCP le veut dans le
 * résultat avec `isError: true` : le modèle lit la raison et change de stratégie au lieu de croire l'outil cassé.
 */
export class RefusOutil extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusOutil';
  }
}

/** Lit une chaîne obligatoire. Les entrées viennent d'un modèle : on ne suppose rien de leur forme. */
function texteObligatoire(args: Record<string, unknown>, cle: string, maxi = 4096): string {
  const v = args[cle];
  if (typeof v !== 'string' || v.trim() === '') throw new RefusOutil(`paramètre « ${cle} » requis (texte non vide)`);
  if (v.length > maxi) throw new RefusOutil(`paramètre « ${cle} » trop long (${maxi} caractères au plus)`);
  return v.trim();
}

/** Lit un entier borné. Absent : défaut. Hors bornes : ramené dedans, jamais refusé. */
function entierBorne(args: Record<string, unknown>, cle: string, defaut: number, mini: number, maxi: number): number {
  const v = args[cle];
  if (v === undefined || v === null) return defaut;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(Math.max(Math.trunc(n), mini), maxi);
}

/** 🔴 La conversation, ou un refus : garde d'espace partagée. `getConversationContext` rend `null` pour une
 *  conversation d'un autre espace, donc un identifiant deviné ne dit rien de plus qu'un inexistant. */
async function contexteOuRefus(deps: DepsMcp, tenantId: string, conversationId: string) {
  const ctx = await deps.getConversationContext(conversationId, tenantId);
  if (ctx === null) throw new RefusOutil('conversation inconnue dans cet espace');
  return ctx;
}

/** Un contact rendu à l'agent : on choisit les champs, jamais tout `ContactRow`. */
function contactPublic(c: ContactRow): Record<string, unknown> {
  return {
    id: c.id,
    phone: c.phoneE164,
    name: c.profileName,
    opt_in: c.optInStatus,
    tags: c.tags,
    fields: c.fields,
    created_at: c.createdAt,
  };
}

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
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Nombre de conversations (1 à 200, défaut 50).' },
        a_traiter: { type: 'boolean', description: 'Ne garder que les conversations à traiter.' },
      },
    },
    async executer(deps, tenantId, args) {
      const conversations = await deps.listConversations(tenantId, {
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
    entree: {
      type: 'object',
      properties: { conversation_id: { type: 'string', description: 'Identifiant rendu par list_conversations.' } },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const ctx = await contexteOuRefus(deps, tenantId, id);
      const [owner, assignee] = await Promise.all([
        deps.getControlOwner(tenantId, ctx.waId),
        deps.getAssignee(tenantId, id),
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
    description: 'Les messages d’une conversation, du plus ancien au plus récent.',
    scope: 'mcp:read',
    entree: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Identifiant rendu par list_conversations.' },
        limit: { type: 'integer', description: 'Nombre de messages les plus RÉCENTS à rendre (1 à 200, défaut 50).' },
      },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      await contexteOuRefus(deps, tenantId, id); // garde d'espace avant de lire les messages
      const limit = entierBorne(args, 'limit', 50, 1, 200);
      const tous = await deps.getMessages(id);
      // La coupe garde les plus récents (la fin de l'échange), dans l'ordre chronologique.
      return {
        conversation_id: id,
        messages: tous.slice(-limit).map((m) => ({
          direction: m.direction,
          type: m.type,
          body: m.body,
          at: m.createdAt,
        })),
        tronque: tous.length > limit,
      };
    },
  },
  {
    nom: 'search_contacts',
    description:
      'Cherche des contacts par nom ou par numéro. Une requête composée de chiffres est comprise comme une '
      + 'recherche de numéro, sinon comme une recherche de nom.',
    scope: 'mcp:read',
    entree: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nom (ou fragment) ou suite de chiffres du numéro.' },
        limit: { type: 'integer', description: 'Nombre de contacts (1 à 100, défaut 20).' },
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
      const contacts = await deps.chercherContacts(tenantId, filtres, entierBorne(args, 'limit', 20, 1, 100), 0);
      return { contacts: contacts.map(contactPublic) };
    },
  },
  {
    nom: 'get_contact',
    description: 'La fiche d’un contact à partir de son numéro au format international (ex. +33612345678).',
    scope: 'mcp:read',
    entree: {
      type: 'object',
      properties: { phone: { type: 'string', description: 'Numéro au format E.164, avec l’indicatif.' } },
      required: ['phone'],
    },
    async executer(deps, tenantId, args) {
      const phone = texteObligatoire(args, 'phone', 32);
      const c = await deps.contactParTelephone(tenantId, phone);
      if (!c) throw new RefusOutil('aucun contact avec ce numéro dans cet espace');
      return contactPublic(c);
    },
  },
  {
    nom: 'list_members',
    description:
      'Les membres de l’espace, avec leur identifiant. À appeler avant assign_conversation, qui a besoin de '
      + 'cet identifiant et non du nom.',
    scope: 'mcp:read',
    entree: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Nombre de membres (1 à 200, défaut 100).' },
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
    entree: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Identifiant rendu par list_conversations.' },
        text: { type: 'string', description: 'Le message, tel que le contact le lira.' },
      },
      required: ['conversation_id', 'text'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const texte = texteObligatoire(args, 'text', 4096);
      // Deux champs, deux questions : `auteur = null` (aucun opérateur ne signe, pas de pastille dans l'inbox) et
      // `origine = 'mcp'` (un agent tiers l'a écrit). Les déduire l'un de l'autre écrit une valeur fausse en base.
      // Le numéro délié sort en exception : traduit en refus, sinon l'agent lirait une panne et réessaierait en
      // consommant le plafond de l'espace.
      let res: Awaited<ReturnType<typeof repondreDansLaFenetre>>;
      try {
        res = await repondreDansLaFenetre(deps, tenantId, id, texte, null, 'mcp');
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
    entree: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Identifiant rendu par list_conversations.' },
        tags: { type: 'array', description: 'Les tags à ajouter (1 à 10).' },
      },
      required: ['conversation_id', 'tags'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const bruts = Array.isArray(args.tags) ? args.tags : [args.tags];
      const tags = [...new Set(bruts.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter((s) => s !== ''))].slice(0, 10);
      if (tags.length === 0) throw new RefusOutil('paramètre « tags » requis (au moins un tag non vide)');
      const ctx = await contexteOuRefus(deps, tenantId, id);
      const { added } = await deps.ajouterTags(tenantId, ctx.waId, tags);
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
    entree: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Identifiant rendu par list_conversations.' },
        member_id: { type: 'string', description: 'Identifiant du membre, ou null pour libérer la conversation.' },
      },
      required: ['conversation_id'],
    },
    async executer(deps, tenantId, args) {
      const id = texteObligatoire(args, 'conversation_id', 100);
      const brut = args.member_id;
      // `null` explicite = libérer. Toute autre forme qu'une chaîne non vide est refusée : une valeur bancale ne
      // doit pas devenir une libération silencieuse, qui rouvre le fil à tout le monde.
      if (brut !== null && brut !== undefined && (typeof brut !== 'string' || brut.trim() === '')) {
        throw new RefusOutil('paramètre « member_id » invalide (identifiant de membre, ou null pour libérer)');
      }
      const membre = typeof brut === 'string' ? brut.trim() : null;
      // `parUserId = null` : ce n'est pas un humain de la console qui affecte, le journal d'audit le verra.
      const ok = await deps.setAssignee(tenantId, id, membre, null);
      if (!ok) throw new RefusOutil('conversation inconnue, ou membre étranger à cet espace');
      return { conversation_id: id, assigned_to: membre };
    },
  },
];

/** Les outils qu'une clé porteuse de `scopes` a le droit d'appeler. */
export function outilsPourScopes(scopes: string[]): OutilMcp[] {
  return OUTILS.filter((o) => scopes.includes(o.scope));
}
