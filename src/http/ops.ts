import type { FastifyInstance } from 'fastify';
import { makeRequireOps } from '../auth/middleware';
import type { TenantOverviewRow, QueueLoadRow, GlobalDailyPoint } from '../ops/store.pg';
import type { WorkerHeartbeatRow } from '../ops/heartbeat-store.pg';

/**
 * Surface d'exploitation cross-tenant, LECTURE SEULE. Aucune méthode de mutation ici, par conception.
 *
 * ⚠️ La session d'observation (`/ops/observe`) est la seule chose qui s'en approche, et elle ne fait
 * qu'ÉMETTRE un jeton : elle n'écrit rien, et le jeton émis est lui-même incapable d'écrire.
 */
export interface OpsRouteDeps {
  /**
   * Ouvre une session d'OBSERVATION dans l'espace d'un client : rend un jeton de session en LECTURE SEULE.
   *
   * Optionnelle : absente, la route n'est pas montée. C'est volontaire : une instance qui n'a pas
   * explicitement câblé cette capacité ne doit pas l'exposer.
   */
  observerTenant?(tenantId: string): Promise<{ token: string; tenantName: string } | null>;
  getTenantOverview(): Promise<TenantOverviewRow[]>;
  getGlobalDaily(days: number): Promise<GlobalDailyPoint[]>;
  getQueueLoad(): Promise<QueueLoadRow[]>;
  /** Signal de vie du worker (item 4.9). OPTIONNEL : omis -> `worker: null` dans le payload, aucun site de
   *  construction cassé. Distinct des files (queues) : prouve que le PROCESS worker vit, pas que les files se vident. */
  getWorkerHeartbeat?(): Promise<WorkerHeartbeatRow | null>;
}

/**
 * Monte `/ops/overview` (GET seul). Protégé par `x-ops-token` == `opsToken` (constant-time). Si `opsToken`
 * est vide, la route répond 401 (surface désactivée par défaut). N'utilise jamais `req.auth` : c'est une
 * autorité SÉPARÉE du JWT tenant. Cross-tenant en LECTURE uniquement (aucune écriture n'est exposée).
 */
export function registerOps(app: FastifyInstance, deps: OpsRouteDeps, opsToken: string): void {
  const guard = { preHandler: makeRequireOps(opsToken) };

  app.get('/ops/overview', guard, async (_req, reply) => {
    const [tenants, daily, queues, worker] = await Promise.all([
      deps.getTenantOverview(),
      deps.getGlobalDaily(14),
      deps.getQueueLoad(),
      deps.getWorkerHeartbeat ? deps.getWorkerHeartbeat() : Promise.resolve(null),
    ]);
    return reply.code(200).send({ tenants, daily, queues, worker });
  });

  /**
   * Entrer dans l'espace d'un client pour VOIR ce qu'il voit.
   *
   * Protégée par le même jeton d'exploitation que le reste de `/ops`, qui est une autorité SÉPARÉE du JWT
   * client : personne ne peut s'ouvrir cette porte depuis un compte de la console.
   *
   * Le jeton rendu est en lecture seule (garde globale dans `makeRequireAuth`), il ne marque rien comme lu,
   * et il ne relit aucun état en base puisque son porteur n'a pas de compte dans cet espace.
   *
   * 🔴 Invisible côté CLIENT, journalisé côté EXPLOITATION : un accès à toutes les données de tous les
   * clients sans aucune trace nulle part est exactement ce qu'un audit de sécurité reproche en premier.
   */
  app.post('/ops/observe', guard, async (req, reply) => {
    if (!deps.observerTenant) return reply.code(503).send({ error: 'observation non disponible sur cette instance' });
    const tenantId = (req.body as { tenantId?: unknown } | null)?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      return reply.code(400).send({ error: 'tenantId requis' });
    }
    const r = await deps.observerTenant(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_observation', tenantId, tenantName: r.tenantName, at: new Date().toISOString() }));
    return reply.code(200).send({ token: r.token, tenantId, tenantName: r.tenantName });
  });
}
