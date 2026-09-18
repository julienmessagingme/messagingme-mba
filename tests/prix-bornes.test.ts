import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { valideGrille, BORNES_GRILLE, GRILLE_DEFAUT, tarifsFactures } from '../src/stats/prix';

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

/**
 * LA MARGE S APPLIQUE UNE SEULE FOIS, A LA SOURCE.
 *
 * 🔴 CE BLOC RECUEILLE LE CAS QUE DEUX AUTRES FICHIERS EXERCAIENT, et il dit pourquoi il a demenage. La
 * marge a d abord ete posee dans les DEUX fonctions qui calculaient un total ; deux AUTRES consommateurs
 * des memes tarifs l ignoraient donc (le graphe de cout du Quantitatif, le bilan d un contact), et des
 * qu un client posait une marge de 150 la Synthese annoncait 1,50 € la ou le graphe du meme produit
 * annoncait 1,00 € pour exactement les memes envois. Le correctif precedent avait DEPLACE la frontiere de
 * la divergence, pas supprimee. Releve en revue finale le 2026-09-18.
 */
describe('tarifsFactures : le point de passage unique de la marge', () => {
  const brut = { marketing: 0.10, utility: 0.02, currency: 'EUR' };

  it('🔴 une marge de 150 majore le prix, et c est le cas transpose depuis cout-messages', () => {
    const p = tarifsFactures(brut, { ...GRILLE_DEFAUT, margeTemplate: 150 });
    expect(p.marketing).toBeCloseTo(0.15, 6);
    expect(p.utility).toBeCloseTo(0.03, 6);
  });

  it('une marge de 100 ne change rien, donc un espace qui n a rien regle lit le meme chiffre qu avant', () => {
    expect(tarifsFactures(brut, GRILLE_DEFAUT)).toEqual({ marketing: 0.1, utility: 0.02, currency: 'EUR' });
  });

  /**
   * 🔴 UN TARIF ABSENT LE RESTE. Le marger en ferait un prix, et `chiffrer` ne pourrait plus compter ces
   * envois comme « sans tarif » : ils passeraient de « on ne sait pas ce que ca coute » a « ca coute
   * zero », exactement l inversion que tout ce module s interdit.
   */
  it('🔴 un tarif ABSENT reste absent, il ne devient pas zero', () => {
    const p = tarifsFactures({ marketing: null, utility: undefined, currency: null }, { ...GRILLE_DEFAUT, margeTemplate: 150 });
    expect(p.marketing).toBeNull();
    expect(p.utility).toBeNull();
    expect(p.currency).toBeNull();
  });

  it('la devise traverse sans etre touchee', () => {
    expect(tarifsFactures({ ...brut, currency: 'USD' }, GRILLE_DEFAUT).currency).toBe('USD');
  });

  /**
   * 🔴 ET LA GARDE STRUCTURELLE : `prixTemplate` ne doit etre appelee QUE par le point de passage. Un
   * second appel ailleurs remettrait la marge deux fois (150 facturerait 2,25 fois le tarif Meta), et
   * aucun test de comportement ne le verrait, puisque chaque fonction prise isolement resterait juste.
   */
  it('🔴 prixTemplate n est appelee nulle part ailleurs dans src/', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const sortie = execSync('git grep -n "prixTemplate(" -- src', { cwd: resolve(__dirname, '..'), encoding: 'utf8' });
    const appels = sortie.split('\n').filter((l) => l.trim() !== '' && !l.includes('src/stats/prix.ts'));
    expect(appels, `prixTemplate est appelee hors du point de passage :\n${appels.join('\n')}`).toHaveLength(0);
  });
});

/**
 * LE FORMAT NE SUFFIT PAS, ET CE QUI PASSAIT FAISAIT UN 500.
 *
 * 🔴 `2026-02-31` passait la validation et partait vers `$5::date`, qui leve
 * `date/time field value out of range`, non attrape : une page d erreur sur un geste ordinaire, c est-a-dire
 * exactement ce que les bornes de ce fichier disent avoir ferme. Et la base ARRONDIT en silence un
 * `numeric(6,2)` : une marge a 100,555 aurait ete enregistree a 100,56, differente de la saisie, sans que
 * personne le sache. Releve en revue finale le 2026-09-18.
 */
describe('valideGrille refuse ce que la base refuserait ou corrigerait', () => {
  const bonne = { ...GRILLE_DEFAUT };

  it('🔴 un jour qui n existe pas est refuse, pas transmis a Postgres', () => {
    for (const impossible of ['2026-02-31', '2026-13-01', '2026-04-31', '2025-02-29']) {
      const v = valideGrille({ ...bonne, serviceDepuis: impossible });
      expect(v.ok, `${impossible} doit etre refuse`).toBe(false);
      if (!v.ok) expect(v.champ).toBe('serviceDepuis');
    }
  });

  it('un 29 fevrier d annee BISSEXTILE reste accepte', () => {
    // La garde doit refuser l impossible, pas le rare.
    expect(valideGrille({ ...bonne, serviceDepuis: '2028-02-29' }).ok).toBe(true);
  });

  it('🔴 plus de deux decimales est REFUSE, parce que la base arrondirait en silence', () => {
    for (const champ of ['margeTemplate', 'serviceCentimes', 'rcsSimpleCentimes', 'rcsConversationnelCentimes']) {
      const v = valideGrille({ ...bonne, [champ]: 2.485 });
      expect(v.ok, `${champ} a trois decimales doit etre refuse`).toBe(false);
      if (!v.ok) expect(v.champ).toBe(champ);
    }
  });

  it('deux decimales exactement restent acceptees, c est la precision de la base', () => {
    expect(valideGrille({ ...bonne, serviceCentimes: 2.48, margeTemplate: 120.5 }).ok).toBe(true);
  });

  it('un champ vide arrive en NaN depuis l ecran, et NaN est refuse', () => {
    // C est le contrat avec `depuisChamps` cote front : un champ vide ne devient pas zero, il devient NaN,
    // et c est ici qu il est refuse en nommant le champ.
    const v = valideGrille({ ...bonne, serviceCentimes: Number.NaN });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.champ).toBe('serviceCentimes');
  });
});
