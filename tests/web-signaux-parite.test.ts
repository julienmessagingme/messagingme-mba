import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EVENEMENTS_SIGNAUX, ATTRIBUTS_SIGNAUX, CHAMP_ID_DOC } from '../web/lib/signaux-dictionnaire';
import { NOMS_EVENEMENTS, NOMS_ATTRIBUTS, CHAMPS_EVENEMENT, CHAMP_ID_EVENEMENT, type NomEvenement } from '../src/signaux/types';
import { OUTILS_TIERS } from './outils-tiers';

/**
 * LA DOCUMENTATION DES SIGNAUX (lot 6 de l'API publique).
 *
 * 🔴 DEUX PROPRIÉTÉS, et la seconde est une demande de Julien du 2026-09-24 (« pas de mention particulière à
 * Batch dans la doc, ça doit servir à d'autres aussi ») : la doc liste EXACTEMENT le dictionnaire du serveur,
 * noms de CHAMPS compris, et elle ne nomme AUCUN outil tiers. Le nom de l'outil branché n'existe que sur son
 * écran de réglage. Les champs comptent autant que les événements : la page promet qu'ils « restent les mêmes
 * quel que soit l'outil », et c'est parce qu'ils vivent dans le dictionnaire (et pas dans un adaptateur) que la
 * promesse peut être tenue.
 *
 * ⚠️ La page qui monte la section et ses exemples sont gardés par `tests/api-exemples.test.ts`, avec la MÊME
 * liste d'outils (`./outils-tiers`) ; ce fichier-ci garde les deux fichiers de la section.
 */
const lire = (chemin: string): string => readFileSync(new URL(`../${chemin}`, import.meta.url), 'utf8');

describe('la documentation des signaux', () => {
  it('🔴 les événements documentés sont EXACTEMENT ceux du dictionnaire', () => {
    expect(EVENEMENTS_SIGNAUX.map((e) => e.nom).sort()).toEqual([...NOMS_EVENEMENTS].sort());
  });

  it('🔴 les attributs documentés sont EXACTEMENT ceux du dictionnaire', () => {
    expect(ATTRIBUTS_SIGNAUX.map((a) => a.nom).sort()).toEqual([...NOMS_ATTRIBUTS].sort());
  });

  it('🔴 les CHAMPS documentés de chaque événement sont EXACTEMENT ceux du dictionnaire, dans son ordre', () => {
    for (const e of EVENEMENTS_SIGNAUX) {
      expect([...e.champs], e.nom).toEqual([...CHAMPS_EVENEMENT[e.nom as NomEvenement]]);
    }
    expect(CHAMP_ID_DOC).toBe(CHAMP_ID_EVENEMENT);
  });

  it('chaque entrée a son texte dans les deux langues', () => {
    for (const e of EVENEMENTS_SIGNAUX) for (const v of [...e.quand, ...e.note]) expect(v.trim(), e.nom).not.toBe('');
    for (const a of ATTRIBUTS_SIGNAUX) for (const v of a.sens) expect(v.trim(), a.nom).not.toBe('');
  });

  describe('🔴 aucun outil tiers n’est nommé : la documentation sert à tous les intégrateurs', () => {
    const fichiers = ['web/lib/signaux-dictionnaire.ts', 'web/components/DocSignaux.tsx'];
    it.each(fichiers.flatMap((f) => OUTILS_TIERS.map(([nom, motif]) => ({ f, nom, motif }))))('$f ne nomme pas $nom', ({ f, motif }) => {
      expect(lire(f)).not.toMatch(motif);
    });
  });

  it('la section est bien rendue par la page', () => {
    expect(lire('web/app/developers/api/page.tsx')).toMatch(/<DocSignaux \/>/);
  });
});
