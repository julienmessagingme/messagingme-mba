import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { COLONNES_ANALYSE_FICHE } from '../src/analysis/fiche';

/**
 * 🔴 LA DERNIÈRE ANALYSE D'UNE FICHE N'EST ÉCRITE QUE PAR L'ANALYSE, ET VIDÉE QUE PAR LA PURGE (Tout sur la
 * fiche, décision 5 : lecture seule).
 *
 * Aucune route, aucun import, aucune écriture de l'API, aucun outil d'agent ne doit pouvoir poser « résolue » ou
 * une satisfaction sur une fiche : ce serait une donnée d'analyse que l'analyse n'a pas produite, et que la
 * suivante écraserait sans prévenir. Le type ne le voit pas (une requête SQL est une chaîne) : ce test lit les
 * sources, et n'autorise l'affectation `analyse_* =` que dans les deux fichiers qui en ont le droit.
 */
const RACINE = resolve(__dirname, '..');
const AUTORISES = new Map([
  // `copierSurLaFiche`, dans la transaction de `save`.
  [join('src', 'analysis', 'store.pg.ts'), 'analyse'],
  // `purgeMany`, qui vide la copie entière.
  [join('src', 'crm', 'contact-store.pg.ts'), 'purge'],
]);
const colonnes = COLONNES_ANALYSE_FICHE.join('|');
// `analyse_x =` suivi d'autre chose qu'un second `=` : une affectation SQL (`set`), jamais une comparaison JS.
const AFFECTATION = new RegExp(`\\b(${colonnes})\\s*=(?!=)`, 'g');

function sources(dossier: string): string[] {
  return readdirSync(resolve(RACINE, dossier), { recursive: true, withFileTypes: false })
    .map((f) => join(dossier, String(f)))
    .filter((f) => f.endsWith('.ts'));
}

describe('les écrivains de la dernière analyse d’une fiche', () => {
  it('🔴 seules l’analyse et la purge affectent une colonne analyse_*', () => {
    const fautifs: string[] = [];
    for (const f of sources('src')) {
      const texte = readFileSync(resolve(RACINE, f), 'utf8');
      if ((texte.match(AFFECTATION) ?? []).length > 0 && !AUTORISES.has(f.split('/').join(sep))) fautifs.push(f);
    }
    expect(fautifs, 'une colonne analyse_* est écrite hors de l’analyse et de la purge').toEqual([]);
  });

  it('les deux écrivains autorisés écrivent bien TOUTES les colonnes (sinon ce test ne garde plus rien)', () => {
    for (const f of AUTORISES.keys()) {
      const trouvees = new Set([...readFileSync(resolve(RACINE, f), 'utf8').matchAll(AFFECTATION)].map((m) => m[1]));
      for (const c of COLONNES_ANALYSE_FICHE) expect(trouvees.has(c), `${f} n’écrit pas ${c}`).toBe(true);
    }
  });
});
