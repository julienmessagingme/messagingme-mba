import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * L'EN-TÊTE NE DOIT JAMAIS AFFICHER UN ZÉRO QU'IL N'A PAS MESURÉ.
 *
 * C'est la seule propriété de ce composant qui, si elle se perd, produit un mensonge à l'écran plutôt qu'un
 * défaut visible. Elle tient dans une garde `messagesTenus !== null` : ce test vérifie qu'elle est là, et que
 * personne ne l'a remplacée par un `??` au premier avertissement de typage.
 */
const SRC = readFileSync(join(resolve(__dirname, '..'), 'web', 'components', 'EnteteAgent.tsx'), 'utf8');

describe('EnteteAgent', () => {
  it('🔴 n affiche le chiffre QUE s il est connu', () => {
    expect(SRC).toContain('messagesTenus !== null');
    expect(SRC, 'un `??` transformerait « on ne sait pas » en un chiffre inventé')
      .not.toMatch(/messagesTenus\s*\?\?/);
  });

  it('🔴 le ratio n est rendu que s il existe vraiment', () => {
    // Le dénominateur n'existe pas côté agent IA : le rendre systématiquement obligerait à en inventer un.
    expect(SRC).toContain('ratio !== undefined');
  });

  it('⚠️ une étape sans onglet reste affichée', () => {
    expect(SRC).toContain('e.onglet === undefined');
  });

  it('🔴 n annonce « tout est réglé » QUE s il a lu les manques', () => {
    // Même famille que le chiffre : `etapes` à `null` veut dire « on ne sait pas ». Rendre la ligne quand
    // même afficherait « Tout est réglé » pendant le chargement et sur un écran bloqué, donc une affirmation
    // que personne n'a mesurée, juste à côté d'un bandeau qui dit le contraire.
    expect(SRC).toContain('etapes !== null');
    expect(SRC, 'un `?? []` transformerait « on ne sait pas » en « tout est réglé »')
      .not.toMatch(/etapes\s*\?\?\s*\[\]/);
  });

  it('🔴 ce qu on ne sait pas garde sa ligne, HORS du compte d étapes', () => {
    /**
     * LE DÉFAUT QUE LA REVUE FINALE A TROUVÉ : la liste grise des `inconnue` obligatoires (le moyen de
     * paiement en tête) avait purement disparu de l'écran avec l'ancien `MbaCompletion`, pendant que cinq
     * textes continuaient de promettre qu'elle « gardait sa ligne ».
     *
     * 🔴 LES DEUX SENS COMPTENT, ET LE SECOND EST LE PLUS IMPORTANT : elle est rendue, ET elle est rendue
     * AILLEURS que dans `etapes`. La verser dans les étapes la ferait entrer dans « n étapes à finir », ce
     * que `src/mba/completion.ts` et le champ `indeterminees` interdisent tous les deux.
     */
    expect(SRC).toContain('data-testid="entete-agent-signalements"');
    expect(SRC).toContain('signalements !== undefined');
    // Le compte se prend sur `etapes.length` et NULLE PART ailleurs : c'est ce qui rend mécaniquement
    // impossible qu'un signalement entre dans « n étapes à finir », quoi qu'on ajoute à l'en-tête.
    expect(SRC).toContain('libelleEtapes(etapes.length, t)');
  });
});

/**
 * LA FENÊTRE DU CHIFFRE D'UN AGENT IA (`{ messages, jours }`), lue avec le chiffre (`lireMessagesTenus`) et
 * CITÉE par la légende : ce test vérifie que la légende la cite, et qu'aucun nombre de jours écrit en dur ne
 * revient.
 *
 * ⚠️ L'agent de Meta n'a plus de fenêtre depuis le 2026-09-25 (les messages qu'il a ÉCRITS, depuis toujours) :
 * `JOURS_MESSAGES` a disparu, et avec lui l'égalité qu'il fallait tenir avec `JOURS_CONSOMMATION`.
 */
describe('la fenêtre du chiffre', () => {
  it('🔴 la légende CITE la fenêtre rendue par le serveur, dans les deux langues', () => {
    expect(SRC).toContain('sur ${jours} jours');
    expect(SRC).toContain('over ${jours} days');
  });

  it('⚠️ et aucun nombre de jours écrit en DUR ne traîne dans le composant', () => {
    // Un « sur 30 jours » oublié à côté de la légende citée ferait dire deux fenêtres au même écran.
    const enDur = [...SRC.matchAll(/(?:sur|over) (\d+) (?:jours|days)/g)].map((m) => m[0]);
    expect(enDur, `fenêtre(s) écrite(s) en dur dans la légende : ${enDur.join(', ')}`).toEqual([]);
  });
});
