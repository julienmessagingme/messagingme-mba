import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE LA DISPONIBILITÉ DE L'ÉQUIPE, DANS LES DEUX PROCESSUS (lot 1 du 2026-09-18).
 *
 * 🔴 CE TEST EXISTE PARCE QUE LA DÉPENDANCE EST OPTIONNELLE, ET QUE L'OPTIONNEL NE SE VOIT PAS. Absente,
 * `lireContexteAgent` rend un contexte sans `equipe`, l'agent se croit toujours joignable, et il promet un
 * conseiller à 3 h du matin. Aucun test unitaire ne le verrait : ils appellent tous la fonction en lui
 * passant ce qu'ils veulent. C'est mot pour mot la leçon du dépôt, « une garde qu'on peut débrancher sans
 * qu'aucun test ne tombe n'est pas une garde », vérifiée par mutation sur les deux fichiers.
 *
 * 🔴 ET IL Y EN A DEUX, PAS UN. Le tour de production (`worker.ts`) et le bac à sable de la console
 * (`index.ts`) construisent le contexte par le même point de passage, précisément pour que l'essai montre ce
 * que la production fera. Câbler un seul des deux redonnerait au bac à sable un comportement que la
 * production n'a pas, c'est-à-dire exactement ce que ce point de passage existe pour empêcher.
 *
 * ⚠️ Il LIT LE FICHIER, comme `campagne-cablage.test.ts`, et pour la même raison : ce qui traverse un
 * câblage ne se vérifie pas au type, il se vérifie en le regardant. Les commentaires sont retirés, sans quoi
 * une explication qui CITE le bon code ferait passer un câblage fautif.
 */
const sansCommentaires = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const CABLAGES = [
  { quoi: 'le tour de production', fichier: '../src/worker.ts' },
  { quoi: 'le bac à sable de la console', fichier: '../src/index.ts' },
];

describe('la disponibilité de l’équipe est câblée', () => {
  for (const { quoi, fichier } of CABLAGES) {
    describe(quoi, () => {
      const source = sansCommentaires(fichier);

      it('🔴 passe `disponibiliteEquipe` à `lireContexteAgent`', () => {
        expect(source).toContain('disponibiliteEquipe: async () => equipePourPrompt(');
      });

      it('🔴 lit le RÉGLAGE de l’espace, pas une valeur en dur', () => {
        // Un câblage qui passerait `'always'` en dur compilerait, passerait le test précédent, et rendrait
        // le réglage de l'écran parfaitement inerte.
        expect(source).toContain('reglages.agentTransfertMode ?? MODE_TRANSFERT_DEFAUT');
      });

      it('🔴 lit les horaires ET le fuseau de l’espace', () => {
        // Le fuseau décide du jour : sans lui, un samedi soir à Paris se lit comme un vendredi ailleurs, et
        // la réouverture annoncée est fausse d'un jour entier.
        expect(source).toContain('reglages.timezone');
        expect(source).toContain('reglages.businessHours');
      });

      it('⚠️ prend l’heure AU MOMENT DU TOUR', () => {
        // Une disponibilité calculée à l'ouverture d'une conversation serait fausse sur celle qui traverse
        // l'heure de fermeture, c'est-à-dire précisément celles qui nous intéressent.
        expect(source).toMatch(/disponibiliteEquipe: async \(\) => equipePourPrompt\([\s\S]{0,200}new Date\(\)/);
      });

      it('⚠️ ne lit les réglages QU’UNE FOIS pour les deux politiques d’espace', () => {
        // Cette fonction est sur le chemin de chaque tour d'agent : deux `get` y feraient deux allers-retours
        // pour la même ligne. La seconde politique est arrivée à côté de la première, c'est le moment exact
        // où l'on duplique une lecture sans s'en apercevoir.
        // Une fenetre a partir du debut du cablage : chercher sa fin par accolade se ferait pieger par la
        // premiere accolade venue, et le test passerait alors sur une tranche vide, donc a vide.
        const debut = source.indexOf('contexte: async');
        const bloc = source.slice(debut, debut + 900);
        expect(bloc.match(/settingsStore\.get\(/g) ?? []).toHaveLength(1);
      });
    });
  }
});

/**
 * 🔴 ET LE CÂBLAGE QUI RENDAIT TOUT LE LOT INERTE (revue finale, 2026-09-18).
 *
 * `escalateToHuman` était écrit `async (t, waId) => { await inboxStore.setControlOwner(...); }` : les
 * accolades AVALAIENT le booléen. Or c'est le seul fait qui distingue « c'est nous qui venons de prendre la
 * main » de « un opérateur l'avait déjà prise », et sans lui `run-turn` jetait la dernière phrase de
 * l'agent, celle qui dit au contact que l'équipe est fermée. Tout le lot des horaires était calculé,
 * transporté, affiché dans le bac à sable, et perdu à l'envoi.
 *
 * ⚠️ C'EST LA QUESTION QU'ON POSE À UN CÂBLAGE, qui n'a par construction aucun dépendant : « que
 * suppose-t-il du module que je viens de changer ? ». Ici, que la bascule DIT si elle a eu lieu.
 */
describe('la bascule vers un humain rend son verdict', () => {
  const source = sansCommentaires('../src/worker.ts');

  it('🔴 `escalateToHuman` REND ce que `setControlOwner` a répondu, il ne l’avale pas', () => {
    expect(source).toContain(
      "escalateToHuman: (t, waId) => inboxStore.setControlOwner(t, waId, 'app_human', { only: ['app_workflow'] })",
    );
  });

  it('⚠️ et il ne reste aucune forme à accolades, qui rendrait `void` sans que rien ne le signale', () => {
    expect(source).not.toMatch(/escalateToHuman:\s*async\s*\([^)]*\)\s*=>\s*\{/);
  });
});
