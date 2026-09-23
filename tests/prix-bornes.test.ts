import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { valideGrille, BORNES_GRILLE, GRILLE_DEFAUT, tarifsFactures, pricingFacture } from '../src/stats/prix';

/**
 * 🔴 LA MIGRATION QUI FAIT FOI EST CELLE DE LA TABLE SERVIE, ET ELLE A CHANGE LE 2026-09-23. Ce test
 * lisait `0154_grille_prix_espace.sql`, c'est-a-dire les six colonnes de `tenant_settings` que le lot 8 a
 * rendues MORTES : la grille est desormais unique et vit dans `grille_prix` (0168). Les bornes
 * coincidaient, donc rien n'etait casse, mais la garde surveillait une table que plus personne ne lit.
 *
 * ⚠️ CE QU'ELLE AURAIT LAISSE PASSER : porter `BORNES_GRILLE.centimes.max` a 200 aurait exige de
 * modifier 0154 (morte), pendant que le CHECK de 0168 aurait garde `<= 100`. Un `PATCH /ops/prix` a 150
 * aurait passe `valideGrille` puis se serait fait refuser par Postgres : un 500 sur un geste ordinaire,
 * c'est-a-dire exactement le mode de panne que ce fichier existe pour fermer.
 */
const SQL = readFileSync(join(resolve(__dirname, '..'), 'db', 'migrations', '0168_grille_prix_globale.sql'), 'utf8');

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
describe('les bornes de saisie sont celles de la migration de la table SERVIE (0168)', () => {
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

  /**
   * 🔴 LE CAS QUI A FAIT TOMBER LA GARDE, ET IL EST LA PARCE QUE MES TESTS NE LE VOYAIENT PAS. La premiere
   * ecriture comparait `Math.round(v * 100) === v * 100`. Or `2.47 * 100` vaut `247.00000000000003` en
   * virgule flottante : 2,47 etait REFUSE, comme 1,15, 9,95, 8,2, 0,07 et 2,03. Mesure a l epoque : 1146
   * refus sur les 10001 valeurs a deux decimales entre 0 et 100. Aucun test ne le montrait parce que les
   * quatre defauts (2,48, 100, 6, 8) et le seul autre cas teste tombaient tous du bon cote. Un test qui
   * n exerce que des valeurs choisies par son auteur ne prouve rien d une garde numerique.
   */
  it('🔴 TOUTES les valeurs a deux decimales sont acceptees, pas seulement celles qui arrangent', () => {
    const refuses: number[] = [];
    for (let i = 0; i <= 10_000; i += 1) {
      const v = i / 100;
      if (!valideGrille({ ...bonne, serviceCentimes: v }).ok) refuses.push(v);
    }
    expect(refuses, `refuses a tort : ${refuses.slice(0, 10).join(', ')}`).toHaveLength(0);
  });

  /**
   * 🔴 UNE MARGE DECIMALE EST ACCEPTEE, ET CETTE REGLE A CHANGE DEUX FOIS. Elle a d abord tout accepte sur
   * la foi d un commentaire faux (la colonne etait un `smallint`, pas un `numeric`), donc Postgres
   * rejetait et la route rendait 500. Puis elle a exige un ENTIER, ce qui tenait le type mais refusait une
   * marge de +20,5 % sans pouvoir l expliquer au client, la valeur etant dans les bornes annoncees. C est
   * la COLONNE qui a ete elargie, la migration n etant pas encore appliquee.
   */
  it('🔴 une marge a DEUX decimales est acceptee, comme sa colonne le permet', () => {
    expect(valideGrille({ ...bonne, margeTemplate: 120.5 }).ok, '+20,5 % est une marge banale').toBe(true);
    expect(valideGrille({ ...bonne, margeTemplate: 120 }).ok).toBe(true);
    const trop = valideGrille({ ...bonne, margeTemplate: 120.555 });
    expect(trop.ok, 'trois decimales seraient arrondies en silence par la base').toBe(false);
    if (!trop.ok) expect(trop.champ).toBe('margeTemplate');
  });

  /**
   * 🔴 LE TYPE DE LA COLONNE EST RELU DANS LE FICHIER SQL, parce que c est LUI qui decide de la regle. Une
   * validation a deux decimales sur une colonne entiere rendrait 500 ; une validation entiere sur une
   * colonne decimale retrecirait le produit. Les deux sont arrives, dans cet ordre, en une heure.
   */
  it('🔴 la colonne de la marge accepte bien deux decimales', () => {
    // ⚠️ UNE REGEXP, PAS CINQ ESPACES LITTERAUX : realigner la colonne du fichier SQL casserait un
    // `toContain` pour une raison qui n est pas celle qu il teste.
    expect(SQL, 'prix_marge_template doit etre un numeric(6,2), pas un smallint')
      .toMatch(/prix_marge_template\s+numeric\(6,2\)/);
    /**
     * ⚠️ L'ASSERTION SUR `alter column ... type` A ETE RETIREE LE 2026-09-23, ET SON SUJET A DISPARU AVEC.
     * Elle gardait un cas propre a 0154 : une colonne AJOUTEE a une table existante, ou `add column if not
     * exists` protege de l'existence mais pas du TYPE, donc un `smallint` pose a la main survivait. 0168
     * CREE la table, avec ses colonnes et leurs types d'un seul geste : une colonne pre-existante au mauvais
     * type ne peut pas exister. Conserver l'assertion aurait exige de garder un `alter column` sans objet
     * dans la migration, uniquement pour qu'un test passe.
     */
  });

  it('deux decimales exactement restent acceptees sur les prix en centimes', () => {
    expect(valideGrille({ ...bonne, serviceCentimes: 2.47, rcsSimpleCentimes: 9.95 }).ok).toBe(true);
  });

  it('un champ vide arrive en NaN depuis l ecran, et NaN est refuse', () => {
    // C est le contrat avec `depuisChamps` cote front : un champ vide ne devient pas zero, il devient NaN,
    // et c est ici qu il est refuse en nommant le champ.
    const v = valideGrille({ ...bonne, serviceCentimes: Number.NaN });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.champ).toBe('serviceCentimes');
  });
});

/**
 * LE CHEMIN QUI AVAIT ETE OUBLIE DEUX FOIS.
 *
 * 🔴 L INVENTAIRE AVAIT ETE FAIT SUR LA MAUVAISE QUESTION. On avait cherche « qui appelle la fonction qui
 * lit les tarifs », alors qu il fallait chercher « qui affiche un prix de template a un client ». Le resume
 * brut de Meta part aussi vers la carte « Detail par template » du Quantitatif et vers l ecran Campagnes :
 * la MEME campagne valait 1,00 € la-bas et 1,50 € sur sa fiche Performance Lab, et deux cartes de la MEME
 * page annoncaient deux totaux. Troisieme revue du 2026-09-18, apres deux correctifs qui avaient chacun
 * deplace la frontiere de la divergence sans la supprimer.
 */
describe('pricingFacture : le resume de Meta devient un prix de vente', () => {
  const brut = {
    byCategory: {
      marketing: { category: 'marketing', cost: 10, volume: 100, ratePerMessage: 0.1 },
      utility: { category: 'utility', cost: 2, volume: 100, ratePerMessage: 0.02 },
    },
    totalCost: 12,
    currency: 'EUR',
  };

  it('🔴 chaque categorie porte le prix de vente', () => {
    const p = pricingFacture(brut, { ...GRILLE_DEFAUT, margeTemplate: 150 });
    expect(p.byCategory.marketing!.ratePerMessage).toBeCloseTo(0.15, 6);
    expect(p.byCategory.utility!.ratePerMessage).toBeCloseTo(0.03, 6);
  });

  /**
   * 🔴 `cost` ET `totalCost` NE BOUGENT PAS, et c est le coeur de la fonction. Ce sont les charges REELLES
   * que Meta a facturees : les marger en ferait une projection de vente melangee a une depense constatee,
   * donc un total qui n est ni l un ni l autre.
   */
  it('🔴 les charges REELLES de Meta ne sont pas margees', () => {
    const p = pricingFacture(brut, { ...GRILLE_DEFAUT, margeTemplate: 150 });
    expect(p.totalCost, 'ce que Meta a facture, pas ce qu on vend').toBe(12);
    expect(p.byCategory.marketing!.cost).toBe(10);
    expect(p.byCategory.marketing!.volume, 'et le volume non plus, evidemment').toBe(100);
  });

  it('une marge de 100 ne change rien, donc les ecrans d avant lisent le meme chiffre', () => {
    expect(pricingFacture(brut, GRILLE_DEFAUT)).toEqual(brut);
  });

  it('un resume sans categorie ne casse pas', () => {
    expect(pricingFacture({ byCategory: {}, totalCost: 0, currency: null }, GRILLE_DEFAUT).byCategory).toEqual({});
  });

  it('la devise et les champs inconnus traversent', () => {
    const p = pricingFacture({ ...brut, currency: 'USD' }, { ...GRILLE_DEFAUT, margeTemplate: 200 });
    expect(p.currency).toBe('USD');
    expect(p.byCategory.marketing!.category, 'les autres champs de la categorie survivent').toBe('marketing');
  });
});

/**
 * 🔴 LA MARGE NE PORTE QUE SUR LES CATEGORIES DE TEMPLATE. Meta rend `service` et `authentication` sur le
 * meme appel ; le prix d un message de service se SAISIT (`serviceCentimes`), il ne se derive d aucun tarif
 * Meta. Les marger rendrait un prix faux, sans erreur, au premier ecran qui les lirait. Aucun n en lit
 * aujourd hui, mais la doc de la fonction invite a la reutiliser : la borne se pose avant, pas apres.
 * Releve a la quatrieme revue du 2026-09-18.
 */
describe('pricingFacture ne marge que ce qui se derive d un tarif Meta', () => {
  const brutComplet = {
    byCategory: {
      marketing: { category: 'marketing', cost: 10, volume: 100, ratePerMessage: 0.1 },
      utility: { category: 'utility', cost: 2, volume: 100, ratePerMessage: 0.02 },
      service: { category: 'service', cost: 5, volume: 200, ratePerMessage: 0.025 },
      authentication: { category: 'authentication', cost: 1, volume: 50, ratePerMessage: 0.02 },
    },
    totalCost: 18,
    currency: 'EUR',
  };

  it('🔴 service et authentication traversent SANS marge', () => {
    const p = pricingFacture(brutComplet, { ...GRILLE_DEFAUT, margeTemplate: 200 });
    expect(p.byCategory.marketing!.ratePerMessage, 'marge').toBeCloseTo(0.2, 6);
    expect(p.byCategory.utility!.ratePerMessage, 'marge').toBeCloseTo(0.04, 6);
    expect(p.byCategory.service!.ratePerMessage, 'son prix se saisit, il ne se marge pas').toBeCloseTo(0.025, 6);
    expect(p.byCategory.authentication!.ratePerMessage, 'pas un template vendu').toBeCloseTo(0.02, 6);
  });

  it('une categorie inconnue de Meta traverse intacte plutot que margee au hasard', () => {
    const p = pricingFacture({ byCategory: { nouvelle: { ratePerMessage: 0.5 } }, totalCost: 0, currency: null },
      { ...GRILLE_DEFAUT, margeTemplate: 200 });
    expect(p.byCategory.nouvelle!.ratePerMessage).toBe(0.5);
  });
});
