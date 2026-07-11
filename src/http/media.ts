import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';

export interface MediaRouteDeps {
  /** Upload une image et renvoie le handle média Meta (header_handle de carte carousel). */
  uploadImage(bytes: Buffer, mime: string): Promise<string>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/;
const MAX_BYTES = 5 * 1024 * 1024; // 5 Mo (Meta limite les images d'en-tête ; le front redimensionne avant)

/**
 * Upload d'image (admin) pour les headers de cartes carousel. Accepte un data URL base64
 * (`data:image/png;base64,...`), décode, valide le type/poids, renvoie le handle Meta. GROUPE
 * admin-only via `guard`. bodyLimit de route élevé (l'image transite en base64).
 */
export function registerMedia(app: FastifyInstance, deps: MediaRouteDeps, guard?: Guard): void {
  const opts = { ...(guard ? { preHandler: guard } : {}), bodyLimit: 7 * 1024 * 1024 };

  app.post('/tenants/:tenantId/media', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const dataUrl = (req.body as { dataUrl?: unknown } | null)?.dataUrl;
    if (typeof dataUrl !== 'string') return reply.code(400).send({ error: 'dataUrl requis' });
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return reply.code(400).send({ error: 'image invalide (data URL base64 image/png ou image/jpeg attendu)' });

    const mime = m[1]!;
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length === 0) return reply.code(400).send({ error: 'image vide' });
    if (bytes.length > MAX_BYTES) return reply.code(400).send({ error: 'image trop lourde (max 5 Mo)' });

    const handle = await deps.uploadImage(bytes, mime);
    return reply.code(200).send({ handle });
  });
}
