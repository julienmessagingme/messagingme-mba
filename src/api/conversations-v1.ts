import type { ControlOwner } from '../inbox/store.pg';

/**
 * LA LECTURE DES FILS PAR L'API (lot 13, domaine 1, spec `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 3) :
 * les formes publiques, les curseurs et les identifiants de message. Le magasin (`conversations-v1.pg.ts`) lit, les
 * routes (`src/http/v1-conversations.ts`) et Claude (`get_messages`) rendent.
 */

/** Qui tient le fil, en trois valeurs publiques : la colonne interne n'a pas à fuir. */
export type Responsable = 'team' | 'meta_agent' | 'automation';
export function responsableDe(owner: ControlOwner): Responsable {
  switch (owner) {
    case 'app_human': return 'team';
    case 'mba': return 'meta_agent';
    case 'app_workflow': return 'automation';
  }
}

export interface ContactDuFil {
  id: string | null;
  phone: string | null;
  name: string | null;
  externalId: string | null;
}

export interface ConversationV1 {
  id: string;
  contact: ContactDuFil;
  lastMessageAt: string;
  lastDirection: 'in' | 'out' | null;
  /** La fin de la fenêtre de 24 h ouverte par le dernier message WhatsApp du contact, `null` si elle est fermée. */
  windowExpiresAt: string | null;
  handledBy: Responsable;
  /** Le fil est dans « À traiter » : la balle est dans le camp de l'équipe. */
  needsReply: boolean;
  archived: boolean;
}

export interface MessageV1 {
  /** L'identifiant de Meta (`wamid.…`), sinon `msg_<uuid>` (`idPublic`). */
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  channel: 'whatsapp' | 'rcs';
  type: string | null;
  text: string | null;
  /** Le `payload` d'un bouton touché par le contact. */
  buttonPayload: string | null;
  /** La transcription d'un vocal, quand elle a été faite : la lecture d'un modèle, pas ce que le client a dit. */
  transcription: string | null;
  /** Un fichier reçu : `GET /v1/messages/{id}/media` le sert tant que Meta le garde (`expired` faux). */
  media: { mimeType: string | null; filename: string | null; expired: boolean } | null;
  /**
   * La livraison d'un message ENVOYÉ : `null` pour un message reçu, et tant qu'aucun accusé n'est arrivé. Ne recule
   * jamais (un `read` arrivé avant le `delivered` reste `read`). `statusAt` : l'instant de l'accusé selon Meta.
   */
  status: StatutMessage | null;
  statusAt: string | null;
  /** L'échec annoncé par Meta (`status: 'failed'`) : son code et son motif, s'ils ont été notés ; `null` sinon. */
  error: { code: number | null; reason: string | null } | null;
  createdAt: string;
}

/** Le statut de livraison d'un message ENVOYÉ, tel que Meta l'annonce (migration 0225). Miroir du CHECK. */
export const STATUTS_MESSAGE = ['sent', 'delivered', 'read', 'failed'] as const;
export type StatutMessage = (typeof STATUTS_MESSAGE)[number];

/** Une page : `nextCursor` mène à la suivante (plus ancienne), `null` quand il n'y en a plus. */
export interface PageV1<T> {
  data: T[];
  nextCursor: string | null;
}

export const LIMITE_PAGE_DEFAUT = 50;
export const LIMITE_PAGE_MAX = 100;

/** Le point de reprise d'une page : l'instant à la microseconde (texte, jamais un `Date`) et l'identifiant. */
export interface Reprise {
  at: string;
  id: string;
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 🔴 Le curseur est OPAQUE et fabriqué par le serveur : base64url de `instant|id`. Le client le renvoie tel quel. Un
 * curseur illisible ou bricolé rend `null`, donc 400 : jamais une page qui recommence au début en silence.
 */
export function encoderCurseur(r: Reprise): string {
  return Buffer.from(`${r.at}|${r.id}`, 'utf8').toString('base64url');
}
export function decoderCurseur(c: string): Reprise | null {
  if (c.length > 200 || !/^[A-Za-z0-9_-]+$/.test(c)) return null;
  const [at, id, ...reste] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (reste.length > 0 || at === undefined || id === undefined || !INSTANT_RE.test(at) || !UUID_RE.test(id)) return null;
  // La FORME ne suffit pas : un 30 février ou un mois 13 passent la regex, et Postgres lève 22008 au cast (donc 500).
  // L'instant doit se relire à l'identique (à la milliseconde, ce que voit `Date`), et pas avant 1970.
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t < 0 || new Date(t).toISOString().slice(0, 23) !== at.slice(0, 23)) return null;
  return { at, id };
}

/** L'identifiant PUBLIC d'un message : celui de Meta, que rendent l'envoi et les événements ; sinon le nôtre, préfixé. */
export const PREFIXE_ID = 'msg_';
export function idPublic(metaMessageId: string | null, id: string): string {
  return metaMessageId ?? `${PREFIXE_ID}${id}`;
}
/** Ce qu'un identifiant public désigne. `null` : il n'a la forme d'aucun des deux (404 sans requête). */
export function lireIdPublic(v: string): { meta: string } | { interne: string } | null {
  if (v.startsWith(PREFIXE_ID)) {
    const id = v.slice(PREFIXE_ID.length);
    return UUID_RE.test(id) ? { interne: id } : null;
  }
  // Un identifiant de Meta : `wamid.` puis du base64, borné (l'index unique le cherche tel quel).
  return v.length <= 200 && /^[A-Za-z0-9._=:+/-]+$/.test(v) ? { meta: v } : null;
}

/** Le dépôt que lisent les routes et Claude. 🔴 Chaque méthode est filtrée sur l'espace : c'est le seul contrôle. */
export interface DepotConversationsV1 {
  lister(tenantId: string, o: { limite: number; avant: Reprise | null; aTraiter: boolean }): Promise<PageV1<ConversationV1>>;
  lire(tenantId: string, conversationId: string): Promise<ConversationV1 | null>;
  /** `null` : la conversation n'est pas dans cet espace. */
  messages(tenantId: string, conversationId: string, o: { limite: number; avant: Reprise | null }): Promise<PageV1<MessageV1> | null>;
  /** Le message désigné par son identifiant public, avec son identifiant interne (pour le média). */
  message(tenantId: string, idPublicDuMessage: string): Promise<(MessageV1 & { idInterne: string }) | null>;
}
