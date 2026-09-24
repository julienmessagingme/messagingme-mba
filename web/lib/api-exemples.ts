// web/lib/api-exemples.ts
/**
 * LES EXEMPLES DE LA PAGE « Documentation API », ses codes et ses bornes. Rien d'autre.
 *
 * 🔴 UN MODULE, PAS DU TEXTE DANS LA PAGE, et c'est tout son intérêt : `tests/api-exemples.test.ts` passe
 * chaque corps aux règles de SA route (schéma zod, clé d'idempotence, règles de cible). La page ne peut donc
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
  | 'POST /v1/messages/rcs';

export interface ExempleCorps {
  readonly route: RouteAvecCorps;
  readonly corps: unknown;
}

const CONTACT_ID = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const CONTACT_ID_2 = '7a3d9c10-2e4b-4f6a-b8c1-0d9e8f7a6b5c';
const SEND_ID = '0b9d7a42-3c1e-4f5a-8d2b-6e7f8a9b0c1d';
const CONVERSATION_ID = 'c4e1b2a3-9d8f-4e7a-a6b5-1c2d3e4f5a6b';
const SCENARIO = 'scn_k3f9qa_01j8z3m4v6x7y8z9a0b1c2d3e4';
const BLOC = 'nod_k3f9qa_01j8z3n5w7x8y9z0a1b2c3d4e5';

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
  envoiScenario: {
    route: 'POST /v1/sends',
    corps: {
      idempotencyKey: 'bienvenue-crm-7781-2026-09-24',
      target: { scenario: SCENARIO },
      category: 'marketing',
      recipients: [{ externalId: 'crm-7781' }],
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
  createdAt: '2026-09-24T10:00:00.000Z',
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
  messageEnvoye: { messageId: 'wamid.exemple-8412', conversationId: CONVERSATION_ID, channel: 'whatsapp' },
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
      { code: SCENARIO, name: 'Bienvenue', opening: 'whatsapp_template', publishedAt: '2026-09-20T08:30:00.000Z' },
      { code: 'scn_k3f9qa_01j8z3p6x8y9z0a1b2c3d4e5f6', name: 'Relance dans la fenêtre', opening: 'whatsapp_session', publishedAt: null },
    ],
  },
  messagesRcs: {
    rcsMessages: [{ name: 'rappel-rdv', kind: 'card', variables: ['prenom', 'date_rdv'] }],
  },
  erreur: { error: 'fenêtre de 24 h fermée : ce contact n’a pas écrit récemment', code: 'window_closed' },
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
  { code: 'scenario_not_found', statut: 404, ecart: false, quoi: ['Scénario introuvable.', 'Scenario not found.'] },
  { code: 'node_not_found', statut: 404, ecart: false, quoi: ['Bloc introuvable.', 'Block not found.'] },
  { code: 'template_not_found', statut: 404, ecart: false, quoi: ['Template absent, ou pas encore approuvé.', 'Template missing, or not approved yet.'] },
  { code: 'rcs_message_not_found', statut: 404, ecart: false, quoi: ['Message RCS introuvable dans la bibliothèque.', 'RCS message not found in the library.'] },
  { code: 'send_not_found', statut: 404, ecart: false, quoi: ['Envoi inconnu.', 'Unknown send.'] },
  { code: 'scenario_ambiguous', statut: 409, ecart: false, quoi: ['Plusieurs scénarios portent ce nom : utilisez le code scn_.', 'Several scenarios have this name: use the scn_ code.'] },
  { code: 'unsendable_target', statut: 422, ecart: false, quoi: ['La cible ne peut pas partir ainsi. Le message dit pourquoi.', 'The target cannot go out like this. The message says why.'] },
  { code: 'template_category_unknown', statut: 422, ecart: false, quoi: ['Catégorie du template illisible chez Meta : l’envoi est refusé plutôt que deviné.', 'The template category cannot be read at Meta: the send is refused rather than guessed.'] },
  { code: 'idempotency_key_required', statut: 400, ecart: false, quoi: ['Clé d’idempotence absente (en-tête ou corps).', 'Idempotency key missing (header or body).'] },
  { code: 'idempotency_in_progress', statut: 409, ecart: false, quoi: ['Un envoi avec cette clé est en cours.', 'A send with this key is in progress.'] },
  { code: 'idempotency_key_reused', statut: 422, ecart: false, quoi: ['Cette clé a déjà servi pour un AUTRE corps.', 'This key was already used for a DIFFERENT body.'] },
  { code: 'rate_limited', statut: 429, ecart: false, quoi: ['Débit dépassé : attendez la durée de retry-after.', 'Rate limit exceeded: wait for retry-after.'] },
] as const satisfies readonly CodeDocumente[];

export type NomDeCode = (typeof CODES_DOCUMENTES)[number]['code'];

/**
 * Les bornes que la page annonce. Toutes sont tenues par la suite (constantes des routes, durée de vie d'une
 * clé d'idempotence, et ce que leurs schémas acceptent, `debitParMinute` compris) SAUF la dernière :
 * `debitParCle` est le défaut de `API_KEY_RATE_LIMIT_MAX` (`src/config.ts`, qu'un test ne charge pas sans
 * environnement). La relire à la main quand cette valeur change.
 */
export const BORNES = {
  contactsParLot: 500,
  destinatairesParEnvoi: 50,
  ecartsDetailles: 200,
  texteWhatsapp: 4096,
  texteRcs: 3072,
  externalId: 512,
  debitParMinute: 80,
  dureeIdempotenceHeures: 24,
  debitParCle: 60,
} as const;
