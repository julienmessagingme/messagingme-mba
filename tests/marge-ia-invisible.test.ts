import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 🔴 NOTRE MARGE SUR L'IA N'APPARAÎT NULLE PART (spec Business, décision de Julien : « on ne parle jamais de notre marge sur
 * l'ia dans les tableaux »). Elle reste dans `DROITS` et s'applique ; aucun texte public ne dit son taux : ni la vitrine, ni
 * le centre d'aide (fiches et pages générées), ni le plugin. La vue de l'offre (console, `get_plan`) est tenue par
 * `tests/offres-vue.test.ts`.
 *
 * Ce qui est refusé : le mot « commission » (ou `commission` en anglais) suivi d'un pourcentage dans la même phrase.
 * « sans commission de Messaging Me » sur les messages de Meta reste permis : ce n'est pas notre marge sur l'IA.
 */
const RACINE = resolve(__dirname, '..');
const TAUX = /commission[^.<\n]{0,120}?\d+(?:[.,]\d+)?\s?(?:&nbsp;| | )?%/i;

function fichiers(dossier: string, extensions: readonly string[]): string[] {
  const absolu = join(RACINE, dossier);
  const vus: string[] = [];
  for (const nom of readdirSync(absolu)) {
    const chemin = join(absolu, nom);
    if (statSync(chemin).isDirectory()) vus.push(...fichiers(relative(RACINE, chemin), extensions));
    else if (extensions.some((e) => nom.endsWith(e))) vus.push(chemin);
  }
  return vus;
}

describe('la marge sur l’IA reste invisible (spec Business)', () => {
  it.each([
    ['la vitrine', 'site', ['.html', '.txt']],
    ['les fiches d’aide', 'docs/aide/fiches', ['.md']],
    ['le plugin', 'plugin', ['.md', '.json']],
  ] as const)('🔴 %s : aucun taux de commission', (_nom, dossier, extensions) => {
    const fautifs = fichiers(dossier, extensions)
      .filter((f) => TAUX.test(readFileSync(f, 'utf8')))
      .map((f) => relative(RACINE, f));
    expect(fautifs).toEqual([]);
  });

  it('le motif attrape les tournures écrites jusqu’ici, et laisse passer les messages de Meta sans commission', () => {
    expect(TAUX.test('Notre commission sur le crédit IA est de 100 % en Free')).toBe(true);
    expect(TAUX.test('Our commission on AI credit is 100% on Free')).toBe(true);
    expect(TAUX.test('notre commission y est de 100&nbsp;% en Free')).toBe(true);
    expect(TAUX.test('Meta facture ses messages directement, sans commission de Messaging Me.')).toBe(false);
  });
});
