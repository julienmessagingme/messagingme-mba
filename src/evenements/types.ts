import { randomUUID } from 'node:crypto';
import type { NomEvenement, Signal, SignalComplet } from '../signaux/types';

/**
 * Le contrat des webhooks sortants (lot 12, spec `docs/superpowers/specs/2026-10-08-webhooks-sortants-design.md`) :
 * ce qui part vers l'application d'un client, sous quels noms, et sous quelle forme.
 *
 * Le mot « webhook » désigne déjà l'ENTRÉE dans ce dépôt (`src/webhooks/`) : ce module dit « événements ». La
 * documentation publique décrit ces types champ par champ, tenue en parité par un test.
 *
 * Les noms sont pointés (`message.received`), pas `em_*` : `em_` est un héritage d'Engage Me et une borne propre à
 * Batch. Le dictionnaire des signaux garde ses noms ; la traduction est le tableau `TYPE_DU_SIGNAL`, un pour un.
 */

/** Les types qu'une adresse peut cocher : un par signal déjà câblé. */
export const TYPES_ABONNABLES = [
  'message.received',
  'message.delivered',
  'message.read',
  'message.failed',
  'link.clicked',
  'contact.opted_out',
  'conversation.analyzed',
  'contact.risk_changed',
] as const;
export type TypeAbonnable = (typeof TYPES_ABONNABLES)[number];

/** L'événement d'essai : il ne s'abonne pas, il part d'un bouton (ou de l'outil MCP) vers une adresse précise. */
export const TYPE_ESSAI = 'test';
export type TypeEvenement = TypeAbonnable | typeof TYPE_ESSAI;

/** La traduction d'un signal en type public. Exhaustive : un signal ajouté demain ne compile pas sans son type. */
export const TYPE_DU_SIGNAL: Readonly<Record<NomEvenement, TypeAbonnable>> = {
  em_replied: 'message.received',
  em_message_delivered: 'message.delivered',
  em_message_read: 'message.read',
  em_message_failed: 'message.failed',
  em_link_clicked: 'link.clicked',
  em_opted_out: 'contact.opted_out',
  em_conversation_analyzed: 'conversation.analyzed',
  em_risk_changed: 'contact.risk_changed',
};

/**
 * Décochés à la création d'une adresse : une campagne en produit jusqu'à trois par destinataire, et une application
 * qui ne les attend pas recevrait des milliers d'appels d'un coup. Le client les coche s'il en veut.
 */
export const TYPES_DECOCHES_PAR_DEFAUT: ReadonlySet<TypeAbonnable> = new Set(['message.delivered', 'message.read', 'message.failed']);

export function estTypeAbonnable(v: unknown): v is TypeAbonnable {
  return typeof v === 'string' && (TYPES_ABONNABLES as readonly string[]).includes(v);
}

/** Le préfixe d'un identifiant d'événement : `evt_` puis l'identifiant stable du signal (32 caractères hexadécimaux). */
export const PREFIXE_EVENEMENT = 'evt_';

/**
 * L'identifiant public d'un événement. Celui d'un signal est stable (le même au réessai, au rejeu, et pour un
 * message redélivré par Meta) : c'est ce qui permet au client de dédoublonner. On ne garde que l'hexadécimal, un
 * aléa de signal (`randomUUID`) perd ses tirets.
 */
export function idEvenement(idDuSignal: string): string {
  return PREFIXE_EVENEMENT + idDuSignal.replace(/-/g, '');
}

export function idEssai(): string {
  return idEvenement(randomUUID());
}

/** La fiche, telle qu'elle part dans chaque événement qui en a une. */
export interface ContactPublic {
  id: string;
  /** Le numéro en E.164, ou `null` pour un contact connu seulement par son identifiant WhatsApp (BSUID). */
  phone: string | null;
  name: string | null;
  external_id: string | null;
  opted_out: { whatsapp: boolean; rcs: boolean };
}

/** Ce que l'envoi part chercher en plus du signal complété : le message lui-même, pour `message.received`. */
export interface MessageRecu {
  type: string | null;
  text: string | null;
  transcription: string | null;
}

export interface Enveloppe {
  id: string;
  type: TypeEvenement;
  created_at: string;
  workspace_id: string;
  data: Record<string, unknown>;
}

function contactPublic(c: SignalComplet['contact']): ContactPublic {
  return {
    id: c.contactId,
    phone: c.telephone,
    name: c.nom,
    external_id: c.externalId,
    opted_out: { whatsapp: c.optOutWhatsapp, rcs: c.optOutRcs },
  };
}

/**
 * Le contenu d'un événement, à partir du signal émis (ce que le chemin chaud savait : identifiant du message) et du
 * signal complété (la fiche et ce qui a été relu). Figé ici, à la distribution : un réessai renvoie ce corps, pas
 * l'état de la fiche au moment du réessai.
 */
export function donneesDuSignal(s: Signal, c: SignalComplet, message: MessageRecu | null): Record<string, unknown> {
  const contact = contactPublic(c.contact);
  const k = c.contenu;
  switch (k.nom) {
    case 'em_replied':
      return {
        contact, channel: k.canal,
        message_id: s.nom === 'em_replied' ? (s.messageId ?? null) : null,
        message_type: message?.type ?? null,
        text: message?.text ?? null,
        transcription: message?.transcription ?? null,
        button: k.bouton,
      };
    case 'em_message_delivered':
    case 'em_message_read':
      return {
        contact, channel: k.canal, message_id: 'messageId' in s ? s.messageId : null, origin: k.origine, send_id: k.sendId,
      };
    case 'em_message_failed':
      return {
        contact, channel: k.canal, message_id: 'messageId' in s ? s.messageId : null, origin: k.origine, send_id: k.sendId,
        reason: k.motif, meta_code: k.codeMeta,
      };
    case 'em_link_clicked':
      return { contact, link: k.lien, template: k.template, destination: k.destination };
    case 'em_opted_out':
      return { contact, channel: k.canal, source: k.source };
    case 'em_conversation_analyzed': {
      const a = k.analyse;
      return {
        contact,
        conversation_id: s.nom === 'em_conversation_analyzed' ? s.conversationId : null,
        intent: a.intent, sentiment: a.sentiment, satisfaction: a.satisfaction, urgency: a.urgence, resolved: a.resolved,
        topic: a.topic, action_suggestion: a.actionSuggestion, handled_by: a.handledBy, exchanges_count: a.exchangesCount,
        summary: a.summary,
      };
    }
    case 'em_risk_changed':
      return { contact, level: k.niveau, previous_level: k.ancienNiveau, score: k.score, reasons: k.raisons };
  }
}

export function enveloppe(o: { id: string; type: TypeEvenement; le: string; tenantId: string; data: Record<string, unknown> }): Enveloppe {
  return { id: o.id, type: o.type, created_at: o.le, workspace_id: o.tenantId, data: o.data };
}

/** Les champs de `data`, par type : la documentation publique les liste, et un test tient la parité. */
export const CHAMPS_DU_TYPE: Readonly<Record<TypeEvenement, readonly string[]>> = {
  'message.received': ['contact', 'channel', 'message_id', 'message_type', 'text', 'transcription', 'button'],
  'message.delivered': ['contact', 'channel', 'message_id', 'origin', 'send_id'],
  'message.read': ['contact', 'channel', 'message_id', 'origin', 'send_id'],
  'message.failed': ['contact', 'channel', 'message_id', 'origin', 'send_id', 'reason', 'meta_code'],
  'link.clicked': ['contact', 'link', 'template', 'destination'],
  'contact.opted_out': ['contact', 'channel', 'source'],
  'conversation.analyzed': [
    'contact', 'conversation_id', 'intent', 'sentiment', 'satisfaction', 'urgency', 'resolved', 'topic',
    'action_suggestion', 'handled_by', 'exchanges_count', 'summary',
  ],
  'contact.risk_changed': ['contact', 'level', 'previous_level', 'score', 'reasons'],
  test: ['message'],
};

/** Le contenu de l'événement d'essai : aucune donnée de contact. */
export function donneesEssai(): Record<string, unknown> {
  return { message: 'Événement d’essai envoyé depuis Messaging Me.' };
}
