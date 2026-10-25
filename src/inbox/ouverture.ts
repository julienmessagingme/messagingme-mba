import type { ConversationMessage, ControlOwner } from './store.pg';
import type { FilTraduit } from '../traduction/fil';
import type { CauseSansTraduction, LangueConsole } from '../traduction/traduire';
import type { VocalLu } from './transcrire';

export interface ContexteConversationInbox {
  waId: string;
  lastInboundAt: string | null;
  windowOpen: boolean;
  langueContact?: string | null;
}

export interface LectureConversationInbox {
  waId: string;
  lastInboundAt: string | null;
  windowOpen: boolean;
  langueContact: string | null;
  controlOwner: ControlOwner;
  messages: ConversationMessage[];
  traductionIndisponible?: boolean;
  traductionCause?: CauseSansTraduction | 'instance';
}

export interface ConversationInboxOuverte {
  /** Lit le fil et son propriétaire après que la portée de la conversation a été prouvée. */
  lire(
    apres?: { at: string; id: string },
    cible?: LangueConsole | null,
  ): Promise<LectureConversationInbox>;
  /** Marque cette conversation comme lue ; l'identifiant et l'espace ne ressortent plus chez l'appelant. */
  marquerLue(): Promise<void>;
  /** Lit un média appartenant précisément à cette conversation. */
  lireMedia(messageId: string): Promise<{ bytes: Buffer; mime: string | null; nom?: string | null } | null>;
  /** Absente quand cette instance ne sait pas transcrire. */
  transcrire?(messageId: string, cible?: LangueConsole | null): Promise<VocalLu>;
}

export type OuvertureConversationInbox = (
  tenantId: string,
  conversationId: string,
) => Promise<ConversationInboxOuverte | null>;

export interface DepsOuvertureConversationInbox {
  conversations: {
    getConversationContext(conversationId: string, tenantId: string): Promise<ContexteConversationInbox | null>;
    getMessages(conversationId: string, apres?: { at: string; id: string }): Promise<ConversationMessage[]>;
    getControlOwner(tenantId: string, waId: string): Promise<ControlOwner>;
    markConversationRead(tenantId: string, conversationId: string): Promise<void>;
  };
  lireMediaMessage(
    tenantId: string,
    messageId: string,
    conversationId?: string,
  ): Promise<{ bytes: Buffer; mime: string | null; nom?: string | null } | null>;
  transcrireMessage?(
    tenantId: string,
    messageId: string,
    conversationId?: string,
    cible?: LangueConsole | null,
  ): Promise<VocalLu>;
  traduireFil?(
    tenantId: string,
    conversationId: string,
    messages: ConversationMessage[],
    cible: LangueConsole,
  ): Promise<FilTraduit<ConversationMessage>>;
}

/**
 * Ouvre une conversation dans un espace puis enferme cette preuve de portée dans une capacité étroite.
 *
 * Le store garde ses lectures spécialisées, mais les adapters HTTP n'enchaînent plus eux-mêmes « vérifier le
 * contexte puis lire par un identifiant nu ». Toutes les méthodes restent appelées sur leur objet : une classe
 * PostgreSQL qui lit `this.pool` ne perd jamais son receveur.
 */
export function creerOuvertureConversationInbox(deps: DepsOuvertureConversationInbox): OuvertureConversationInbox {
  return async (tenantId, conversationId) => {
    const contexte = await deps.conversations.getConversationContext(conversationId, tenantId);
    if (contexte === null) return null;

    return {
      async lire(apres, cible = null) {
        const messages = await deps.conversations.getMessages(conversationId, apres);
        const traduit = cible !== null && deps.traduireFil
          ? await deps.traduireFil(tenantId, conversationId, messages, cible)
          : null;
        const traductionIndisponible = cible !== null
          ? traduit === null || traduit.indisponible !== null
          : undefined;
        const traductionCause = cible !== null && traductionIndisponible
          ? (traduit === null ? 'instance' : traduit.indisponible ?? undefined)
          : undefined;

        return {
          waId: contexte.waId,
          windowOpen: contexte.windowOpen,
          lastInboundAt: contexte.lastInboundAt,
          langueContact: contexte.langueContact ?? null,
          controlOwner: await deps.conversations.getControlOwner(tenantId, contexte.waId),
          messages: traduit?.messages ?? messages,
          ...(traductionIndisponible !== undefined ? { traductionIndisponible } : {}),
          ...(traductionCause !== undefined ? { traductionCause } : {}),
        };
      },
      marquerLue: () => deps.conversations.markConversationRead(tenantId, conversationId),
      lireMedia: (messageId) => deps.lireMediaMessage(tenantId, messageId, conversationId),
      ...(deps.transcrireMessage
        ? { transcrire: (messageId: string, cible?: LangueConsole | null) => deps.transcrireMessage!(tenantId, messageId, conversationId, cible) }
        : {}),
    };
  };
}
