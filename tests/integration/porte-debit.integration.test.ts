import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { arbitreDeDebitPartage, depsPorteDebitPg, type DepsPorteDebit } from '../../src/meta/arbitre-debit-partage';
import { arbitreDeDebit } from '../../src/meta/arbitre-debit';

const url = process.env.DATABASE_URL ?? '';

/**
 * Le budget d'envoi d'un numéro, PARTAGÉ (migration 0102).
 *
 * 🔴 EN INTÉGRATION, et c'est le seul endroit où ça se prouve. Un test unitaire vérifie que l'attente rendue
 * par la base est bien observée ; il ne peut pas vérifier que DEUX process qui réservent en même temps se
 * partagent réellement un budget, parce que c'est POSTGRES qui l'assure, par le verrou de ligne de
 * l'instruction de réservation. Le trou qu'on ferme est précisément celui-là : l'API et le worker sont deux
 * conteneurs et avaient chacun leur compteur en mémoire.
 *
 * DEUX POOLS séparés dans ce test, et pas un seul : c'est la seule façon d'imiter deux process. Un pool
 * unique aurait pu réussir pour une mauvaise raison (deux requêtes sur la même connexion se sérialisent de
 * toute façon).
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('porte de débit partagée entre process (Postgres)', () => {
  const NUMERO = 'pn-itest-debit';
  let poolApi: Pool;
  let poolWorker: Pool;

  beforeAll(async () => {
    poolApi = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    poolWorker = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    await poolApi.query('delete from phone_rate_gate where phone_number_id = $1', [NUMERO]);
  });

  afterAll(async () => {
    await poolApi.query('delete from phone_rate_gate where phone_number_id = $1', [NUMERO]).catch(() => {});
    await poolApi.end().catch(() => {});
    await poolWorker.end().catch(() => {});
  });

  /**
   * Les deps réelles, mais le sommeil est CAPTURÉ au lieu d'être subi : on lit ainsi l'attente que la base a
   * calculée, sans que la suite de tests passe une minute à dormir pour de vrai.
   */
  function depsMesurees(pool: Pool): { deps: DepsPorteDebit; attentes: number[] } {
    const attentes: number[] = [];
    return { deps: { ...depsPorteDebitPg(pool), dormir: async (ms) => { attentes.push(ms); } }, attentes };
  }

  it('🔴 deux « process » distincts se partagent UN SEUL budget pour le même numéro', async () => {
    // 60/min -> un envoi par seconde. Six réservations alternées entre les deux pools doivent donc s'étaler
    // sur cinq secondes : la première part tout de suite, les cinq suivantes attendent 1, 2, 3, 4 puis 5
    // secondes. AVANT cette migration, chaque process comptait pour lui et les attentes auraient été
    // 0, 0, 1, 1, 2, 2 : le numéro recevait le DOUBLE du débit configuré.
    const cotéApi = depsMesurees(poolApi);
    const cotéWorker = depsMesurees(poolWorker);
    const api = arbitreDeDebitPartage(arbitreDeDebit(60), 60, cotéApi.deps);
    const worker = arbitreDeDebitPartage(arbitreDeDebit(60), 60, cotéWorker.deps);

    const attentes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const cote = i % 2 === 0 ? { a: api, m: cotéApi } : { a: worker, m: cotéWorker };
      const avant = cote.m.attentes.length;
      await cote.a.pour(NUMERO).acquire();
      // Aucune attente enregistrée = la porte n'a pas dormi, donc l'attente valait zéro.
      attentes.push(cote.m.attentes.length > avant ? cote.m.attentes[cote.m.attentes.length - 1]! : 0);
    }

    // La première réservation ne doit RIEN attendre.
    expect(attentes[0]).toBe(0);
    // Et chaque suivante attend environ une seconde de plus que la précédente, quel que soit le process.
    for (let i = 1; i < attentes.length; i += 1) {
      const attendu = i * 1000;
      // Tolérance large : la base met quelques millisecondes à répondre et la CI est partagée. Ce qui compte
      // est la PROGRESSION d'un process à l'autre, pas la précision.
      expect(attentes[i], `réservation ${i} (attentes : ${attentes.join(', ')})`).toBeGreaterThan(attendu - 400);
      expect(attentes[i], `réservation ${i} (attentes : ${attentes.join(', ')})`).toBeLessThan(attendu + 400);
    }
  });

  it('🔴 le budget est PAR NUMÉRO : un second numéro ne paie pas l’attente du premier', async () => {
    // Sinon un client bavard freinerait le numéro d'un autre client, ce qui serait pire que le trou qu'on
    // vient de fermer.
    const autre = 'pn-itest-debit-2';
    await poolApi.query('delete from phone_rate_gate where phone_number_id = $1', [autre]);
    try {
      const { deps } = depsMesurees(poolApi);
      await deps.reserver(NUMERO, 1000);
      await deps.reserver(NUMERO, 1000);
      expect(await deps.reserver(autre, 1000)).toBe(0);
    } finally {
      await poolApi.query('delete from phone_rate_gate where phone_number_id = $1', [autre]).catch(() => {});
    }
  });

  it('un numéro INACTIF repart de maintenant, il n’accumule pas de crédit', async () => {
    // Une ligne dont l'instant est loin dans le passé ne doit pas donner droit à une rafale : le calcul
    // repart de `greatest(valeur, now())`. Sans ce `greatest`, un numéro qui n'a rien envoyé depuis une
    // heure aurait pu envoyer 4800 messages d'affilée sans attendre.
    await poolApi.query(
      `insert into phone_rate_gate (phone_number_id, next_allowed_at) values ($1, now() - interval '1 hour')
       on conflict (phone_number_id) do update set next_allowed_at = now() - interval '1 hour'`,
      [NUMERO],
    );
    const { deps } = depsMesurees(poolApi);
    expect(await deps.reserver(NUMERO, 1000)).toBe(0);
    // Et le SUIVANT attend bien son tour : la réservation est repartie de maintenant, pas d'il y a une heure.
    expect(await deps.reserver(NUMERO, 1000)).toBeGreaterThan(600);
  });
});
