import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * LE MOTIF D'UNE PASTILLE `{{nom}}`, ÉCRIT À QUATRE ENDROITS, ET DONT C'EST L'ÉGALITÉ QUI PORTE L'INVARIANT.
 *
 * 🔴 CHACUN EST PLAUSIBLE SEUL, ET C'EST EXACTEMENT LE MOTIF QUE CE DÉPÔT PAIE. Le serveur substitue selon
 * SON motif ; l'écran des connecteurs signale les pastilles mal placées selon le SIEN ; l'éditeur de messages
 * en affiche des pastilles cliquables selon un troisième. Qu'un seul accepte un caractère que les autres
 * refusent, et l'écran déclare valide un gabarit que le serveur refusera en pleine conversation, ou l'inverse.
 * Aucun compilateur ne voit cet écart : les quatre sont des littéraux dans quatre fichiers.
 *
 * ⚠️ LE TEST COMPARE LES SOURCES, PAS LES RÉSULTATS, et c'est plus dur à tromper : deux motifs différents
 * peuvent coïncider sur les exemples auxquels on pense, et diverger sur celui auquel on ne pense pas.
 */

const RACINE = resolve(__dirname, '..');
const lire = (chemin: string): string => readFileSync(resolve(RACINE, chemin), 'utf8');

/** Le CORPS d'un littéral d'expression régulière nommé, sans ses drapeaux : c'est lui qui doit coïncider. */
function motifDe(source: string, nom: string): string | null {
  const m = new RegExp(`const ${nom} = /(.+?)/[a-z]*;`).exec(source);
  return m?.[1] ?? null;
}

describe('le motif d’une pastille', () => {
  const serveur = motifDe(lire('src/agent/requete-http.ts'), 'VARIABLE');
  const console_ = motifDe(lire('web/lib/gabarit-pastilles.ts'), 'PASTILLE');
  const ancree = motifDe(lire('web/lib/gabarit-pastilles.ts'), 'PASTILLE_ANCREE');
  const editeur = motifDe(lire('web/components/VariableBodyEditor.tsx'), 'NAMED_VAR_RE');

  it('🔴 les quatre déclarations existent : une renommée sans le dire ferait taire ce test', () => {
    // Sans cette assertion, `motifDe` rendrait `null` des deux côtés et l'égalité serait vraie pour rien.
    // C'est le mode de panne d'un test de parité : il devient vert en cessant de comparer quoi que ce soit.
    expect(serveur, 'src/agent/requete-http.ts : VARIABLE').toBeTruthy();
    expect(console_, 'web/lib/gabarit-pastilles.ts : PASTILLE').toBeTruthy();
    expect(ancree, 'web/lib/gabarit-pastilles.ts : PASTILLE_ANCREE').toBeTruthy();
    expect(editeur, 'web/components/VariableBodyEditor.tsx : NAMED_VAR_RE').toBeTruthy();
  });

  it('🔴 l’écran des connecteurs lit EXACTEMENT ce que le serveur substitue', () => {
    // L'écart coûterait une erreur en conversation sur un gabarit que l'écran a déclaré bon.
    expect(console_).toBe(serveur);
    expect(ancree).toBe(serveur);
  });

  it('🔴 et l’éditeur de messages parle la même langue', () => {
    // Même famille : une variable qu'un écran transforme en pastille et que l'autre laisse en texte brut
    // partirait littéralement `{{prenom}}` dans un message envoyé à un contact.
    expect(editeur).toBe(serveur);
  });

  it('⚠️ ce motif accepte bien ce que les écrans laissent saisir, et rien de plus', () => {
    // Un garde-fou sur le motif lui-même : lettres, chiffres, tiret, point, souligné, et des espaces
    // intérieurs tolérés. Un nom avec une espace au milieu n'en est pas un, et ne doit pas passer.
    const re = new RegExp(`^${serveur!}$`);
    for (const bon of ['{{ville}}', '{{ ville }}', '{{contact.nom}}', '{{ref-1}}', '{{user_ns}}']) {
      expect(re.test(bon), bon).toBe(true);
    }
    for (const mauvais of ['{{ville brune}}', '{{}}', '{ville}']) {
      expect(re.test(mauvais), mauvais).toBe(false);
    }
  });
});
