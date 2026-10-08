import type { DepsMcp, OutilMcp } from './outils';
import { RefusOutil, valeurOuRefus } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import type { AuditSink } from '../audit/journal';
import { TYPES_ABONNABLES } from '../evenements/types';
import { creerAdresse, envoyerEssai, type DepsGestionEvenements } from '../evenements/gestion';

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
];
