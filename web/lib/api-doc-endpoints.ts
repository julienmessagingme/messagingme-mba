// web/lib/api-doc-endpoints.ts
import type { Bilingue } from './api-exemples';
import type { LienVers } from './doc-api-pages';

/**
 * LES ENDPOINTS DE L'API PUBLIQUE, SOURCE UNIQUE : l'index de l'accueil (« Tous les endpoints »), le sommaire
 * « Sur cette page » de chaque page de ressource, l'en-tête de chaque route (méthode, chemin, phrase, droit,
 * ancre) et le tableau des droits de la page Authentification lisent CETTE liste.
 *
 * 🔴 `tests/api-doc-endpoints.test.ts` la tient égale aux routes `/v1` que le serveur monte (méthode et chemin),
 * et chaque droit égal à celui que la route exige (une clé sans ce droit reçoit 403 `missing_scope`, une clé qui
 * n'a que lui passe la garde). Chaque lien vise une ancre déclarée (`LienVers`, typé sur `PAGES_DOC`), et
 * `web/e2e/developers-api.spec.ts` vérifie qu'elle porte bien la route.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par le build de la console ET par la suite racine.
 */

export type Methode = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type Droit = 'contacts:write' | 'contacts:read' | 'sends:create' | 'conversations:read' | 'templates:write' | 'webhooks:write';
export type GroupeEndpoints = 'contacts' | 'messages' | 'conversations' | 'envois' | 'modeles' | 'webhooks' | 'catalogues';

export interface EndpointDoc {
  readonly methode: Methode;
  readonly chemin: string;
  readonly droit: Droit;
  readonly groupe: GroupeEndpoints;
  /** Où vit son détail : une page de la doc et l'ancre de la route. */
  readonly lien: LienVers & { readonly ancre: string };
  /** Une phrase, sans exception ni code d'erreur. */
  readonly resume: Bilingue;
}

export const GROUPES_ENDPOINTS: ReadonlyArray<{ readonly cle: GroupeEndpoints; readonly titre: Bilingue }> = [
  { cle: 'contacts', titre: ['Contacts', 'Contacts'] },
  { cle: 'messages', titre: ['Messages', 'Messages'] },
  { cle: 'conversations', titre: ['Conversations', 'Conversations'] },
  { cle: 'envois', titre: ['Envois', 'Sends'] },
  { cle: 'modeles', titre: ['Modèles', 'Templates'] },
  { cle: 'webhooks', titre: ['Webhooks sortants', 'Outgoing webhooks'] },
  { cle: 'catalogues', titre: ['Catalogues', 'Catalogs'] },
];

export const ENDPOINTS = [
  {
    methode: 'GET', chemin: '/v1/conversations', droit: 'conversations:read', groupe: 'conversations', lien: { page: 'conversations', ancre: 'lister' },
    resume: ['Liste les conversations, la plus récente d’abord, par pages.', 'Lists conversations, most recent first, page by page.'],
  },
  {
    methode: 'GET', chemin: '/v1/conversations/{conversationId}', droit: 'conversations:read', groupe: 'conversations', lien: { page: 'conversations', ancre: 'lire' },
    resume: ['Lit une conversation : le contact, qui la tient, la fenêtre de 24 h.', 'Reads a conversation: the contact, who handles it, the 24-hour window.'],
  },
  {
    methode: 'GET', chemin: '/v1/conversations/{conversationId}/messages', droit: 'conversations:read', groupe: 'conversations', lien: { page: 'conversations', ancre: 'messages' },
    resume: ['Les messages d’une conversation, le plus récent d’abord, par pages.', 'A conversation’s messages, most recent first, page by page.'],
  },
  {
    methode: 'GET', chemin: '/v1/messages/{messageId}', droit: 'conversations:read', groupe: 'conversations', lien: { page: 'conversations', ancre: 'message' },
    resume: ['Lit un message par son identifiant.', 'Reads a message by its ID.'],
  },
  {
    methode: 'GET', chemin: '/v1/messages/{messageId}/media', droit: 'conversations:read', groupe: 'conversations', lien: { page: 'conversations', ancre: 'media' },
    resume: ['Télécharge le fichier d’un message reçu.', 'Downloads the file of a received message.'],
  },
  {
    methode: 'POST', chemin: '/v1/contacts', droit: 'contacts:write', groupe: 'contacts', lien: { page: 'contacts', ancre: 'creer' },
    resume: ['Crée ou met à jour une fiche.', 'Creates or updates a record.'],
  },
  {
    methode: 'POST', chemin: '/v1/contacts/batch', droit: 'contacts:write', groupe: 'contacts', lien: { page: 'contacts', ancre: 'lot' },
    resume: ['Crée ou met à jour jusqu’à 50 fiches en un appel.', 'Creates or updates up to 50 records in one call.'],
  },
  {
    methode: 'GET', chemin: '/v1/contacts/{contactId}', droit: 'contacts:read', groupe: 'contacts', lien: { page: 'contacts', ancre: 'lire' },
    resume: ['Lit une fiche.', 'Reads a record.'],
  },
  {
    methode: 'POST', chemin: '/v1/contacts/search', droit: 'contacts:read', groupe: 'contacts', lien: { page: 'contacts', ancre: 'rechercher' },
    resume: ['Cherche une fiche par téléphone, BSUID ou identifiant externe.', 'Finds a record by phone, BSUID or external id.'],
  },
  {
    methode: 'PATCH', chemin: '/v1/contacts/{contactId}', droit: 'contacts:write', groupe: 'contacts', lien: { page: 'contacts', ancre: 'modifier' },
    resume: ['Modifie les champs, les tags, le consentement ou l’identifiant externe d’une fiche.', 'Updates a record’s fields, tags, consent or external id.'],
  },
  {
    methode: 'POST', chemin: '/v1/messages', droit: 'sends:create', groupe: 'messages', lien: { page: 'messages', ancre: 'message-meta' },
    resume: ['Envoie un message au format de Meta : image, document, lieu, boutons, liste, bouton lien.', 'Sends a message in Meta’s format: image, document, location, buttons, list, link button.'],
  },
  {
    methode: 'POST', chemin: '/v1/messages/whatsapp', droit: 'sends:create', groupe: 'messages', lien: { page: 'messages', ancre: 'message-whatsapp' },
    resume: ['Envoie tout de suite un texte WhatsApp à une fiche existante.', 'Sends a WhatsApp text right away to an existing record.'],
  },
  {
    methode: 'POST', chemin: '/v1/messages/rcs', droit: 'sends:create', groupe: 'messages', lien: { page: 'messages', ancre: 'message-rcs' },
    resume: ['Envoie tout de suite un texte RCS à une fiche existante.', 'Sends an RCS text right away to an existing record.'],
  },
  {
    methode: 'POST', chemin: '/v1/sends', droit: 'sends:create', groupe: 'envois', lien: { page: 'sends', ancre: 'envoi' },
    resume: ['Lance un envoi asynchrone et idempotent, vers 1 à 50 destinataires.', 'Starts an asynchronous, idempotent send to 1 to 50 recipients.'],
  },
  {
    methode: 'GET', chemin: '/v1/sends/{sendId}', droit: 'sends:create', groupe: 'envois', lien: { page: 'sends', ancre: 'suivi' },
    resume: ['Lit l’état et les résultats d’un envoi.', 'Reads the state and results of a send.'],
  },
  {
    methode: 'POST', chemin: '/v1/templates', droit: 'templates:write', groupe: 'modeles', lien: { page: 'templates', ancre: 'creer' },
    resume: ['Crée un modèle au format de Meta et le soumet à sa validation.', 'Creates a template in Meta’s format and submits it for review.'],
  },
  {
    methode: 'GET', chemin: '/v1/templates/{name}', droit: 'templates:write', groupe: 'modeles', lien: { page: 'templates', ancre: 'statut' },
    resume: ['Lit le statut d’un modèle chez Meta, langue par langue.', 'Reads a template’s status at Meta, language by language.'],
  },
  {
    methode: 'GET', chemin: '/v1/webhooks', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'lister' },
    resume: ['Liste les adresses, la limite de l’offre et les types disponibles.', 'Lists the endpoints, the plan limit and the available types.'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'creer' },
    resume: ['Inscrit une adresse et rend son secret, une seule fois.', 'Registers an endpoint and returns its secret, only once.'],
  },
  {
    methode: 'GET', chemin: '/v1/webhooks/{webhookId}', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'lire' },
    resume: ['Lit une adresse et l’état de ses envois.', 'Reads an endpoint and the state of its deliveries.'],
  },
  {
    methode: 'PATCH', chemin: '/v1/webhooks/{webhookId}', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'modifier' },
    resume: ['Change les types, la description, ou met l’adresse en pause.', 'Changes the types, the description, or pauses the endpoint.'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/{webhookId}/rotate-secret', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'rotation' },
    resume: ['Renouvelle le secret ; l’ancien signe encore 24 h.', 'Rotates the secret; the old one still signs for 24 h.'],
  },
  {
    methode: 'DELETE', chemin: '/v1/webhooks/{webhookId}', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'supprimer' },
    resume: ['Supprime une adresse.', 'Deletes an endpoint.'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/{webhookId}/test', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'essai' },
    resume: ['Envoie un événement d’essai signé et rend la réponse de l’application.', 'Sends a signed test event and returns the app’s answer.'],
  },
  {
    methode: 'GET', chemin: '/v1/webhooks/{webhookId}/deliveries', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'journal' },
    resume: ['Lit le journal d’une adresse, le plus récent d’abord.', 'Reads an endpoint’s log, most recent first.'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/deliveries/{deliveryId}/replay', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'rejeu' },
    resume: ['Rejoue un envoi terminé, avec le même corps.', 'Replays a finished delivery, with the same body.'],
  },
  {
    methode: 'POST', chemin: '/v1/webhooks/{webhookId}/replay-failures', droit: 'webhooks:write', groupe: 'webhooks', lien: { page: 'webhook-endpoints', ancre: 'rejeu-echecs' },
    resume: ['Rejoue les envois en échec depuis une date.', 'Replays the failed deliveries since a date.'],
  },
  {
    methode: 'GET', chemin: '/v1/templates', droit: 'sends:create', groupe: 'catalogues', lien: { page: 'catalogs', ancre: 'templates' },
    resume: ['Liste les templates WhatsApp approuvés et envoyables.', 'Lists the approved, sendable WhatsApp templates.'],
  },
  {
    methode: 'GET', chemin: '/v1/scenarios', droit: 'sends:create', groupe: 'catalogues', lien: { page: 'catalogs', ancre: 'scenarios' },
    resume: ['Liste les scénarios publiés et leur message d’ouverture.', 'Lists the published scenarios and their opening message.'],
  },
  {
    methode: 'GET', chemin: '/v1/rcs-messages', droit: 'sends:create', groupe: 'catalogues', lien: { page: 'catalogs', ancre: 'messages-rcs' },
    resume: ['Liste les messages RCS de la bibliothèque.', 'Lists the RCS messages of the library.'],
  },
] as const satisfies readonly EndpointDoc[];

type Declare = (typeof ENDPOINTS)[number];
/** La clé d'un endpoint : « POST /v1/contacts ». Une clé inventée ne compile pas. */
export type CleEndpoint = Declare extends { methode: infer M extends string; chemin: infer C extends string } ? `${M} ${C}` : never;

export const cleEndpoint = (e: Pick<EndpointDoc, 'methode' | 'chemin'>): string => `${e.methode} ${e.chemin}`;

export function endpoint(cle: CleEndpoint): EndpointDoc {
  // `find` ne peut pas échouer : `cle` est typée sur la liste elle-même.
  return ENDPOINTS.find((e) => cleEndpoint(e) === cle)!;
}
