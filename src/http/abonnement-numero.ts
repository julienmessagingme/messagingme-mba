import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';
import type { EtatDeLEspace } from '../stripe/abonnements.pg';

/**
 * L'ÉTAT DE L'ABONNEMENT DU NUMÉRO POUR LA CONSOLE (lot 4, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`) :
 * le bandeau le lit sur chaque page. Tout MEMBRE de l'espace le lit, pas seulement un admin : la suspension coupe
 * aussi les réponses des agents de l'Inbox, qui doivent savoir pourquoi. Lecture seule, filtrée sur l'espace.
 */
export interface AbonnementNumeroRouteDeps {
  /** La SEULE lecture de l'état (`PgAbonnementsNumeroStore.etatDeLEspace`). */
  etat(tenantId: string): Promise<EtatDeLEspace | null>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function registerAbonnementNumero(app: FastifyInstance, deps: AbonnementNumeroRouteDeps, garde: Guard): void {
  app.get('/tenants/:tenantId/abonnement-numero', { preHandler: garde }, async (req, reply) => {
    const e = await deps.etat(espaceVerifie(req));
    return reply.code(200).send({
      etat: e?.etat ?? null,
      finPrevueLe: iso(e?.finPrevueLe),
      coupureLe: iso(e?.coupureLe),
      liberationLe: iso(e?.liberationLe),
      // Suspendu PARCE QUE fini : la console propose un nouveau paiement (le même numéro), sinon le portail.
      fini: e?.finiLe != null,
    });
  });
}
