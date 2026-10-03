import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { ComptesAuthDep } from '../auth/routes';
import { verifyDemandeOauth } from '../auth/token';
import { makeJournal } from '../audit/journal';
import { clientConnu } from '../oauth/clients';
import { autoriser, DEMANDE_EXPIREE, type DepsAutoriser } from '../oauth/autoriser';
import type { PgOauthStore } from '../oauth/store.pg';
import { espaceVerifie, estUuid } from './scope';

/**
 * L'OAUTH VU DE LA CONSOLE, classe `tenant`, monté sur `g.admin` : autoriser Claude avec la session de la console,
 * lister les autorisations de l'espace (« Applications autorisées ») et en révoquer une.
 *
 * Admin, lecture comprise, comme les clés d'API : seul un admin autorise (décision du 2026-10-03), et la liste dit
 * qui a ouvert l'espace à Claude. `autoriser` relit malgré tout le rôle en base : la garde de montage ne remplace
 * pas la règle de la fonction partagée avec la porte Google (`src/http/oauth.ts`).
 */
export interface OauthConsentementRouteDeps extends DepsAutoriser {
  store: Pick<PgOauthStore, 'creerAutorisation' | 'lister' | 'revoquer'>;
  /** `getSessionUser` donne l'adresse du compte de la session, `getByEmail` la relit dans `autoriser`. */
  comptes: Required<Pick<ComptesAuthDep, 'getByEmail' | 'getSessionUser'>>;
  /** `AUTH_SECRET`, pour relire la demande signée par `/oauth/authorize`. */
  secret: string;
}

export function registerOauthConsentement(app: FastifyInstance, deps: OauthConsentementRouteDeps, garde: Guard, base: string | null): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  /**
   * « Autoriser dans <espace> » pour une personne déjà connectée à la console : l'espace est celui de la session,
   * vérifié par l'étape d'espace. Sans `PUBLIC_API_URL`, aucune demande n'a pu être émise : 404, comme le reste de
   * l'OAuth.
   */
  app.post('/tenants/:tenantId/oauth/autoriser', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (base === null) return reply.code(404).send({ error: 'la connexion de Claude n’est pas configurée sur cette instance' });
    const lu = z.object({ demande: z.string().min(1) }).safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'demande requise' });
    const demande = await verifyDemandeOauth(lu.data.demande, deps.secret);
    if (!demande) return reply.code(400).send(DEMANDE_EXPIREE);
    const moi = req.auth ? await deps.comptes.getSessionUser(req.auth.userId) : null;
    if (!moi) return reply.code(403).send({ error: 'compte introuvable' });
    const r = await autoriser(deps, base, { email: moi.email }, tenant, demande);
    return r.ok ? reply.code(200).send({ adresse: r.adresse }) : reply.code(403).send({ error: r.erreur });
  });

  // Ni empreinte ni échéance de jeton : le client (nommé), la personne, la date, le dernier usage.
  app.get('/tenants/:tenantId/oauth/autorisations', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const autorisations = (await deps.store.lister(tenant)).map((a) => ({ ...a, client: clientConnu(a.clientId)?.nom ?? a.clientId }));
    return reply.code(200).send({ autorisations });
  });

  // L'appel suivant de Claude échoue en 401, et il redemande une connexion.
  app.delete('/tenants/:tenantId/oauth/autorisations/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id?: unknown };
    // Un identifiant mal formé ferait lever Postgres (`22P02`) : 404, comme une autorisation inconnue.
    if (!estUuid(id) || !(await deps.store.revoquer(tenant, id))) {
      return reply.code(404).send({ error: 'autorisation inconnue ou déjà révoquée' });
    }
    // Après le succès : une révocation refusée n'a rien révoqué.
    await journal(tenant, req, 'oauth.revoque', { kind: 'oauth_autorisation', id });
    return reply.code(200).send({ id, revoked: true });
  });
}
