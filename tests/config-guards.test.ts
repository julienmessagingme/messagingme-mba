import { describe, it, expect, afterEach } from 'vitest';
import { schema } from '../src/config';
import { poolOptions } from '../src/queue/pgboss';

/**
 * Gardes de démarrage (bloc 0 du PLAN.md). Ces règles BLOQUENT le boot : une erreur ici couche la production
 * au déploiement suivant. D'où des tests qui vérifient les deux sens, refus ET acceptation, et pas seulement
 * que « ça throw » : un fail-fast trop large est aussi dangereux qu'un fail-fast absent.
 *
 * On parse le SCHÉMA (et non `config`, figé à l'import) sur un environnement fabriqué.
 */

// Environnement de production MINIMAL et valide : le socle sur lequel on retire une variable à la fois.
const prodEnv = {
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  META_APP_SECRET: 'x'.repeat(32),
  AUTH_SECRET: 'y'.repeat(32),
};
const asProd = () => { process.env.NODE_ENV = 'production'; };
const errPaths = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }): string[] =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => String(i.path[0]));

// RESTAURER la valeur d'entrée, ne pas la réécrire en dur : `src/config` parse à l'IMPORT, donc un
// NODE_ENV=production qui fuiterait vers un autre fichier de test le ferait échouer au chargement de module,
// avec un message qui ne pointerait pas ici. Isolé par le pool `forks` de vitest aujourd'hui, pas demain.
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

describe('gardes de config en production', () => {
  it('environnement complet -> accepté (le fail-fast ne bloque pas une prod valide)', () => {
    asProd();
    expect(schema.safeParse(prodEnv).success).toBe(true);
  });

  it('DATABASE_URL vide -> refusé, en nommant la variable', () => {
    asProd();
    const r = schema.safeParse({ ...prodEnv, DATABASE_URL: '' });
    expect(r.success).toBe(false);
    expect(errPaths(r)).toContain('DATABASE_URL');
  });

  it('META_APP_SECRET vide -> refusé (sinon 100 % des webhooks Meta partent en 403 en silence)', () => {
    asProd();
    const r = schema.safeParse({ ...prodEnv, META_APP_SECRET: '' });
    expect(r.success).toBe(false);
    expect(errPaths(r)).toContain('META_APP_SECRET');
  });

  it('hors production -> les deux gardes sont inertes (ergonomie du dev, aucune variable requise)', () => {
    process.env.NODE_ENV = 'test';
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('les gardes préexistantes ne sont pas affaiblies : AUTH_SECRET faible reste refusé', () => {
    asProd();
    expect(schema.safeParse({ ...prodEnv, AUTH_SECRET: 'dev-insecure-change-me' }).success).toBe(false);
    expect(schema.safeParse({ ...prodEnv, AUTH_SECRET: 'court' }).success).toBe(false);
  });
});

describe('budget de connexions Postgres', () => {
  it('les plafonds sont BORNÉS par défaut : sans eux, pg et pg-boss prennent 10 chacun (40 sessions pour ~15)', () => {
    const c = schema.parse({});
    // On n'assène pas la constante exacte (ça ne testerait que la relecture du littéral) : ce qui compte est
    // qu'un plafond existe, qu'il soit petit devant les 15 du pooler, et que l'attente ne soit jamais illimitée.
    expect(c.DB_POOL_MAX).toBeGreaterThan(0);
    expect(c.DB_POOL_MAX).toBeLessThan(8);
    expect(c.PGBOSS_MAX).toBeGreaterThan(0);
    expect(c.PGBOSS_MAX).toBeLessThan(8);
    // 0 = attente ILLIMITÉE : c'est précisément ce qui figeait l'API sans trace. Ne doit jamais être le défaut.
    expect(c.DB_CONN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('surchargeables par l’environnement (coercition depuis des chaînes)', () => {
    const c = schema.parse({ DB_POOL_MAX: '5', PGBOSS_MAX: '4', DB_CONN_TIMEOUT_MS: '2000' });
    expect(c.DB_POOL_MAX).toBe(5);
    expect(c.PGBOSS_MAX).toBe(4);
    expect(c.DB_CONN_TIMEOUT_MS).toBe(2000);
  });
});

/**
 * `poolOptions` est le CÂBLAGE réel du plafond vers pg-boss. Le tester est ce qui distingue un vrai test d'un
 * faux témoin : sans ces cas, on pourrait revenir à `opts.max ? ...` ou retirer l'option sans rien casser.
 */
describe('poolOptions (options de pool passées à pg-boss)', () => {
  it('max: 0 est TRANSMIS : c’est une valeur explicite, pas une absence', () => {
    // Le piège que corrige `!== undefined` : `opts.max ? ...` rendrait `{}` ici, et pg-boss reprendrait
    // son défaut de 10 connexions alors que l'appelant en demandait zéro.
    expect(poolOptions({ max: 0 })).toEqual({ max: 0 });
  });

  it('une option ABSENTE reste absente (pg-boss applique son propre défaut, on ne le devine pas)', () => {
    expect(poolOptions({})).toEqual({});
    expect(poolOptions({ max: 2 })).toEqual({ max: 2 });
  });

  it('transmet les deux plafonds ensemble', () => {
    expect(poolOptions({ max: 2, connectionTimeoutMillis: 8000 })).toEqual({ max: 2, connectionTimeoutMillis: 8000 });
  });

  it('connectionTimeoutMillis: 0 est transmis tel quel (même piège que max)', () => {
    expect(poolOptions({ connectionTimeoutMillis: 0 })).toEqual({ connectionTimeoutMillis: 0 });
  });
});
