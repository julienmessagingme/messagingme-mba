import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Db } from 'pg-boss';
import { PgBossQueue, type PoolPrete } from '../src/queue/pgboss';
import { BATTEMENT_SECONDES, RAFRAICHISSEMENT_BATTEMENT_SECONDES, SURVEILLANCE_FILES_SECONDES } from '../src/queue/names';

/**
 * LA FILE DE L'API EMPRUNTE LE POOL APPLICATIF (lot C du plan `2026-09-28-api-multi-instances.md`).
 *
 * Chaque copie de l'API ouvrait un pool pg-boss en mode SESSION pour seulement empiler : N copies retenaient
 * N x `PGBOSS_MAX` sessions d'un pooler plafonné. Elle prête désormais son pool (`db` de pg-boss), qui n'ouvre
 * alors rien à lui. Ces tests lisent la configuration RÉELLEMENT passée au constructeur de pg-boss (un faux
 * `PgBoss` la capture) : relire nos propres fonctions d'options ne dirait rien de ce que le constructeur en fait.
 */
const etat = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  echecDemarrage: null as Error | null,
  /** Ce que la file demande à pg-boss : réglages de file (`updateQueue`) et options de traitement (`work`). */
  reglages: [] as Array<[string, Record<string, unknown>]>,
  travaux: [] as Array<[string, Record<string, unknown>, (jobs: Array<{ data: unknown }>) => Promise<void>]>,
  reveils: [] as string[],
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    constructor(options: Record<string, unknown>) {
      etat.options.push(options);
    }
    on(): void {}
    async createQueue(): Promise<void> {}
    async updateQueue(nom: string, o: Record<string, unknown>): Promise<void> { etat.reglages.push([nom, o]); }
    async send(): Promise<string> { return 'id'; }
    async work(nom: string, o: Record<string, unknown>, h: (jobs: Array<{ data: unknown }>) => Promise<void>): Promise<string> {
      etat.travaux.push([nom, o, h]);
      return `boucle-${etat.travaux.length}`;
    }
    notifyWorker(id: string): void { etat.reveils.push(id); }
    async start(): Promise<void> {
      if (etat.echecDemarrage) throw etat.echecDemarrage;
    }
    async stop(): Promise<void> {}
  },
}));

beforeEach(() => {
  etat.options.length = 0;
  etat.echecDemarrage = null;
  etat.reglages.length = 0;
  etat.travaux.length = 0;
  etat.reveils.length = 0;
});

/** Un pool qui note chaque appel et rend un résultat reconnaissable. */
function faux(): PoolPrete & { appels: Array<[string, unknown[] | undefined]>; resultat: { rows: unknown[]; rowCount: number } } {
  const resultat = { rows: [{ n: 1 }], rowCount: 1 };
  const appels: Array<[string, unknown[] | undefined]> = [];
  return {
    appels,
    resultat,
    query: async (text, values) => {
      appels.push([text, values]);
      return resultat;
    },
  };
}

const derniere = (): Record<string, unknown> => {
  const o = etat.options.at(-1);
  if (!o) throw new Error('PgBoss jamais construit');
  return o;
};

describe('pool PRÊTÉ (l’API) : pg-boss n’ouvre rien et ne fait qu’empiler', () => {
  it('🔴 passe `db`, éteint migration, supervision, cron et écoute, et ne porte AUCUNE option de pool', () => {
    new PgBossQueue(faux(), 'pgboss');
    const o = derniere();
    // `toEqual` sur l'objet ENTIER : une clé de trop (`connectionString`, `max`, `ssl`) ferait ouvrir un pool, ou
    // serait ignorée en silence ; une clé de moins rallumerait le défaut de pg-boss (`migrate` et `supervise` à true).
    expect(o).toEqual({
      db: { executeSql: expect.any(Function) },
      schema: 'pgboss',
      migrate: false,
      useListenNotify: false,
      schedule: false,
      supervise: false,
    });
  });

  it('`executeSql` relaie le texte et les valeurs au pool, et rend son résultat tel quel (`{ rows }`)', async () => {
    const pool = faux();
    new PgBossQueue(pool, 'pgboss');
    const db = derniere()['db'] as Db;
    const r = await db.executeSql('select $1::int as n', [1]);
    expect(pool.appels).toEqual([['select $1::int as n', [1]]]);
    expect(r).toBe(pool.resultat);
    expect(r.rows).toEqual([{ n: 1 }]);
  });

  it('une requête SANS valeurs reste sans valeurs (la création de file est un bloc `BEGIN; ...; COMMIT;` à plusieurs instructions)', async () => {
    // `pg` n'accepte plusieurs instructions que par le protocole simple, sans paramètres : inventer un `[]` serait
    // aujourd'hui sans effet, mais ce n'est pas à nous de décider du protocole.
    const pool = faux();
    new PgBossQueue(pool, 'pgboss');
    await (derniere()['db'] as Db).executeSql('BEGIN; SELECT 1; COMMIT;');
    expect(pool.appels).toEqual([['BEGIN; SELECT 1; COMMIT;', undefined]]);
  });

  it('le type refuse toute option de pool, de maintenance ou d’écoute avec un prêt', () => {
    // Vérifié par `npm run typecheck`, qui lit ce fichier : si le prêt acceptait ces options, elles seraient
    // ignorées sans un mot, et la directive ci-dessous deviendrait inutilisée, donc une erreur.
    // @ts-expect-error une instance sur un pool prêté ne supervise pas
    new PgBossQueue(faux(), 'pgboss', { supervise: true });
    expect(derniere()['supervise']).toBe(false);
  });
});

describe('chaîne de connexion (le worker) : pg-boss garde SON pool', () => {
  it('🔴 ouvre son pool borné, écoute, et migre (aucun `migrate`, donc le défaut de pg-boss)', () => {
    new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss', {
      max: 2,
      connectionTimeoutMillis: 8000,
      flowIntervalSeconds: 60,
      ecouteNotifications: true,
    });
    const o = derniere();
    expect(o).toMatchObject({ connectionString: 'postgres://u:p@h:5432/db', schema: 'pgboss', max: 2, connectionTimeoutMillis: 8000, useListenNotify: true });
    expect(o).not.toHaveProperty('db');
    expect(o).not.toHaveProperty('migrate');
    expect(o).not.toHaveProperty('supervise');
  });

  it('🔴 surveille ses files toutes les SURVEILLANCE_FILES_SECONDES (orphelines, comptes, cache de la rafale)', () => {
    // Sans elle, le battement de cœur ne sert à rien : pg-boss ne contrôle une file qu'une fois par
    // `monitorIntervalSeconds` (60 s par défaut), lu dans sa source (`boss.js`, `#monitor`).
    new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss', { max: 2 });
    expect(derniere()).toMatchObject({
      superviseIntervalSeconds: SURVEILLANCE_FILES_SECONDES,
      monitorIntervalSeconds: SURVEILLANCE_FILES_SECONDES,
      queueCacheIntervalSeconds: SURVEILLANCE_FILES_SECONDES,
    });
  });
});

describe('🔴 le battement de cœur des tâches (banc des trente espaces, 2026-10-03)', () => {
  it('chaque file reçoit son battement par updateQueue (la file existe déjà en production), le réveil reste aux files notifiées', async () => {
    const q = new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss', { max: 2 });
    await q.enqueue('webhook', {});
    await q.enqueue('webhook-status', {});
    expect(etat.reglages).toContainEqual(['webhook', { heartbeatSeconds: BATTEMENT_SECONDES }]);
    expect(etat.reglages).toContainEqual(['webhook', { notify: true }]);
    expect(etat.reglages).toContainEqual(['webhook-status', { heartbeatSeconds: BATTEMENT_SECONDES }]);
    expect(etat.reglages).not.toContainEqual(['webhook-status', { notify: true }]);
  });

  it('🔴 la file des entrants : une boucle par registration, et chaque message traité réveille les trois', async () => {
    const q = new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss', { max: 2 });
    await q.work('webhook', async () => {}, { concurrency: 3, groupConcurrency: 1 });
    expect(etat.travaux).toHaveLength(3);
    for (const [nom, o] of etat.travaux) {
      expect(nom).toBe('webhook');
      // Le plafond par contact reste posé sur chaque registration : pg-boss le suit par nom de file.
      expect(o).toMatchObject({ localConcurrency: 1, localGroupConcurrency: 1, heartbeatRefreshSeconds: RAFRAICHISSEMENT_BATTEMENT_SECONDES, notifyPollingIntervalSeconds: 5 });
    }
    await etat.travaux[1]![2]([{ data: {} }]);
    expect(etat.reveils.sort()).toEqual(['boucle-1', 'boucle-2', 'boucle-3']);
  });

  it('un message en échec réveille aussi la file (il en est sorti), et l’échec remonte à pg-boss', async () => {
    const q = new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss', { max: 2 });
    await q.work('webhook', async () => { throw new Error('panne'); }, { concurrency: 3, groupConcurrency: 1 });
    await expect(etat.travaux[0]![2]([{ data: {} }])).rejects.toThrow('panne');
    expect(etat.reveils).toHaveLength(3);
  });

  it('une autre file garde UNE registration à sa concurrence, sans réveil par message', async () => {
    const q = new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss', { max: 2 });
    await q.work('agent-turn', async () => {}, { concurrency: 12, groupConcurrency: 1 });
    expect(etat.travaux).toHaveLength(1);
    expect(etat.travaux[0]![1]).toMatchObject({ localConcurrency: 12, heartbeatRefreshSeconds: RAFRAICHISSEMENT_BATTEMENT_SECONDES });
    await etat.travaux[0]![2]([{ data: {} }]);
    expect(etat.reveils).toEqual([]);
  });
});

describe('un schéma pas prêt : l’API échoue en disant QUI migre', () => {
  it('🔴 sur un prêt, l’erreur de version de pg-boss nomme le worker et garde sa cause', async () => {
    const cause = new Error('pg-boss database requires migrations');
    etat.echecDemarrage = cause;
    const err = await new PgBossQueue(faux(), 'pgboss').start().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/requires migrations.*c'est le WORKER qui le fait/);
    expect((err as Error).cause).toBe(cause);
  });

  it('un schéma absent aussi', async () => {
    etat.echecDemarrage = new Error('pg-boss is not installed');
    await expect(new PgBossQueue(faux(), 'pgboss').start()).rejects.toThrow(/not installed.*WORKER/);
  });

  it('toute autre panne remonte telle quelle, et le worker n’est jamais réécrit (c’est lui qui migre)', async () => {
    const panne = new Error('connect ECONNREFUSED');
    etat.echecDemarrage = panne;
    await expect(new PgBossQueue(faux(), 'pgboss').start()).rejects.toBe(panne);
    const version = new Error('pg-boss database requires migrations');
    etat.echecDemarrage = version;
    await expect(new PgBossQueue('postgres://u:p@h:5432/db', 'pgboss').start()).rejects.toBe(version);
  });
});

/**
 * Le câblage : une seule ligne par processus, lue dans le source sans ses commentaires. Sans ces deux gardes, les
 * tests ci-dessus prouveraient que le prêt marche, pas que l'API s'en sert, ni que le worker n'en a pas hérité.
 */
describe('câblage des deux processus', () => {
  const sansCommentaires = (f: string): string =>
    readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 l’API construit sa file sur SON pool applicatif, et nulle part sur une chaîne de connexion', () => {
    const src = sansCommentaires('../src/index.ts');
    expect(src).toMatch(/import \{ pool, mesureAttentePool \} from '\.\/db\/pool';/);
    expect(src).toMatch(/new PgBossQueue\(pool, config\.PGBOSS_SCHEMA\)/);
    expect(src.match(/new PgBossQueue\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/PGBOSS_MAX/);
  });

  it('🔴 le worker garde sa chaîne de connexion, son plafond et son écoute', () => {
    const src = sansCommentaires('../src/worker.ts');
    expect(src).toMatch(/new PgBossQueue\(config\.DATABASE_URL, config\.PGBOSS_SCHEMA, \{\s*max: config\.PGBOSS_MAX,/);
    expect(src).toMatch(/ecouteNotifications: true/);
    expect(src.match(/new PgBossQueue\(/g)).toHaveLength(1);
  });
});
