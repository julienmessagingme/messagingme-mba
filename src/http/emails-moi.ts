import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { LANGUES } from '../emails-produit/catalogue';
import type { PgEmailsProduitStore } from '../emails-produit/store.pg';

/**
 * LES PRÉFÉRENCES D'E-MAILS DE LA PERSONNE CONNECTÉE (lot 7) : la langue de ses e-mails et ses deux abonnements
 * (commerciaux, transferts), pour la page « Mon compte ». La console y écrit aussi la langue choisie dans son
 * sélecteur, seul endroit où elle est connue.
 *
 * Elles appartiennent à la PERSONNE (`identities`), pas au compte d'un espace : une adresse qui a trois espaces a une
 * langue et une désinscription. La session porte le compte ; la route lit l'identité de CE compte dans l'espace de
 * l'adresse, vérifié par l'étape d'espace (`espaceVerifie`), jamais une identité tirée du corps.
 */

export interface EmailsMoiDeps {
  store: Pick<PgEmailsProduitStore, 'identiteDuCompte' | 'preferences' | 'poserLangue' | 'desinscrire' | 'reabonner'>;
}

const majSchema = z.object({
  langue: z.enum(LANGUES).optional(),
  commerciaux: z.boolean().optional(),
  transferts: z.boolean().optional(),
}).strict();

export function registerEmailsMoi(app: FastifyInstance, deps: EmailsMoiDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };

  const identite = async (req: { auth?: { userId: string } }): Promise<string | null> =>
    req.auth ? deps.store.identiteDuCompte(espaceVerifie(req), req.auth.userId) : null;

  const lire = async (identityId: string) => {
    const p = await deps.store.preferences(identityId);
    if (p === null) return null;
    return {
      langue: p.langue,
      commerciaux: !p.desinscriptions.includes('commercial'),
      transferts: !p.desinscriptions.includes('transfert'),
    };
  };

  app.get('/tenants/:tenantId/moi/emails', opts, async (req, reply) => {
    const id = await identite(req);
    const p = id ? await lire(id) : null;
    if (p === null) return reply.code(404).send({ error: 'compte sans identité' });
    return reply.code(200).send(p);
  });

  app.put('/tenants/:tenantId/moi/emails', opts, async (req, reply) => {
    const lu = majSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'langue (fr ou en), commerciaux et transferts (vrai ou faux), tous facultatifs' });
    const id = await identite(req);
    if (id === null) return reply.code(404).send({ error: 'compte sans identité' });
    const { langue, commerciaux, transferts } = lu.data;
    if (langue !== undefined) await deps.store.poserLangue(id, langue);
    if (commerciaux !== undefined) await (commerciaux ? deps.store.reabonner(id, 'commercial') : deps.store.desinscrire(id, 'commercial'));
    if (transferts !== undefined) await (transferts ? deps.store.reabonner(id, 'transfert') : deps.store.desinscrire(id, 'transfert'));
    return reply.code(200).send(await lire(id));
  });
}
