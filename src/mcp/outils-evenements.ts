import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { DepsMcp, OutilMcp } from './outils';
import { RefusOutil, entierBorne, valeurOuRefus } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import type { AuditSink } from '../audit/journal';
import { TYPES_ABONNABLES, TYPES_DECOCHES_PAR_DEFAUT } from '../evenements/types';
import { creerAdresse, envoyerEssai, lireJournal, rejouerEnvoi, type DepsGestionEvenements } from '../evenements/gestion';
import { deliveryV1, webhookV1 } from '../http/v1-webhooks';

/**
 * LES WEBHOOKS SORTANTS DEPUIS CLAUDE CODE (lot 12, livraison A, décision de Julien du 2026-10-08 : la console, plus un
 * outil qui crée une adresse et un qui envoie l'essai). Le client du tunnel vit dans Claude Code : c'est là qu'il
 * branche son application. La liste, le journal et le rejeu passent par l'API et le MCP au lot 13.
 *
 * 🔴 Les deux exigent une PERSONNE (un jeton OAuth d'admin, jamais une clé d'API) : une adresse sortante est un canal
 * par lequel des données de contacts quittent l'espace. Une clé `mcp:write` branchée comme connecteur d'un agent qui
 * lit des messages de clients ne doit pas pouvoir en créer une sur l'injection d'un message.
 *
 * Aucun contrôle propre ici : ce sont ceux de la console (`src/evenements/gestion.ts`), et un refus y garde sa phrase.
 */
export interface DepsEvenementsMcp {
  gestion: DepsGestionEvenements;
  audit: AuditSink;
}

export const OUTILS_EVENEMENTS: OutilMcp[] = [
  {
    ...ficheOutilMcp('create_webhook_endpoint'),
    fonction: null,
    description:
      'Registers an HTTPS address of the application (an outgoing webhook): Messaging Me will send it the chosen events '
      + 'by POST, signed in the Standard Webhooks format (message received, link clicked, unsubscribe, conversation '
      + 'analyzed...), and will retry them for 24 hours as long as it does not answer 2xx. Returns the endpoint and its '
      + 'secret (whsec_...), shown ONLY ONCE: it belongs in an environment variable of the application (never in the '
      + 'code), to verify the webhook-signature header. Without types given: all, except delivery receipts and AI agent '
      + 'actions (agent.action). The limit of active endpoints depends on the plan (refusal plan_limit_reached).',
    // Non idempotente : chaque appel qui réussit crée une adresse de plus. Destructrice pour la règle du répertoire de
    // Claude (voir `AnnotationsMcp`).
    annotations: { title: 'Create an outgoing webhook', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 9, maxLength: 2048, pattern: '^https://', description: 'The application\'s address, in HTTPS, reachable from the Internet.' },
        types: {
          type: 'array', minItems: 1, maxItems: TYPES_ABONNABLES.length, items: { type: 'string', enum: [...TYPES_ABONNABLES] },
          description: `The events to receive, each one once. Absent: all, except ${[...TYPES_DECOCHES_PAR_DEFAUT].join(', ')}.`,
        },
        description: { type: 'string', maxLength: 200, description: 'A readable name in the console (optional).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const r = valeurOuRefus(await creerAdresse(deps.evenements.gestion, tenantId, args));
      await deps.evenements.audit(
        tenantId, { userId: personne?.userId ?? null, email: null }, 'evenements.adresse_creee',
        { kind: 'adresse_evenements', id: r.adresse.id }, { url: r.adresse.url, types: r.adresse.types, via: 'mcp' },
      );
      return {
        adresse: { id: r.adresse.id, url: r.adresse.url, types: r.adresse.types, active: r.adresse.active },
        secret: r.secret,
        a_faire: 'Ranger le secret dans une variable d’environnement (par exemple MESSAGINGME_WEBHOOK_SECRET), puis appeler send_test_event.',
      };
    },
  },
  {
    ...ficheOutilMcp('send_test_event'),
    fonction: null,
    description:
      'Immediately sends a signed test event (type test) to an endpoint created by create_webhook_endpoint, and returns '
      + 'what the application answered (HTTP code and start of the response). It checks that the application receives '
      + 'the event and verifies the signature. Writes to the endpoint\'s log. Counts toward the workspace\'s heavy '
      + 'operations.',
    // Monde ouvert : un appel part vers l'application du client. Destructrice pour la règle du répertoire de Claude.
    annotations: { title: 'Send a webhook test', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        adresse_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'The id returned by create_webhook_endpoint.' },
      },
      required: ['adresse_id'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args) {
      const id = typeof args.adresse_id === 'string' ? args.adresse_id : '';
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      const r = valeurOuRefus(await envoyerEssai(deps.evenements.gestion, tenantId, id));
      return { evenement_id: r.evenementId, livre: r.livre, code: r.code, reponse: r.reponse };
    },
  },
  /*
   * Lot 13, domaine 4 : la liste, le journal et le rejeu, comme `GET /v1/webhooks`, `GET /v1/webhooks/{id}/deliveries`
   * et `POST /v1/webhooks/deliveries/{id}/replay`, avec les MÊMES vues (`webhookV1`, `deliveryV1`).
   */
  {
    ...ficheOutilMcp('list_webhook_endpoints'),
    fonction: null,
    description:
      'The workspace\'s outgoing webhook endpoints (url, event types checked, active or paused, deliveries being '
      + 'retried and failed), the plan\'s limit of active endpoints (null = no limit) and the available types. The '
      + 'secret is never read back: it is shown only at creation.',
    /**
     * Une PERSONNE, comme la console, qui réserve cette liste aux admins : l'adresse d'un outil sans code (Make, Zapier,
     * n8n) porte son jeton dans le chemin, et une clé `mcp:read` confiée à un agent tiers la lirait.
     */
    annotations: { title: 'List outgoing webhooks', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: {}, additionalProperties: false },
    async executer(deps: DepsMcp, tenantId) {
      const g = deps.evenements.gestion;
      return {
        adresses: (await g.adresses.lister(tenantId)).map(webhookV1),
        limite: await g.limiteAdresses(tenantId),
        types: TYPES_ABONNABLES,
      };
    },
  },
  {
    ...ficheOutilMcp('get_webhook_deliveries'),
    fonction: null,
    description:
      'The log of an outgoing webhook endpoint, most recent first: each delivery with its type, its status (pending, '
      + 'delivered, failed), its attempts, the application\'s last code and last response, and the body sent (it '
      + 'carries contact data). before (an ISO date) gives the next page, which next_before returns.',
    // Le corps des événements porte des numéros et des messages de contacts : une personne, jamais une clé.
    annotations: { title: 'Read a webhook log', readOnlyHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        adresse_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'The endpoint id (list_webhook_endpoints).' },
        before: { type: 'string', format: 'date-time', maxLength: 40, description: 'The deliveries created before this date (next_before of the previous page).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of deliveries (1 to 100, default 20).' },
      },
      required: ['adresse_id'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args) {
      const id = typeof args.adresse_id === 'string' ? args.adresse_id : '';
      // 100 = `JOURNAL_PAGE_MAX`, écrit en clair : le test des bornes annoncées lit les littéraux (tenu ci-dessous).
      const limite = entierBorne(args, 'limit', 20, 1, 100);
      const avant = typeof args.before === 'string' ? args.before : undefined;
      if (avant !== undefined && Number.isNaN(Date.parse(avant))) throw new RefusOutil('before : une date ISO est attendue');
      const r = valeurOuRefus(await lireJournal(deps.evenements.gestion, tenantId, id, { avant, limite: String(limite) }));
      const envois = r.map(deliveryV1);
      return { envois, next_before: envois.length === limite ? envois[envois.length - 1]!.createdAt : null };
    },
  },
  {
    ...ficheOutilMcp('replay_webhook_delivery'),
    fonction: null,
    description:
      'Replays a finished delivery (delivered or failed) of an outgoing webhook endpoint: it goes out again with the '
      + 'same body and the same event id (the application deduplicates), and its 24 hours of retries start again. A '
      + 'delivery still in progress or a test is not replayed.',
    // Renvoie vers l'application du client ; le même identifiant d'événement : rejouer deux fois est sans effet de plus
    // pour une application qui dédoublonne. Destructrice pour la règle du répertoire de Claude.
    annotations: { title: 'Replay a webhook delivery', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        envoi_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'The id of a delivery (get_webhook_deliveries).' },
      },
      required: ['envoi_id'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const id = typeof args.envoi_id === 'string' ? args.envoi_id : '';
      valeurOuRefus(await rejouerEnvoi(deps.evenements.gestion, tenantId, id));
      await deps.evenements.audit(
        tenantId, { userId: personne?.userId ?? null, email: null }, 'evenements.envoi_rejoue', { kind: 'envoi_evenements', id }, { via: 'mcp' },
      );
      return { rejoue: true };
    },
  },
];
