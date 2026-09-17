import { describe, it, expect } from 'vitest';
import { granularite, lundiDe, regrouper, SEUIL_SEMAINE_JOURS, type JourAnalyse } from './jours-analyse';

/**
 * LE REGROUPEMENT DES JOURNEES D'ANALYSE.
 *
 * 🔴 CE QUE CES TESTS PROTEGENT, ET QUI NE SE VOIT PAS EN LISANT LE CODE : la PONDERATION des moyennes.
 * Une semaine ou un jour porte 1 mesure a 9 et un autre 9 mesures a 3 ne fait PAS une moyenne de 6. Une
 * moyenne de moyennes non ponderee est l'erreur la plus naturelle du monde, elle rend un nombre plausible,
 * et rien a l'ecran ne la contredit. Le client lit ce nombre pour savoir si ses clients vont bien.
 */

const J = (jour: string, conversations: number, satisfaction: number | null, urgence: number | null, mesurees: number): JourAnalyse =>
  ({ jour, conversations, satisfaction, urgence, mesurees });

describe('granularite', () => {
  it('sous le seuil : par jour', () => {
    expect(granularite(30)).toBe('jour');
    expect(granularite(SEUIL_SEMAINE_JOURS)).toBe('jour');
  });

  it('🔴 au-dela du seuil : par semaine', () => {
    // Le choix de Julien du 2026-09-17 (« 1 et 2 en meme temps ») : jours vides masques ET regroupement
    // hebdomadaire au-dela de 90 jours.
    expect(granularite(SEUIL_SEMAINE_JOURS + 1)).toBe('semaine');
    expect(granularite(366)).toBe('semaine');
  });

  it('🔴 le FORCAGE gagne toujours, dans les DEUX sens', () => {
    // Le bascule manuel est ce qui rend le changement automatique acceptable : sans lui, un lecteur qui
    // veut le detail d'une longue periode n'a aucun recours.
    expect(granularite(366, 'jour')).toBe('jour');
    expect(granularite(7, 'semaine')).toBe('semaine');
  });
});

describe('lundiDe', () => {
  it('un mercredi rend son lundi', () => {
    // 2026-09-16 est un mercredi.
    expect(lundiDe('2026-09-16')).toBe('2026-09-14');
  });

  it('un lundi se rend lui-meme', () => {
    expect(lundiDe('2026-09-14')).toBe('2026-09-14');
  });

  it('🔴 un DIMANCHE rend le lundi qui PRECEDE, pas celui du lendemain', () => {
    // Le piege classique de `getDay()` : dimanche vaut 0, donc un `-(d - 1)` naif avancerait d'un jour et
    // rangerait le dimanche dans la semaine SUIVANTE. La semaine serait alors coupee au mauvais endroit.
    expect(lundiDe('2026-09-20')).toBe('2026-09-14');
  });

  it('⚠️ il traverse un changement de mois et une annee bissextile', () => {
    expect(lundiDe('2026-03-01')).toBe('2026-02-23');
    expect(lundiDe('2024-03-01')).toBe('2024-02-26');
  });
});

describe('regrouper par jour', () => {
  it('rend une ligne par journee, telle quelle', () => {
    const r = regrouper([J('2026-09-16', 3, 7, 4, 2), J('2026-09-15', 1, null, null, 0)], 'jour');
    expect(r.map((l) => l.debut)).toEqual(['2026-09-16', '2026-09-15']);
    expect(r[0]).toMatchObject({ conversations: 3, satisfaction: 7, urgence: 4, mesurees: 2 });
  });

  it('🔴 une journee SANS mesure garde `null`, jamais zero', () => {
    // Zero est une note valide et la PIRE : la confondre avec « pas de mesure » rangerait tout
    // l'historique d'avant la migration 0121 dans le coin « clients furieux ».
    expect(regrouper([J('2026-09-15', 4, null, null, 0)], 'jour')[0]!.satisfaction).toBeNull();
  });

  it('une liste vide rend une liste vide', () => {
    expect(regrouper([], 'jour')).toEqual([]);
  });
});

describe('regrouper par semaine', () => {
  it('🔴 LA MOYENNE EST PONDEREE PAR LES MESURES, pas une moyenne de moyennes', () => {
    // Lundi : 1 analyse mesuree a 9. Mardi : 9 analyses mesurees a 3. La bonne moyenne est
    // (9x1 + 3x9) / 10 = 3,6. La moyenne des moyennes rendrait 6, un nombre parfaitement plausible et faux
    // du simple au double. C'est le defaut que ce fichier existe pour empecher.
    const r = regrouper([J('2026-09-14', 1, 9, 9, 1), J('2026-09-15', 9, 3, 3, 9)], 'semaine');
    expect(r).toHaveLength(1);
    expect(r[0]!.satisfaction).toBeCloseTo(3.6, 5);
    expect(r[0]!.urgence).toBeCloseTo(3.6, 5);
  });

  it('🔴 ET SURTOUT PAS PONDEREE PAR LES CONVERSATIONS', () => {
    // Mardi porte 100 conversations mais une seule mesure. Ponderer par les conversations tirerait la
    // moyenne vers le jour le plus BAVARD au lieu du plus MESURE, et compterait des analyses sans note.
    const r = regrouper([J('2026-09-14', 1, 10, 10, 1), J('2026-09-15', 100, 2, 2, 1)], 'semaine');
    expect(r[0]!.satisfaction).toBeCloseTo(6, 5);
  });

  it('🔴 les journees se rangent sous le LUNDI de leur semaine', () => {
    // Deux semaines distinctes : le dimanche 20 appartient a la semaine du 14, pas a celle du 21.
    const r = regrouper([J('2026-09-21', 1, 5, 5, 1), J('2026-09-20', 1, 5, 5, 1), J('2026-09-14', 1, 5, 5, 1)], 'semaine');
    expect(r.map((l) => l.debut)).toEqual(['2026-09-21', '2026-09-14']);
    expect(r[1]!.jours).toEqual(['2026-09-20', '2026-09-14']);
  });

  it('🔴 les JOURS COUVERTS voyagent avec la ligne, sinon le clic ouvre le mauvais detail', () => {
    // Cliquer une semaine doit ouvrir les conversations de CES jours-la. Sans la liste, l'ecran devrait
    // recalculer une plage, et une semaine partielle (debut ou fin de periode) ouvrirait des jours que la
    // ligne ne comptait pas.
    const r = regrouper([J('2026-09-16', 2, null, null, 0), J('2026-09-14', 1, null, null, 0)], 'semaine');
    expect(r[0]!.jours).toEqual(['2026-09-16', '2026-09-14']);
    expect(r[0]!.conversations).toBe(3);
  });

  it('🔴 une semaine SANS aucune mesure rend `null`, pas zero', () => {
    const r = regrouper([J('2026-09-16', 5, null, null, 0), J('2026-09-15', 3, null, null, 0)], 'semaine');
    expect(r[0]!.satisfaction).toBeNull();
    expect(r[0]!.urgence).toBeNull();
    expect(r[0]!.conversations).toBe(8);
  });

  it('⚠️ le plus RECENT en tete, comme la liste des journees', () => {
    const r = regrouper([J('2026-09-07', 1, 5, 5, 1), J('2026-09-21', 1, 5, 5, 1), J('2026-09-14', 1, 5, 5, 1)], 'semaine');
    expect(r.map((l) => l.debut)).toEqual(['2026-09-21', '2026-09-14', '2026-09-07']);
  });

  it('⚠️ une journee avec des conversations mais AUCUNE mesure compte quand meme son volume', () => {
    // Le volume et la mesure sont deux questions : une semaine peut etre tres active et n'avoir aucune
    // note. Oublier son volume la ferait disparaitre du tableau.
    const r = regrouper([J('2026-09-16', 12, null, null, 0), J('2026-09-15', 2, 8, 2, 2)], 'semaine');
    expect(r[0]!.conversations).toBe(14);
    expect(r[0]!.mesurees).toBe(2);
    expect(r[0]!.satisfaction).toBeCloseTo(8, 5);
  });
});
