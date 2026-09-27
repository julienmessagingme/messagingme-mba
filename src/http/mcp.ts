import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import { traiterMessage, erreurDeParsing, lotRefuse, VERSION_PROTOCOLE } from '../mcp/serveur';
import type { DepsMcp } from '../mcp/outils';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';

/**
 * La route MCP : `POST /mcp`, un seul chemin, sans état, relayée par le front comme `/api/backend/*`.
 * 🔴 L'autorisation est celle de `/v1` : une clé d'API en Bearer, avec des scopes, révocable et limitée en débit.
 * Un grant OAuth délégué posé à moitié donnerait l'illusion d'un contrôle d'accès par personne.
 */
export function registerMcp(app: FastifyInstance, deps: DepsMcp, prehandlers: PreHandler[], usage: ApiUsageGuard): void {
  const opts = { preHandler: prehandlers };

  app.post('/mcp', opts, async (req, reply) => {
    // 🔴 L'espace vient de la clé résolue, jamais d'un paramètre : impossible de désigner l'espace d'un autre.
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'clé d’API requise' });
    const ctx = { tenantId, scopes: req.apiScopes ?? [] };

    // Un message par requête, donc une unité : c'est le refus du lot JSON-RPC, plus bas, qui rend ce compte honnête.
    if (!await compterOuRefuser(usage, req, reply, 'mcp.call')) return reply;

    reply.header('MCP-Protocol-Version', VERSION_PROTOCOLE);

    const corps = req.body;
    if (corps === undefined || corps === null || typeof corps !== 'object') {
      return reply.code(200).send(erreurDeParsing());
    }

    // 🔴 Un seul message par requête : le lot JSON-RPC est refusé. Le débit se compte une fois par requête HTTP ;
    // un tableau ferait passer des milliers d'envois Meta réels pour une seule unité. Le lot a d'ailleurs été
    // retiré de MCP dans la version que ce serveur annonce (2025-06-18).
    if (Array.isArray(corps)) {
      return reply.code(200).send(lotRefuse());
    }

    const reponse = await traiterMessage(deps, ctx, corps);
    // Notification : rien à répondre. 202 avec un corps vide, pas un 200 avec `null`, qu'un client lirait
    // comme une réponse malformée.
    if (reponse === null) return reply.code(202).send();
    return reply.code(200).send(reponse);
  });

  /**
   * GET sur le même chemin : un serveur peut y ouvrir un flux SSE ; celui-ci n'a rien à dire spontanément, et le
   * protocole autorise le 405. Elle est comptée quand même : elle traverse le préhandler de clé (un lookup), et une
   * boucle dessus serait sinon invisible.
   */
  app.get('/mcp', opts, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'clé d’API requise' });
    if (!await compterOuRefuser(usage, req, reply, 'mcp.refus')) return reply;
    return reply.code(405).send({ error: 'ce serveur MCP ne pousse rien : utilise POST' });
  });
}
