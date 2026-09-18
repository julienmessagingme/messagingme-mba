import { describe, it, expect } from 'vitest';
import { estimateCoutParCampagne } from '../src/stats/cost';

/**
 * LES MESSAGES DE SERVICE ENTRENT DANS LE COUT D'UNE CAMPAGNE.
 *
 * 🔴 CE QUE CES TESTS FERMENT, ET QUI A ETE LIVRE A MOITIE. Le cadrage dit « LE NUMERATEUR INCLUT LES
 * MESSAGES DE SERVICE, PAS SEULEMENT LES TEMPLATES », et l'etape du plan qui l'implementait n'a jamais ete
 * faite : le « cout par engagement » affichait le seul template de depart, donc une campagne qui ouvre une
 * conversation et fait echanger dix messages de service paraissait coûter trois fois moins qu'elle ne
 * coûte. Releve en revue finale le 2026-09-17.
 */

const TARIFS = { marketing: 0.10, utility: 0.02, currency: 'EUR' };
const vol = (campaignId: string, count: number, category = 'marketing') =>
  ({ campaignId, nom: campaignId, template: 't', category, count });

describe('le service s ajoute au template', () => {
  it('🔴 le cout d une campagne comprend ses messages de service', () => {
    const r = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map([['c1', 5]]),
      { parCampagne: new Map([['c1', 20]]), prixUnitaire: 0.02 });
    // 10 templates a 0,10 = 1,00 ; 20 services a 0,02 = 0,40.
    expect(r.lignes[0]!.cout).toBeCloseTo(1.4, 6);
    expect(r.lignes[0]!.coutParEngagement, '1,40 / 5 engages').toBeCloseTo(0.28, 6);
  });

  it('sans imputation, le cout reste celui des templates', () => {
    // Une instance qui ne sait pas encore compter les services ne doit pas inventer un zero : elle rend
    // exactement ce qu'elle rendait avant.
    const r = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map([['c1', 5]]));
    expect(r.lignes[0]!.cout).toBeCloseTo(1, 6);
  });

  it('une campagne sans message de service n est pas penalisee', () => {
    const r = estimateCoutParCampagne([vol('c1', 10), vol('c2', 10)], TARIFS, new Map(), new Map(),
      { parCampagne: new Map([['c1', 20]]), prixUnitaire: 0.02 });
    const parId = new Map(r.lignes.map((l) => [l.campaignId, l.cout]));
    expect(parId.get('c1')).toBeCloseTo(1.4, 6);
    expect(parId.get('c2'), 'aucun service impute -> le seul template').toBeCloseTo(1, 6);
  });

  /**
   * 🔴 LA GARDE QUI COMPTE, ET ELLE VA A CONTRE-COURANT DE L'AJOUT. La regle des trois cases vides de ce
   * fichier dit qu'une campagne dont AUCUN envoi n'est chiffrable garde sa case COUT vide : « on ne sait
   * pas ce qu'elle a coute » ne se remplace pas par « voila ce qu'elle a coute » au motif qu'on sait
   * chiffrer ses messages de service. L'addition ne doit pas contourner la regle.
   */
  it('🔴 une campagne SANS TARIF garde sa case vide, meme avec des services chiffrables', () => {
    const r = estimateCoutParCampagne([vol('c1', 10, 'inconnue')], TARIFS, new Map(), new Map(),
      { parCampagne: new Map([['c1', 20]]), prixUnitaire: 0.02 });
    expect(r.lignes[0]!.cout, 'vide, pas 0,40').toBeNull();
    expect(r.lignes[0]!.nonChiffrables).toBe(10);
  });

  /**
   * ⚠️ LE PRIX EST CELUI D'APRES LA FRANCHISE, et un prix effectif de ZERO est un cas NORMAL : une periode
   * entierement sous le millieme mensuel ne facture aucun message de service. Zero ne veut pas dire
   * « on ne sait pas », il veut dire « c'est gratuit ce mois-ci ».
   */
  it('un prix effectif de zero n ajoute rien, et ce n est pas une absence', () => {
    const r = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map(),
      { parCampagne: new Map([['c1', 20]]), prixUnitaire: 0 });
    expect(r.lignes[0]!.cout).toBeCloseTo(1, 6);
  });

  it('le tri par cout decroissant tient compte du service', () => {
    // Sans le service, c2 (2,00) passerait devant c1 (1,00). Avec, c1 monte a 3,00 et prend la tete : le
    // tableau doit classer sur ce que ca coûte REELLEMENT, pas sur la moitie qu'on savait chiffrer.
    const r = estimateCoutParCampagne([vol('c1', 10), vol('c2', 20)], TARIFS, new Map(), new Map(),
      { parCampagne: new Map([['c1', 100]]), prixUnitaire: 0.02 });
    expect(r.lignes.map((l) => l.campaignId)).toEqual(['c1', 'c2']);
  });
});

/**
 * LES DEUX LIGNES DE LA CARTE APPLIQUENT LA MEME MARGE.
 *
 * 🔴 CE DEFAUT ETAIT LATENT, ET LE CABLAGE DE LA GRILLE L A RENDU ATTEIGNABLE. La ligne « messages
 * envoyes » applique `prixTemplate` (donc la marge de l espace) ; le tableau des campagnes utilisait le
 * tarif Meta BRUT. Tant que la marge valait 100, les deux coincidaient et personne ne pouvait le voir.
 * Depuis que la marge se regle depuis un ecran, deux chiffres de la MEME carte divergeraient en silence.
 * Corrige au moment precis ou il a cesse d etre theorique.
 */
describe('la marge de l espace vaut pour les deux lignes de la carte', () => {
  it('🔴 une marge de 150 majore le cout du tableau, comme celui des messages', () => {
    const r = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map(), undefined, 150);
    // 10 envois a 0,10 majores de 50 % = 1,50, et non 1,00.
    expect(r.lignes[0]!.cout).toBeCloseTo(1.5, 6);
  });

  it('une marge absente vaut 100, donc exactement le comportement d avant', () => {
    const sans = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map());
    const cent = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map(), undefined, 100);
    expect(sans.lignes[0]!.cout).toBe(cent.lignes[0]!.cout);
    expect(sans.lignes[0]!.cout).toBeCloseTo(1, 6);
  });

  it('la marge porte sur les templates, PAS sur les messages de service', () => {
    // Le service a son propre prix, saisi, deja au prix de VENTE : le marger une seconde fois le
    // facturerait deux fois.
    const r = estimateCoutParCampagne([vol('c1', 10)], TARIFS, new Map(), new Map(),
      { parCampagne: new Map([['c1', 10]]), prixUnitaire: 0.02 }, 150);
    // 1,50 de templates + 0,20 de service, et non 0,30 de service.
    expect(r.lignes[0]!.cout).toBeCloseTo(1.7, 6);
  });
});
