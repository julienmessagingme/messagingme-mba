import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgVerrousCourts } from '../../src/db/verrous-courts.pg';
import { clesAntiRejeu } from '../../src/mba/anti-rejeu';
import { BAIL_PUBLICATION_MS, clePublication } from '../../src/http/mba-publication';
import { attendreQueLaPurgeAttende, verrouillerPuisPurger } from './aide-verrous-ordonnes';

/**
 * LES VERROUS COURTS (migration 0185), CONTRE UNE VRAIE BASE.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : que DEUX copies de l'API qui prennent la même clé en même temps n'en
 * laissent passer qu'une. C'est Postgres qui tranche (l'index unique fait attendre la seconde insertion, qui relit
 * ensuite la ligne), pas notre code : le double en mémoire le simule, il ne le prouve pas.
 *
 * DEUX POOLS, et pas un : c'est la seule façon d'imiter deux copies. Sur un seul pool, deux requêtes pourraient se
 * sérialiser pour une mauvaise raison.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('les verrous courts, en base', () => {
  const PREFIXE = `itest-verrous:${randomUUID()}:`;
  const cle = (nom: string): string => `${PREFIXE}${nom}`;
  let poolA: Pool;
  let poolB: Pool;
  let copieA: PgVerrousCourts;
  let copieB: PgVerrousCourts;

  beforeAll(() => {
    poolA = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    poolB = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    copieA = new PgVerrousCourts(poolA);
    copieB = new PgVerrousCourts(poolB);
  });

  afterAll(async () => {
    await poolA.query(`delete from verrous_courts where cle like $1 || '%'`, [PREFIXE]).catch(() => {});
    await poolA.query(`delete from verrous_courts where cle like 'mba-%' || $1 || '%'`, [PREFIXE]).catch(() => {});
    await poolA.end().catch(() => {});
    await poolB.end().catch(() => {});
  });

  /** Fait échoir une clé tout de suite, sans dormir : l'échéance est une colonne, pas une minuterie. */
  const faireEchoir = (c: string) => poolA.query(`update verrous_courts set expire_le = now() - interval '1 second' where cle = $1`, [c]);

  it('🔴 la migration : trois colonnes non nulles, et la clé primaire sur la clé', async () => {
    const colonnes = await poolA.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'verrous_courts' order by ordinal_position`,
    );
    expect(colonnes.rows).toEqual([
      { column_name: 'cle', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'jeton', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'expire_le', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
    ]);
    const pk = await poolA.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conrelid = 'public.verrous_courts'::regclass and c.contype = 'p'`,
    );
    expect(pk.rows.map((r) => r.def)).toEqual(['PRIMARY KEY (cle)']);
    // Aucun autre index, délibérément (la migration dit pourquoi).
    const index = await poolA.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'verrous_courts'`,
    );
    expect(index.rows).toHaveLength(1);
  });

  it('🔴 prise par une copie, refusée à l’autre tant que l’échéance court, reprise à l’échéance', async () => {
    const k = cle('echeance');
    const premiere = await copieA.prendre([[k, 60_000]]);
    expect(premiere).not.toBeNull();
    expect(await copieB.prendre([[k, 60_000]])).toBeNull();
    await faireEchoir(k);
    const reprise = await copieB.prendre([[k, 60_000]]);
    expect(reprise).not.toBeNull();
    expect(reprise!.jeton).not.toBe(premiere!.jeton);
  });

  it('🔴 un relâchement avec un AUTRE jeton est sans effet ; le bon jeton libère', async () => {
    const k = cle('jeton');
    const echue = await copieA.prendre([[k, 60_000]]);
    await faireEchoir(k);
    const reprise = await copieB.prendre([[k, 60_000]]);
    await copieA.relacher(echue!);
    expect(await copieA.prendre([[k, 60_000]]), 'la prise échue a effacé celle qui l’avait reprise').toBeNull();
    await copieB.relacher(reprise!);
    expect(await copieA.prendre([[k, 60_000]])).not.toBeNull();
  });

  it('🔴 toutes ou aucune : une clé tenue fait refuser la prise, et les autres ne restent PAS prises', async () => {
    const [a, b, c] = [cle('tout-a'), cle('tout-b'), cle('tout-c')];
    await copieA.prendre([[b, 60_000]]);
    expect(await copieB.prendre([[a, 60_000], [b, 60_000], [c, 60_000]])).toBeNull();
    const restees = await poolA.query<{ cle: string }>(`select cle from verrous_courts where cle = any($1::text[])`, [[a, b, c]]);
    expect(restees.rows.map((r) => r.cle)).toEqual([b]);
  });

  it('🔴 LA COURSE : des prises simultanées de la même clé sur deux copies, une seule gagne', async () => {
    const k = cle('course');
    const prises = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 === 0 ? copieA : copieB).prendre([[k, 60_000]])));
    expect(prises.filter((p) => p !== null)).toHaveLength(1);
  });

  it('🔴 des prises croisées de plusieurs clés ne s’interbloquent pas, et une seule gagne', async () => {
    // Écrites dans des ordres opposés : sans l'ordre imposé à l'écriture, deux transactions se tiendraient
    // chacune la clé que l'autre attend, et Postgres en tuerait une (deadlock), en erreur et non en refus.
    const [x, y] = [cle('croise-x'), cle('croise-y')];
    const prises = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 === 0 ? copieA.prendre([[x, 60_000], [y, 60_000]]) : copieB.prendre([[y, 60_000], [x, 60_000]]))));
    expect(prises.filter((p) => p !== null)).toHaveLength(1);
  });

  it('🔴 l’anti-rejeu : le rappel servi par l’autre copie est refusé, et le plancher tient seul', async () => {
    const t = `${PREFIXE}espace`;
    expect(await copieA.prendre(clesAntiRejeu(t, '33612345678', 'o1', 'm1'))).not.toBeNull();
    expect(await copieB.prendre(clesAntiRejeu(t, '33612345678', 'o1', 'm1'))).toBeNull();
    // Un nouveau message, sous le plancher : toujours refusé (la clé du plancher est commune).
    expect(await copieB.prendre(clesAntiRejeu(t, '33612345678', 'o1', 'm2'))).toBeNull();
    // Les durées sont celles de l'anti-rejeu, écrites par la base : 30 s pour le plancher, 2 min pour la demande.
    const [plancher, demande] = clesAntiRejeu(t, '33612345678', 'o1', 'm1').map(([c]) => c);
    const ecarts = await poolA.query<{ cle: string; secondes: number }>(
      `select cle, extract(epoch from expire_le - now())::float8 as secondes from verrous_courts where cle = any($1::text[])`,
      [[plancher, demande]],
    );
    const parCle = new Map(ecarts.rows.map((r) => [r.cle, r.secondes]));
    expect(parCle.get(plancher!)).toBeGreaterThan(25);
    expect(parCle.get(plancher!)).toBeLessThanOrEqual(30);
    expect(parCle.get(demande!)).toBeGreaterThan(115);
    expect(parCle.get(demande!)).toBeLessThanOrEqual(120);
  });

  it('🔴 la publication : une seule par espace, quelle que soit la copie', async () => {
    const t = `${PREFIXE}espace-pub`;
    const prise = await copieA.prendre([[clePublication(t), BAIL_PUBLICATION_MS]]);
    expect(prise).not.toBeNull();
    expect(await copieB.prendre([[clePublication(t), BAIL_PUBLICATION_MS]])).toBeNull();
    await copieA.relacher(prise!);
    expect(await copieB.prendre([[clePublication(t), BAIL_PUBLICATION_MS]])).not.toBeNull();
  });

  it('🔴 prolonger : repousse l’échéance de SA prise, et échoue sur une clé reprise par l’autre copie', async () => {
    const k = cle('prolonger');
    const prise = await copieA.prendre([[k, 60_000]]);
    expect(await copieA.prolonger(prise!, 3_600_000)).toBe(true);
    const ecart = await poolA.query<{ secondes: number }>(
      `select extract(epoch from expire_le - now())::float8 as secondes from verrous_courts where cle = $1`, [k],
    );
    expect(ecart.rows[0]!.secondes).toBeGreaterThan(3_500);
    await faireEchoir(k);
    const reprise = await copieB.prendre([[k, 60_000]]);
    expect(reprise).not.toBeNull();
    expect(await copieA.prolonger(prise!, 3_600_000), 'le jeton de A ne tient plus la clé').toBe(false);
    // Et la prise de B est intacte : son échéance est la sienne, pas celle que A demandait.
    const apres = await poolA.query<{ jeton: string; secondes: number }>(
      `select jeton, extract(epoch from expire_le - now())::float8 as secondes from verrous_courts where cle = $1`, [k],
    );
    expect(apres.rows[0]).toMatchObject({ jeton: reprise!.jeton });
    expect(apres.rows[0]!.secondes).toBeLessThanOrEqual(60);
  });

  it('🔴 la purge verrouille dans l’ordre de la clé : elle ne s’interbloque pas avec qui tient une clé échue', async () => {
    // `b` prise AVANT `a` (donc rangée avant elle dans la table), les deux déjà échues. Une autre session tient `a`,
    // puis demande `b` : dans l'ordre physique, la purge aurait pris `b` puis attendu `a`, et Postgres aurait tué
    // l'une des deux (40P01). Relecture du lot A.
    const [a, b] = [cle('ordre-a'), cle('ordre-b')];
    // Une milliseconde de bail : échues dès leur écriture, sans `update` qui déplacerait les lignes dans la table.
    await copieA.prendre([[b, 1]]);
    await copieA.prendre([[a, 1]]);
    const effacees = await verrouillerPuisPurger({
      pool: poolB,
      table: 'verrous_courts',
      premiere: a,
      seconde: b,
      purger: () => copieA.purgerEchues(),
      attendre: () => attendreQueLaPurgeAttende(poolA, 'verrous_courts'),
    });
    expect(effacees).toBeGreaterThanOrEqual(2);
  });

  it('la purge efface les clés échues, et seulement elles', async () => {
    const [echue, vivante] = [cle('purge-echue'), cle('purge-vivante')];
    await copieA.prendre([[echue, 60_000], [vivante, 60_000]]);
    await faireEchoir(echue);
    expect(await copieA.purgerEchues()).toBeGreaterThanOrEqual(1);
    const restees = await poolA.query<{ cle: string }>(`select cle from verrous_courts where cle = any($1::text[])`, [[echue, vivante]]);
    expect(restees.rows.map((r) => r.cle)).toEqual([vivante]);
  });
});
