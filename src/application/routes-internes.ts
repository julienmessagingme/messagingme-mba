import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyRequest } from '../lib/signature';
import type { GestionnaireSessions } from './sessions';
import { ErreurApplication, PREFIXE } from './interne';

/**
 * LES ROUTES INTERNES DU SERVICE DE CONNEXIONS (plan 2026-10-22, tâche 3). Servies par `mba-application`, sur le seul
 * réseau privé, jamais par l'API publique : elles ne passent donc pas par le registre de `src/server.ts`. Chaque appel
 * est signé comme nos services (`x-mm-service-signature`, `src/lib/signature.ts`) sur le corps brut, la méthode et le
 * chemin, et la signature se vérifie AVANT de lire quoi que ce soit.
 */
export { PREFIXE };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const corpsEnvoi = z.object({
  destinataire: z.string().min(3).max(120),
  texte: z.string().min(1).max(4096),
});

export interface DepsRoutesApplication {
  sessions: GestionnaireSessions;
  secret: string;
  now?: () => number;
  windowMs?: number;
}

export function enregistrerRoutesApplication(app: FastifyInstance, d: DepsRoutesApplication): void {
  const now = d.now ?? (() => Date.now());
  const windowMs = d.windowMs ?? 60_000;

  void app.register(async (portee) => {
    // Le corps reste brut : la signature porte sur ses octets exacts.
    portee.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, corps, fait) => fait(null, corps));

    portee.addHook('preHandler', async (req, reply) => {
      const brut = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const entete = req.headers['x-mm-service-signature'];
      const signature = Array.isArray(entete) ? entete[0] : entete;
      const chemin = req.url.split('?')[0] ?? req.url;
      if (!verifyRequest(brut, signature, d.secret, { method: req.method, path: chemin, now: now(), windowMs })) {
        return reply.code(401).send({ error: 'signature invalide' });
      }
      const { id } = req.params as { id?: string };
      if (!id || !UUID.test(id)) return reply.code(400).send({ error: 'compte invalide' });
    });

    const refus = (err: unknown) => {
      if (err instanceof ErreurApplication) return { code: 409, corps: { error: err.message, raison: err.raison } };
      throw err;
    };

    portee.post(`${PREFIXE}/:id/relier`, async (req, reply) => {
      try {
        await d.sessions.relier((req.params as { id: string }).id);
        return { ok: true };
      } catch (err) {
        const r = refus(err);
        return reply.code(r.code).send(r.corps);
      }
    });

    portee.get(`${PREFIXE}/:id/qr`, async (req) => d.sessions.qr((req.params as { id: string }).id));

    portee.post(`${PREFIXE}/:id/envoyer`, async (req, reply) => {
      let json: unknown;
      try {
        json = JSON.parse((req.body as Buffer).toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'corps illisible' });
      }
      const corps = corpsEnvoi.safeParse(json);
      if (!corps.success) return reply.code(400).send({ error: 'corps invalide' });
      try {
        const messageId = await d.sessions.envoyer((req.params as { id: string }).id, corps.data.destinataire, corps.data.texte);
        return { messageId };
      } catch (err) {
        const r = refus(err);
        return reply.code(r.code).send(r.corps);
      }
    });

    portee.post(`${PREFIXE}/:id/sommeil`, async (req) => {
      await d.sessions.sommeil((req.params as { id: string }).id);
      return { ok: true };
    });

    portee.post(`${PREFIXE}/:id/retirer`, async (req) => {
      await d.sessions.retirer((req.params as { id: string }).id);
      return { ok: true };
    });
  });
}
