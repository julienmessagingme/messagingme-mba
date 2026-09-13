import type { ConversationSummary, ConversationMessage, ListConversationsOptions, ControlOwner } from '../inbox/store.pg';
import type { ContactRow, ContactFilters } from '../crm/contact-store.pg';
import { repondreDansLaFenetre, type DepsRepondre } from '../inbox/repondre';

/**
 * Le CATALOGUE d'outils exposé aux agents tiers par le serveur MCP.
 *
 * 🔴 La règle du lot, et la seule qui compte sur la durée : un outil n'a JAMAIS de logique métier à lui. Il
 * appelle la fonction que la console appelle. C'est pour ça que `reply_in_open_window` passe par
 * `repondreDansLaFenetre`, extrait de la route d'inbox et partagé avec elle : une seconde implémentation
 * dériverait, et une dérive sur une surface d'ÉCRITURE veut dire un agent qui envoie des WhatsApp avec des
 * garde-fous différents de ceux de l'interface (fenêtre de 24 h, prise du fil, journal). C'est la leçon du
 * connecteur HubSpot, en plus dangereux.
 *
 * 🔴 LECTURE D'ABORD, écriture ÉTROITE. Il n'y a volontairement PAS de `send_template` ni rien qui touche
 * aux campagnes : ouvrir l'envoi de template à un modèle, c'est lui donner un mégaphone facturé sur un
 * numéro dont Meta note la qualité. Le jour où on l'ajoutera, ce sera une décision, pas un oubli.
 *
 * 🔴 AUCUN outil n'ÉMET d'événement d'automation. Le CLAUDE.md range l'API publique parmi les chemins qui
 * n'émettent pas, et un serveur MCP en est une : un agent qui boucle sur 500 conversations déclencherait
 * 500 automations, donc des envois facturés que personne n'a demandés. Poser un tag depuis MCP écrit donc
 * le tag SANS réveiller les automations qui l'écoutent, et la description de l'outil le dit à l'intégrateur.
 */

/** Le scope de clé d'API qu'un outil exige. Deux seulement : lire, et écrire. */
export type ScopeMcp = 'mcp:read' | 'mcp:write';

export interface DepsMcp extends DepsRepondre {
  listConversations(tenantId: string, opts?: ListConversationsOptions): Promise<ConversationSummary[]>;
  getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]>;
  getControlOwner?(tenantId: string, waId: string): Promise<ControlOwner>;
  getAssignee?(tenantId: string, conversationId: string): Promise<string | null | undefined>;
  setAssignee?(tenantId: string, conversationId: string, assignee: string | null, parUserId: string | null): Promise<boolean>;
  /** Recherche de contacts (le même moteur de filtres que le mini-CRM). */
  chercherContacts(tenantId: string, filtres: ContactFilters, limit: number, offset: number): Promise<ContactRow[]>;
  contactParTelephone(tenantId: string, phoneE164: string): Promise<ContactRow | null>;
  ajouterTags(tenantId: string, waId: string, tags: string[]): Promise<{ touched: number; added: string[] }>;
  /** Membres de l'espace, pour qu'un agent puisse confier une conversation à quelqu'un de nommé. */
  listerMembres(tenantId: string): Promise<Array<{ id: string; name: string | null; email: string; role: string }>>;
}

/** Un schéma JSON d'entrée, tel que MCP l'attend (sous-ensemble volontairement pauvre : objet + propriétés). */
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
 * Refus MÉTIER d'un outil (fenêtre fermée, conversation inconnue), par opposition à une panne.
 *
 * MCP veut que ce genre d'échec revienne dans le RÉSULTAT avec `isError: true`, et non comme une erreur de
 * protocole : c'est ce qui permet au modèle de lire la raison et de changer de stratégie, au lieu de croire
 * que l'outil est cassé.
 */
export class RefusOutil extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusOutil';
  }
}

/** Lit une chaîne obligatoire. Les entrées viennent d'un MODÈLE : on ne suppose rien de leur forme. */
function texteObligatoire(args: Record<string, unknown>, cle: string, maxi = 4096): string {
  const v = args[cle];
  if (typeof v !== 'string' || v.trim() === '') throw new RefusOutil(`paramètre « ${cle} » requis (texte non vide)`);
  if (v.length > maxi) throw new RefusOutil(`paramètre « ${cle} » trop long (${maxi} caractères au plus)`);
  return v.trim();
}

/** Lit un entier borné. Absent -> défaut. Hors bornes -> ramené dedans, jamais refusé (c'est du confort). */
function entierBorne(args: Record<string, unknown>, cle: string, defaut: number, mini: number, maxi: number): number {
  const v = args[cle];
  if (v === undefined || v === null) return defaut;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return defaut;
  return Math.min(Math.max(Math.trunc(n), mini), maxi);
}

/** La conversation, ou un refus. Sert de garde tenant PARTAGÉE : `getConversationContext` rend `null` pour
 *  une conversation d'un autre espace, donc un identifiant deviné ne dit rien de plus qu'un inexistant. */
async function contexteOuRefus(deps: DepsMcp, tenantId: string, conversationId: string) {
  const ctx = await deps.getConversationContext(conversationId, tenantId);
  if (ctx === null) throw new RefusOutil('conversation inconnue dans cet espace');
  return ctx;
}

/** Un contact rendu à l'agent : on ne sort PAS tout `ContactRow` (champs internes), on choisit. */
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
     * ⚠️ LES CONVERSATIONS ARCHIVÉES SONT EXCLUES, et la description le DIT (2026-09-08).
     *
     * L'archivage est arrivé côté console, et `listConversations` l'applique par défaut : cet outil s'est
     * donc mis à rendre moins de lignes qu'avant, sans que rien ne le signale. Un assistant qui ne lit que
     * le schéma conclurait que la conversation n'existe pas, au lieu de comprendre qu'elle est rangée. La
     * cohérence avec l'Inbox est le bon comportement ; le taire ne l'était pas.
     */
    description:
      'Liste les conversations WhatsApp de l’espace, la plus récemment active en premier. Utilise `a_traiter` '
      + 'pour ne voir que celles dont le scénario ne s’occupe plus et qui attendent une réponse humaine. '
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
        deps.getControlOwner?.(tenantId, ctx.waId) ?? Promise.resolve(undefined),
        deps.getAssignee?.(tenantId, id) ?? Promise.resolve(undefined),
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
      await contexteOuRefus(deps, tenantId, id); // garde tenant AVANT de lire les messages
      const limit = entierBorne(args, 'limit', 50, 1, 200);
      const tous = await deps.getMessages(id);
      // La coupe se fait sur les plus RÉCENTS : un agent qui demande 20 messages veut la fin de l'échange,
      // pas son début. L'ordre chronologique est conservé dans ce qu'on rend.
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
      // Un modèle écrit « 06 12 34 56 78 » aussi bien que « Martin ». On tranche sur ce que la requête
      // CONTIENT plutôt que d'exiger un paramètre de plus, qu'il oublierait.
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
    entree: { type: 'object', properties: {} },
    async executer(deps, tenantId) {
      return { members: await deps.listerMembres(tenantId) };
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
      // Deux champs, deux questions. `auteur = null` : aucun opérateur ne signe ce message, donc pas de
      // pastille d'auteur dans l'inbox. `origine = 'mcp'` : ce qui l'a écrit est un agent tiers, ni un
      // humain ni un scénario. Les déduire l'un de l'autre est précisément le bug que la revue a trouvé,
      // et il était INVISIBLE parce que la valeur fausse était écrite explicitement en base.
      const res = await repondreDansLaFenetre(deps, tenantId, id, texte, null, 'mcp');
      if ('refus' in res) {
        if (res.refus.motif === 'conversation_inconnue') throw new RefusOutil('conversation inconnue dans cet espace');
        if (res.refus.motif === 'aucun_numero') throw new RefusOutil('aucun numéro WhatsApp rattaché à cet espace');
        /**
         * 🔴 UNE MACHINE NE PARLE PAS À QUELQU'UN QUI A DIT STOP (décision de Julien du 2026-09-13). Le
         * message le dit à l'agent ET lui donne l'issue : un opérateur, lui, peut encore répondre. Sans
         * cette phrase, l'agent conclurait à une panne et réessaierait.
         */
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
      // On rend ce qui a RÉELLEMENT changé : un agent qui repose un tag déjà là doit pouvoir s'en rendre
      // compte, sinon il boucle en croyant échouer.
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
      if (!deps.setAssignee) throw new RefusOutil('affectation indisponible sur cette instance');
      const brut = args.member_id;
      // `null` explicite = libérer. Toute autre forme qu'une chaîne non vide est refusée : une valeur
      // bancale ne doit pas se traduire par une libération silencieuse, qui rouvre le fil à tout le monde.
      // Même règle que la route de console, et pour la même raison.
      if (brut !== null && brut !== undefined && (typeof brut !== 'string' || brut.trim() === '')) {
        throw new RefusOutil('paramètre « member_id » invalide (identifiant de membre, ou null pour libérer)');
      }
      const membre = typeof brut === 'string' ? brut.trim() : null;
      // `parUserId = null` : ce n'est pas un humain de la console qui affecte. Le journal d'audit le verra.
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
