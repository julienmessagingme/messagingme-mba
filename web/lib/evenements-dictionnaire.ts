/**
 * LES TYPES DES WEBHOOKS SORTANTS, tels que la documentation publique les annonce (lot 12). Simple donnée, dans `lib/` :
 * `tests/web-evenements-parite.test.ts` la compare au contrat du serveur (`src/evenements/types.ts`, `CHAMPS_DU_TYPE`).
 * Sans cette garde, la page promettrait un champ retiré, ou tairait un type ajouté.
 */
export interface TypeDocumente {
  type: string;
  quand: [string, string];
  /** Les champs de `data`, dans l'ordre où ils partent. */
  champs: readonly string[];
  /** Décoché à la création d'une adresse. */
  decocheParDefaut?: true;
}

export const TYPES_DOCUMENTES: readonly TypeDocumente[] = [
  {
    type: 'message.received',
    quand: ['Un contact vous écrit (texte, bouton tapé, média, réponse de formulaire).', 'A contact writes to you (text, tapped button, media, form reply).'],
    champs: ['contact', 'channel', 'message_id', 'message_type', 'text', 'transcription', 'button'],
  },
  {
    type: 'message.delivered',
    quand: ['Meta confirme la livraison d’un de vos messages.', 'Meta confirms one of your messages was delivered.'],
    champs: ['contact', 'channel', 'message_id', 'origin', 'send_id'],
    decocheParDefaut: true,
  },
  {
    type: 'message.read',
    quand: ['Le contact a lu un de vos messages.', 'The contact read one of your messages.'],
    champs: ['contact', 'channel', 'message_id', 'origin', 'send_id'],
    decocheParDefaut: true,
  },
  {
    type: 'message.failed',
    quand: ['Un de vos messages n’a pas pu être livré.', 'One of your messages could not be delivered.'],
    champs: ['contact', 'channel', 'message_id', 'origin', 'send_id', 'reason', 'meta_code'],
    decocheParDefaut: true,
  },
  {
    type: 'link.clicked',
    quand: ['Le contact a cliqué un lien suivi.', 'The contact clicked a tracked link.'],
    champs: ['contact', 'link', 'template', 'destination'],
  },
  {
    type: 'contact.opted_out',
    quand: ['Le contact s’est désabonné (STOP, fiche, action en masse, API).', 'The contact opted out (STOP, record, bulk action, API).'],
    champs: ['contact', 'channel', 'source'],
  },
  {
    type: 'conversation.analyzed',
    quand: ['L’analyse d’une conversation est prête (offres Pro et Entreprise).', 'A conversation analysis is ready (Pro and Enterprise plans).'],
    champs: [
      'contact', 'conversation_id', 'intent', 'sentiment', 'satisfaction', 'urgency', 'resolved', 'topic', 'action_suggestion',
      'handled_by', 'exchanges_count', 'summary',
    ],
  },
  {
    type: 'contact.risk_changed',
    quand: ['Le risque de désengagement d’un contact a changé de niveau (calcul de nuit).', 'A contact’s disengagement risk changed level (nightly run).'],
    champs: ['contact', 'level', 'previous_level', 'score', 'reasons'],
  },
  {
    type: 'template.status_changed',
    quand: [
      'Meta a tranché sur un de vos modèles (approuvé, refusé, en pause, désactivé). Aucune donnée de contact.',
      'Meta ruled on one of your templates (approved, rejected, paused, disabled). No contact data.',
    ],
    champs: ['template', 'status', 'reason'],
  },
  {
    type: 'conversation.needs_reply',
    quand: [
      'Mode « mon application répond » : un message attend la réponse de votre application, à l’adresse désignée par le répondeur.',
      '“My app answers” mode: a message awaits your app’s answer, at the address set as the responder.',
    ],
    champs: ['contact', 'conversation_id', 'channel', 'message_id', 'message_type', 'text', 'transcription', 'reply_with'],
  },
  {
    type: 'test',
    quand: ['Le bouton « Envoyer un essai », ou l’outil MCP send_test_event.', 'The “Send a test” button, or the send_test_event MCP tool.'],
    champs: ['message'],
  },
];
