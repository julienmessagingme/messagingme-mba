import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FICHIERS_DOC, pageDoc } from './doc-api-pages';

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

  it('🔴 UN SEUL endroit décide : la documentation en dérive, elle ne la réécrit pas', () => {
    // Ces deux lignes portaient l'adresse en dur. Un intégrateur qui l'aurait copiée après la bascule aurait
    // bâti son intégration sur un chemin mort, et l'aurait découvert en production, chez lui.
    // Depuis la refonte du 2026-09-25, la doc tient en plusieurs fichiers (liste fermée, `./doc-api-pages`) :
    // l'adresse y est définie EXACTEMENT une fois (zéro ferait passer ce test à vide), et nulle part en dur.
    const sources = FICHIERS_DOC.map((f) => {
      const texte = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      return { f, code: texte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') };
    });
    const definitions = sources.filter((s) => /const ADRESSE_API\b/.test(s.code));
    expect(definitions, 'la doc doit définir son adresse une fois, et une seule').toHaveLength(1);
    expect(definitions[0]!.code, 'l’adresse de la doc doit dériver de BASE').toMatch(/const ADRESSE_API = BASE\./);
    for (const s of sources) {
      const enDur = s.code.match(/https:\/\/mba\.messagingme\.app\/api\/backend\/v1/g) ?? [];
      expect(enDur, `${s.f} : plus aucune adresse d’API écrite en dur`).toEqual([]);
    }
  });

  it('🔴 la page MCP en dérive AUSSI : c’est l’API qui sert /mcp, pas la console', () => {
    // Elle prenait le domaine de la page. Sur la console hébergée chez Vercel, `/mcp` rend 404 (mesuré le
    // 2026-09-25) : la commande copiée depuis engageme.messagingme.app visait une adresse morte.
    // Le fichier qui AFFICHE l'adresse MCP, tel que la carte de la doc le déclare (la refonte n'a pas déplacé son contenu).
    const mcp = readFileSync(new URL(`../../${pageDoc('mcp').fichier}`, import.meta.url), 'utf8');
    const sansComm = mcp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sansComm, 'l’adresse du serveur MCP doit venir de BASE quand elle est absolue').toMatch(/const origine = BASE\.startsWith\('http'\) \? BASE :/);
  });
});
