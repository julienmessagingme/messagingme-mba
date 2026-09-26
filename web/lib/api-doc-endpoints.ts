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

export type Methode = 'GET' | 'POST' | 'PATCH';
export type Droit = 'contacts:write' | 'contacts:read' | 'sends:create';
export type GroupeEndpoints = 'contacts' | 'messages' | 'envois' | 'catalogues';

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
  { cle: 'envois', titre: ['Envois', 'Sends'] },
  { cle: 'catalogues', titre: ['Catalogues', 'Catalogs'] },
];

export const ENDPOINTS = [
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
