import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * OÙ LE NAVIGATEUR VA CHERCHER L'API (bascule Vercel, `docs/PLAN-BASCULE-VERCEL-2026-09-03.md`).
 *
 * 🔴 DEUX MONDES, ET LE PASSAGE DE L'UN À L'AUTRE EST SILENCIEUX. Sans variable, le navigateur appelle la
 * même origine que la page et le serveur Next relaie : aucune requête d'origine croisée, donc aucun CORS.
 * Avec la variable, il parle directement à l'API sous son propre nom, et il faut que l'API ait inscrit cette
 * origine. Se tromper de monde ne produit pas d'erreur de compilation : ça produit une console qui ne charge
 * rien, avec un message de navigateur qui ne dit pas pourquoi.
 *
 * ⚠️ Ces tests lisent la SOURCE. `BASE` est figée à l'import du module et `NEXT_PUBLIC_*` est remplacée au
 * build par Next : on ne peut donc pas la faire varier à l'exécution dans un test, seulement vérifier que la
 * règle écrite est la bonne.
 */
const source = readFileSync(new URL('./http.ts', import.meta.url), 'utf8');
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('adresse de l’API vue du navigateur', () => {
  it('🔴 sans variable, on garde le proxy de même origine : c’est le montage du VPS', () => {
    // Le repli doit rester `/api/backend`, et pas devenir une adresse absolue « par précaution » : ce serait
    // basculer tout le monde en cross-origine, donc exiger un CORS, pour rien.
    expect(sansCommentaires).toMatch(/\|\|\s*'\/api\/backend'/);
  });

  it('🔴 la variable est LUE, et ses barres finales retirées', () => {
    // Une variable d'environnement recopiée avec une barre en trop fabriquerait des adresses en double barre
    // sur CHAQUE appel de la console.
    expect(sansCommentaires).toMatch(/process\.env\.NEXT_PUBLIC_API_URL/);
    expect(sansCommentaires).toMatch(/\.replace\(\/\\\/\+\$\/, ''\)/);
  });

  it('🔴 UN SEUL endroit décide : la page Développeurs en dérive, elle ne la réécrit pas', () => {
    // Ces deux lignes portaient l'adresse en dur. Un intégrateur qui l'aurait copiée après la bascule aurait
    // bâti son intégration sur un chemin mort, et l'aurait découvert en production, chez lui.
    const dev = readFileSync(new URL('../app/developers/api/page.tsx', import.meta.url), 'utf8');
    expect(dev, 'la page doit dériver son adresse de BASE').toMatch(/const ADRESSE_API = BASE\./);
    const sansComm = dev.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const enDur = sansComm.match(/https:\/\/mba\.messagingme\.app\/api\/backend\/v1/g) ?? [];
    expect(enDur, 'plus aucune adresse d’API écrite en dur dans le corps de la page').toEqual([]);
  });
});
