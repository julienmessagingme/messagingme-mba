import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { ApiKeyRow, PlafondCles } from '../auth/api-key-store.pg';
import { DROIT_RELAIS } from '../mba/cle-relais';
import { espaceVerifie, nonEmpty } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Les droits qu'une clé d'API peut porter (sous-ensemble non vide). `mcp:read` et `mcp:write` sont séparés des
 * autres : une clé donnée à un agent tiers pour lire l'Inbox n'emporte pas le droit d'écrire, et le serveur MCP
 * ne liste même pas les outils hors des scopes de la clé.
 */
export const VALID_API_SCOPES = ['contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write', 'conversations:read', 'templates:write', 'webhooks:write'] as const;

/**
 * Au plus dix clés actives par espace (décision de Julien, 2026-10-04). Chaque clé active est un secret confié à
 * quelqu'un : la borne limite les clés oubliées chez d'anciens intégrateurs, et révoquer en libère une place.
 * ⚠️ Ce n'est PAS un limiteur de débit : le plafond de l'API est déjà commun à toutes les clés de l'espace.
 * La clé du relais de l'agent de Meta n'y compte pas : la publication la pose, le client ne la crée pas, et elle
 * ne doit ni lui prendre une place ni être refusée par lui. Les clés déjà au-delà ne sont pas révoquées : seule
 * la création est refusée.
 * La parité avec l'écran est tenue par `tests/api-droits-parite.test.ts`.
 */
export const MAX_CLES_API_ACTIVES = 10;
const PLAFOND_CLES: PlafondCles = { max: MAX_CLES_API_ACTIVES, horsDroit: DROIT_RELAIS };

export interface ApiKeysRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Une clé d'API lit les contacts
   * sans compte : savoir qui l'a créée et quand est la seule trace de l'origine de l'accès.
   * 🔴 Le `detail` ne porte jamais la clé ni son empreinte, seulement les droits accordés (ce journal n'est pas purgé).
   */
  audit: AuditSink;
  cles: ClesApiDep;
}

export interface ClesApiDep {
  /** `null` = plafond atteint, rien n'est créé. La route n'a pas accès à une création sans plafond. */
  creerSousPlafond(tenantId: string, name: string, scopes: string[], plafond: PlafondCles): Promise<{ id: string; key: string } | null>;
  listByTenant(tenantId: string): Promise<ApiKeyRow[]>;
  revoke(tenantId: string, id: string): Promise<boolean>;
}

/**
 * CRUD des clés d'API (console, admin par la garde de montage `g.admin`). L'espace vient du JWT. La création rend
 * la clé en clair une seule fois ; la liste n'expose jamais le hash.
 */
export function registerApiKeys(app: FastifyInstance, deps: ApiKeysRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  app.post('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { name?: unknown; scopes?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes.map(String))] : [];
    if (scopes.length === 0) return reply.code(400).send({ error: 'au moins un scope requis' });
    const invalid = scopes.filter((s) => !(VALID_API_SCOPES as readonly string[]).includes(s));
    if (invalid.length > 0) return reply.code(400).send({ error: `scope(s) inconnu(s) : ${invalid.join(', ')}` });
    const creee = await deps.cles.creerSousPlafond(tenant, b.name.trim().slice(0, 100), scopes, PLAFOND_CLES);
    if (!creee) {
      return reply.code(409).send({
        error: `${MAX_CLES_API_ACTIVES} clés actives au maximum par espace (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre`,
      });
    }
    const { id, key } = creee;
    // `key` en clair, montrée une seule fois. L'audit porte les droits accordés, jamais la clé.
    await journal(tenant, req, 'cle_api.creee', { kind: 'api_key', id }, { scopes });
    return reply.code(201).send({ id, key, name: b.name.trim().slice(0, 100), scopes });
  });

  app.get('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ keys: await deps.cles.listByTenant(tenant) });
  });

  app.delete('/tenants/:tenantId/api-keys/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const ok = await deps.cles.revoke(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'clé inconnue ou déjà révoquée' });
    // Après le succès : une révocation refusée n'a rien révoqué.
    await journal(tenant, req, 'cle_api.revoquee', { kind: 'api_key', id });
    return reply.code(200).send({ id, revoked: true });
  });
}
