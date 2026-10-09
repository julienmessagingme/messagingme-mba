import { construireDocument } from './document';
import { EVENEMENTS_OPENAPI, enveloppeEvenement } from './evenements';
import { ROUTES_V1 } from './registre';

/** Le contrat OpenAPI de l'API publique, servi par `GET /openapi.json`. `base` : l'adresse publique de l'API. */
export function contratOpenapi(base: string): Record<string, unknown> {
  return construireDocument({ base, routes: ROUTES_V1, evenements: EVENEMENTS_OPENAPI, enveloppe: enveloppeEvenement });
}
