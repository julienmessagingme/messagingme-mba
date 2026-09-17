import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LES DEUX COPIES DE LA RÈGLE « QUEL NOM DE PARAMÈTRE » DOIVENT DIRE LA MÊME CHOSE.
 *
 * 🔴 ELLES AVAIENT DIVERGÉ, ET PERSONNE NE POUVAIT LE VOIR. `nomParametreJs`
 * (`web/components/WorkflowConfigPanel.tsx`) écartait `now`, quand `nomDeParametreSur`
 * (`src/workflow/fonction-js.ts`) l'accepte. Le moteur injectait donc un paramètre `now` que l'écran
 * annonçait comme inexistant : il affichait `function (valeur)` là où `function (now)` marchait aussi.
 * ⚠️ Le sens du défaut compte : l'écran promettait MOINS que le moteur, donc rien ne cassait, et c'est
 * précisément pour ça que ça pouvait durer.
 *
 * 🔴 POURQUOI UNE COPIE PLUTÔT QU'UN IMPORT : `web/` et la racine sont deux projets TypeScript séparés,
 * le front ne peut pas importer `src/`. La copie est donc inévitable ; ce qui ne l'est pas, c'est qu'elle
 * dérive en silence. C'est le cas d'école des « deux constantes de fichiers différents qui doivent rester
 * ordonnées » : l'invariant n'est visible dans aucun des deux, il ne peut vivre que dans un test.
 *
 * ⚠️ CE TEST LIT LES DEUX SOURCES, il ne les exécute pas : il compare les DEUX règles, pas deux résultats
 * sur des cas qu'on aurait choisis. Un jeu de cas choisi par l'auteur de la divergence ne l'aurait pas vue.
 */

const MOTEUR = 'src/workflow/fonction-js.ts';
const ECRAN = 'web/components/WorkflowConfigPanel.tsx';

/** Le corps de la fonction nommée, tel qu'il est écrit, commentaires retirés. */
function regle(fichier: string, nom: string): string {
  const src = readFileSync(fichier, 'utf8');
  const debut = src.indexOf(`function ${nom}(`);
  expect(debut, `${nom} introuvable dans ${fichier}`).toBeGreaterThan(-1);
  const corps = src.slice(debut, src.indexOf('\n}', debut));
  return corps
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('la règle du nom de paramètre est la MÊME des deux côtés', () => {
  it('🔴 le REFUS est écrit à l’identique : même motif, même exception', () => {
    const moteur = regle(MOTEUR, 'nomDeParametreSur');
    const ecran = regle(ECRAN, 'nomParametreJs');
    const condition = (s: string): string => {
      const i = s.indexOf('if (!cle');
      return s.slice(i, s.indexOf('return null;', i) + 'return null;'.length);
    };
    expect(condition(ecran), 'l’écran annoncerait un nom que le moteur n’injecte pas, ou l’inverse')
      .toBe(condition(moteur));
  });

  it('🔴 et la liste des mots RÉSERVÉS est la même, mot pour mot', () => {
    const mots = (s: string): string[] => {
      const i = s.indexOf('RESERVES');
      const bloc = s.slice(s.indexOf('[', i), s.indexOf(']', i));
      return (bloc.match(/'[^']+'/g) ?? []).map((m) => m.slice(1, -1)).sort();
    };
    const m = mots(regle(MOTEUR, 'nomDeParametreSur'));
    expect(m.length, 'la liste des mots réservés est introuvable').toBeGreaterThan(30);
    expect(mots(regle(ECRAN, 'nomParametreJs'))).toEqual(m);
  });

  it('⚠️ et `now` passe des deux côtés : c’est la divergence qui a motivé ce test', () => {
    // Un cas NOMMÉ en plus de la comparaison structurelle : si quelqu'un réécrit les deux règles de la même
    // façon FAUSSE, la comparaison ci-dessus reste verte. Celui-ci dit ce qu'on attend, pas seulement que
    // les deux s'accordent.
    for (const f of [MOTEUR, ECRAN]) {
      expect(readFileSync(f, 'utf8'), `${f} écarte encore « now » par un cas particulier`)
        .not.toMatch(/cle === CHAMP_MAINTENANT/);
    }
  });
});
