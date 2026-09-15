import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * LE DÉCOUPAGE DE LA CI EN DEUX WORKFLOWS, ET L'ASYMÉTRIE QUI LE GOUVERNE (2026-09-15).
 *
 * 🔴 CE QUI EST GARDÉ ICI EST UNE ASYMÉTRIE, PAS UNE SYMÉTRIE, et c'est tout le piège. Le job du FRONT peut
 * être sauté quand le front ne bouge pas : il ne peut pas voir un changement de backend (aucun fichier de
 * `web/` n'importe `src/`, et les E2E interceptent tous les appels `/api/backend/**`). L'INVERSE est FAUX :
 * des dizaines de tests de la RACINE LISENT des fichiers de `web/`, ce sont les tests de parité, qui
 * comparent une liste du serveur à sa jumelle du navigateur. Filtrer `ci.yml` sur le backend les ferait
 * sauter sur un changement purement front, c'est-à-dire exactement quand ils ont quelque chose à dire.
 *
 * 🔴 ET C'EST LA RAISON QUI EST VÉRIFIÉE, PAS SEULEMENT LA RÈGLE. Le test compte les lecteurs réels : le jour
 * où il n'y en aura plus, il le dira, et la contrainte pourra être levée en connaissance de cause. Une règle
 * dont personne ne sait plus si elle sert encore est une règle qu'on finit par contourner.
 *
 * ⚠️ Mesure qui a motivé le découpage : sur les 300 runs du 2 au 15 septembre, 141 (47 %) ne touchaient QUE
 * le backend, et le job du front y a consommé 1 241 minutes à re-vérifier des octets identiques, en étant au
 * passage le poteau le plus long (8,8 min contre 3,3 pour `unit`).
 */

const RACINE = resolve(__dirname, '..');
const ci = readFileSync(resolve(RACINE, '.github/workflows/ci.yml'), 'utf8');
const ciWeb = readFileSync(resolve(RACINE, '.github/workflows/ci-web.yml'), 'utf8');

/** Les noms de jobs d'un workflow : les clés à DEUX espaces d'indentation sous `jobs:`. */
function jobsDe(yml: string): string[] {
  const apres = yml.slice(yml.indexOf('\njobs:'));
  return apres.split('\n')
    .map((l) => /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n));
}

describe('les deux moitiés de la CI', () => {
  it('🔴 le job du front vit dans SON fichier, et nulle part ailleurs', () => {
    // Le laisser dans les deux le ferait tourner DEUX fois sur un push au front, ce qui est le mode de
    // panne coûteux et silencieux d'un découpage à moitié fait.
    expect(jobsDe(ciWeb)).toEqual(['web']);
    expect(jobsDe(ci)).not.toContain('web');
  });

  it('🔴 les trois autres jobs sont restés, aucun n’a disparu dans le déménagement', () => {
    // Un découpage qui perd un job en route ne se voit pas : il ne reste qu'un check vert de moins, sur une
    // page que personne ne compte.
    expect(jobsDe(ci).sort()).toEqual(['integration', 'securite', 'unit']);
  });

  it('🔴 `ci-web.yml` ne se déclenche QUE sur le front, SUR CHAQUE événement', () => {
    /**
     * ⚠️ LES DEUX BLOCS SÉPARÉMENT, ET C'EST UNE CORRECTION DE CE TEST. Sa première version lisait tout
     * `on:` d'un coup : retirer le filtre du bloc `push` (le seul qui compte ici, on ne fait pas de PR) le
     * laissait passer, puisque le bloc `pull_request` portait encore la même ligne. Une assertion qui
     * cherche une chaîne quelque part dans deux blocs ne dit rien de chacun.
     */
    const fin = ciWeb.indexOf('concurrency:');
    const push = ciWeb.slice(ciWeb.indexOf('push:'), ciWeb.indexOf('pull_request:'));
    const pr = ciWeb.slice(ciWeb.indexOf('pull_request:'), fin);
    for (const [nom, bloc] of [['push', push], ['pull_request', pr]] as const) {
      expect(bloc, `le bloc ${nom} a perdu son filtre`).toContain("- 'web/**'");
      // Son propre fichier, sinon une modification du workflow ne serait jamais exercée.
      expect(bloc, `le bloc ${nom} ne s'exerce pas lui-même`).toContain("- '.github/workflows/ci-web.yml'");
    }
  });

  it('🔴 `ci.yml` garde un filtre NÉGATIF : il doit tourner sur un changement de `web/`', () => {
    // C'est l'assertion qui porte l'asymétrie. Un `paths:` positif sur `src/**` ferait sauter les tests de
    // parité précisément quand le front change, donc quand ils servent.
    const bloc = ci.slice(ci.indexOf('on:'), ci.indexOf('concurrency:'));
    expect(bloc).toContain('paths-ignore:');
    expect(bloc).not.toMatch(/^\s+paths:\s*$/m);
  });

  it('🔴 les deux groupes de concurrence sont DISTINCTS', () => {
    // Un groupe partagé ferait s'annuler les deux moitiés de la CI l'une l'autre : le front annulerait le
    // backend, et le verdict manquant ressemblerait à un run qui n'a jamais été demandé.
    const groupe = (yml: string) => /group:\s*(\S+)/.exec(yml)?.[1];
    expect(groupe(ci)).toBeTruthy();
    expect(groupe(ciWeb)).toBeTruthy();
    expect(groupe(ci)).not.toBe(groupe(ciWeb));
  });
});

describe('la RAISON de l’asymétrie, vérifiée plutôt qu’affirmée', () => {
  const fichiersDeTest = readdirSync(resolve(RACINE, 'tests'))
    .filter((n) => n.endsWith('.test.ts'));

  it('🔴 des tests de la RACINE lisent des fichiers de `web/` : `unit` doit tourner sur un push au front', () => {
    const lecteurs = fichiersDeTest.filter((n) =>
      readFileSync(resolve(RACINE, 'tests', n), 'utf8').includes('../web/'));
    // Pas un compte en dur : un compte en dur dériverait au premier test ajouté. Ce qui est gardé est
    // l'EXISTENCE de ces lecteurs, c'est-à-dire la raison pour laquelle `ci.yml` n'est pas filtré.
    expect(lecteurs.length).toBeGreaterThan(0);
  });

  it('🔴 et AUCUN fichier de `web/` n’importe la racine `src/` : le front est hermétique au backend', () => {
    // C'est la moitié qui autorise le saut. Le jour où un import traverserait, sauter le job du front
    // deviendrait un vrai trou, et ce test tomberait avant.
    const fautifs: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
        const p = resolve(dir, e.name);
        if (e.isDirectory()) { parcourir(p); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        const src = readFileSync(p, 'utf8');
        if (/from\s+['"](?:\.\.\/)+src\//.test(src)) fautifs.push(p.slice(RACINE.length + 1));
      }
    };
    parcourir(resolve(RACINE, 'web'));
    expect(fautifs).toEqual([]);
  });

  it('🔴 aucun spec E2E ne vise un VRAI backend : ils interceptent tous leurs appels', () => {
    // Deuxième moitié de l'hermétisme. Un spec qui appellerait `api.messagingme.app` verrait, lui, un
    // changement de backend, et le saut cesserait d'être neutre.
    const e2e = resolve(RACINE, 'web/e2e');
    const fautifs = readdirSync(e2e, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.spec.ts'))
      .filter((e) => /api\.messagingme\.app|localhost:8095|127\.0\.0\.1:8095/
        .test(readFileSync(resolve(e2e, e.name), 'utf8')))
      .map((e) => e.name);
    expect(fautifs).toEqual([]);
  });
});
