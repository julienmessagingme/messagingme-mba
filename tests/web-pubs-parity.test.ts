import { describe, it, expect } from 'vitest';
import { TAILLE_VISUEL_PUB_MAX, TYPES_VISUEL_PUB } from '../src/meta/pubs-creation';
import { TAILLE_VISUEL_MAX, TYPES_VISUEL } from '../web/lib/api-pubs';
import { ISSUES_NON_PRISES_EN_CHARGE } from '../src/pubs/entonnoir';

/**
 * LES BORNES DU VISUEL D'UNE PUBLICITÉ, DES DEUX CÔTÉS.
 *
 * L'écran refuse AVANT de téléverser (attendre cinq mégaoctets pour se faire dire non est une mauvaise
 * expérience, et la limite de corps de la route couperait de toute façon), le serveur refuse en dernier
 * ressort. Deux chiffres qui divergent donnent le pire des deux : un écran qui promet ce que le serveur
 * refuse, avec un 400 que personne ne relie à la promesse. Même patron que les autres tests de parité du
 * dépôt.
 *
 * 🔴 C'EST L'ÉCART QUI PORTE L'INVARIANT, PAS CHAQUE CONSTANTE. Prise seule, chacune est plausible : cinq
 * mégaoctets ici, six là, personne ne sursaute en relisant l'un des deux fichiers. Ce genre d'invariant
 * n'est visible dans aucun des deux, et ne tient donc que dans un test.
 */
describe('parité des bornes du visuel publicitaire', () => {
  it('l’écran et le serveur annoncent le MÊME poids maximum', () => {
    expect(TAILLE_VISUEL_MAX).toBe(TAILLE_VISUEL_PUB_MAX);
  });

  it('l’écran et le serveur acceptent les MÊMES types', () => {
    expect([...TYPES_VISUEL]).toEqual([...TYPES_VISUEL_PUB]);
  });

  it('🔴 ni SVG ni GIF, des deux côtés : ce fichier part chez un tiers sous l’identité du client', () => {
    // Un SVG est un document exécutable. Le laisser entrer par le côté où la garde est la plus faible
    // suffirait : c'est le serveur qui décide, et l'écran ne doit pas lui promettre autre chose.
    for (const liste of [[...TYPES_VISUEL], [...TYPES_VISUEL_PUB]]) {
      expect(liste).not.toContain('image/svg+xml');
      expect(liste).not.toContain('image/gif');
    }
  });
});

/**
 * L'ÉCRAN NOMME LES TROIS ISSUES « NON PRISES EN CHARGE », et il doit nommer LES MÊMES que le serveur.
 *
 * ⚠️ CE TEST LIT UN TEXTE D'ÉCRAN, DONC IL PINCE UNE ORTHOGRAPHE, et c'est assumé : ce qu'il protège n'est
 * pas un comportement (le calcul est fait côté serveur) mais une PROMESSE faite au client. Si le serveur
 * cessait de compter les désabonnés et que l'écran continuait de les annoncer, le chiffre resterait juste et
 * la phrase deviendrait fausse, ce qu'aucun test de comportement ne verrait.
 */
describe('ce que l’écran annonce sur les prospects non pris en charge', () => {
  it('les trois issues du serveur sont bien celles que l’écran énumère', () => {
    expect([...ISSUES_NON_PRISES_EN_CHARGE]).toEqual(['reprise_refusee', 'desabonne', 'bloque', 'sans_scenario']);
  });
});
