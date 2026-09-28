import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
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

/**
 * LA PROLONGATION (relecture du lot A, 2026-09-28) : le bail d'une publication pouvait échoir entre deux gestes
 * (deux appels à Meta muets de 300 s), et une seconde publication partait alors en même temps. Prolonger ne vaut que
 * pour SA prise : c'est ce qui fait qu'une publication qui a perdu son verrou le sait.
 */
describe('prolonger une prise', () => {
  it('🔴 repousse l’échéance : une autre copie reste refusée au-delà du bail d’origine', async () => {
    const horloge = { t: 0 };
    const v = verrousEnMemoire(() => horloge.t);
    const prise = await v.prendre([['k', 1000]]);
    horloge.t = 900;
    expect(await v.prolonger(prise!, 1000)).toBe(true);
    horloge.t = 1500;
    expect(await v.prendre([['k', 1000]]), 'sans prolongation, la clé serait libre depuis 1000').toBeNull();
    horloge.t = 1900;
    expect(await v.prendre([['k', 1000]])).not.toBeNull();
  });

  it('🔴 refusée quand la clé a été REPRISE par une autre copie : son jeton ne la tient plus', async () => {
    const horloge = { t: 0 };
    const v = verrousEnMemoire(() => horloge.t);
    const echue = await v.prendre([['k', 1000]]);
    horloge.t = 1000;
    const reprise = await v.prendre([['k', 1000]]);
    expect(await v.prolonger(echue!, 1000)).toBe(false);
    // Et elle n'a pas touché à la prise de l'autre.
    horloge.t = 1999;
    expect(v.tenues()).toEqual(['k']);
    horloge.t = 2000;
    expect(v.tenues()).toEqual([]);
    expect(reprise).not.toBeNull();
  });

  it('une clé échue que personne n’a reprise se prolonge : son jeton prouve que personne ne l’a tenue', async () => {
    const horloge = { t: 0 };
    const v = verrousEnMemoire(() => horloge.t);
    const prise = await v.prendre([['k', 1000]]);
    horloge.t = 5000;
    expect(await v.prolonger(prise!, 1000)).toBe(true);
    expect(await v.prendre([['k', 1000]])).toBeNull();
  });

  it('refusée dès qu’UNE clé de la prise ne porte plus son jeton', async () => {
    const v = verrousEnMemoire();
    const prise = await v.prendre([['a', 60_000], ['b', 60_000]]);
    await v.relacher({ jeton: prise!.jeton, cles: ['b'] });
    expect(await v.prolonger(prise!, 60_000)).toBe(false);
  });
});

/**
 * 🔴 L'ORDRE DES VERROUS DE LIGNE, lu dans le SQL des deux adaptateurs (relecture du lot A, 2026-09-28). Une prise ou
 * un comptage écrivent leurs lignes dans l'ordre de la clé ; un `delete` ou un `update` nu les verrouille dans l'ordre
 * PHYSIQUE, et peut tenir la ligne qu'une prise attend pendant qu'il attend celle qu'elle tient. Postgres en tue alors
 * un, en ERREUR et non en refus. Chaque instruction qui touche plusieurs lignes sans les écrire dans l'ordre doit donc
 * les verrouiller d'abord, triées (`order by cle ... for update`). La preuve contre une vraie base est dans
 * `tests/integration/verrous-courts.integration.test.ts` et `compteurs-debit.integration.test.ts`.
 */
describe('les verrous de ligne se prennent dans l’ordre de la clé', () => {
  const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
  const requetes = (fichier: string): string[] =>
    [...lire(fichier).matchAll(/`([^`]*)`/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim())
      // Les requêtes, pas les mots cités entre accents graves dans un commentaire : elles nomment leur table.
      .filter((q) => /^(with|delete|update|insert)\b/i.test(q) && /\b(verrous_courts|compteurs_debit)\b/.test(q));

  it.each([
    ['../src/db/verrous-courts.pg.ts'],
    ['../src/db/debit.pg.ts'],
  ])('🔴 %s : chaque delete et chaque update verrouille ses lignes triées avant de les toucher', (fichier) => {
    // Un `insert ... on conflict do update` écrit dans l'ordre de son `order by` (cas suivant) : il n'est pas visé ici.
    const touchent = requetes(fichier).filter((q) => !/insert into/i.test(q) && /\b(delete from|update)\b/i.test(q));
    expect(touchent.length).toBeGreaterThan(0);
    for (const q of touchent) expect(q, q).toMatch(/order by (\w+\.)?cle(, (\w+\.)?fenetre)? for update/i);
  });

  it.each([
    ['../src/db/verrous-courts.pg.ts'],
    ['../src/db/debit.pg.ts'],
  ])('%s : chaque insert écrit ses lignes dans l’ordre de la clé', (fichier) => {
    const inserts = requetes(fichier).filter((q) => /insert into/i.test(q));
    expect(inserts.length).toBeGreaterThan(0);
    for (const q of inserts) expect(q, q).toMatch(/order by (c|cle) on conflict/i);
  });
});
