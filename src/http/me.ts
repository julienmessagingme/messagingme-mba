import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';

/** Profil de l'utilisateur courant (dérivé de req.auth.userId). Sert au « Bonjour {prénom} » de l'Accueil. */
export interface MeRouteDeps {
  getUser(userId: string): Promise<{ email: string; name: string | null; role: string } | null>;
}

export function registerMe(app: FastifyInstance, deps: MeRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/me', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'authentification requise' });
    /**
     * La session d'observation de `/ops` n'a pas de compte dans l'espace : son identité `ops-observation` n'est pas
     * un uuid, et la chercher dans `users` lèverait `22P02` (donc un 500). On rend la même forme, sans nom.
     */
    if (req.auth?.impersonated === true) return reply.code(200).send({ email: '', name: null, role: req.auth.role });
    const u = await deps.getUser(userId);
    if (!u) return reply.code(404).send({ error: 'utilisateur inconnu' });
    return reply.code(200).send({ email: u.email, name: u.name, role: u.role });
  });
}
