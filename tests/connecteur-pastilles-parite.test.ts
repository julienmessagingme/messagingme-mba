import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOTIF_PASTILLE } from '../web/lib/partage/pastille';

/**
 * LE MOTIF D'UNE PASTILLE `{{nom}}`, ÉCRIT UNE FOIS (`web/lib/partage/pastille.ts`) ET LU À QUATRE ENDROITS.
 *
 * 🔴 IL ÉTAIT RECOPIÉ EN QUATRE LITTÉRAUX, et c'est leur égalité qui portait l'invariant : le serveur substitue selon
 * son motif, l'écran des connecteurs signale les pastilles mal placées selon le sien, l'éditeur de messages en
 * affiche des pastilles selon un troisième. Le motif est désormais partagé ; ce test vérifie que chacun le lit au lieu
 * d'en réécrire un, et que le motif accepte ce que les écrans laissent saisir.
 */

const RACINE = resolve(__dirname, '..');
const lire = (chemin: string): string => readFileSync(resolve(RACINE, chemin), 'utf8');

describe('le motif d’une pastille', () => {
  it('🔴 les quatre lecteurs construisent leur expression depuis le motif partagé', () => {
    const lecteurs: Array<[string, string]> = [
      ['src/agent/requete-http.ts', "const VARIABLE = new RegExp(MOTIF_PASTILLE, 'g');"],
      ['web/lib/gabarit-pastilles.ts', "export const PASTILLE = new RegExp(MOTIF_PASTILLE, 'g');"],
      ['web/lib/gabarit-pastilles.ts', "const PASTILLE_ANCREE = new RegExp(MOTIF_PASTILLE, 'y');"],
      ['web/components/VariableBodyEditor.tsx', "export const NAMED_VAR_RE = new RegExp(MOTIF_PASTILLE, 'g');"],
    ];
    for (const [fichier, declaration] of lecteurs) expect(lire(fichier), `${fichier} : ${declaration}`).toContain(declaration);
  });

  it('⚠️ ce motif accepte bien ce que les écrans laissent saisir, et rien de plus', () => {
    // Lettres, chiffres, tiret, point, souligné, et des espaces intérieurs tolérées. Un nom avec une espace au
    // milieu n'en est pas un, et ne doit pas passer.
    const re = new RegExp(`^${MOTIF_PASTILLE}$`);
    for (const bon of ['{{ville}}', '{{ ville }}', '{{contact.nom}}', '{{ref-1}}', '{{user_ns}}']) {
      expect(re.test(bon), bon).toBe(true);
    }
    for (const mauvais of ['{{ville brune}}', '{{}}', '{ville}']) {
      expect(re.test(mauvais), mauvais).toBe(false);
    }
    // Le nom est le premier groupe : c'est lui que les trois lecteurs utilisent.
    expect(new RegExp(MOTIF_PASTILLE).exec('Bonjour {{ prenom }} !')?.[1]).toBe('prenom');
  });
});
