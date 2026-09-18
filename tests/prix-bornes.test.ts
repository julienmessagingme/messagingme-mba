import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { valideGrille, BORNES_GRILLE, GRILLE_DEFAUT } from '../src/stats/prix';

const SQL = readFileSync(join(resolve(__dirname, '..'), 'db', 'migrations', '0154_grille_prix_espace.sql'), 'utf8');

/**
 * LES BORNES DE SAISIE D UNE GRILLE DE PRIX.
 *
 * 🔴 CE FICHIER EXISTE PARCE QUE LA MEME REGLE EST ECRITE DEUX FOIS, ET QUE C EST INEVITABLE. Le CHECK de
 * la migration est la GARANTIE (rien ne rentre en base hors bornes) ; `valideGrille` est le MESSAGE (le
 * client sait quel champ ne va pas). Aucune des deux ne peut jouer le role de l autre : un CHECK ne sait
 * pas parler, et une validation applicative ne protege pas d un `UPDATE` direct. Ce qui est evitable, c est
 * qu elles DIVERGENT : plus large que le CHECK rend un 500 sur un geste ordinaire, plus etroit refuse un
 * reglage legitime sans raison lisible.
 */
describe('les bornes de saisie sont celles de la migration 0154', () => {
  it('🔴 la marge : les memes deux nombres des deux cotes', () => {
    expect(SQL).toContain(`check (prix_marge_template between ${BORNES_GRILLE.margeTemplate.min} and ${BORNES_GRILLE.margeTemplate.max})`);
  });

  it('🔴 les prix en centimes : le meme plafond des deux cotes', () => {
    // Le plafond attrape la virgule oubliee (248 au lieu de 2,48). Trois colonnes le partagent.
    const max = BORNES_GRILLE.centimes.max;
    for (const col of ['prix_service_centimes', 'prix_rcs_centimes', 'prix_rcs_conv_centimes']) {
      expect(SQL, `${col} doit etre borne a ${max} en base`).toContain(`${col} >= 0 and ${col} <= ${max}`);
    }
  });

  it('la franchise ne peut pas etre negative, des deux cotes', () => {
    expect(SQL).toContain('prix_service_franchise >= 0');
    expect(BORNES_GRILLE.franchise.min).toBe(0);
  });
});

describe('valideGrille', () => {
  const bonne = { ...GRILLE_DEFAUT };

  it('accepte la grille par defaut', () => {
    const v = valideGrille(bonne);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.grille).toEqual(GRILLE_DEFAUT);
  });

  /**
   * 🔴 ELLE REFUSE, ELLE NE CORRIGE PAS. Ramener 248 a 100 enregistrerait un prix que personne n a choisi,
   * et le client batirait un budget dessus sans savoir que sa saisie avait ete reecrite.
   */
  it('🔴 une valeur hors bornes est REFUSEE, jamais ramenee dans les bornes', () => {
    const v = valideGrille({ ...bonne, serviceCentimes: 248 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.champ).toBe('serviceCentimes');
  });

  it('🔴 elle NOMME le champ fautif, chacun des six', () => {
    // Un « erreur » nu obligerait a chercher lequel des six ne va pas.
    const cas: Array<[string, unknown]> = [
      ['margeTemplate', 0], ['serviceCentimes', -1], ['serviceFranchise', 1.5],
      ['serviceDepuis', '01/10/2026'], ['rcsSimpleCentimes', 101], ['rcsConversationnelCentimes', 'six'],
    ];
    for (const [champ, valeur] of cas) {
      const v = valideGrille({ ...bonne, [champ]: valeur });
      expect(v.ok, `${champ} = ${String(valeur)} doit etre refuse`).toBe(false);
      if (!v.ok) expect(v.champ).toBe(champ);
    }
  });

  /**
   * 🔴 IL N EXISTE PAS DE GRILLE PARTIELLE. Un envoi a un champ obligerait le serveur a fusionner avec
   * l existant, et c est exactement la ou ce depot s est deja fait avoir : une liste REMPLACEE au lieu
   * d etre fusionnee, qui a detruit du travail client.
   */
  it('🔴 une grille incomplete est refusee, elle n est pas completee par les defauts', () => {
    const v = valideGrille({ margeTemplate: 120 });
    expect(v.ok).toBe(false);
  });

  it('un corps vide, null, ou un tableau sont refuses sans lever', () => {
    for (const mauvais of [null, undefined, {}, [], 'grille', 42]) {
      expect(valideGrille(mauvais).ok, `${JSON.stringify(mauvais)} doit etre refuse`).toBe(false);
    }
  });

  it('une marge a 1 et un prix a 0 sont des valeurs VALIDES, pas des oublis', () => {
    // 0 centime veut dire « je ne facture pas ce canal », et c est un choix legitime. Le refuser
    // obligerait a poser un prix qu on ne pratique pas.
    expect(valideGrille({ ...bonne, margeTemplate: 1, rcsSimpleCentimes: 0 }).ok).toBe(true);
  });
});

/**
 * LA DATE D EFFET, LUE DEPUIS UNE COLONNE `date`.
 *
 * 🔴 CE DEFAUT A ETE TROUVE PAR UNE SONDE EN BASE, PAS PAR UN TEST, et ces tests-ci ne peuvent pas
 * pretendre l avoir attrape. node-postgres rend une colonne `date` en `Date` a MINUIT LOCAL ; l ancienne
 * conversion faisait `toISOString().slice(0, 10)`, qui repasse en UTC et rend LA VEILLE des qu on est a
 * l est de Greenwich. Ecrit 2026-11-01, relu 2026-10-31 : la facturation du service aurait demarre un jour
 * trop tot, pour tout le monde, defaut compris, et l ecran aurait affiche la date fausse sans rien trahir.
 *
 * ⚠️ CE QUE CES TESTS PROUVENT, ET CE QU ILS NE PROUVENT PAS. Sur une machine a decalage NUL (la CI tourne
 * en UTC), les deux ecritures rendent le meme resultat : ils ne discriminent donc pas la-bas, et le dire
 * vaut mieux que de laisser croire a une garde qui n en est pas une. Ce qu ils tiennent partout, c est que
 * la conversion lit bien des composantes LOCALES, ce qui est exactement la propriete corrigee. La preuve
 * discriminante vit dans la sonde (session isolee, Europe/Paris), et la seconde ceinture est ailleurs : le
 * `select` du chemin chaud demande la date en TEXTE, donc aucune `Date` ne s y construit.
 */
describe('la date d effet ne recule pas d un jour', () => {
  const lire = (d: unknown) => valideGrille({
    ...GRILLE_DEFAUT,
    serviceDepuis: typeof d === 'string' ? d : GRILLE_DEFAUT.serviceDepuis,
  });

  it('une chaine deja au bon format traverse intacte', () => {
    const v = lire('2026-11-01');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.grille.serviceDepuis).toBe('2026-11-01');
  });

  it('🔴 une Date construite a MINUIT LOCAL rend CE jour-la, pas la veille', async () => {
    const { grilleDepuisLigne } = await import('../src/stats/prix');
    // `new Date(2026, 10, 1)` = 1er novembre a minuit LOCAL, exactement ce que node-postgres construit
    // depuis une colonne `date`.
    expect(grilleDepuisLigne({ prix_service_depuis: new Date(2026, 10, 1) }).serviceDepuis).toBe('2026-11-01');
    // Un mois et un jour a un chiffre doivent etre completes a deux : '2026-1-5' serait refuse par la
    // validation, et un CHECK de base ne rattraperait pas une chaine mal formee lue en sortie.
    expect(grilleDepuisLigne({ prix_service_depuis: new Date(2026, 0, 5) }).serviceDepuis).toBe('2026-01-05');
  });

  it('une Date invalide retombe sur le defaut au lieu de rendre « NaN-NaN-NaN »', async () => {
    const { grilleDepuisLigne } = await import('../src/stats/prix');
    expect(grilleDepuisLigne({ prix_service_depuis: new Date('pas une date') }).serviceDepuis)
      .toBe(GRILLE_DEFAUT.serviceDepuis);
  });
});
