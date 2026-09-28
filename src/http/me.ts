import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';

/** Profil de l'utilisateur courant (dérivé de req.auth.userId). Sert au « Bonjour {prénom} » de l'Accueil. */
export interface MeRouteDeps {
  getById(userId: string): Promise<{ email: string; name: string | null; role: string } | null>;
  /**
   * L'adresse est-elle dans `OPS_EMAILS` ? Sert au seul lien « Exploitation » du menu du compte : un confort
   * d'affichage, jamais une autorisation (`/ops` a sa propre garde). Absent : aucun lien.
   */
  estExploitant?(email: string): boolean;
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
    const u = await deps.getById(userId);
    if (!u) return reply.code(404).send({ error: 'utilisateur inconnu' });
    // `exploitation` n'est posé que vrai : la personne elle-même apprend qu'elle a l'accès, personne d'autre.
    return reply.code(200).send({ email: u.email, name: u.name, role: u.role, ...(deps.estExploitant?.(u.email) ? { exploitation: true } : {}) });
  });
}
