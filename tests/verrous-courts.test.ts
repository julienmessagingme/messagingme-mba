import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { normaliserCles } from '../src/db/verrous-courts';
import { PgVerrousCourts } from '../src/db/verrous-courts.pg';
import { verrousEnMemoire } from './verrous';

/**
 * LES VERROUS COURTS (`src/db/verrous-courts.ts`), CONTRE LE DOUBLE EN MÉMOIRE.
 *
 * 🔴 Ce que ce fichier protège : les trois règles qui font d'une clé un verrou et pas un drapeau (toutes les clés ou
 * aucune, reprise à l'échéance, relâche par le seul jeton de la prise). Le double les tient aux mêmes conditions que
 * l'adaptateur Postgres, que `tests/integration/verrous-courts.integration.test.ts` éprouve contre une vraie base
 * (dont la course entre deux prises simultanées, que seul Postgres tranche).
 */
describe('une clé', () => {
  it('🔴 prise, puis refusée tant que son échéance court, puis reprise à l’échéance', async () => {
    const horloge = { t: 0 };
    const v = verrousEnMemoire(() => horloge.t);
    const premiere = await v.prendre([['k', 1000]]);
    expect(premiere).not.toBeNull();
    expect(await v.prendre([['k', 1000]])).toBeNull();
    horloge.t = 999;
    expect(await v.prendre([['k', 1000]])).toBeNull();
    horloge.t = 1000;
    const reprise = await v.prendre([['k', 1000]]);
    expect(reprise).not.toBeNull();
    expect(reprise!.jeton).not.toBe(premiere!.jeton);
  });

  it('🔴 relâchée par SA prise, elle se reprend tout de suite', async () => {
    const v = verrousEnMemoire();
    const prise = await v.prendre([['k', 60_000]]);
    await v.relacher(prise!);
    expect(await v.prendre([['k', 60_000]])).not.toBeNull();
  });

  it('🔴 un relâchement avec un AUTRE jeton est sans effet : la prise de la copie qui a repris la clé tient', async () => {
    const horloge = { t: 0 };
    const v = verrousEnMemoire(() => horloge.t);
    const echue = await v.prendre([['k', 1000]]);
    horloge.t = 1000;
    const reprise = await v.prendre([['k', 1000]]);
    await v.relacher(echue!);
    expect(v.tenues()).toEqual(['k']);
    expect(await v.prendre([['k', 1000]])).toBeNull();
    await v.relacher(reprise!);
    expect(v.tenues()).toEqual([]);
  });

  it('deux clés différentes ne se gênent pas', async () => {
    const v = verrousEnMemoire();
    expect(await v.prendre([['a', 1000]])).not.toBeNull();
    expect(await v.prendre([['b', 1000]])).not.toBeNull();
  });

  it('🔴 de prises SIMULTANÉES de la même clé, une seule réussit', async () => {
    const v = verrousEnMemoire();
    const prises = await Promise.all(Array.from({ length: 5 }, () => v.prendre([['k', 1000]])));
    expect(prises.filter((p) => p !== null)).toHaveLength(1);
  });
});

describe('plusieurs clés', () => {
  it('🔴 toutes ou aucune : une seule clé tenue fait refuser la prise, et RIEN n’est retenu des autres', async () => {
    const v = verrousEnMemoire();
    await v.prendre([['b', 60_000]]);
    expect(await v.prendre([['a', 60_000], ['b', 60_000], ['c', 60_000]])).toBeNull();
    expect(v.tenues()).toEqual(['b']);
    expect(await v.prendre([['a', 60_000]])).not.toBeNull();
    expect(await v.prendre([['c', 60_000]])).not.toBeNull();
  });

  it('chaque clé a sa durée : la plus courte se libère seule', async () => {
    const horloge = { t: 0 };
    const v = verrousEnMemoire(() => horloge.t);
    await v.prendre([['plancher', 30_000], ['demande', 120_000]]);
    horloge.t = 30_000;
    expect(v.tenues()).toEqual(['demande']);
    expect(await v.prendre([['plancher', 30_000]])).not.toBeNull();
  });

  it('une prise relâche toutes ses clés, et seulement les siennes', async () => {
    const v = verrousEnMemoire();
    const a = await v.prendre([['a', 60_000], ['b', 60_000]]);
    await v.prendre([['c', 60_000]]);
    await v.relacher(a!);
    expect(v.tenues()).toEqual(['c']);
  });
});

describe('les clés demandées', () => {
  it('sans doublon (la plus longue durée gagne), triées : deux prises écrivent dans le même ordre', () => {
    expect(normaliserCles([['b', 10], ['a', 5], ['b', 30]])).toEqual([['a', 5], ['b', 30]]);
  });

  it('une liste vide, une clé vide ou une durée non positive est une faute d’appel, jamais une prise', () => {
    expect(() => normaliserCles([])).toThrow();
    expect(() => normaliserCles([['', 10]])).toThrow();
    expect(() => normaliserCles([['k', 0]])).toThrow();
    expect(() => normaliserCles([['k', Number.NaN]])).toThrow();
  });
});

/**
 * L'adaptateur Postgres, contre un faux pool : la base décide quelles clés sont libres (ici, le nombre de lignes
 * rendues) ; ce que ce bloc vérifie, c'est ce que le CODE fait de sa réponse. Une prise à moitié doit être ANNULÉE,
 * pas validée : sans le `rollback`, les clés libres resteraient prises pour rien, et un geste jamais parti serait
 * refusé pendant toute leur échéance.
 */
describe('l’adaptateur Postgres, face à la réponse de la base', () => {
  function faussePool(lignesRendues: number) {
    const ordres: string[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        const s = sql.trim().split(/\s+/)[0]!.toLowerCase();
        ordres.push(s);
        if (s === 'insert') return { rowCount: lignesRendues, rows: [], params };
        return { rowCount: 0, rows: [] };
      },
      release: () => { ordres.push('release'); },
    };
    const pool = { connect: async () => client, query: client.query } as unknown as Pool;
    return { pool, ordres };
  }

  it('🔴 toutes les clés rendues : la prise est VALIDÉE et rend son jeton', async () => {
    const { pool, ordres } = faussePool(2);
    const prise = await new PgVerrousCourts(pool).prendre([['a', 1000], ['b', 1000]]);
    expect(prise).toMatchObject({ cles: ['a', 'b'] });
    expect(ordres).toEqual(['begin', 'insert', 'commit', 'release']);
  });

  it('🔴 une clé manque : la prise est ANNULÉE et rend null', async () => {
    const { pool, ordres } = faussePool(1);
    expect(await new PgVerrousCourts(pool).prendre([['a', 1000], ['b', 1000]])).toBeNull();
    expect(ordres).toEqual(['begin', 'insert', 'rollback', 'release']);
  });
});
