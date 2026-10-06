import { randomBytes } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import Fastify from 'fastify';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildServer, modulesDeRoutes } from '../src/server';
import type { ClasseDAcces, ServerDeps } from '../src/server';
import { signSession, signLienNumero } from '../src/auth/token';
import { FakeQueue } from './fake-queue';
import { gardesOuvertes } from './gardes';

/**
 * LE VRAI SERVEUR, SONDÉ ROUTE PAR ROUTE, SANS BASE (lot 3 de l'audit ponytail, 2026-09-26).
 *
 * 🔴 CE QUE CE HARNAIS APPORTE, ET QU'UN MODULE MONTÉ À LA MAIN N'APPORTE PAS. Les preuves d'isolation et de
 * rôle doivent regarder CE QUE `buildServer` MONTE : le vrai registre, les vraies gardes (`requireAuth`,
 * `makeRequireRole`), l'étape d'espace posée par `entree`. Un test qui recomposerait les gardes lui-même
 * resterait vert le jour où la production les change, puisque le faux bougerait avec le code.
 *
 * ⚠️ COMMENT ON VOIT DANS UN SERVEUR QU'ON NE CONSTRUIT PAS SOI-MÊME. `buildServer` crée son instance Fastify
 * en interne ; Fastify publie chaque instance créée sur le canal de diagnostic `fastify.initialization`, de
 * façon SYNCHRONE, avant qu'une seule route soit montée. On s'y abonne le temps de l'appel, et on pose un
 * `onRoute` qui garde les OPTIONS de chaque route (le même objet que l'étape d'espace complète ensuite, donc
 * sa chaîne FINALE se lit après `ready`) et qui enveloppe son handler pour savoir s'il a été ATTEINT.
 *
 * ⚠️ Les dépendances sont des bouchons qui COMPTENT leurs appels : « refusé avant tout travail » se mesure,
 * il ne se déduit pas d'un statut. Aucune n'est réelle, aucune ne touche une base ni le réseau.
 */

export interface RouteSondee {
  readonly methode: string;
  readonly chemin: string;
  /** Le module du registre qui la déclare, et sa classe d'accès, lus en montant ce module SEUL. */
  readonly module: string;
  readonly acces: ClasseDAcces;
  /** Les options de la route telles que Fastify les exécute, lues après `ready` (chaîne `preHandler` finale). */
  readonly options: Pick<RouteOptions, 'preHandler'>;
}

export interface ServeurSonde {
  readonly app: FastifyInstance;
  /** Toutes les routes du serveur construit, HEAD comprises, dans l'ordre de montage. */
  readonly routes: readonly RouteSondee[];
  /** Appels de dépendances depuis la dernière remise à zéro. */
  appelsDeps(): number;
  /** Le handler de cette route a-t-il été atteint depuis la dernière remise à zéro ? */
  atteint(r: RouteSondee): boolean;
  remettreAZero(): void;
  /** Une session signée avec le secret de ce serveur. */
  jeton(tenantId: string, role: 'admin' | 'manager' | 'agent'): Promise<string>;
  /** Le jeton du lien de connexion du numéro (lot 3c), signé avec le secret de ce serveur. */
  lien(tenantId: string): Promise<string>;
}

/** Un identifiant bien formé pour les paramètres autres que l'espace : un uuid mal formé rendrait 404 tôt. */
const UUID = '22222222-2222-4222-8222-222222222222';

/** L'adresse concrète d'une route : l'espace demandé, un uuid pour tout autre paramètre. */
export const adresse = (chemin: string, espace: string): string =>
  chemin.replace(':tenantId', espace).replace(/:[A-Za-z_]+(\.[a-z]+)?/g, UUID);

export async function serveurSonde(): Promise<ServeurSonde> {
  let appels = 0;
  const bouchon = (): unknown => new Proxy(function () {} as never, {
    get: (_c, p) => (typeof p === 'symbol' || p === 'then' ? undefined : bouchon()),
    apply: () => { appels += 1; return bouchon(); },
  });

  // Les clés que le registre LIT pour décider de monter ses entrées, comme `clesDuRegistre` de l'auto-attaque :
  // un module ajouté demain est monté ici sans que personne l'inscrive.
  const cles = new Set<string>();
  const espion = new Proxy({}, { get: (_c, p) => { if (typeof p === 'string') cles.add(p); return undefined; } });
  modulesDeRoutes(espion as ServerDeps, bouchon() as never);
  const secret = randomBytes(32).toString('hex');
  const deps: Record<string, unknown> = Object.fromEntries([...cles].map((c) => [c, bouchon()]));
  Object.assign(deps, {
    queue: new FakeQueue(),
    auth: { users: { findIdentity: async () => null }, secret },
    // Des centaines d'appels avec la même session : le plafond par utilisateur rendrait des 429.
    plafonds: { utilisateurParMinute: 0, couteuxParMinute: 0 },
  });

  // La classe de chaque route, prise à l'entrée du registre qui la déclare (module monté SEUL).
  const classe = new Map<string, { module: string; acces: ClasseDAcces }>();
  for (const m of modulesDeRoutes(deps as unknown as ServerDeps, bouchon() as never)) {
    const seul = Fastify({ logger: false });
    seul.addHook('onRoute', (r) => { classe.set(`${String(r.method)} ${r.url}`, { module: m.nom, acces: m.acces }); });
    m.monte(seul, gardesOuvertes);
    await seul.ready();
    await seul.close();
  }

  const routes: RouteSondee[] = [];
  const atteints = new Set<RouteOptions>();
  const surInstance = (message: unknown): void => {
    const { fastify } = message as { fastify: FastifyInstance };
    fastify.addHook('onRoute', (r) => {
      const methode = String(r.method);
      const c = classe.get(`${methode} ${r.url}`);
      // `/live` et `/health` ne viennent d'aucun module : ils n'ont ni espace ni classe.
      routes.push({ methode, chemin: r.url, module: c?.module ?? '(serveur)', acces: c?.acces ?? 'anonyme', options: r });
      const handler = r.handler;
      r.handler = function (this: FastifyInstance, ...a: Parameters<typeof handler>) {
        atteints.add(r);
        return handler.apply(this, a);
      };
    });
  };
  subscribe('fastify.initialization', surInstance);
  let app: FastifyInstance;
  try {
    app = buildServer(deps as unknown as ServerDeps);
  } finally {
    unsubscribe('fastify.initialization', surInstance);
  }
  await app.ready();

  return {
    app,
    routes,
    appelsDeps: () => appels,
    atteint: (r) => atteints.has(r.options as RouteOptions),
    remettreAZero: () => { appels = 0; atteints.clear(); },
    jeton: (tenantId, role) => signSession({ userId: '11111111-1111-4111-8111-111111111111', tenantId, role }, secret),
    lien: (tenantId) => signLienNumero({ userId: '11111111-1111-4111-8111-111111111111', tenantId, mode: 'fourni' }, secret),
  };
}
