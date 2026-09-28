import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LE CÂBLAGE DU COMPTEUR DE DÉBIT PARTAGÉ, lu dans le CODE (lot B, 2026-09-28).
 *
 * 🔴 CE QUE LE TYPAGE NE VOIT PAS : `buildServer` accepte d'être construit SANS `debit`, et retombe alors sur un
 * compteur en mémoire, celui d'une copie seule (les serveurs de test, par dizaines, en ont besoin). Si la racine de l'API oubliait
 * de le passer, rien ne casserait : chaque copie servirait chaque plafond pour elle seule, exactement le défaut que ce
 * lot ferme, et sans une erreur. Ce test tient la ligne qui l'empêche, et le fait que le compteur en mémoire n'est
 * branché nulle part ailleurs dans `src/`.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const lire = (chemin: string): string => sansCommentaires(readFileSync(new URL(chemin, import.meta.url), 'utf8'));

describe('le compteur de débit partagé, de la base aux plafonds', () => {
  it('🔴 le socle construit le compteur en base, une fois, et le rend aux deux processus', () => {
    const socle = lire('../src/socle.ts');
    expect(socle.match(/new PgCompteurDebit\(pool\)/g)).toHaveLength(1);
    expect(socle).toMatch(/return \{[\s\S]*\bcompteurDebit\b[\s\S]*\};/);
  });

  it('🔴 l’API le passe à `buildServer`, et la surveillance de `/ops` compte dedans', () => {
    const api = lire('../src/index.ts');
    expect(api).toMatch(/buildServer\(\{\s*debit: compteurDebit,/);
    expect(api).toMatch(/surveillerOps\(\{[\s\S]*?compteur: compteurDebit,\s*verrous: verrousCourts,\s*\}\)/);
  });

  it('🔴 la minute entre deux codes d’un numéro est tenue par les verrous partagés', () => {
    const api = lire('../src/index.ts');
    expect(api).toMatch(/embeddedSignup: \(\(\) => \{[\s\S]*?verrous: verrousCourts,\s*\};\s*\}\)\(\)/);
  });

  it('🔴 le worker efface les fenêtres échues, sur sa propre cadence', () => {
    const worker = lire('../src/worker.ts');
    expect(worker).toMatch(/taches\.programmer\('compteurs-debit', 5 \* 60_000, async \(\) => \{\s*const n = await compteurDebit\.purgerEchues\(\);/);
  });

  it('🔴 le compteur EN MÉMOIRE n’est branché nulle part dans `src/`, sauf comme défaut de `buildServer`', () => {
    const racine = fileURLToPath(new URL('../src', import.meta.url));
    const fichiers: string[] = [];
    const parcourir = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (p.endsWith('.ts')) fichiers.push(p);
      }
    };
    parcourir(racine);
    const importeurs = fichiers
      .filter((f) => /from '\.{1,2}\/(db\/)?debit\.memoire'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(racine.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(importeurs).toEqual(['server.ts']);
  });
});
