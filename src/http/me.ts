import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { scopeTenant } from './scope';

/** Profil de l'utilisateur COURANT (dérivé de req.auth.userId). Sert au « Bonjour {prénom} » de l'Accueil. */
export interface MeRouteDeps {
  getUser(userId: string): Promise<{ email: string; name: string | null; role: string } | null>;
}

export function registerMe(app: FastifyInstance, deps: MeRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/me', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'authentification requise' });
    /**
     * 🔴 LA SESSION D'OBSERVATION DE `/ops` N'A PAS DE COMPTE DANS L'ESPACE, et on ne la cherche pas en base.
     * Son identité est `ops-observation`, qui n'est pas un uuid : lue dans `users`, elle faisait lever la
     * comparaison `where id = $1` sur une colonne uuid (`22P02`), donc un 500 sur l'Accueil de chaque
     * observation. Même défaut que la pastille de non-lus, corrigé le matin même dans `PgInboxStore`. La réponse
     * garde la forme de toutes les autres : pas de nom (l'Accueil dit « Bonjour »), et le rôle de la session.
     */
    if (req.auth?.impersonated === true) return reply.code(200).send({ email: '', name: null, role: req.auth.role });
    const u = await deps.getUser(userId);
    if (!u) return reply.code(404).send({ error: 'utilisateur inconnu' });
    return reply.code(200).send({ email: u.email, name: u.name, role: u.role });
  });
}
