import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * L'API ET LE WORKER NE CHARGENT PAS BAILEYS (relecture du lot du 2026-10-22). Seul le service de connexions
 * (`src/application/service.ts`) tient des sessions ; les modules que l'API et le worker importent n'en tirent rien, sinon
 * chaque copie de l'API chargerait Baileys et Signal au démarrage. La garde suit les imports qui ne sont pas `import
 * type` (effacés à la compilation), de proche en proche, depuis les modules de la filière que le socle et le worker
 * importent.
 */
const RACINE = resolve(__dirname, '..');
const DEPARTS = [
  'src/application/client.ts', 'src/application/envoi.ts', 'src/application/connexion.ts', 'src/application/entrant.ts',
  'src/application/entrant.pg.ts', 'src/application/garde-outils.ts', 'src/application/sommeil.ts', 'src/application/avis.ts',
  'src/application/comptes.pg.ts', 'src/application/premier-message.ts', 'src/application/premier-message.pg.ts',
];

/** Les imports de valeur d'un fichier, relatifs, résolus en chemins de fichiers ; les paquets sont rendus tels quels. */
function importsDeValeur(fichier: string): string[] {
  const texte = readFileSync(resolve(RACINE, fichier), 'utf8');
  const sortie: string[] = [];
  for (const m of texte.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gms)) {
    const cible = m[1]!;
    if (!cible.startsWith('.')) { sortie.push(cible); continue; }
    sortie.push(resolve(dirname(resolve(RACINE, fichier)), cible).slice(RACINE.length + 1).replace(/\\/g, '/') + '.ts');
  }
  return sortie;
}

describe('les modules de la filière que l’API et le worker importent', () => {
  it('🔴 n’entraînent jamais Baileys, ni les sessions, ni le transport', () => {
    const vus = new Set<string>();
    const pile = [...DEPARTS];
    const fautifs: string[] = [];
    while (pile.length > 0) {
      const f = pile.pop()!;
      if (vus.has(f)) continue;
      vus.add(f);
      for (const cible of importsDeValeur(f)) {
        if (cible.startsWith('@whiskeysockets/') || cible.startsWith('src/application/transport/') || cible === 'src/application/sessions.ts') {
          fautifs.push(`${f} -> ${cible}`);
        } else if (cible.startsWith('src/application/')) {
          pile.push(cible);
        }
      }
    }
    expect(fautifs).toEqual([]);
    expect(vus.size).toBeGreaterThanOrEqual(DEPARTS.length);
  });
});
