// web/lib/api-exemples.ts
/**
 * LES EXEMPLES DE LA DOCUMENTATION DE L'API (ses pages, `web/lib/doc-api-pages.ts`), ses codes et ses bornes.
 * Les tableaux de champs vivent à côté, dans `web/lib/api-champs.ts`.
 *
 * 🔴 UN MODULE, PAS DU TEXTE DANS LES PAGES, et c'est tout son intérêt : `tests/api-exemples.test.ts` passe
 * chaque corps aux règles de SA route (schéma zod, clé d'idempotence, règles de cible). Une page ne peut donc
 * plus montrer un corps que le serveur refuse. La même suite tient les codes égaux à ceux du serveur (nom,
 * statut, motif d'écart), les bornes égales à ce que les routes acceptent, et les réponses typées par ce que
 * les routes rendent.
 *
 * ⚠️ AUCUN IMPORT : ce fichier est lu par le build de la console ET par la suite de tests racine. Tirer un
 * module serveur ici l'embarquerait dans le bundle du navigateur, et un alias `@/` ne se résout pas depuis
 * la racine.
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ, ni ici ni dans la page (décision de Julien du 2026-09-24) : la documentation
 * sert à tous les intégrateurs. Les identifiants d'exemple sont neutres. La suite le vérifie.
 *
 * ⚠️ AUCUNE APOSTROPHE DROITE dans un corps : la page en fait des commandes curl, dont le corps est entre
 * apostrophes. Le français s'écrit ici avec l'apostrophe typographique.
 */

export type Bilingue = readonly [fr: string, en: string];

/** Les routes qui prennent un corps. Chacune a son validateur dans la suite, et au moins un exemple ici. */
export type RouteAvecCorps =
  | 'POST /v1/contacts'
  | 'POST /v1/contacts/batch'
  | 'POST /v1/contacts/search'
  | 'PATCH /v1/contacts/{contactId}'
  | 'POST /v1/sends'
  | 'POST /v1/messages/whatsapp'
  | 'POST /v1/messages'
  | 'POST /v1/messages/rcs'
  | 'POST /v1/templates'
  | 'POST /v1/webhooks'
  | 'PATCH /v1/webhooks/{webhookId}'
  | 'POST /v1/webhooks/{webhookId}/replay-failures';

export interface ExempleCorps {
  readonly route: RouteAvecCorps;
  readonly corps: unknown;
}

const CONTACT_ID = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const CONTACT_ID_2 = '7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c';
const SEND_ID = '0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d';
const CONVERSATION_ID = 'c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b';
/** Une adresse de webhook sortant, telle que `/v1/webhooks` la rend (lot 13, domaine 4). */
const WEBHOOK = {
  id: '3b8e1f2a-7c4d-4e9b-a5f6-0d1c2b3a4e5f', url: 'https://www.exemple.fr/messagingme/evenements', description: 'Mon application',
  types: ['message.received', 'template.status_changed'], active: true, createdAt: '2026-10-09T08:00:00.000Z',
  previousSecretValidUntil: null, lastDeliveredAt: '2026-10-09T09:41:02.000Z', retrying: 0, failed: 1,
} as const;
/**
 * Les codes publics, sous la forme que le serveur les pose (`<type>_<code client>_<ULID en majuscules>`) : un
 * code d'exemple d'une autre forme ne serait retrouvé par aucune cible. Deux scénarios : le premier ouvre par un
 * template (`SCENARIO`, bloc d'entrée `ENTREE_SCENARIO`), le second par un message de session (`SCENARIO_FENETRE`,
 * qui ne se vise que par son bloc d'entrée, `BLOC`).
 */
const SCENARIO = 'scn_k3f9qa_01J8Z3M4V6X7Y8Z9A0B1C2D3E4';
const ENTREE_SCENARIO = 'nod_k3f9qa_01J8Z3Q7Y9Z0A1B2C3D4E5F6G7';
const SCENARIO_FENETRE = 'scn_k3f9qa_01J8Z3P6X8Y9Z0A1B2C3D4E5F6';
const BLOC = 'nod_k3f9qa_01J8Z3N5W7X8Y9Z0A1B2C3D4E5';

export const EXEMPLES_CORPS = {
  contactCreer: {
    route: 'POST /v1/contacts',
    corps: {
      phone: '+33612345678',
      externalId: 'crm-7781',
      name: 'Camille Roy',
      fields: { ville: 'Lyon' },
      tags: ['prospect'],
      consent: 'opted_in',
      consentSource: 'formulaire-site',
    },
  },
  contactsLot: {
    route: 'POST /v1/contacts/batch',
    corps: {
      contacts: [
        { phone: '+33612345678', externalId: 'crm-7781' },
        { phone: '+33698765432', externalId: 'crm-7782', consent: 'opted_out', consentSource: 'desinscription-email' },
      ],
    },
  },
  contactRechercher: {
    route: 'POST /v1/contacts/search',
    corps: { externalId: 'crm-7781' },
  },
  contactModifier: {
    route: 'PATCH /v1/contacts/{contactId}',
    corps: {
      fields: { ville: 'Grenoble', code_promo: null },
      addTags: ['client'],
      removeTags: ['prospect'],
      consent: 'opted_out',
      consentSource: 'centre-de-preferences',
    },
  },
  envoiTemplate: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'confirmation-8412',
      target: { template: { name: 'confirmation_commande', language: 'fr' } },
      recipients: [
        { externalId: 'crm-7781', phone: '+33612345678', consent: 'opted_in', variables: { commande: '8412' } },
        { contactId: CONTACT_ID_2, variables: { commande: '8413' } },
      ],
      params: [
        { position: 1, source: { type: 'field', key: 'prenom' } },
        { position: 2, source: { type: 'variable', key: 'commande' } },
      ],
      ratePerMinute: 20,
    },
  },
  // Le scénario ouvre par `confirmation_commande` (deux variables, `EXEMPLES_REPONSES.scenarios` et
  // `.templates`) : `params` en décrit donc exactement deux, et jamais par la source « variable ».
  envoiScenario: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'suivi-commande-crm-7781-2026-09-24',
      target: { scenario: SCENARIO },
      category: 'utility',
      recipients: [{ externalId: 'crm-7781' }],
      params: [
        { position: 1, source: { type: 'field', key: 'prenom' } },
        { position: 2, source: { type: 'field', key: 'numero_commande' } },
      ],
    },
  },
  envoiBloc: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'relance-fenetre-crm-7781-2026-09-24',
      target: { node: BLOC },
      category: 'utility',
      recipients: [{ contactId: CONTACT_ID }],
    },
  },
  envoiRcs: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'rappel-rdv-crm-7781-2026-09-24',
      target: { rcsMessage: 'rappel-rdv' },
      category: 'utility',
      recipients: [{ externalId: 'crm-7781', variables: { date_rdv: 'jeudi 25 septembre à 14 h' } }],
    },
  },
  messageWhatsapp: {
    route: 'POST /v1/messages/whatsapp',
    corps: { externalId: 'crm-7781', text: 'Votre commande 8412 est prête, vous pouvez passer la retirer.' },
  },
  // Le corps de Meta tel quel (lot 13, domaine 2) : deux boutons de réponse.
  messageMeta: {
    route: 'POST /v1/messages',
    corps: {
      messaging_product: 'whatsapp',
      to: '+33612345678',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Votre commande 8412 part demain. On la livre où ?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'domicile', title: 'À domicile' } },
            { type: 'reply', reply: { id: 'relais', title: 'En point relais' } },
          ],
        },
      },
    },
  },
  // Un modèle au format de Meta (lot 13, domaine 3) : une image d'en-tête par son adresse, une variable, deux boutons.
  modeleMeta: {
    route: 'POST /v1/templates',
    corps: {
      name: 'commande_prete',
      language: 'fr',
      category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://www.exemple.fr/img/commande.jpg'] } },
        { type: 'BODY', text: 'Bonjour {{1}}, votre commande est prête. Vous pouvez passer la retirer.', example: { body_text: [['Claire']] } },
        { type: 'FOOTER', text: 'Boutique du centre' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'J’arrive' },
            { type: 'URL', text: 'Voir la commande', url: 'https://www.exemple.fr/commandes' },
          ],
        },
      ],
    },
  },
  // Les webhooks sortants par l'API (lot 13, domaine 4).
  webhookCree: {
    route: 'POST /v1/webhooks',
    corps: { url: 'https://www.exemple.fr/messagingme/evenements', description: 'Mon application', types: ['message.received', 'template.status_changed'] },
  },
  webhookEnPause: { route: 'PATCH /v1/webhooks/{webhookId}', corps: { active: false } },
  rejeuEchecs: { route: 'POST /v1/webhooks/{webhookId}/replay-failures', corps: { since: '2026-10-09T00:00:00Z' } },
  messageRcs: {
    route: 'POST /v1/messages/rcs',
    corps: { phone: '+33612345678', text: 'Votre rendez-vous de jeudi 14 h est confirmé.' },
  },
  outilParContact: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'relance-panier-crm-7781-etape-3-2026-09-24',
      target: { template: { name: 'relance_panier', language: 'fr' } },
      recipients: [{
        externalId: 'crm-7781',
        phone: '+33612345678',
        consent: 'opted_in',
        consentSource: 'outil-marketing',
        variables: { produit: 'Veste en lin' },
      }],
      params: [{ position: 1, source: { type: 'variable', key: 'produit' } }],
    },
  },
} as const satisfies Record<string, ExempleCorps>;

const CONTACT_LU = {
  contactId: CONTACT_ID,
  externalId: 'crm-7781',
  phone: '+33612345678',
  bsuid: null,
  name: 'Camille Roy',
  fields: { ville: 'Lyon' },
  tags: ['prospect'],
  consent: { status: 'opted_in', source: 'formulaire-site', optedOutAt: null },
  rcsOptedOutAt: null,
  blocked: false,
  reachability: { whatsapp: true, rcs: null },
  engagementRisk: { level: 'moyen', score: 40, reasons: ['silence_60j'], computedAt: '2026-09-25T03:05:00.000Z' },
  lastAnalysis: {
    intent: 'suivi_commande',
    sentiment: 'negatif',
    satisfaction: 3,
    urgency: 7,
    resolved: false,
    topic: 'Colis en retard',
    handledBy: 'humain',
    actionSuggestion: 'rappeler',
    analyzedAt: '2026-09-26T14:32:00.000Z',
  },
  createdAt: '2026-09-24T10:00:00.000Z',
} as const;

/**
 * La réponse 200 des deux routes de message simple. ⚠️ `conversationId` peut valoir `null` en RCS : le message est
 * parti, mais la fiche a été bloquée ou supprimée entre-temps et aucun fil ne l'accueille. Typée ici (et pas
 * laissée à `as const`, qui l'aurait figée en chaîne) : `tests/api-exemples.test.ts` la tient égale à ce que les
 * routes rendent.
 */
export interface MessageEnvoye {
  readonly messageId: string;
  readonly conversationId: string | null;
  readonly channel: 'whatsapp' | 'rcs';
}

const MESSAGE_ENVOYE: MessageEnvoye = { messageId: 'wamid.exemple-8412', conversationId: CONVERSATION_ID, channel: 'whatsapp' };

/** Une conversation lue (`GET /v1/conversations/{id}`), la forme d'une ligne de la liste. */
const CONVERSATION_LUE = {
  id: CONVERSATION_ID,
  contact: { id: CONTACT_ID, phone: '+33612345678', name: 'Claire', externalId: 'crm-7781' },
  lastMessageAt: '2026-10-08T09:58:02.123Z',
  lastDirection: 'in',
  windowExpiresAt: '2026-10-09T09:58:02.123Z',
  handledBy: 'automation',
  needsReply: false,
  archived: false,
} as const;

/** Un message reçu, avec un fichier (`GET /v1/messages/{id}`). */
const MESSAGE_LU = {
  id: 'wamid.exemple-9031',
  conversationId: CONVERSATION_ID,
  direction: 'in',
  channel: 'whatsapp',
  type: 'image',
  text: 'Voici la photo du colis',
  buttonPayload: null,
  transcription: null,
  media: { mimeType: 'image/jpeg', filename: null, expired: false },
  // Un message REÇU n'a pas de livraison à suivre.
  status: null,
  statusAt: null,
  error: null,
  createdAt: '2026-10-08T09:58:02.123Z',
} as const;

export const EXEMPLES_REPONSES = {
  contactEcrit: { contactId: CONTACT_ID, status: 'created' },
  contactsLot: {
    results: [
      { index: 0, status: 'updated', contactId: CONTACT_ID },
      { index: 1, status: 'created', contactId: CONTACT_ID_2 },
    ],
    created: 1,
    updated: 1,
    errors: 0,
  },
  contactLu: CONTACT_LU,
  contactTrouve: { contact: CONTACT_LU },
  contactModifie: { contactId: CONTACT_ID },
  messageEnvoye: MESSAGE_ENVOYE,
  envoiCree: {
    sendId: SEND_ID,
    opening: 'whatsapp_template',
    recipientCount: 1,
    created: 0,
    matched: 2,
    skipped: [{ index: 1, reason: 'opted_out' }],
    skippedTotal: 1,
  },
  envoiSuivi: {
    sendId: SEND_ID,
    status: 'running',
    target: { template: { name: 'confirmation_commande', language: 'fr' } },
    opening: 'whatsapp_template',
    createdAt: '2026-09-24T10:00:00.000Z',
    counts: { pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 },
    // Le nombre de destinataires de l'envoi : `recipients` en rend 500 au plus.
    recipientsTotal: 1,
    recipients: [{
      contactId: CONTACT_ID,
      externalId: 'crm-7781',
      channel: 'whatsapp',
      status: 'sent',
      messageId: 'wamid.exemple-8412',
      delivery: 'delivered',
      error: null,
      sentAt: '2026-09-24T10:00:04.000Z',
    }],
  },
  templates: {
    templates: [{
      name: 'confirmation_commande',
      language: 'fr',
      category: 'utility',
      header: 'none',
      variables: [
        { position: 1, source: { type: 'field', key: 'prenom' } },
        { position: 2, source: null },
      ],
    }],
  },
  scenarios: {
    scenarios: [
      {
        code: SCENARIO, name: 'Suivi de commande', opening: 'whatsapp_template',
        openingTemplate: { name: 'confirmation_commande', language: 'fr' }, entryNode: ENTREE_SCENARIO,
        publishedAt: '2026-09-20T08:30:00.000Z',
      },
      {
        code: SCENARIO_FENETRE, name: 'Relance dans la fenêtre', opening: 'whatsapp_session',
        openingTemplate: null, entryNode: BLOC, publishedAt: null,
      },
    ],
  },
  messagesRcs: {
    rcsMessages: [{ name: 'rappel-rdv', kind: 'card', variables: ['prenom', 'date_rdv'] }],
  },
  erreur: { error: 'fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).', code: 'window_closed' },
  // La lecture des fils (lot 13) : leurs formes sont tenues à celles du serveur par `tests/api-exemples.test.ts`.
  conversationLue: CONVERSATION_LUE,
  conversations: { data: [CONVERSATION_LUE], nextCursor: 'MjAyNi0xMC0wOFQwOTo1ODowMi4xMjM0NTZafGM0ZTFiMmEzLTlkOGYtNGU3YS1hNmI1LTFjMmQzZTRmNWE2Yg' },
  messageLu: MESSAGE_LU,
  // Les webhooks sortants (lot 13, domaine 4) : tenus aux formes du serveur par `tests/api-exemples.test.ts`.
  webhook: WEBHOOK,
  webhooks: { data: [WEBHOOK], limit: 5, types: ['message.received', 'template.status_changed'], defaultTypes: ['message.received', 'template.status_changed'] },
  webhookCree: { webhook: WEBHOOK, secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' },
  envoisWebhook: {
    data: [{
      id: '9c2e4a10-6b3d-4f7a-8e1c-2d5b7a9f0c3e', eventId: 'evt_4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c', type: 'message.received', status: 'failed',
      attempts: 9, lastStatusCode: 500, lastResponse: 'erreur interne', nextAttemptAt: null, createdAt: '2026-10-09T08:12:30.000Z', deliveredAt: null,
      body: '{"id":"evt_4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c","type":"message.received","created_at":"2026-10-09T08:12:30.000Z","workspace_id":"…","data":{}}',
    }],
    nextBefore: null,
  },
  // Les modèles (lot 13, domaine 3) : tenus aux formes du serveur par `tests/api-exemples.test.ts`.
  modeleCree: { id: '1489201163476524', name: 'commande_prete', language: 'fr', category: 'utility', status: 'pending' },
  statutModele: {
    name: 'commande_prete',
    languages: [
      { language: 'fr', status: 'approved', category: 'utility', rejectedReason: null },
      { language: 'en_US', status: 'rejected', category: 'utility', rejectedReason: 'INVALID_FORMAT' },
    ],
  },
  messagesDuFil: {
    data: [MESSAGE_LU, {
      id: 'wamid.exemple-8412', conversationId: CONVERSATION_ID, direction: 'out', channel: 'whatsapp', type: 'text',
      text: 'Bonjour Claire, elle part demain.', buttonPayload: null, transcription: null, media: null,
      status: 'read', statusAt: '2026-10-08T09:56:12.000Z', error: null, createdAt: '2026-10-08T09:55:40.000Z',
    }],
    nextCursor: null,
  },
} as const;

/**
 * Un code d'erreur tel que la page le documente. `statut` null = il n'arrive QUE comme motif d'écart d'un
 * envoi, jamais en erreur. La suite tient cette table égale à `CodeApi` (`src/api/erreurs.ts`) dans les deux
 * sens, chaque statut égal à celui du serveur, et les motifs d'écart égaux à ceux de l'envoi.
 */
export interface CodeDocumente {
  readonly code: string;
  readonly statut: number | null;
  readonly ecart: boolean;
  readonly quoi: Bilingue;
}

export const CODES_DOCUMENTES = [
  { code: 'invalid_body', statut: 400, ecart: false, quoi: ['Corps mal formé. Le message nomme le champ fautif.', 'Malformed body. The message names the faulty field.'] },
  { code: 'invalid_recipient', statut: 400, ecart: true, quoi: ['Aucune clé de fiche (contactId, externalId, phone, bsuid).', 'No record key (contactId, externalId, phone, bsuid).'] },
  { code: 'invalid_phone', statut: 400, ecart: true, quoi: ['Numéro illisible.', 'Unreadable phone number.'] },
  { code: 'unauthorized', statut: 401, ecart: false, quoi: ['Clé absente, mal formée, inconnue ou révoquée.', 'Key missing, malformed, unknown or revoked.'] },
  { code: 'missing_scope', statut: 403, ecart: false, quoi: ['La clé n’a pas le droit que la route exige.', 'The key lacks the scope the route requires.'] },
  { code: 'tenant_locked', statut: 403, ecart: false, quoi: ['Espace suspendu : la clé est valide, mais l’espace ne peut plus rien lire ni envoyer par l’API. Inutile de refaire une clé.', 'Workspace suspended: the key is valid, but the workspace can no longer read or send through the API. No need to create a new key.'] },
  { code: 'unknown_contact', statut: 404, ecart: true, quoi: ['Aucune fiche ne correspond, et la route n’en crée pas.', 'No record matches, and the route does not create one.'] },
  { code: 'duplicate', statut: null, ecart: true, quoi: ['Le même destinataire figure deux fois dans l’envoi.', 'The same recipient appears twice in the send.'] },
  { code: 'identity_conflict', statut: 409, ecart: true, quoi: ['Les clés données désignent deux fiches différentes, ou cet identifiant externe est déjà porté par une autre fiche. Rien n’est écrit.', 'The keys given designate two different records, or this external id is already carried by another record. Nothing is written.'] },
  { code: 'blocked_contact', statut: 409, ecart: true, quoi: ['Fiche bloquée.', 'Blocked record.'] },
  { code: 'opted_out', statut: 409, ecart: true, quoi: ['Désabonné, en général, ou du RCS pour un envoi RCS.', 'Opted out, in general, or from RCS for an RCS send.'] },
  { code: 'no_consent', statut: 409, ecart: true, quoi: ['Consentement manquant : envoi marketing vers qui n’est pas opted_in, ou RCS libre vers qui n’a ni consenti ni écrit.', 'Missing consent: a marketing send to someone not opted_in, or a free RCS to someone who neither consented nor wrote.'] },
  { code: 'window_closed', statut: 422, ecart: true, quoi: ['Fenêtre de 24 h fermée : seul un template peut partir.', '24-hour window closed: only a template can go out.'] },
  { code: 'missing_variable', statut: null, ecart: true, quoi: ['Une variable manque pour ce destinataire, sans valeur de repli.', 'A variable is missing for this recipient, with no fallback.'] },
  { code: 'no_phone', statut: 422, ecart: true, quoi: ['Fiche sans numéro, alors que le RCS l’exige.', 'Record without a phone number, which RCS requires.'] },
  { code: 'rcs_unreachable', statut: 422, ecart: false, quoi: ['Ce numéro n’est pas joignable en RCS (appris d’un envoi précédent).', 'This number is not reachable over RCS (learned from a previous send).'] },
  { code: 'rcs_not_enabled', statut: 409, ecart: false, quoi: ['Le canal RCS n’est pas actif sur cet espace.', 'The RCS channel is not active on this workspace.'] },
  { code: 'no_whatsapp_number', statut: 409, ecart: false, quoi: ['Aucun numéro WhatsApp sur cet espace.', 'No WhatsApp number on this workspace.'] },
  { code: 'number_unlinked', statut: 409, ecart: false, quoi: ['Le numéro WhatsApp de l’espace est délié depuis l’Accueil : rien ne part par WhatsApp tant qu’un administrateur ne l’a pas relié. Rendu par POST /v1/messages/whatsapp, et par POST /v1/sends quand le premier message part en WhatsApp.', 'The workspace’s WhatsApp number is unlinked from the Home page: nothing goes out over WhatsApp until an admin relinks it. Returned by POST /v1/messages/whatsapp, and by POST /v1/sends when the first message goes out over WhatsApp.'] },
  { code: 'number_suspended', statut: 409, ecart: false, quoi: ['L’abonnement du numéro WhatsApp fourni est impayé depuis 7 jours, ou terminé : rien ne part par WhatsApp tant qu’il n’est pas renouvelé. Rendu par POST /v1/messages/whatsapp, et par POST /v1/sends quand le premier message part en WhatsApp.', 'The subscription of the provided WhatsApp number is 7 days overdue, or ended: nothing goes out over WhatsApp until it is renewed. Returned by POST /v1/messages/whatsapp, and by POST /v1/sends when the first message goes out over WhatsApp.'] },
  { code: 'scenario_not_found', statut: 404, ecart: false, quoi: ['Scénario introuvable.', 'Scenario not found.'] },
  { code: 'node_not_found', statut: 404, ecart: false, quoi: ['Bloc introuvable.', 'Block not found.'] },
  { code: 'template_not_found', statut: 404, ecart: false, quoi: ['Template absent, ou pas encore approuvé.', 'Template missing, or not approved yet.'] },
  { code: 'rcs_message_not_found', statut: 404, ecart: false, quoi: ['Message RCS introuvable dans la bibliothèque.', 'RCS message not found in the library.'] },
  { code: 'send_not_found', statut: 404, ecart: false, quoi: ['Envoi inconnu.', 'Unknown send.'] },
  { code: 'meta_rejected', statut: 422, ecart: false, quoi: ['Meta a refusé le contenu du message ou du modèle : son motif suit.', 'Meta refused the message or template content: its reason follows.'] },
  { code: 'invalid_header_media', statut: 422, ecart: false, quoi: ['Le fichier d’en-tête d’un modèle n’a pas pu être pris à son adresse : son motif suit.', 'The template header file could not be fetched from its address: the reason follows.'] },
  { code: 'meta_auth_failed', statut: 409, ecart: false, quoi: ['Meta refuse le jeton de l’espace : reconnectez le compte WhatsApp depuis la console.', 'Meta refuses the workspace token: reconnect the WhatsApp account from the console.'] },
  { code: 'webhook_not_found', statut: 404, ecart: false, quoi: ['Adresse de webhook inconnue de cet espace.', 'Webhook endpoint unknown to this workspace.'] },
  { code: 'delivery_not_found', statut: 404, ecart: false, quoi: ['Envoi de webhook inconnu.', 'Webhook delivery unknown.'] },
  { code: 'delivery_not_replayable', statut: 409, ecart: false, quoi: ['Envoi inconnu de cet espace, encore en cours, ou un essai : rien à rejouer.', 'Delivery unknown to this workspace, still pending, or a test: nothing to replay.'] },
  { code: 'webhooks_unavailable', statut: 503, ecart: false, quoi: ['L’instance ne sait pas chiffrer les secrets : réessayez plus tard.', 'The instance cannot encrypt secrets: retry later.'] },
  { code: 'template_rejected', statut: 422, ecart: false, quoi: ['Le modèle est refusé avant Meta (un lien n’a pas pu être tracé) : son motif suit.', 'The template is refused before Meta (a link could not be tracked): the reason follows.'] },
  { code: 'conversation_not_found', statut: 404, ecart: false, quoi: ['Conversation inconnue de cet espace.', 'Conversation unknown to this workspace.'] },
  { code: 'message_not_found', statut: 404, ecart: false, quoi: ['Message inconnu de cet espace.', 'Message unknown to this workspace.'] },
  { code: 'invalid_cursor', statut: 400, ecart: false, quoi: ['Curseur illisible : renvoyez tel quel le nextCursor d’une page.', 'Unreadable cursor: send back a page’s nextCursor as is.'] },
  { code: 'no_media', statut: 404, ecart: false, quoi: ['Ce message ne porte aucun fichier reçu.', 'This message carries no received file.'] },
  { code: 'media_expired', statut: 410, ecart: false, quoi: ['Meta ne garde un fichier reçu que 7 jours.', 'Meta keeps a received file for 7 days only.'] },
  { code: 'media_unavailable', statut: 422, ecart: false, quoi: ['Meta n’a pas rendu le fichier, ou il est trop lourd : réessayez.', 'Meta did not return the file, or it is too large: retry.'] },
  { code: 'scenario_ambiguous', statut: 409, ecart: false, quoi: ['Plusieurs scénarios portent ce nom : utilisez le code scn_.', 'Several scenarios have this name: use the scn_ code.'] },
  { code: 'unsendable_target', statut: 422, ecart: false, quoi: ['La cible ne peut pas partir ainsi. Le message dit pourquoi.', 'The target cannot go out like this. The message says why.'] },
  { code: 'template_category_unknown', statut: 422, ecart: false, quoi: ['Catégorie du template illisible chez Meta : l’envoi est refusé plutôt que deviné.', 'The template category cannot be read at Meta: the send is refused rather than guessed.'] },
  { code: 'idempotency_key_required', statut: 400, ecart: false, quoi: ['Clé d’idempotence absente (en-tête ou corps).', 'Idempotency key missing (header or body).'] },
  { code: 'idempotency_in_progress', statut: 409, ecart: false, quoi: ['Un envoi avec cette clé est en cours.', 'A send with this key is in progress.'] },
  { code: 'idempotency_key_reused', statut: 422, ecart: false, quoi: ['Cette clé a déjà servi pour un autre corps.', 'This key was already used for a different body.'] },
  { code: 'rate_limited', statut: 429, ecart: false, quoi: ['Débit dépassé : attendez la durée de retry-after.', 'Rate limit exceeded: wait for retry-after.'] },
  { code: 'quota_exceeded', statut: 429, ecart: false, quoi: ['Quota quotidien de l’espace atteint (envois ou fiches écrites), ou dépassé par ce lot : retry-after donne l’attente jusqu’à minuit, heure de Paris. Un lot plus petit peut encore passer.', 'Daily workspace quota reached (sends or written contacts), or exceeded by this request: retry-after gives the wait until midnight, Paris time. A smaller request may still go through.'] },
  { code: 'plan_feature_unavailable', statut: 402, ecart: false, quoi: ['Cette fonction n’est pas comprise dans l’offre de l’espace : upgradeUrl mène à la page de l’offre.', 'This feature is not included in the workspace plan: upgradeUrl leads to the plan page.'] },
  { code: 'plan_limit_reached', statut: 402, ecart: true, quoi: ['Une limite de l’offre de l’espace est atteinte (contacts créés, modèles du mois…) : upgradeUrl mène à la page de l’offre. Les réponses dans la fenêtre de 24 h ne sont jamais concernées.', 'A workspace plan limit is reached (contacts created, templates this month…): upgradeUrl leads to the plan page. Replies within the 24-hour window are never affected.'] },
] as const satisfies readonly CodeDocumente[];

export type NomDeCode = (typeof CODES_DOCUMENTES)[number]['code'];

/**
 * Le statut HTTP d'un code, lu dans la table : les pages le citent par là, jamais en chiffre écrit à côté du code
 * (les deux divergeraient). `null` : le code n'arrive qu'en motif d'écart.
 */
export function statutDe(code: NomDeCode): number | null {
  return CODES_DOCUMENTES.find((c) => c.code === code)!.statut;
}

/**
 * Les bornes que la doc annonce. Toutes sont tenues par la suite (constantes des routes, durée de vie d'une clé
 * d'idempotence, défauts de la configuration, et ce que les schémas acceptent, `debitParMinute` compris).
 *
 * ⚠️ `debitParCle` (le défaut de `API_KEY_RATE_LIMIT_MAX`) est parti le 2026-09-25 : il ne décrit plus que le
 * relais du Meta Business Agent, que la doc ne documente pas, et plus aucune page ne l'affichait.
 */
export const BORNES = {
  contactsParLot: 50,
  /** Champs ET étiquettes d'une fiche : à l'unité (`POST /v1/contacts`, `PATCH`), et dans un lot. */
  parFiche: 20,
  parFicheEnLot: 10,
  destinatairesParEnvoi: 50,
  ecartsDetailles: 200,
  texteWhatsapp: 4096,
  texteRcs: 3072,
  externalId: 512,
  debitParMinute: 80,
  dureeIdempotenceHeures: 24,
  /** Le bail d'une clé EN COURS dont l'appel est mort en route (`DUREE_CLE_EN_COURS_MAX_MS`) : au-delà, elle se libère. */
  cleEnCoursMinutes: 5,
  /** Le plafond de l'API PAR ESPACE (2026-09-25), tenus égaux à `PLAFOND_API_DEFAUT` par `tests/api-exemples.test.ts`. */
  plafondEspaceMinute: 60,
  plafondEspaceHeure: 1000,
  /** Les quotas QUOTIDIENS par espace (2026-10-04), tenus égaux à `QUOTAS_API_DEFAUT` par `tests/api-exemples.test.ts`. */
  quotaEnvoisJour: 2000,
  quotaFichesJour: 20000,
  /** Les tableaux de champs (`api-champs.ts`) : la source du consentement, et les variables d'un destinataire. */
  consentSource: 100,
  cleIdempotence: 255,
  variablesParDestinataire: 50,
  valeurVariable: 1024,
} as const;
