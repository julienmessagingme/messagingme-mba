import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import { traiterMessage, erreurDeParsing, lotRefuse, VERSION_PROTOCOLE } from '../mcp/serveur';
import type { DepsMcp } from '../mcp/outils';

/**
 * La route MCP : `POST /mcp`, un seul chemin, sans état.
 *
 * L'adresse publique est `https://mba.messagingme.app/mcp` (choix de Julien du 2026-09-01) : un CHEMIN et
 * pas un domaine à part, ce qui évite un certificat, une entrée de proxy et un nom de plus à expliquer. Le
 * front la relaie vers l'API par un rewrite Next, comme `/api/backend/*` et `/r/:code`.
 *
 * 🔴 L'autorisation est celle de `/v1` : une clé d'API en Bearer, avec des scopes. C'est une autorité déjà
 * en place, révocable par clé et déjà limitée en débit. Le grant OAuth 2.1 délégué que décrit le scénario
 * `claude mcp add` + fenêtre de login est un chantier À PART (enregistrement dynamique de client, écran de
 * consentement, révocation par utilisateur) : le poser à moitié aurait donné l'illusion d'un contrôle
 * d'accès par personne alors qu'il n'y en aurait pas.
 */
export function registerMcp(app: FastifyInstance, deps: DepsMcp, prehandlers: PreHandler[]): void {
  const opts = { preHandler: prehandlers };

  app.post('/mcp', opts, async (req, reply) => {
    // Le tenant vient à 100 % de la clé résolue, jamais d'un paramètre : c'est la même règle que `/v1`, et
    // c'est ce qui rend impossible qu'un appelant désigne l'espace d'un autre.
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'clé d’API requise' });
    const ctx = { tenantId, scopes: req.apiScopes ?? [] };

    reply.header('MCP-Protocol-Version', VERSION_PROTOCOLE);

    const corps = req.body;
    if (corps === undefined || corps === null || typeof corps !== 'object') {
      return reply.code(200).send(erreurDeParsing());
    }

    // 🔴 UN SEUL message par requête. Le LOT JSON-RPC est REFUSÉ, et ce refus est une garde de sécurité
    // avant d'être une conformité.
    //
    // Le plafond de débit est compté UNE FOIS PAR REQUÊTE HTTP, dans le preHandler de la clé d'API. Un
    // tableau accepté aurait donc laissé passer, pour le prix d'UNE unité de débit, autant d'appels
    // `reply_in_open_window` que le corps de 1 Mo peut en contenir, soit plusieurs milliers d'envois Meta
    // réels dans un seul POST. C'est exactement le mégaphone que ce lot dit avoir fermé en n'exposant pas
    // `send_template` : le rouvrir par le volume plutôt que par la fonctionnalité n'aurait rien changé pour
    // le numéro, dont Meta note la qualité.
    //
    // Et le protocole va dans le même sens : le lot JSON-RPC a été RETIRÉ de MCP en 2025-06-18, la version
    // que ce serveur annonce. Aucun client conforme n'en a besoin. Refuser est donc à la fois plus sûr et
    // plus juste que borner la taille du lot.
    if (Array.isArray(corps)) {
      return reply.code(200).send(lotRefuse());
    }

    const reponse = await traiterMessage(deps, ctx, corps);
    // Notification : rien à répondre. 202 avec un corps VIDE, pas un 200 avec `null`, qu'un client lirait
    // comme une réponse malformée.
    if (reponse === null) return reply.code(202).send();
    return reply.code(200).send(reponse);
  });

  /**
   * GET sur le même chemin : le protocole prévoit qu'un serveur puisse y ouvrir un flux SSE pour parler à
   * l'initiative du serveur. Celui-ci n'a rien à dire spontanément (aucune ressource, aucun abonnement),
   * et le protocole autorise explicitement à répondre 405 dans ce cas. Le dire est plus honnête que de
   * laisser un client attendre un flux qui ne viendra jamais.
   */
  app.get('/mcp', opts, async (_req, reply) => reply.code(405).send({ error: 'ce serveur MCP ne pousse rien : utilise POST' }));
}
