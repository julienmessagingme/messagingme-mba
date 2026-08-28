import type { FastifyInstance } from 'fastify';
import { makeRequireOps } from '../auth/middleware';
import { estUuid } from './scope';
import type { TenantOverviewRow, QueueLoadRow, GlobalDailyPoint } from '../ops/store.pg';
import type { WorkerHeartbeatRow } from '../ops/heartbeat-store.pg';

/**
 * Surface d'exploitation cross-tenant, en LECTURE SEULE À UNE EXCEPTION PRÈS.
 *
 * ⚠️ La session d'observation (`/ops/observe`) ne fait qu'ÉMETTRE un jeton : elle n'écrit rien, et le jeton
 * émis est lui-même incapable d'écrire.
 *
 * 🔴 LE RECHARGEMENT DU SOLDE (`/ops/credits`) EST LA PREMIÈRE ÉCRITURE MÉTIER DE CETTE SURFACE, et c'est
 * assumé plutôt que glissé. Créditer le compte prépayé d'un client est un geste d'EXPLOITATION par nature :
 * il ne doit jamais être accessible depuis un compte de la console, sans quoi un client se rechargerait
 * lui-même. L'autorité séparée de `/ops` (jeton d'exploitation, jamais le JWT client) est exactement la
 * bonne, et le geste est journalisé comme l'observation. Aucune autre écriture ne doit rejoindre cette
 * surface sans la même justification.
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
  /**
   * Le solde prépayé d'un workspace, en micro-euros, avec son journal. `null` = espace inconnu.
   *
   * ⚠️ Distinguer « inconnu » de « zéro » n'est pas cosmétique : un opérateur qui lit 0 sur un identifiant mal
   * tapé croit voir un client à sec et le recharge, sur un espace qui n'existe pas.
   */
  soldeAgent?(tenantId: string): Promise<{ soldeMicroEur: number; mouvements: unknown[] } | null>;
  /** Recharge le solde. Rend le nouveau solde, ou `null` si l'espace est inconnu. Absente -> route non montée. */
  rechargerAgent?(tenantId: string, montantMicroEur: number, note: string): Promise<number | null>;
}

/**
 * Monte `/ops/overview` (GET), `/ops/observe` et `/ops/credits`. Protégé par `x-ops-token` == `opsToken`
 * (constant-time). Si `opsToken` est vide, tout répond 401 (surface désactivée par défaut). N'utilise jamais
 * `req.auth` : c'est une autorité SÉPARÉE du JWT tenant.
 */
/** Plafond d'une recharge : 1000 euros. Une virgule mal placée ne doit pas passer en silence, et il
 *  n'existe aucune route de débit pour la rattraper. */
const MAX_RECHARGE_MICRO_EUR = 1_000_000_000;

/** Longueur minimale de la note d'un rechargement. Trois caractères ne prouvent rien, mais ils empêchent le
 *  champ d'être rempli par un espace pour passer la garde. */
const MIN_NOTE = 3;

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
    // Même raison que sur `/ops/credits` : un identifiant mal formé fait LEVER Postgres (`22P02`) au lieu de
    // rendre zéro ligne, donc un 500 dont Cloudflare remplace le corps.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.observerTenant(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_observation', tenantId, tenantName: r.tenantName, at: new Date().toISOString() }));
    return reply.code(200).send({ token: r.token, tenantId, tenantName: r.tenantName });
  });

  /** Le solde prépayé d'un workspace et son journal. Lecture, comme le reste de la surface. */
  app.get('/ops/credits/:tenantId', guard, async (req, reply) => {
    if (!deps.soldeAgent) return reply.code(503).send({ error: 'solde agent non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    // Un identifiant mal formé part tel quel dans un `where id = $1` sur une colonne `uuid` : Postgres LÈVE
    // (`22P02`), donc 500, dont Cloudflare remplace le corps par sa page d'erreur. Une adresse tapée de
    // travers doit rendre 404.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.soldeAgent(tenantId);
    if (!r) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send(r);
  });

  /**
   * RECHARGER le solde prépayé d'un workspace.
   *
   * 🔴 La seule écriture métier de cette surface, et elle est ici parce qu'elle ne peut être nulle part
   * ailleurs : un client ne doit jamais pouvoir créditer son propre compte. Journalisée comme l'observation,
   * pour la même raison : un mouvement d'argent sans trace est ce qu'un audit reproche en premier.
   *
   * Le montant est en MICRO-EUROS, comme tous les compteurs du produit, et il est BORNÉ : une recharge de
   * plusieurs milliers d'euros passée par une virgule mal placée n'a aucune raison d'être acceptée en
   * silence, et se corrige mal (il n'y a pas de route de débit).
   *
   * La NOTE est obligatoire : le jeton d'exploitation est partagé, donc il n'y a aucune identité d'opérateur
   * à enregistrer, et cette phrase est la seule trace de qui a rechargé et pourquoi.
   */
  app.post('/ops/credits/:tenantId', guard, async (req, reply) => {
    if (!deps.rechargerAgent) return reply.code(503).send({ error: 'rechargement non disponible sur cette instance' });
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const corps = (req.body ?? {}) as { montantMicroEur?: unknown; note?: unknown };
    const montant = typeof corps.montantMicroEur === 'number' ? Math.round(corps.montantMicroEur) : NaN;
    if (!Number.isFinite(montant) || montant <= 0 || montant > MAX_RECHARGE_MICRO_EUR) {
      return reply.code(400).send({ error: `montantMicroEur requis, entre 1 et ${MAX_RECHARGE_MICRO_EUR} (soit 1000 euros)` });
    }
    const note = typeof corps.note === 'string' ? corps.note.trim().slice(0, 500) : '';
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui recharge, et pourquoi' });
    const solde = await deps.rechargerAgent(tenantId, montant, note);
    // Espace inconnu : sans cette garde, la clé étrangère lèverait et l'identifiant mal tapé rendrait un 500
    // remplacé par la page d'erreur de Cloudflare, sur la seule route qui écrit de l'argent.
    if (solde === null) return reply.code(404).send({ error: 'espace inconnu' });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ lvl: 'warn', msg: 'ops_recharge_agent', tenantId, montantMicroEur: montant, soldeMicroEur: solde, at: new Date().toISOString() }));
    return reply.code(200).send({ tenantId, soldeMicroEur: solde });
  });
}
