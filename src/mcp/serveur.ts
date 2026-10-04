import { outilsPour, RefusOutil, type DepsMcp, type OutilMcp, type PersonneMcp } from './outils';
import { messageDe } from '../lib/erreur';

/**
 * Le transport MCP : du JSON-RPC 2.0 sur un seul POST, sans état.
 *
 * Écrit à la main plutôt qu'avec le SDK : la surface utile tient en cinq méthodes, et le SDK apporte une gestion de
 * session et un canal SSE inutiles à un serveur d'outils sans état.
 * Sans état : ni `Mcp-Session-Id` ni reprise de flux, deux requêtes d'un même client peuvent tomber sur deux process.
 * 🔴 L'autorisation n'est pas ici : le preHandler de la route la pose (clé d'API ou jeton OAuth, comme `/v1`), et ce
 * module ne reçoit que l'espace résolu, les scopes et la personne. Il ne doit pas décider des droits autrement que `/v1`.
 */

/** Version du protocole que ce serveur parle. Un client qui en demande une autre reçoit celle-ci et décide. */
export const VERSION_PROTOCOLE = '2025-06-18';

/** Versions connues : on reprend celle du client si on la connaît, c'est ce que la négociation demande. */
const VERSIONS_CONNUES = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export const SERVEUR_INFO = { name: 'messagingme-mba', title: 'Engage Me', version: '1.0.0' } as const;

/** Codes d'erreur JSON-RPC 2.0. Les seuls dont ce serveur a besoin. */
const ERREUR = { PARSE: -32700, REQUETE_INVALIDE: -32600, METHODE_INCONNUE: -32601, PARAMS_INVALIDES: -32602, INTERNE: -32603 } as const;

interface RequeteRpc { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

/** Une réponse à renvoyer, ou `null` quand l'entrée était une notification (pas d'`id` : rien à répondre). */
export type ReponseRpc = { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string } }
  | null;

export interface ContexteMcp {
  tenantId: string;
  scopes: string[];
  /**
   * La personne derrière un jeton OAuth, toujours un admin de l'espace (relu à chaque appel par la garde) ; `null`
   * derrière une clé d'API. Requise : un appelant qui l'oublierait ferait signer par personne en silence.
   */
  personne: PersonneMcp | null;
}

function ok(id: string | number, result: unknown): ReponseRpc {
  return { jsonrpc: '2.0', id, result };
}
function ko(id: string | number, code: number, message: string): ReponseRpc {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * La description d'un outil telle que MCP l'attend dans `tools/list`. `title` est aussi au premier niveau : c'est là
 * que la spécification 2025-06-18 le lit en premier, l'annotation n'étant que son repli.
 */
function descriptionOutil(o: OutilMcp): Record<string, unknown> {
  return { name: o.nom, title: o.annotations.title, description: o.description, inputSchema: o.entree, annotations: o.annotations };
}

/**
 * Traite un message JSON-RPC. Rend `null` pour une notification (le HTTP répondra 202 sans corps).
 * Aucune exception ne sort : une panne devient une erreur `-32603` (« l'outil est cassé »), un refus métier un
 * résultat avec `isError: true` (« lis pourquoi et change de plan »).
 */
export async function traiterMessage(deps: DepsMcp, ctx: ContexteMcp, message: unknown): Promise<ReponseRpc> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return ko(0, ERREUR.REQUETE_INVALIDE, 'message JSON-RPC attendu');
  }
  const m = message as RequeteRpc;
  const methode = typeof m.method === 'string' ? m.method : '';
  const estNotification = m.id === undefined || m.id === null;
  const id = (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : 0;

  // Notifications : pas de réponse. `notifications/initialized` est la seule attendue, les autres sont ignorées.
  if (estNotification) return null;

  if (m.jsonrpc !== '2.0') return ko(id, ERREUR.REQUETE_INVALIDE, 'jsonrpc doit valoir "2.0"');

  switch (methode) {
    case 'initialize': {
      const demandee = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const version = typeof demandee === 'string' && VERSIONS_CONNUES.has(demandee) ? demandee : VERSION_PROTOCOLE;
      return ok(id, {
        protocolVersion: version,
        // `listChanged: false` : le catalogue est figé dans le code, `true` ferait attendre une notification qui ne
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
      // Un outil hors des scopes de la clé n'est même pas listé, ni un outil qui exige une personne derrière une clé :
      // la liste dit exactement ce que cet appel permet.
      return ok(id, { tools: outilsPour(ctx).map(descriptionOutil) });
    case 'tools/call': {
      const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
      const nom = typeof params.name === 'string' ? params.name : '';
      const outil = outilsPour(ctx).find((o) => o.nom === nom);
      if (!outil) {
        // Même message pour « n'existe pas », « pas autorisé » et « exige une personne » : ne pas renseigner sur des
        // capacités refusées.
        return ko(id, ERREUR.PARAMS_INVALIDES, `outil inconnu ou non autorisé par cette clé : ${nom || '(sans nom)'}`);
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments))
        ? params.arguments as Record<string, unknown>
        : {};
      try {
        const resultat = await outil.executer(deps, ctx.tenantId, args, ctx.personne);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(resultat, null, 2) }], isError: false });
      } catch (err) {
        if (err instanceof RefusOutil) {
          return ok(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        // Panne : journalisée côté serveur, sans renvoyer le message d'origine (fragment SQL ou réponse Meta possible).
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
 * Refus d'un lot (tableau de messages JSON-RPC). Le message dit la raison de protocole ; la vraie est de sécurité :
 * le plafond de débit se compte par requête HTTP, un lot enverrait des milliers de messages pour une unité de quota.
 */
export function lotRefuse(): ReponseRpc {
  return ko(0, ERREUR.REQUETE_INVALIDE, 'un seul message JSON-RPC par requête : le lot a été retiré de MCP en 2025-06-18');
}
