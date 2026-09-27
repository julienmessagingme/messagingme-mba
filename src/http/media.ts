import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';

export interface MediaRouteDeps {
  /** Upload une image et renvoie le handle média Meta (header_handle de carte carousel). */
  uploadImage(bytes: Buffer, mime: string): Promise<string>;
}

// Média accepté pour un en-tête (carousel = image ; en-tête simple = image ou vidéo). Data URL base64.
const DATA_URL_RE = /^data:(image\/(?:png|jpeg)|video\/mp4);base64,([A-Za-z0-9+/=]+)$/;
const IMG_MAX = 5 * 1024 * 1024; // 5 Mo (limite en-tête image Meta ; le front redimensionne avant)
const VIDEO_MAX = 16 * 1024 * 1024; // 16 Mo (limite en-tête vidéo Meta)

/**
 * Upload média (admin) : image (carousel, en-tête simple) ou vidéo mp4 (en-tête simple), reçue en data URL
 * base64, validée (type, poids), rend le handle Meta. bodyLimit élevé : le base64 ajoute 33 % (~22 Mo pour 16 Mo).
 */
export function registerMedia(app: FastifyInstance, deps: MediaRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde, bodyLimit: 24 * 1024 * 1024 };

  app.post('/tenants/:tenantId/media', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);

    const dataUrl = (req.body as { dataUrl?: unknown } | null)?.dataUrl;
    if (typeof dataUrl !== 'string') return reply.code(400).send({ error: 'dataUrl requis' });
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return reply.code(400).send({ error: 'média invalide (data URL base64 image/png, image/jpeg ou video/mp4 attendu)' });

    const mime = m[1]!;
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length === 0) return reply.code(400).send({ error: 'média vide' });
    const max = mime.startsWith('video/') ? VIDEO_MAX : IMG_MAX;
    if (bytes.length > max) return reply.code(400).send({ error: `média trop lourd (max ${Math.round(max / 1024 / 1024)} Mo)` });

    const handle = await deps.uploadImage(bytes, mime);
    return reply.code(200).send({ handle });
  });
}
