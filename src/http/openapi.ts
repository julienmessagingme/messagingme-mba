import type { FastifyInstance } from 'fastify';

/** Ce que la route sert : le contrat, construit par `contratOpenapi` (`src/api/openapi`), injecté par le câblage. */
export interface OpenapiRouteDeps {
  contrat(base: string): Record<string, unknown>;
}

/**
 * `GET /openapi.json` : le contrat OpenAPI 3.1 de l'API publique (lot 16), classe `anonyme` : c'est un document public,
 * sans donnée d'espace. Construit une fois par processus, au premier appel : il ne dépend que du code déployé et de
 * l'adresse publique de l'API (`null` sans `PUBLIC_API_URL` : le serveur annoncé est alors relatif, `/`).
 *
 * `access-control-allow-origin: *` sur CETTE route seule : un éditeur OpenAPI ouvert dans un navigateur doit pouvoir le
 * lire, et il ne porte ni cookie ni jeton. Le CORS du reste de l'API reste en liste blanche.
 */
export function registerOpenapi(app: FastifyInstance, deps: OpenapiRouteDeps, base: string | null): void {
  let document: string | null = null;
  app.get('/openapi.json', async (_req, reply) => {
    document ??= JSON.stringify(deps.contrat(base ?? '/'));
    return reply
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'public, max-age=300')
      .type('application/json; charset=utf-8')
      .send(document);
  });
}
