import type { DepsMcp, OutilMcp } from './outils';
import { RefusOutil, entierBorne, valeurOuRefus } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import type { AuditSink } from '../audit/journal';
import { TYPES_ABONNABLES } from '../evenements/types';
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
    nom: 'create_webhook_endpoint',
    fonction: null,
    description:
      'Inscrit une adresse HTTPS de l’application (un webhook sortant) : Messaging Me y enverra en POST, signés au format '
      + 'Standard Webhooks, les événements choisis (message reçu, lien cliqué, désabonnement, conversation analysée…), et '
      + 'les réessaiera pendant 24 h tant qu’elle ne répond pas 2xx. Rend l’adresse et son secret (whsec_…), montré UNE '
      + 'seule fois : le ranger dans une variable d’environnement de l’application (jamais dans le code) pour vérifier '
      + 'l’en-tête webhook-signature. Sans types précisés : tous, sauf les accusés de livraison. La limite d’adresses '
      + 'actives dépend de l’offre (refus plan_limit_reached).',
    scope: 'mcp:write',
    exigePersonne: true,
    // Ni destructrice ni idempotente : chaque appel qui réussit crée une adresse de plus.
    annotations: { title: 'Créer un webhook sortant', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 9, maxLength: 2048, pattern: '^https://', description: 'L’adresse de l’application, en HTTPS, joignable depuis Internet.' },
        types: {
          type: 'array', minItems: 1, maxItems: TYPES_ABONNABLES.length, items: { type: 'string', enum: [...TYPES_ABONNABLES] },
          description: 'Les événements à recevoir, chacun une fois. Absent : tous, sauf message.delivered, message.read et message.failed.',
        },
        description: { type: 'string', maxLength: 200, description: 'Un nom lisible dans la console (facultatif).' },
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
    nom: 'send_test_event',
    fonction: null,
    description:
      'Envoie tout de suite un événement d’essai (type test), signé, à une adresse créée par create_webhook_endpoint, et '
      + 'rend ce que l’application a répondu (code HTTP et début de la réponse). Sert à vérifier que l’application reçoit '
      + 'et vérifie la signature. Écrit dans le journal de l’adresse. Compte dans les opérations lourdes de l’espace.',
    scope: 'mcp:write',
    exigePersonne: true,
    // Monde ouvert : un appel part vers l'application du client.
    annotations: { title: 'Envoyer un essai de webhook', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        adresse_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'L’identifiant (id) rendu par create_webhook_endpoint.' },
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
    nom: 'list_webhook_endpoints',
    fonction: null,
    description:
      'Les adresses de webhooks sortants de l’espace (url, types d’événements cochés, active ou en pause, envois en '
      + 'réessai et en échec), la limite d’adresses actives de l’offre (null = sans limite) et les types disponibles. Le '
      + 'secret n’est jamais relu : il n’est montré qu’à la création.',
    scope: 'mcp:read',
    /**
     * Une PERSONNE, comme la console, qui réserve cette liste aux admins : l'adresse d'un outil sans code (Make, Zapier,
     * n8n) porte son jeton dans le chemin, et une clé `mcp:read` confiée à un agent tiers la lirait.
     */
    exigePersonne: true,
    annotations: { title: 'Lister les webhooks sortants', readOnlyHint: true, openWorldHint: false },
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
    nom: 'get_webhook_deliveries',
    fonction: null,
    description:
      'Le journal d’une adresse de webhooks sortants, du plus récent au plus ancien : chaque envoi avec son type, son '
      + 'statut (pending, delivered, failed), ses tentatives, le dernier code et la dernière réponse de l’application, et '
      + 'le corps envoyé (il porte des données de contacts). before (une date ISO) pour la page suivante, que rend '
      + 'next_before.',
    scope: 'mcp:read',
    // Le corps des événements porte des numéros et des messages de contacts : une personne, jamais une clé.
    exigePersonne: true,
    annotations: { title: 'Lire le journal d’un webhook', readOnlyHint: true, openWorldHint: false },
    entree: {
      type: 'object',
      properties: {
        adresse_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'L’identifiant de l’adresse (list_webhook_endpoints).' },
        before: { type: 'string', format: 'date-time', maxLength: 40, description: 'Les envois créés avant cette date (next_before de la page précédente).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Nombre d’envois (1 à 100, défaut 20).' },
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
    nom: 'replay_webhook_delivery',
    fonction: null,
    description:
      'Rejoue un envoi terminé (livré ou en échec) d’une adresse de webhooks sortants : il repart avec le même corps et '
      + 'le même identifiant d’événement (l’application dédoublonne), et ses 24 h de réessais repartent. Un envoi encore en '
      + 'cours ou un essai ne se rejoue pas.',
    scope: 'mcp:write',
    exigePersonne: true,
    // Renvoie vers l'application du client ; le même identifiant d'événement : rejouer deux fois est sans effet de plus
    // pour une application qui dédoublonne.
    annotations: { title: 'Rejouer un envoi de webhook', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    entree: {
      type: 'object',
      properties: {
        envoi_id: { type: 'string', format: 'uuid', minLength: 1, maxLength: 100, description: 'L’identifiant d’un envoi (get_webhook_deliveries).' },
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
