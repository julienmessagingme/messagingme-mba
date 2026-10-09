import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * LE CODE PARTAGÉ ENTRE LE SERVEUR ET LA CONSOLE (`web/lib/partage/`, audit de simplicité du 2026-10-09, lot B).
 *
 * Rangé côté console parce que c'est le seul endroit que Vercel et l'image de `mba-web` voient ; le serveur l'importe
 * (`../../web/lib/partage/...`), et l'image de l'API le copie. Deux règles, que rien d'autre ne tient :
 * - 🔴 le dossier reste PUR : il n'importe que lui-même. Un alias `@/` ne se résout pas côté serveur, un paquet
 *   (React, `zod`, `node:`) n'existe que d'un seul côté, et un `../` y ferait entrer du code qui n'est partagé par
 *   personne ;
 * - 🔴 dès que `src/` l'importe, l'image de l'API le copie : sans cette ligne du Dockerfile, l'API ne démarre plus
 *   (module introuvable à l'import), et aucun test unitaire ne le verrait, ils lisent le dépôt entier.
 */
const RACINE = join(__dirname, '..');
const lireArbre = (dir: string): string[] => readdirSync(join(RACINE, dir)).flatMap((n) => {
  const rel = posix.join(dir, n);
  return statSync(join(RACINE, rel)).isDirectory() ? lireArbre(rel) : /\.tsx?$/.test(n) ? [rel] : [];
});
const imports = (fichier: string): string[] =>
  [...readFileSync(join(RACINE, fichier), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('le dossier partagé entre le serveur et la console', () => {
  const partages = lireArbre('web/lib/partage');

  it('existe, et ne contient que du TypeScript', () => {
    expect(partages.length).toBeGreaterThan(0);
  });

  it('🔴 n’importe que lui-même : ni alias, ni paquet, ni remontée hors du dossier', () => {
    for (const f of partages) {
      for (const spec of imports(f)) expect(spec, `${f} importe ${spec}`).toMatch(/^\.\/[\w-]+$/);
    }
  });

  it('🔴 l’image de l’API le copie dès que le serveur l’importe', () => {
    const importeParLeServeur = lireArbre('src').some((f) => imports(f).some((s) => s.includes('web/lib/partage/')));
    expect(importeParLeServeur).toBe(true);
    expect(readFileSync(join(RACINE, 'Dockerfile'), 'utf8')).toMatch(/^COPY --chown=node:node web\/lib\/partage \.\/web\/lib\/partage$/m);
  });

  it('la console l’importe en relatif depuis `web/lib`, où le serveur, qui ne connaît pas l’alias `@/`, la lit aussi', () => {
    for (const f of lireArbre('web/lib').filter((x) => !x.startsWith('web/lib/partage/'))) {
      for (const spec of imports(f)) expect(spec, `${f} importe ${spec}`).not.toMatch(/^@\/lib\/partage\//);
    }
  });
});
