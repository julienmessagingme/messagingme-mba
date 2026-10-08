import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guard } from '../auth/middleware';
import { refuser } from '../api/erreurs';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import {
  decoderCurseur, LIMITE_PAGE_DEFAUT, LIMITE_PAGE_MAX, type DepotConversationsV1, type Reprise,
} from '../api/conversations-v1';
import { MediaExpire, enTetesMedia } from '../inbox/media-entrant';
import { MediaTropGros } from '../meta/media';
import { journaliser } from '../lib/journal';

/**
 * LA LECTURE DES FILS PAR L'API (lot 13, domaine 1, spec `docs/superpowers/specs/2026-10-08-api-complete-design.md`
 * § 3) : les conversations de l'espace, leurs messages, un message, le fichier d'un message reçu. Sous le droit
 * `conversations:read` (un droit neuf, sans reprise des clés existantes : décision de Julien du 2026-10-08), et ouvert
 * en Free : seul l'écran de l'Inbox est réservé au Pro.
 *
 * Chaque appel compte une unité `conversations.read`, au plafond d'appels, jamais au quota du jour. 🔴 L'espace vient
 * de la clé (`req.auth.tenantId`), jamais de l'URL : le dépôt filtre chaque requête dessus.
 */
export interface V1ConversationsRouteDeps {
  conversations: DepotConversationsV1;
  /** La lecture d'un fichier reçu chez Meta, la même que l'Inbox (`lireMediaRecu`), par l'identifiant INTERNE. */
  lireMediaMessage(tenantId: string, messageId: string, conversationId?: string): Promise<{ bytes: Buffer; mime: string | null; nom?: string | null } | null>;
  usage: ApiUsageGuard;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `limit` et `cursor` d'une query string, vérifiés. Une valeur hors bornes est un refus, jamais une page bricolée. */
function lirePagination(req: FastifyRequest): { limite: number; avant: Reprise | null } | { refus: string; code: 'invalid_body' | 'invalid_cursor' } {
  const q = (req.query ?? {}) as Record<string, unknown>;
  let limite = LIMITE_PAGE_DEFAUT;
  if (q.limit !== undefined) {
    const n = typeof q.limit === 'string' && /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > LIMITE_PAGE_MAX) return { refus: `« limit » : un entier de 1 à ${LIMITE_PAGE_MAX}`, code: 'invalid_body' };
    limite = n;
  }
  let avant: Reprise | null = null;
  if (q.cursor !== undefined) {
    avant = typeof q.cursor === 'string' ? decoderCurseur(q.cursor) : null;
    if (avant === null) return { refus: '« cursor » illisible : renvoyez tel quel le nextCursor d’une page précédente', code: 'invalid_cursor' };
  }
  return { limite, avant };
}

export function registerV1Conversations(app: FastifyInstance, deps: V1ConversationsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /** Le début commun : la clé, puis le compte (avant toute forme : une sonde compte aussi). */
  const entree = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    if (!req.auth) { refuser(reply, 401, 'unauthorized', 'clé d’API requise'); return null; }
    if (!await compterOuRefuser(deps.usage, req, reply, 'conversations.read')) return null;
    return req.auth.tenantId;
  };

  app.get('/v1/conversations', opts, async (req, reply) => {
    const tenantId = await entree(req, reply);
    if (tenantId === null) return reply;
    const p = lirePagination(req);
    if ('refus' in p) return refuser(reply, 400, p.code, p.refus);
    const { needsReply } = (req.query ?? {}) as Record<string, unknown>;
    if (needsReply !== undefined && needsReply !== 'true' && needsReply !== 'false') {
      return refuser(reply, 400, 'invalid_body', '« needsReply » : true ou false');
    }
    return reply.code(200).send(await deps.conversations.lister(tenantId, { ...p, aTraiter: needsReply === 'true' }));
  });

  app.get('/v1/conversations/:conversationId', opts, async (req, reply) => {
    const tenantId = await entree(req, reply);
    if (tenantId === null) return reply;
    const { conversationId } = req.params as { conversationId: string };
    // Un identifiant qui n'est pas un uuid ferait lever Postgres (22P02), donc un 500 : il est inconnu, 404.
    const c = UUID_RE.test(conversationId) ? await deps.conversations.lire(tenantId, conversationId) : null;
    if (!c) return refuser(reply, 404, 'conversation_not_found', 'conversation inconnue');
    return reply.code(200).send(c);
  });

  app.get('/v1/conversations/:conversationId/messages', opts, async (req, reply) => {
    const tenantId = await entree(req, reply);
    if (tenantId === null) return reply;
    const { conversationId } = req.params as { conversationId: string };
    const p = lirePagination(req);
    if ('refus' in p) return refuser(reply, 400, p.code, p.refus);
    const page = UUID_RE.test(conversationId) ? await deps.conversations.messages(tenantId, conversationId, p) : null;
    if (!page) return refuser(reply, 404, 'conversation_not_found', 'conversation inconnue');
    return reply.code(200).send(page);
  });

  app.get('/v1/messages/:messageId', opts, async (req, reply) => {
    const tenantId = await entree(req, reply);
    if (tenantId === null) return reply;
    const { messageId } = req.params as { messageId: string };
    const m = await deps.conversations.message(tenantId, messageId);
    if (!m) return refuser(reply, 404, 'message_not_found', 'message inconnu');
    const { idInterne: _interne, ...publique } = m;
    return reply.code(200).send(publique);
  });

  /**
   * Le fichier d'un message REÇU, cherché chez Meta (l'URL de Meta vit quelques minutes et exige notre jeton). Mêmes
   * en-têtes que l'Inbox (`enTetesMedia`) : `nosniff`, `attachment` hors des images, `no-store`. 4xx, jamais 5xx :
   * Cloudflare remplacerait le corps.
   */
  app.get('/v1/messages/:messageId/media', opts, async (req, reply) => {
    const tenantId = await entree(req, reply);
    if (tenantId === null) return reply;
    const { messageId } = req.params as { messageId: string };
    const m = await deps.conversations.message(tenantId, messageId);
    if (!m) return refuser(reply, 404, 'message_not_found', 'message inconnu');
    if (m.media === null) return refuser(reply, 404, 'no_media', 'ce message ne porte aucun fichier reçu');
    if (m.media.expired) return refuser(reply, 410, 'media_expired', 'Meta ne garde un fichier reçu que 7 jours : celui-ci n’existe plus');
    try {
      const f = await deps.lireMediaMessage(tenantId, m.idInterne, m.conversationId);
      if (!f) return refuser(reply, 404, 'no_media', 'ce message ne porte aucun fichier reçu');
      return reply.headers(enTetesMedia(f.mime, f.nom ?? null, `piece-jointe-${m.idInterne.slice(0, 8)}`)).send(f.bytes);
    } catch (err) {
      if (err instanceof MediaExpire) return refuser(reply, 410, 'media_expired', err.message);
      if (err instanceof MediaTropGros) {
        return refuser(reply, 422, 'media_unavailable', `fichier trop lourd (${Math.round(err.octets / 1024 / 1024)} Mo, maximum ${Math.round(err.plafond / 1024 / 1024)} Mo)`);
      }
      journaliser('error', 'v1_media_illisible', { err, tenantId, messageId: m.idInterne });
      return refuser(reply, 422, 'media_unavailable', 'Meta n’a pas rendu ce fichier : réessayez dans un instant');
    }
  });
}
