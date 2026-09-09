import { describe, it, expect } from 'vitest';
import { phrasesNonChiffrables } from './cout-non-chiffrable';

const fmt = (n: number): string => String(n);

describe('phrasesNonChiffrables', () => {
  it('rien à dire quand tout est chiffré', () => {
    expect(phrasesNonChiffrables({ nonChiffrables: 0, sansCategorie: 0, sansTarif: 0 }, 'periode', fmt)).toEqual([]);
  });

  it('🔴 les deux causes ne portent PAS la même promesse de réparation', () => {
    // C'est la raison d'être du partage : l'une est close, l'autre s'ouvrira demain. Un lecteur qui ne peut
    // pas les distinguer ne sait pas s'il doit attendre ou aller réparer.
    const [herite] = phrasesNonChiffrables({ nonChiffrables: 3, sansCategorie: 3, sansTarif: 0 }, 'periode', fmt);
    expect(herite?.fr).toMatch(/ne redeviendra pas chiffrable/);
    expect(herite?.fr).toMatch(/7 septembre 2026/);

    const [panne] = phrasesNonChiffrables({ nonChiffrables: 3, sansCategorie: 0, sansTarif: 3 }, 'periode', fmt);
    expect(panne?.fr).toMatch(/redeviendront chiffrables/);
    expect(panne?.fr).not.toMatch(/7 septembre 2026/);
  });

  it('les deux à la fois -> deux phrases, jamais une somme muette', () => {
    const p = phrasesNonChiffrables({ nonChiffrables: 7, sansCategorie: 2, sansTarif: 5 }, 'periode', fmt);
    expect(p).toHaveLength(2);
    expect(p[0]?.fr.startsWith('2 envoi(s)')).toBe(true);
    expect(p[1]?.fr.startsWith('5 envoi(s)')).toBe(true);
  });

  it('🔴 la PORTÉE change la phrase : un tableau qui tronque ne parle pas de la période', () => {
    // Annoncer « de la période » sur une liste tronquée serait faux exactement là où le chiffre compte le
    // plus : quand des campagnes sont écartées et que leurs envois ne sont comptés nulle part.
    const [campagnes] = phrasesNonChiffrables({ nonChiffrables: 1, sansCategorie: 1, sansTarif: 0 }, 'campagnes-affichees', fmt);
    expect(campagnes?.fr).toContain('des campagnes affichées');
    expect(campagnes?.en).toContain('among the campaigns shown');
    const [periode] = phrasesNonChiffrables({ nonChiffrables: 1, sansCategorie: 1, sansTarif: 0 }, 'periode', fmt);
    expect(periode?.fr).toContain('de la période');
    expect(periode?.en).toContain('over this period');
  });

  it('un compte absurde venu du réseau ne produit pas une phrase absurde', () => {
    // Le type est une promesse, pas une preuve : « undefined envoi(s) » serait pire que le silence.
    const nimporteQuoi = { nonChiffrables: undefined } as unknown as { nonChiffrables: number };
    expect(phrasesNonChiffrables(nimporteQuoi, 'periode', fmt)).toEqual([]);
  });

  /**
   * 🔴 LA FENÊTRE OÙ LE NOUVEAU FRONT PARLE À L'ANCIENNE API, et elle est STRUCTURELLE ici : Vercel déploie
   * la console à chaque push, le VPS déploie l'API à la main. Pendant ce temps, la réponse ne porte que
   * `nonChiffrables`. Exiger le détail ferait disparaître la phrase, donc escamoter l'information même que
   * l'écran existe pour dire, et sans aucun signe. Ce test est le seul endroit qui garde cette fenêtre.
   */
  it('🔴 API sans le détail -> la phrase GÉNÉRIQUE, jamais le silence', () => {
    const p = phrasesNonChiffrables({ nonChiffrables: 22 }, 'periode', fmt);
    expect(p).toHaveLength(1);
    expect(p[0]?.fr).toContain('22 envoi(s)');
    // Elle ne PROMET rien qu'on ne sache : ni la date de l'héritage, ni une réparation à venir.
    expect(p[0]?.fr).not.toMatch(/7 septembre 2026/);
    expect(p[0]?.fr).not.toMatch(/redeviendront chiffrables/);
  });

  it('🔴 un détail qui ne TOTALISE PAS le compte annoncé est refusé, on retombe sur le générique', () => {
    // Deux phrases dont les nombres ne font pas le total affiché ailleurs sont pires qu'une phrase vague :
    // le lecteur ne sait plus lequel des deux chiffres croire.
    const p = phrasesNonChiffrables({ nonChiffrables: 10, sansCategorie: 2, sansTarif: 3 }, 'periode', fmt);
    expect(p).toHaveLength(1);
    expect(p[0]?.fr).toContain('10 envoi(s)');
    expect(p[0]?.fr).toContain('ou Meta n’en rend pas le tarif');
  });

  it('un détail à moitié présent est traité comme absent', () => {
    const p = phrasesNonChiffrables({ nonChiffrables: 4, sansCategorie: 4 }, 'periode', fmt);
    expect(p).toHaveLength(1);
    expect(p[0]?.fr).not.toMatch(/7 septembre 2026/);
  });

  it('le formateur injecté est bien celui qui écrit le nombre', () => {
    const [p] = phrasesNonChiffrables({ nonChiffrables: 1234, sansCategorie: 1234, sansTarif: 0 }, 'periode', (n) => `<${n}>`);
    expect(p?.fr.startsWith('<1234> envoi(s)')).toBe(true);
  });
});
