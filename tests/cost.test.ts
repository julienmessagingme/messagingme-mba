import { describe, it, expect } from 'vitest';
import { estimateCostSeries, enumerateDays, estimateCoutParCampagne } from '../src/stats/cost';
import type { CategoryRates, VolumeCampagneRow } from '../src/stats/cost';
import type { CostVolumeRow } from '../src/stats/store.pg';

describe('enumerateDays', () => {
  it('énumère les jours inclus', () => {
    expect(enumerateDays('2026-07-09', '2026-07-11')).toEqual(['2026-07-09', '2026-07-10', '2026-07-11']);
  });
  it('un seul jour', () => {
    expect(enumerateDays('2026-07-09', '2026-07-09')).toEqual(['2026-07-09']);
  });
});

describe('estimateCostSeries', () => {
  const rows: CostVolumeRow[] = [
    { date: '2026-07-09', category: 'marketing', count: 10 },
    { date: '2026-07-09', category: 'utility', count: 4 },
    { date: '2026-07-11', category: 'marketing', count: 2 },
  ];

  it('multiplie volume × tarif, dense sur la plage, arrondi 2 décimales', () => {
    const s = estimateCostSeries('2026-07-09', '2026-07-11', rows, { marketing: 0.1431, utility: 0.05 });
    expect(s.marketing).toEqual([
      { date: '2026-07-09', count: 1.43 },
      { date: '2026-07-10', count: 0 },
      { date: '2026-07-11', count: 0.29 },
    ]);
    expect(s.utility).toEqual([
      { date: '2026-07-09', count: 0.2 },
      { date: '2026-07-10', count: 0 },
      { date: '2026-07-11', count: 0 },
    ]);
    expect(s.total).toBe(1.92); // 1.431 + 0.2862 + 0.2 = 1.9172 -> 1.92
    expect(s.hasRates).toBe(true);
  });

  it('catégorie sans tarif ne contribue pas (jamais de coût inventé)', () => {
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: null, utility: 0.05 });
    expect(s.marketing[0]!.count).toBe(0); // pas de tarif marketing -> 0
    expect(s.utility[0]!.count).toBe(0.2);
    expect(s.total).toBe(0.2);
    expect(s.hasRates).toBe(true); // utility a un tarif
  });

  it('aucun tarif -> hasRates=false, total 0', () => {
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: null, utility: null });
    expect(s.total).toBe(0);
    expect(s.hasRates).toBe(false);
  });

  /**
   * 🔴 CE QUI N EST PAS CHIFFRABLE SE COMPTE, IL NE DISPARAIT PAS.
   *
   * Une ligne sans categorie connue ne produit aucun cout, et jusqu ici elle sortait du calcul SANS
   * LAISSER DE TRACE : l ecran affichait zero la ou il y avait bien eu des envois. C est ce qui a fait
   * croire a un cout nul sur 22 envois de scenario du tenant Demo, dont la categorie n etait pas ecrite
   * avant le 2026-09-07. Le volume, lui, les comptait : les deux ecrans se contredisaient sans que rien
   * ne l explique.
   */
  it('🔴 compte les envois NON CHIFFRABLES au lieu de les jeter en silence', () => {
    const rows = [
      { date: '2026-07-09', category: 'marketing', count: 2 },
      { date: '2026-07-09', category: null, count: 7 },
    ];
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: 0.05 });
    expect(s.nonChiffrables).toBe(7);
    // Et ils n entrent PAS dans le cout : on ne devine pas une categorie, elle se facturerait au mauvais tarif.
    expect(s.total).toBeCloseTo(0.2, 5);
  });

  it('un tarif MANQUANT rend aussi la ligne non chiffrable, pas gratuite', () => {
    // Meme cause, autre origine : la categorie est connue mais Meta n a pas donne son tarif. Compter la
    // ligne a zero laisserait croire a un envoi gratuit.
    const rows = [{ date: '2026-07-09', category: 'utility', count: 3 }];
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: null });
    expect(s.nonChiffrables).toBe(3);
    expect(s.total).toBe(0);
  });

  it('rien de non chiffrable quand tout a sa categorie et son tarif', () => {
    const rows = [{ date: '2026-07-09', category: 'marketing', count: 4 }];
    expect(estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: 0.05 }).nonChiffrables).toBe(0);
  });

  /**
   * 🔴 LES DEUX CAUSES SE COMPTENT A PART, ET C EST LA QUESTION DE JULIEN DU 2026-09-09.
   *
   * « catégorie inconnue OU tarif indisponible » posait au lecteur un ou exclusif qu il ne pouvait pas
   * trancher, donc la question « est-ce que ca se repare ? » restait sans reponse. Les deux causes
   * n appellent pas le meme geste : une categorie absente est un heritage clos (les envois de scenario
   * n ont commence a la porter que le 2026-09-07, mesure en production), un tarif manquant est une panne
   * du jour qui se repare en relisant les tarifs. Un seul nombre les confondait.
   */
  it('🔴 categorie ABSENTE et tarif MANQUANT ne se comptent pas ensemble', () => {
    const rows = [
      { date: '2026-07-09', category: 'marketing', count: 2 },  // chiffrable
      { date: '2026-07-09', category: null, count: 7 },         // heritage : aucune categorie
      { date: '2026-07-09', category: 'utility', count: 3 },    // panne : categorie connue, tarif absent
    ];
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: null });
    expect(s.sansCategorie).toBe(7);
    expect(s.sansTarif).toBe(3);
    // Le total reste la SOMME des deux : l ancien champ ne change pas de sens, il gagne un detail.
    expect(s.nonChiffrables).toBe(10);
    expect(s.total).toBeCloseTo(0.2, 5);
  });

  it('une categorie INCONNUE (ni marketing ni utility) compte comme absente, pas comme un tarif manquant', () => {
    // Le discriminant est la CATEGORIE, pas le tarif : une valeur exotique venue de la base ne doit pas
    // se ranger du cote reparable, sans quoi l ecran promettrait une reparation qui n arrivera jamais.
    const rows = [{ date: '2026-07-09', category: 'authentication', count: 5 }];
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: 0.05 });
    expect(s.sansCategorie).toBe(5);
    expect(s.sansTarif).toBe(0);
  });
});

/**
 * Le tableau « ce que coûte un engagement » (lot E du 2026-09-08).
 *
 * 🔴 CE QUE CE BLOC PROTÈGE : les TROIS cases qui doivent rester VIDES plutôt que de valoir zéro. Un zéro
 * est une affirmation (« ça n'a rien coûté », « personne n'a cliqué ») ; l'absence dit « on ne peut pas
 * répondre », et c'est la vérité dans les trois cas. C'est tout l'écran qui en dépend : le client décide
 * de son budget dessus.
 */
describe('estimateCoutParCampagne', () => {
  const TARIFS: CategoryRates = { marketing: 0.1431, utility: 0.05, currency: 'EUR' };
  const ligne = (campaignId: string, nom: string, category: string | null, count: number, template: string | null = 'tpl'): VolumeCampagneRow =>
    ({ campaignId, nom, template, canal: 'whatsapp', category, count, envois: count });

  it('🔴 une campagne SANS RIEN DE FACTURABLE a sa ligne, à coût connu ; une campagne RCS, à coût vide (lot 4)', () => {
    // Seules les campagnes à envoi de MODÈLE facturable apparaissaient : 2 sur 7 dans l'espace d'essai.
    const scenario: VolumeCampagneRow = { campaignId: 'sc', nom: 'test4', template: null, canal: 'whatsapp', category: null, count: 0, envois: 3 };
    const rcs: VolumeCampagneRow = { campaignId: 'rc', nom: 'gr sentis', template: null, canal: 'rcs', category: null, count: 0, envois: 1 };
    const r = estimateCoutParCampagne([scenario, rcs, ligne('tp', 'Promo', 'marketing', 2)], TARIFS, new Map(), new Map([['sc', 1], ['rc', 1], ['tp', 1]]));
    const par = new Map(r.lignes.map((l) => [l.campaignId, l]));
    // La ligne vide de facturable ne compte pas comme un envoi « sans catégorie » : il n'y en a aucun.
    expect(par.get('sc')).toMatchObject({ envoyes: 0, envois: 3, cout: 0, nonChiffrables: 0, sansCategorie: 0, coutParEngagement: 0 });
    expect(par.get('rc')).toMatchObject({ envoyes: 0, envois: 1, cout: null, coutParEngagement: null });
    expect(par.get('tp')).toMatchObject({ envoyes: 2, envois: 2, cout: 0.29 });
  });

  it('🔴 sans facturable mais avec des messages de SERVICE, le coût est celui du service', () => {
    const scenario: VolumeCampagneRow = { campaignId: 'sc', nom: 'test4', template: null, canal: 'whatsapp', category: null, count: 0, envois: 1 };
    const r = estimateCoutParCampagne([scenario], TARIFS, new Map(), new Map([['sc', 1]]), { parCampagne: new Map([['sc', 10]]), prixUnitaire: 0.01 });
    expect(r.lignes[0]).toMatchObject({ cout: 0.1, coutParEngagement: 0.1 });
  });

  it('coût = envois × tarif, additionné sur les catégories de la campagne', () => {
    const r = estimateCoutParCampagne(
      [ligne('c1', 'Promo', 'marketing', 10), ligne('c1', 'Promo', 'utility', 4)],
      TARIFS,
      new Map([['c1', 2]]),
    );
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0]).toMatchObject({ campaignId: 'c1', envoyes: 14, cout: 1.63, clics: 2, nonChiffrables: 0 });
    expect(r.currency).toBe('EUR');
    expect(r.hasRates).toBe(true);
  });

  it('coût par clic = coût / clics', () => {
    const r = estimateCoutParCampagne([ligne('c1', 'Promo', 'marketing', 10)], TARIFS, new Map([['c1', 4]]));
    // 10 × 0,1431 = 1,431 -> arrondi à 1,43, puis 1,43 / 4.
    expect(r.lignes[0]!.coutParClic).toBeCloseTo(0.3575, 4);
  });

  it('🔴 ZÉRO clic mesuré -> pas de ratio, jamais un ∞ ni un 0 €', () => {
    const r = estimateCoutParCampagne([ligne('c1', 'Promo', 'marketing', 10)], TARIFS, new Map([['c1', 0]]));
    expect(r.lignes[0]!.clics).toBe(0);
    expect(r.lignes[0]!.coutParClic).toBeNull();
  });

  it('🔴 campagne ABSENTE de la carte des clics -> clics null, et pas zéro', () => {
    // C'est le cas d'une campagne à SCÉNARIO (aucun template, donc aucun lien tracé) ou d'un template sans
    // lien. Un zéro se lirait « personne n'a cliqué » ; la vérité est « il n'y a rien à mesurer ici ».
    const r = estimateCoutParCampagne([ligne('c1', 'Parcours', 'marketing', 10, null)], TARIFS, new Map());
    expect(r.lignes[0]!.clics).toBeNull();
    expect(r.lignes[0]!.coutParClic).toBeNull();
    expect(r.lignes[0]!.template).toBeNull();
  });

  it('🔴 aucun tarif pour la catégorie -> coût VIDE et envois comptés à part', () => {
    // Même règle que la série (`estimateCostSeries`) : une catégorie inconnue ou sans tarif ne produit
    // aucun coût, et ces envois se COMPTENT, sinon l'écran affiche zéro là où il y a bien eu des envois.
    const r = estimateCoutParCampagne(
      [ligne('c1', 'Promo', null, 7)],
      { marketing: 0.1431, utility: null, currency: 'EUR' },
      new Map([['c1', 3]]),
    );
    expect(r.lignes[0]).toMatchObject({ envoyes: 7, cout: null, nonChiffrables: 7, coutParClic: null });
    // Categorie `null` : c est l heritage, pas la panne de tarif. Le tableau doit dire la meme chose que
    // la serie, sinon deux ecrans du meme onglet nomment differemment le meme envoi.
    expect(r.lignes[0]).toMatchObject({ sansCategorie: 7, sansTarif: 0 });
  });

  it('🔴 sur UNE campagne aussi, les deux causes restent separees', () => {
    // Une meme campagne peut porter les deux : de vieux envois sans categorie ET des envois recents dont
    // Meta ne rend pas le tarif. Les additionner ferait disparaitre celle des deux qui se repare.
    const r = estimateCoutParCampagne(
      [ligne('c1', 'Promo', null, 4), ligne('c1', 'Promo', 'utility', 6), ligne('c1', 'Promo', 'marketing', 10)],
      { marketing: 0.1431, utility: null, currency: 'EUR' },
      new Map([['c1', 2]]),
    );
    expect(r.lignes[0]).toMatchObject({ envoyes: 20, sansCategorie: 4, sansTarif: 6, nonChiffrables: 10 });
    // ...et le cout ne compte QUE les dix envois chiffrables.
    expect(r.lignes[0]!.cout).toBeCloseTo(1.43, 2);
  });

  it('une campagne PARTIELLEMENT chiffrable garde son coût et dit ce qui manque', () => {
    // Le cas réel : des envois de campagne (catégorie connue) et des envois de scénario rattachés qui n'en
    // portent pas. Vider tout le coût pour autant priverait le client du chiffre qu'il peut avoir.
    const r = estimateCoutParCampagne(
      [ligne('c1', 'Promo', 'marketing', 10), ligne('c1', 'Promo', null, 5)],
      TARIFS,
      new Map([['c1', 5]]),
    );
    expect(r.lignes[0]).toMatchObject({ envoyes: 15, cout: 1.43, nonChiffrables: 5 });
  });

  it('Meta ne rend aucun tarif -> hasRates faux, toute la colonne coût est vide', () => {
    const r = estimateCoutParCampagne(
      [ligne('c1', 'Promo', 'marketing', 10)],
      { marketing: null, utility: null, currency: null },
      new Map([['c1', 5]]),
    );
    expect(r.hasRates).toBe(false);
    expect(r.lignes[0]).toMatchObject({ cout: null, nonChiffrables: 10, coutParClic: null });
  });

  it('🔴 au-delà du plafond, le tableau TRONQUE et le DIT', async () => {
    // Une liste sans borne sur une plage qui accepte 366 jours rendrait des centaines de lignes dans une
    // page qu'on ouvre pour se faire une idée. Et une troncature muette se lit comme un inventaire complet,
    // ce qui est pire que la troncature elle-même : le client conclurait que la période n'a rien d'autre.
    const { PLAFOND_CAMPAGNES_SYNTHESE } = await import('../src/stats/cost');
    const beaucoup = Array.from({ length: PLAFOND_CAMPAGNES_SYNTHESE + 1 }, (_, i) =>
      ligne(`c${i}`, `Campagne ${i}`, 'marketing', i + 1));
    const r = estimateCoutParCampagne(beaucoup, TARIFS, new Map());
    expect(r.tronque).toBe(true);
    expect(r.lignes).toHaveLength(PLAFOND_CAMPAGNES_SYNTHESE);
    // 🔴 CE QU'ON GARDE EST « CELLES QUI ONT LE PLUS ENVOYÉ », comme le dit l'écran, et non « les moins
    // chères en moins ». La campagne 0 (un seul envoi) est donc la seule absente ; trancher au coût après
    // le tri d'affichage aurait produit un ensemble que la phrase de l'écran décrirait de travers.
    expect(r.lignes.some((l) => l.campaignId === 'c0')).toBe(false);
    expect(r.lignes.some((l) => l.campaignId === `c${PLAFOND_CAMPAGNES_SYNTHESE}`)).toBe(true);

    // Et l'autre sens : pile le plafond ne tronque pas, sinon l'écran annoncerait un reste qui n'existe pas.
    const r2 = estimateCoutParCampagne(beaucoup.slice(0, PLAFOND_CAMPAGNES_SYNTHESE), TARIFS, new Map());
    expect(r2.tronque).toBe(false);
    expect(r2.lignes).toHaveLength(PLAFOND_CAMPAGNES_SYNTHESE);
  });

  it('trié par coût décroissant, les campagnes sans coût en dernier', () => {
    const r = estimateCoutParCampagne(
      [ligne('c1', 'Petite', 'marketing', 1), ligne('c2', 'Grosse', 'marketing', 100), ligne('c3', 'Inconnue', null, 50)],
      TARIFS,
      new Map(),
    );
    expect(r.lignes.map((l) => l.campaignId)).toEqual(['c2', 'c1', 'c3']);
  });
});

/**
 * 🔴 UNE REPONSE EST UN ENGAGEMENT DE PREMIER NIVEAU (Julien, 2026-09-13, sur un cas reel : sur
 * « Testjulien2 », le destinataire n a PAS clique mais il a REPONDU).
 *
 * ⚠️ ON COMPTE DES PERSONNES, PAS DES GESTES, et c est un ecart assume avec la fiche des campagnes a
 * scenario. Tranche par Julien : diviser un cout par des PERSONNES donne ce que coute une personne
 * engagee, ce qui se compare d une campagne a l autre ; par des gestes, on flatte mecaniquement les
 * campagnes dont les gens reagissent plusieurs fois.
 */
describe('le cout par ENGAGEMENT', () => {
  const rows = [{ campaignId: 'c1', nom: 'Testjulien2', template: 'promo', canal: 'whatsapp', category: 'marketing', count: 100, envois: 100 }];
  const rates = { marketing: 0.05, utility: 0.01 };

  it('🔴 une campagne SANS clic mais AVEC des reponses a bien un cout par engagement', () => {
    // Le cas exact de Julien : zero clic, des gens qui ont repondu. Avant, la ligne etait vide.
    const r = estimateCoutParCampagne(rows as never, rates as never, new Map([['c1', 0]]), new Map([['c1', 4]]));
    const l = r.lignes[0]!;
    expect(l.clics).toBe(0);
    // 🔴 LE COUT PAR CLIC RESTE VIDE, et c est juste : personne n a clique. Les deux colonnes disent
    // deux choses differentes, et c est pour ca qu on a AJOUTE la seconde au lieu de renommer la premiere.
    expect(l.coutParClic).toBeNull();
    expect(l.engagements).toBe(4);
    expect(l.coutParEngagement).toBe(1.25); // 100 x 0,05 = 5 ; 5 / 4
  });

  it('sans mesure d engagement, la case est VIDE et non a zero', () => {
    // ⚠️ Le deploiement est decale (Vercel avant le VPS) : la reponse peut ne pas porter le champ.
    // « On ne sait pas » et « personne ne s est engage » n appellent pas la meme lecture.
    const r = estimateCoutParCampagne(rows as never, rates as never, new Map([['c1', 3]]));
    expect(r.lignes[0]!.engagements).toBeNull();
    expect(r.lignes[0]!.coutParEngagement).toBeNull();
  });

  it('zero engagement mesure ne produit AUCUN ratio, jamais un infini', () => {
    const r = estimateCoutParCampagne(rows as never, rates as never, new Map([['c1', 0]]), new Map([['c1', 0]]));
    expect(r.lignes[0]!.engagements).toBe(0);
    expect(r.lignes[0]!.coutParEngagement).toBeNull();
  });

  it('sans cout chiffrable, pas de ratio non plus', () => {
    const sansTarif = [{ campaignId: 'c1', nom: 'X', template: 'p', canal: 'whatsapp', category: null, count: 10, envois: 10 }];
    const r = estimateCoutParCampagne(sansTarif as never, rates as never, new Map(), new Map([['c1', 5]]));
    expect(r.lignes[0]!.cout).toBeNull();
    expect(r.lignes[0]!.coutParEngagement).toBeNull();
  });
});
