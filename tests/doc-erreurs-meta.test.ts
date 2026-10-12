import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERREURS_META, GROUPES_ERREURS_META } from '../web/lib/erreurs-meta';

/**
 * 🔴 CHAQUE CODE DE META QUE NOTRE CODE NOMME EST AU CATALOGUE DE LA DOC (lot 17).
 *
 * Un code que `src/` traite à part (un réessai, une pause de campagne, un refus annoncé) est un code qu'un intégrateur
 * finira par recevoir : il doit pouvoir le lire dans le catalogue (`web/lib/erreurs-meta.ts`). Les codes cherchés : tout
 * nombre de six chiffres en 13xxxx dans `src/`, plus les ensembles de `src/meta/errors.ts` qui décident du réessai
 * (`RETRYABLE_CODES`, `TERMINAL_CODES`, où vivent aussi les codes courts 1, 2, 4, 100 et 190).
 */
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function fichiers(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? fichiers(chemin) : chemin.endsWith('.ts') ? [chemin] : [];
  });
}

function codesNommesParSrc(): Set<number> {
  const codes = new Set<number>();
  for (const f of fichiers(SRC)) for (const m of readFileSync(f, 'utf8').matchAll(/\b13\d{4}\b/g)) codes.add(Number(m[0]));
  const erreurs = readFileSync(join(SRC, 'meta', 'errors.ts'), 'utf8');
  for (const nom of ['RETRYABLE_CODES', 'TERMINAL_CODES']) {
    const bloc = new RegExp(`const ${nom} = new Set<number>\\(\\[([^\\]]*)\\]\\)`).exec(erreurs);
    if (!bloc) throw new Error(`${nom} introuvable dans src/meta/errors.ts : ce test ne lit plus ce qu'il croit`);
    for (const c of bloc[1]!.split(',')) codes.add(Number(c.trim()));
  }
  return codes;
}

describe('le catalogue des erreurs de Meta', () => {
  it('garde de la garde : src/ nomme bien des codes de Meta', () => {
    const codes = codesNommesParSrc();
    expect(codes.size).toBeGreaterThan(15);
    for (const c of [131047, 131026, 130429, 190, 4]) expect(codes.has(c), String(c)).toBe(true);
  });

  it('🔴 chaque code que src/ nomme a son entrée', () => {
    const documentes = new Set<number>(ERREURS_META.map((e) => e.code));
    const manquants = [...codesNommesParSrc()].filter((c) => !documentes.has(c)).sort((a, b) => a - b);
    expect(manquants, 'à ajouter dans web/lib/erreurs-meta.ts').toEqual([]);
  });

  it('un code une seule fois, dans un groupe connu, avec son sens et son geste dans les deux langues', () => {
    expect(new Set(ERREURS_META.map((e) => e.code)).size).toBe(ERREURS_META.length);
    const groupes = GROUPES_ERREURS_META.map((g) => g.cle);
    for (const e of ERREURS_META) {
      expect(groupes, String(e.code)).toContain(e.groupe);
      for (const texte of [...e.sens, ...e.geste, ...('chezNous' in e ? e.chezNous : [])]) expect(texte.trim(), String(e.code)).not.toBe('');
    }
  });

  it('🔴 « rejouée seule » n’est dit que d’un code que le transport rejoue vraiment (RETRYABLE_CODES)', () => {
    const erreurs = readFileSync(join(SRC, 'meta', 'errors.ts'), 'utf8');
    const bloc = /const RETRYABLE_CODES = new Set<number>\(\[([^\]]*)\]\)/.exec(erreurs);
    const rejouables = new Set((bloc?.[1] ?? '').split(',').map((c) => Number(c.trim())));
    expect(rejouables.size).toBeGreaterThan(3);
    const disentRejouee = ERREURS_META.filter((e) => 'chezNous' in e && /rejou/i.test(e.chezNous[0]));
    expect(disentRejouee.length).toBeGreaterThan(0);
    for (const e of disentRejouee) expect(rejouables.has(e.code), String(e.code)).toBe(true);
  });

  it('chaque groupe a au moins un code', () => {
    for (const g of GROUPES_ERREURS_META) expect(ERREURS_META.some((e) => e.groupe === g.cle), g.cle).toBe(true);
  });
});
