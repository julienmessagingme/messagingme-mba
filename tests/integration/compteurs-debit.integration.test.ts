import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as dormir } from 'node:timers/promises';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCompteurDebit } from '../../src/db/debit.pg';
import { attendreQueLaPurgeAttende, verrouillerPuisPurger } from './aide-verrous-ordonnes';

/**
 * LES COMPTEURS DES PLAFONDS DE DÉBIT (migration 0186), CONTRE UNE VRAIE BASE.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : que DEUX copies de l'API qui comptent la même clé en même temps tiennent le
 * compte EXACT, et qu'aucune ne passe au-delà du plafond. C'est Postgres qui tranche (l'index unique sérialise les
 * écritures d'une ligne), pas notre code : le double en mémoire le simule, il ne le prouve pas. Et que le « toutes ou
 * aucune » tient en base, où il se fait en deux instructions (compter, puis rendre ce qu'une fenêtre non pleine avait
 * compté).
 *
 * DEUX POOLS, et pas un : c'est la seule façon d'imiter deux copies.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
const url = process.env.DATABASE_URL ?? '';
/** Une fenêtre d'un jour : trente appels ne tombent pas à cheval sur deux fenêtres (une fois sur quarante mille avec une heure). */
const JOUR_MS = 86_400_000;

describe.skipIf(!url)('les compteurs de débit, en base', () => {
  const PREFIXE = `itest-debit:${randomUUID()}:`;
  const cle = (nom: string): string => `${PREFIXE}${nom}`;
  let poolA: Pool;
  let poolB: Pool;
  let copieA: PgCompteurDebit;
  let copieB: PgCompteurDebit;

  beforeAll(() => {
    poolA = new Pool({ connectionString: url, ssl: pgSsl(), max: 5 });
    poolB = new Pool({ connectionString: url, ssl: pgSsl(), max: 5 });
    copieA = new PgCompteurDebit(poolA);
    copieB = new PgCompteurDebit(poolB);
  });

  afterAll(async () => {
    await poolA.query(`delete from compteurs_debit where starts_with(cle, $1)`, [PREFIXE]).catch(() => {});
    await poolA.end().catch(() => {});
    await poolB.end().catch(() => {});
  });

  const compteEnBase = async (c: string): Promise<number[]> =>
    (await poolA.query<{ n: number }>(`select n from compteurs_debit where cle = $1 order by fenetre`, [c])).rows.map((r) => r.n);

  it('🔴 la migration : quatre colonnes non nulles, la clé primaire sur (clé, fenêtre), aucun autre index', async () => {
    const colonnes = await poolA.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'compteurs_debit' order by ordinal_position`,
    );
    expect(colonnes.rows).toEqual([
      { column_name: 'cle', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'fenetre', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
      { column_name: 'n', data_type: 'integer', is_nullable: 'NO', column_default: null },
      { column_name: 'expire_le', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
    ]);
    const pk = await poolA.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conrelid = 'public.compteurs_debit'::regclass and c.contype = 'p'`,
    );
    expect(pk.rows.map((r) => r.def)).toEqual(['PRIMARY KEY (cle, fenetre)']);
    const index = await poolA.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'compteurs_debit'`,
    );
    expect(index.rows).toHaveLength(1);
  });

  it('🔴 LA COURSE : trente appels simultanés sur deux copies pour dix places, dix exactement passent', async () => {
    const k = cle('course');
    const verdicts = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      (i % 2 === 0 ? copieA : copieB).compter([{ cle: k, dureeMs: JOUR_MS, max: 10 }])));
    expect(verdicts.filter((v) => v.accepte)).toHaveLength(10);
    expect(await compteEnBase(k)).toEqual([10]);
    // Chaque accepté a vu un compte différent : de 1 à 10, aucun doublon (la ligne sérialise).
    expect(verdicts.filter((v) => v.accepte).map((v) => v.fenetres[0]!.compte).sort((a, b) => a! - b!))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('🔴 sans plafond, le compte est EXACT sous la concurrence (aucune écriture perdue)', async () => {
    const k = cle('exact');
    await Promise.all(Array.from({ length: 25 }, (_, i) =>
      (i % 2 === 0 ? copieA : copieB).compter([{ cle: k, dureeMs: JOUR_MS, max: null, pas: 3 }])));
    expect(await compteEnBase(k)).toEqual([75]);
  });

  it('🔴 toutes ou aucune, en base : la minute pleine refuse, et l’heure est RENDUE à ce qu’elle était', async () => {
    const [m, h] = [cle('tout-minute'), cle('tout-heure')];
    const demande = [{ cle: m, dureeMs: JOUR_MS, max: 1 }, { cle: h, dureeMs: 2 * JOUR_MS, max: 100 }];
    expect((await copieA.compter(demande)).accepte).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      const refus = await copieB.compter(demande);
      expect(refus.accepte).toBe(false);
      expect(refus.fenetres.map((f) => f.pleine)).toEqual([true, false]);
      expect(refus.fenetres[1]!.compte).toBe(1);
    }
    expect(await compteEnBase(h), 'cinq refus, et l’heure n’a rien gardé').toEqual([1]);
  });

  it('🔴 la fenêtre REPART : pleine jusqu’à sa fin, neuve ensuite (heure de la base)', async () => {
    const k = cle('repart');
    const deux = [{ cle: k, dureeMs: 2_000, max: 1 }];
    const premier = await copieA.compter(deux);
    expect(premier.accepte).toBe(true);
    expect((await copieB.compter(deux)).accepte).toBe(false);
    // L'attente annoncée est celle de la base, et elle ne dépasse pas la fenêtre.
    const attente = premier.fenetres[0]!.finMs - premier.maintenantMs;
    expect(attente).toBeGreaterThan(0);
    expect(attente).toBeLessThanOrEqual(2_000);
    await dormir(attente + 100);
    const neuf = await copieB.compter(deux);
    expect(neuf.accepte).toBe(true);
    expect(neuf.fenetres[0]!.compte).toBe(1);
  });

  it('🔴 une ORIGINE de fenêtre (le jour de Paris d’un quota) : la ligne commence à l’origine, et finit à son terme', async () => {
    // Le jour civil de Paris en cours : la base doit poser la fenêtre à son minuit, pas à minuit UTC.
    const { comptageQuota } = await import('../../src/api/quotas');
    const c = { ...comptageQuota('fiches', 'itest', 3, 2, Date.now()), cle: cle('quota-paris') };
    const v = await copieA.compter([c]);
    expect(v.accepte).toBe(true);
    expect(v.fenetres[0]!.finMs).toBe(c.origineMs! + c.dureeMs);
    const ligne = await poolA.query<{ debut: string }>(
      'select (extract(epoch from fenetre) * 1000)::bigint::text as debut from compteurs_debit where cle = $1', [c.cle],
    );
    expect(Number(ligne.rows[0]!.debut)).toBe(c.origineMs);
    // Tout ou rien : deux de plus dépasseraient trois, refusé, et la seconde copie voit le même compte.
    expect((await copieB.compter([c])).accepte).toBe(false);
    expect((await copieB.compter([{ ...c, pas: 1 }])).accepte).toBe(true);
  });

  it('🔴 un pas plus grand que le plafond ne s’écrit même pas', async () => {
    const k = cle('gros-pas');
    expect((await copieA.compter([{ cle: k, dureeMs: 60_000, max: 10, pas: 11 }])).accepte).toBe(false);
    expect(await compteEnBase(k)).toEqual([]);
  });

  it('`lister` rend les lignes d’un préfixe, les plus récentes d’abord, et rien d’autre', async () => {
    const [u1, u2] = [cle('lister|a'), cle('lister|b')];
    await copieA.compter([{ cle: u1, dureeMs: 60_000, max: null, pas: 4, garderMs: 7_200_000 }]);
    await copieB.compter([{ cle: u2, dureeMs: 60_000, max: null, garderMs: 7_200_000 }]);
    const lignes = await copieA.lister(cle('lister|'), 3_600_000);
    expect(lignes.map((l) => [l.cle, l.n]).sort()).toEqual([[u1, 4], [u2, 1]]);
    expect(await copieA.lister(`${PREFIXE}rien-de-tel`, 3_600_000)).toEqual([]);
  });

  it('🔴 la purge efface les lignes échues, et seulement elles', async () => {
    const [echue, vivante] = [cle('purge-echue'), cle('purge-vivante')];
    await poolA.query(
      `insert into compteurs_debit (cle, fenetre, n, expire_le) values
         ($1, now() - interval '2 minutes', 3, now() - interval '1 minute'),
         ($2, now(), 3, now() + interval '1 hour')`,
      [echue, vivante],
    );
    expect(await copieA.purgerEchues()).toBeGreaterThanOrEqual(1);
    const restees = await poolA.query<{ cle: string }>(`select cle from compteurs_debit where cle = any($1::text[])`, [[echue, vivante]]);
    expect(restees.rows.map((r) => r.cle)).toEqual([vivante]);
  });

  it('🔴 la purge verrouille dans l’ordre de la clé : elle ne s’interbloque pas avec qui tient une ligne échue', async () => {
    // Deux lignes échues, `b` écrite AVANT `a` (donc avant elle dans la table). Une autre session tient `a`, puis
    // demande `b`. Dans l'ordre physique, la purge aurait pris `b` puis attendu `a` : les deux s'attendraient, et
    // Postgres en tuerait une (40P01). Dans l'ordre de la clé, elle attend `a` sans rien tenir.
    const [a, b] = [cle('ordre-a'), cle('ordre-b')];
    for (const k of [b, a]) {
      await poolA.query(
        `insert into compteurs_debit (cle, fenetre, n, expire_le) values ($1, now() - interval '2 minutes', 1, now() - interval '1 minute')`,
        [k],
      );
    }
    const effacees = await verrouillerPuisPurger({
      pool: poolB,
      table: 'compteurs_debit',
      premiere: a,
      seconde: b,
      purger: () => copieA.purgerEchues(),
      attendre: () => attendreQueLaPurgeAttende(poolA, 'compteurs_debit'),
    });
    expect(effacees).toBeGreaterThanOrEqual(2);
  });
});
