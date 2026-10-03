import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import { traiterMessage, erreurDeParsing, lotRefuse, VERSION_PROTOCOLE, type ContexteMcp } from '../mcp/serveur';
import type { DepsMcp } from '../mcp/outils';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { enTeteWwwAuthenticate } from '../oauth/metadonnees';
import { PREFIXE_ACCES } from '../oauth/jetons';

/**
 * La route MCP : `POST /mcp`, un seul chemin, sans état, relayée par le front comme `/api/backend/*`.
 * 🔴 L'autorisation est celle de `/v1` : une clé d'API en Bearer, ou un jeton d'accès OAuth de notre serveur
 * (migration 0204), avec des scopes, révocables et limités en débit. Un jeton porte une personne, admin de
 * l'espace, relue à chaque appel : c'est elle qui signe les écritures.
 *
 * `base` : l'adresse publique de l'API (`PUBLIC_API_URL`), `null` quand elle n'est pas posée. Elle décide du
 * `WWW-Authenticate` du 401, qui fait ouvrir la connexion OAuth à Claude. 🔴 Posé seulement quand l'hôte appelé
 * est celui de `base` : sur `mba.messagingme.app`, la ressource annoncée (`api.`) ne correspondrait pas à
 * l'adresse appelée (RFC 9728, 3.3), et un client à clé révoquée partirait vers une connexion qui ne peut pas
 * aboutir. Jamais sur `/v1`, ni sur un 403 ou un 429 : seul ce 401 ouvre une connexion.
 */
export function registerMcp(app: FastifyInstance, deps: DepsMcp, prehandlers: PreHandler[], usage: ApiUsageGuard, base: string | null): void {
  const hote = base === null ? null : new URL(base).host.toLowerCase();
  /**
   * Un crochet de route, et pas la garde : la garde sert aussi `/v1` et le relais. Il voit aussi le 401 rendu par
   * la garde, puisqu'il appartient à la route.
   */
  const annoncerConnexion = async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (base !== null && reply.statusCode === 401 && req.host.toLowerCase() === hote) {
      // `invalid_token` seulement quand un jeton OAuth a été présenté : sans authentification, la RFC 6750 veut un
      // en-tête sans code d'erreur, et une clé refusée n'est pas un jeton.
      const jeton = req.headers.authorization?.startsWith(`Bearer ${PREFIXE_ACCES}`) === true;
      reply.header('www-authenticate', enTeteWwwAuthenticate(base, jeton ? 'invalid_token' : undefined));
    }
    return payload;
  };
  const opts = { preHandler: prehandlers, onSend: annoncerConnexion };

  app.post('/mcp', opts, async (req, reply) => {
    // 🔴 L'espace vient de la clé ou du jeton résolu, jamais d'un paramètre : impossible de désigner l'espace d'un autre.
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'clé d’API requise' });
    const ctx: ContexteMcp = { tenantId, scopes: req.apiScopes ?? [], personne: req.apiPersonne ?? null };

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
