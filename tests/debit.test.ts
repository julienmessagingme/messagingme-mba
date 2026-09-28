import { describe, it, expect } from 'vitest';
import { memoireDesPleines, normaliserComptages, restantDe, type CompteurDebit } from '../src/db/debit';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';

/**
 * LE COMPTEUR DE DÉBIT (`src/db/debit.ts`), CONTRE SON DOUBLE EN MÉMOIRE.
 *
 * 🔴 Ce que ce fichier protège : les trois règles qui font d'un compteur un plafond tenu au total (fenêtre fixe
 * commune, toutes les fenêtres ou aucune, un appel compté seulement s'il tient), et la mémoire des fenêtres pleines
 * qu'une copie pose devant la base. Le double tient les règles aux mêmes conditions que l'adaptateur Postgres, que
 * `tests/integration/compteurs-debit.integration.test.ts` éprouve contre une vraie base (dont la course entre deux
 * copies, que seul Postgres tranche).
 */
function horloge(depart = 1_800_000_000_000) {
  const h = { t: depart };
  return { h, maintenant: () => h.t };
}

describe('une fenêtre', () => {
  it('🔴 compte jusqu’au plafond, refuse au-delà, et repart à la fenêtre suivante', async () => {
    const { h, maintenant } = horloge();
    const c = new CompteurDebitMemoire(maintenant);
    const un = { cle: 'k', dureeMs: 60_000, max: 2 };
    expect((await c.compter([un])).fenetres[0]).toMatchObject({ pleine: false, compte: 1, finMs: h.t + 60_000 });
    expect((await c.compter([un])).accepte).toBe(true);
    const refus = await c.compter([un]);
    expect(refus.accepte).toBe(false);
    expect(refus.fenetres[0]).toMatchObject({ pleine: true, compte: null });
    h.t += 59_999;
    expect((await c.compter([un])).accepte).toBe(false);
    h.t += 1;
    const neuve = await c.compter([un]);
    expect(neuve.accepte).toBe(true);
    expect(neuve.fenetres[0]!.compte).toBe(1);
  });

  it('🔴 un refus n’ajoute rien : il ne repousse pas la réouverture', async () => {
    const c = new CompteurDebitMemoire(horloge().maintenant);
    const un = { cle: 'k', dureeMs: 60_000, max: 3 };
    await c.compter([un]);
    for (let i = 0; i < 10; i += 1) await c.compter([{ ...un, pas: 5 }]);
    expect((await c.compter([un])).fenetres[0]!.compte).toBe(2);
  });

  it('un plafond `null` compte sans jamais refuser, et un pas compte ce qu’il vaut', async () => {
    const c = new CompteurDebitMemoire(horloge().maintenant);
    for (let i = 0; i < 5; i += 1) await c.compter([{ cle: 'u', dureeMs: 60_000, max: null, pas: 50 }]);
    expect((await c.lister('u', 60_000))[0]!.n).toBe(250);
  });

  it('🔴 un pas plus grand que le plafond est refusé même dans une fenêtre vide', async () => {
    const c = new CompteurDebitMemoire(horloge().maintenant);
    expect((await c.compter([{ cle: 'q', dureeMs: 60_000, max: 10, pas: 11 }])).accepte).toBe(false);
    expect(await c.lister('q', 60_000)).toEqual([]);
  });
});

describe('plusieurs fenêtres', () => {
  it('🔴 toutes ou aucune : la minute pleine refuse, et l’heure n’a RIEN compté', async () => {
    const c = new CompteurDebitMemoire(horloge().maintenant);
    const minute = { cle: 'm', dureeMs: 60_000, max: 1 };
    const heure = { cle: 'h', dureeMs: 3_600_000, max: 100 };
    await c.compter([minute, heure]);
    const refus = await c.compter([minute, heure]);
    expect(refus.accepte).toBe(false);
    expect(refus.fenetres.map((f) => f.pleine)).toEqual([true, false]);
    expect(refus.fenetres[1]!.compte, 'le compte de l’heure, rendu tel qu’il était').toBe(1);
    expect((await c.lister('h', 3_600_000))[0]!.n).toBe(1);
  });

  it('les états suivent l’ordre de la demande', async () => {
    const c = new CompteurDebitMemoire(horloge().maintenant);
    const v = await c.compter([{ cle: 'z', dureeMs: 60_000, max: 5 }, { cle: 'a', dureeMs: 60_000, max: 5 }]);
    expect(v.fenetres.map((f) => f.cle)).toEqual(['z', 'a']);
  });
});

describe('deux copies sur le même compteur', () => {
  it('🔴 le total est tenu, pas chaque copie : trois places, trois appels acceptés en tout', async () => {
    const base = new CompteurDebitMemoire(horloge().maintenant);
    const copieA = memoireDesPleines(base);
    const copieB = memoireDesPleines(base);
    const un = [{ cle: 'api.minute|t1', dureeMs: 60_000, max: 3 }];
    const verdicts = [];
    for (const copie of [copieA, copieB, copieA, copieB, copieA, copieB]) verdicts.push((await copie.compter(un)).accepte);
    expect(verdicts).toEqual([true, true, true, false, false, false]);
  });

  it('🔴 de demandes SIMULTANÉES pour la dernière place, une seule l’obtient', async () => {
    const base = new CompteurDebitMemoire(horloge().maintenant);
    const un = [{ cle: 'k', dureeMs: 60_000, max: 1 }];
    const v = await Promise.all(Array.from({ length: 6 }, () => memoireDesPleines(base).compter(un).then((r) => r.accepte)));
    expect(v.filter(Boolean)).toHaveLength(1);
  });
});

describe('la mémoire des fenêtres pleines d’une copie', () => {
  function espion(base: CompteurDebit) {
    const e = { appels: 0 };
    const c: CompteurDebit = { compter: (x) => { e.appels += 1; return base.compter(x); }, lister: (p, d) => base.lister(p, d) };
    return { e, c };
  }

  it('🔴 un refus vu une fois ne repasse plus par la base jusqu’à la fin de la fenêtre', async () => {
    const { h, maintenant } = horloge();
    const { e, c } = espion(new CompteurDebitMemoire(maintenant));
    const copie = memoireDesPleines(c, maintenant);
    const un = [{ cle: 'k', dureeMs: 60_000, max: 1 }];
    await copie.compter(un);
    expect((await copie.compter(un)).accepte).toBe(false);
    const apres = e.appels;
    for (let i = 0; i < 50; i += 1) expect((await copie.compter(un)).accepte).toBe(false);
    expect(e.appels).toBe(apres);
    // La fenêtre finie, la base est de nouveau interrogée, et elle accepte.
    h.t += 60_000;
    expect((await copie.compter(un)).accepte).toBe(true);
    expect(e.appels).toBe(apres + 1);
  });

  it('🔴 le refus mémorisé dit la MÊME attente que la base, même quand l’horloge de la copie n’est pas la sienne', async () => {
    // La base a 7 s d'avance sur la copie. Au refus, la base dit « 35 s » ; cinq secondes plus tard, la mémoire de la
    // copie doit dire 30 s, pas 37 : l'écart entre les deux horloges ne doit pas décaler l'attente annoncée.
    const { h, maintenant } = horloge();
    const base = new CompteurDebitMemoire(() => h.t + 7_000);
    const copie = memoireDesPleines(base, maintenant);
    const un = [{ cle: 'k', dureeMs: 60_000, max: 1 }];
    await copie.compter(un);
    h.t += 25_000;
    const refus = await copie.compter(un);
    expect(refus.fenetres[0]!.finMs - refus.maintenantMs).toBe(35_000);
    h.t += 5_000;
    const v = await copie.compter(un);
    expect(v.accepte).toBe(false);
    expect(v.fenetres[0]!.finMs - v.maintenantMs).toBe(30_000);
  });

  it('🔴 un plafond RELEVÉ repasse tout de suite par la base (un réglage de `/ops` ne doit pas attendre la fin de l’heure)', async () => {
    const { maintenant } = horloge();
    const { e, c } = espion(new CompteurDebitMemoire(maintenant));
    const copie = memoireDesPleines(c, maintenant);
    await copie.compter([{ cle: 'k', dureeMs: 3_600_000, max: 1 }]);
    expect((await copie.compter([{ cle: 'k', dureeMs: 3_600_000, max: 1 }])).accepte).toBe(false);
    const avant = e.appels;
    expect((await copie.compter([{ cle: 'k', dureeMs: 3_600_000, max: 5 }])).accepte).toBe(true);
    expect(e.appels).toBe(avant + 1);
  });

  it('⚠️ une mémoire pleine n’apprend plus, elle ne refuse pas pour autant : la base répond', async () => {
    const { maintenant } = horloge();
    const { e, c } = espion(new CompteurDebitMemoire(maintenant));
    const copie = memoireDesPleines(c, maintenant, 1);
    for (const k of ['a', 'b']) {
      await copie.compter([{ cle: k, dureeMs: 60_000, max: 1 }]);
      await copie.compter([{ cle: k, dureeMs: 60_000, max: 1 }]);
    }
    const avant = e.appels;
    expect((await copie.compter([{ cle: 'b', dureeMs: 60_000, max: 1 }])).accepte).toBe(false);
    expect(e.appels, '`b` n’a pas été retenue (mémoire pleine) : la base a répondu').toBe(avant + 1);
  });
});

describe('les comptages', () => {
  it('🔴 une clé en double est une faute d’appel (Postgres refuserait de toucher deux fois la même ligne)', () => {
    expect(() => normaliserComptages([{ cle: 'k', dureeMs: 60_000, max: 1 }, { cle: 'k', dureeMs: 3_600_000, max: 1 }])).toThrow(/double/);
  });

  it('une liste vide, une durée, un pas ou un plafond qui n’est pas un entier positif sont refusés', () => {
    expect(() => normaliserComptages([])).toThrow();
    expect(() => normaliserComptages([{ cle: 'k', dureeMs: 0, max: 1 }])).toThrow();
    expect(() => normaliserComptages([{ cle: 'k', dureeMs: 60_000, max: 0 }])).toThrow();
    expect(() => normaliserComptages([{ cle: 'k', dureeMs: 60_000, max: 1, pas: 1.5 }])).toThrow();
    expect(() => normaliserComptages([{ cle: '', dureeMs: 60_000, max: 1 }])).toThrow();
  });

  it('ce qui reste : le plafond moins le compte, 0 pour une fenêtre pleine', () => {
    expect(restantDe({ cle: 'k', max: 5, pleine: false, compte: 2, finMs: 0 })).toBe(3);
    expect(restantDe({ cle: 'k', max: 5, pleine: true, compte: null, finMs: 0 })).toBe(0);
  });
});
