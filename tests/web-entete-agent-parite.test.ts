import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JOURS_MESSAGES } from '../src/http/mba';
import { JOURS_CONSOMMATION } from '../src/http/agents';

/**
 * L'EN-TÊTE NE DOIT JAMAIS AFFICHER UN ZÉRO QU'IL N'A PAS MESURÉ.
 *
 * C'est la seule propriété de ce composant qui, si elle se perd, produit un mensonge à l'écran plutôt qu'un
 * défaut visible. Elle tient dans une garde `messages30j !== null` : ce test vérifie qu'elle est là, et que
 * personne ne l'a remplacée par un `?? 0` au premier avertissement de typage.
 */
const SRC = readFileSync(join(resolve(__dirname, '..'), 'web', 'components', 'EnteteAgent.tsx'), 'utf8');

describe('EnteteAgent', () => {
  it('🔴 n affiche le chiffre QUE s il est connu', () => {
    expect(SRC).toContain('messages30j !== null');
    expect(SRC, 'un `?? 0` transformerait « on ne sait pas » en « personne n a parlé »')
      .not.toMatch(/messages30j\s*\?\?\s*0/);
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
 * 🔴 LE NOMBRE 30 EST ÉCRIT À PLUSIEURS ENDROITS, ET RIEN NE LES TENAIT ENSEMBLE.
 *
 * Deux constantes serveur portent la fenêtre du chiffre de l'en-tête : `JOURS_MESSAGES` pour l'agent de Meta,
 * `JOURS_CONSOMMATION` pour un agent IA. Elles doivent rester ÉGALES, parce que les deux nombres se lisent
 * dans le même dessin sous le même mot, et parce que la consommation d'un agent IA s'affiche à deux onglets
 * de son compte de messages. « La même que » était écrit en prose dans les deux fichiers, donc vérifié par
 * personne.
 *
 * ⚠️ LE TEXTE DE L'EN-TÊTE EST LA TROISIÈME COPIE, et c'est celle que le client lit. La spec dit que la
 * fenêtre est RENDUE par le serveur (`{ messages, jours }`) et que l'écran ne l'invente pas : tant qu'elle
 * reste écrite en dur dans la légende, la seule parade honnête est de DÉRIVER le nombre attendu de la
 * constante plutôt que de le réécrire ici. Le passage en prop reste le correctif propre, et il n'est pas
 * fait : ce test est ce qui empêche la divergence en attendant.
 */
describe('la fenêtre de 30 jours', () => {
  it('🔴 les deux constantes serveur sont ÉGALES', () => {
    expect(JOURS_MESSAGES).toBe(JOURS_CONSOMMATION);
  });

  it('🔴 et le texte de l en-tête porte CE nombre, dans les deux langues', () => {
    expect(SRC, `la légende française doit dire « sur ${JOURS_MESSAGES} jours »`)
      .toContain(`sur ${JOURS_MESSAGES} jours`);
    expect(SRC, `la légende anglaise doit dire « over ${JOURS_MESSAGES} days »`)
      .toContain(`over ${JOURS_MESSAGES} days`);
  });

  it('⚠️ et aucun AUTRE nombre de jours ne traîne dans le composant', () => {
    // Sans ce sens-là, changer la fenêtre à 60 laisserait le test précédent passer sur une légende qui
    // porterait les DEUX (« sur 60 jours » ajouté à côté d'un « sur 30 jours » oublié).
    const autres = [...SRC.matchAll(/(?:sur|over) (\d+) (?:jours|days)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n !== JOURS_MESSAGES);
    expect(autres, `fenêtre(s) étrangère(s) dans la légende : ${autres.join(', ')}`).toEqual([]);
  });
});
