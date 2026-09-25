import { outilsPourScopes, RefusOutil, type DepsMcp, type OutilMcp } from './outils';
import { messageDe } from '../lib/erreur';

/**
 * Le transport MCP : du JSON-RPC 2.0 sur un seul POST, SANS ÉTAT.
 *
 * Pourquoi écrit ici plutôt qu'avec le SDK officiel : la surface dont ce serveur a besoin tient en cinq
 * méthodes (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`), et le SDK
 * apporte avec lui une gestion de session et un canal SSE dont un serveur d'outils sans état n'a aucun
 * usage. Le dépôt est tenu léger en dépendances, et une dépendance qu'on n'utilise qu'à 10 % est une
 * dépendance qu'on subira à 100 % le jour où elle changera de contrat.
 *
 * SANS ÉTAT est un choix, pas une facilité : il n'y a ni `Mcp-Session-Id` ni reprise de flux, donc deux
 * requêtes du même client peuvent tomber sur deux process différents sans que rien ne casse. C'est ce qui
 * permet de mettre l'API derrière un proxy et, un jour, d'en lancer une seconde instance.
 *
 * 🔴 L'AUTORISATION N'EST PAS ICI. Elle est posée par le preHandler de la route (clé d'API, comme `/v1`),
 * et ce module ne reçoit que le tenant déjà résolu et les scopes de la clé. Un module de transport qui
 * déciderait aussi des droits finirait par en décider différemment de `/v1`.
 */

/** Version du protocole que ce serveur parle. Un client qui en demande une autre reçoit celle-ci et décide. */
export const VERSION_PROTOCOLE = '2025-06-18';

/** Versions connues : on ÉCHO celle du client si on la connaît, c'est ce que la négociation demande. */
const VERSIONS_CONNUES = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export const SERVEUR_INFO = { name: 'messagingme-mba', title: 'Engage Me', version: '1.0.0' } as const;

/** Codes d'erreur JSON-RPC 2.0. Les seuls dont ce serveur a besoin. */
const ERREUR = { PARSE: -32700, REQUETE_INVALIDE: -32600, METHODE_INCONNUE: -32601, PARAMS_INVALIDES: -32602, INTERNE: -32603 } as const;

interface RequeteRpc { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

/** Une réponse à renvoyer, ou `null` quand l'entrée était une NOTIFICATION (pas d'`id` : rien à répondre). */
export type ReponseRpc = { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string } }
  | null;

export interface ContexteMcp {
  tenantId: string;
  scopes: string[];
}

function ok(id: string | number, result: unknown): ReponseRpc {
  return { jsonrpc: '2.0', id, result };
}
function ko(id: string | number, code: number, message: string): ReponseRpc {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** La description d'un outil telle que MCP l'attend dans `tools/list`. */
function descriptionOutil(o: OutilMcp): Record<string, unknown> {
  return { name: o.nom, description: o.description, inputSchema: o.entree };
}

/**
 * Traite UN message JSON-RPC. Rend `null` pour une notification (le HTTP répondra 202 sans corps).
 *
 * Aucune exception ne sort d'ici : une panne devient une erreur JSON-RPC `-32603`, et un refus métier
 * devient un RÉSULTAT avec `isError: true`. La distinction compte pour l'agent en face : une erreur de
 * protocole veut dire « l'outil est cassé », un résultat en erreur veut dire « ta demande n'était pas
 * recevable, lis pourquoi et change de plan ».
 */
export async function traiterMessage(deps: DepsMcp, ctx: ContexteMcp, message: unknown): Promise<ReponseRpc> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return ko(0, ERREUR.REQUETE_INVALIDE, 'message JSON-RPC attendu');
  }
  const m = message as RequeteRpc;
  const methode = typeof m.method === 'string' ? m.method : '';
  const estNotification = m.id === undefined || m.id === null;
  const id = (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : 0;

  // Notifications : le client ne veut pas de réponse. `notifications/initialized` est la seule qu'un client
  // MCP envoie à un serveur d'outils ; les autres sont ignorées sans bruit, comme le protocole le demande.
  if (estNotification) return null;

  if (m.jsonrpc !== '2.0') return ko(id, ERREUR.REQUETE_INVALIDE, 'jsonrpc doit valoir "2.0"');

  switch (methode) {
    case 'initialize': {
      const demandee = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const version = typeof demandee === 'string' && VERSIONS_CONNUES.has(demandee) ? demandee : VERSION_PROTOCOLE;
      return ok(id, {
        protocolVersion: version,
        // `listChanged: false` est la vérité : le catalogue est figé dans le code, il ne bouge pas en
        // cours de session. Annoncer `true` inviterait le client à s'abonner à une notification qui ne
        // viendra jamais.
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVEUR_INFO,
        instructions:
          'Outils de la console Engage Me (WhatsApp). Commence par list_conversations, puis '
          + 'get_conversation pour savoir si la fenêtre de 24 h est ouverte avant toute tentative de réponse.',
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      // Un outil hors des scopes de la clé n'est même pas LISTÉ : un agent ne doit pas passer son tour à
      // essayer des outils qu'on lui refusera, et la liste dit exactement ce que cette clé permet.
      return ok(id, { tools: outilsPourScopes(ctx.scopes).map(descriptionOutil) });
    case 'tools/call': {
      const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
      const nom = typeof params.name === 'string' ? params.name : '';
      const outil = outilsPourScopes(ctx.scopes).find((o) => o.nom === nom);
      if (!outil) {
        // Message DÉLIBÉRÉMENT identique pour « n'existe pas » et « pas autorisé » : dire lequel des deux
        // renseignerait un porteur de clé sur des capacités qu'on lui refuse.
        return ko(id, ERREUR.PARAMS_INVALIDES, `outil inconnu ou non autorisé par cette clé : ${nom || '(sans nom)'}`);
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments))
        ? params.arguments as Record<string, unknown>
        : {};
      try {
        const resultat = await outil.executer(deps, ctx.tenantId, args);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(resultat, null, 2) }], isError: false });
      } catch (err) {
        if (err instanceof RefusOutil) {
          return ok(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        // Panne : on journalise côté serveur et on ne renvoie PAS le message d'origine, qui peut porter un
        // fragment de requête SQL ou de réponse Meta.
        // eslint-disable-next-line no-console
        console.error(`mcp: échec de l'outil ${nom} (tenant ${ctx.tenantId}):`, messageDe(err));
        return ko(id, ERREUR.INTERNE, 'échec interne de l’outil');
      }
    }
    default:
      return ko(id, ERREUR.METHODE_INCONNUE, `méthode inconnue : ${methode || '(vide)'}`);
  }
}

/** Erreur de parsing du corps, à renvoyer telle quelle avec un HTTP 200 (le protocole veut du JSON-RPC). */
export function erreurDeParsing(): ReponseRpc {
  return ko(0, ERREUR.PARSE, 'corps JSON invalide');
}

/**
 * Refus d'un LOT (tableau de messages JSON-RPC).
 *
 * Le message dit la RAISON de protocole, parce que c'est celle qu'un intégrateur peut corriger. Il tait la
 * raison de sécurité, qui est la vraie : le plafond de débit se compte par requête HTTP, donc un lot serait
 * un moyen d'envoyer des milliers de messages pour une unité de quota.
 */
export function lotRefuse(): ReponseRpc {
  return ko(0, ERREUR.REQUETE_INVALIDE, 'un seul message JSON-RPC par requête : le lot a été retiré de MCP en 2025-06-18');
}
