import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LE TARIF DE META PASSE SOUS MICRO-CACHE : L'INVENTAIRE DE SES APPELANTS.
 *
 * 🔴 CE QUE CE FICHIER FERME. `getPricingAnalytics` est un appel à une API TIERCE À QUOTA, qui n'avait aucun
 * cache : quatre écrans le déclenchent, dont l'onglet Campagnes qu'on ouvre en permanence.
 *
 * 🔴 ET LA PREMIÈRE VERSION DE CE FICHIER ÉTAIT UN FAUX NÉGATIF, ce qui est la vraie leçon. Sa garde cherchait
 * `pricingClientT.getPricingAnalytics(`, c'est-à-dire un NOM DE VARIABLE local à une seule fonction : un
 * CINQUIÈME appelant, écrit `pricing.getPricingAnalytics(`, passait sans être vu. Elle compte donc TOUS les
 * appels, quel que soit le receveur, et exige qu'ils passent par le point unique `tarifMeta`.
 *
 * ⚠️ Le COMPORTEMENT du cache (un aller-retour pour deux lectures, la clé qui porte l'espace et la fenêtre, un
 * échec oublié, soixante secondes, la mutualisation des appels simultanés) s'EXÉCUTE depuis le 2026-09-27 dans
 * `tests/chiffrage.test.ts` : le cache a quitté la racine pour `src/stats/chiffrage.ts`, où il s'importe. Les
 * gardes qui relisaient sa déclaration dans `index.ts` sont parties avec lui. Reste ici ce qu'aucun test de
 * comportement ne peut voir : un appelant de plus, ailleurs dans `src/`, qui irait chez Meta sans le cache.
 */
const sansCommentaires = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Tous les fichiers de `src/` sauf le client de tarif lui-même, qui DÉFINIT la méthode. */
function sources(): Array<{ fichier: string; texte: string }> {
  const racine = fileURLToPath(new URL('../src', import.meta.url));
  const out: Array<{ fichier: string; texte: string }> = [];
  const visiter = (dossier: string): void => {
    for (const nom of readdirSync(dossier)) {
      const complet = join(dossier, nom);
      if (statSync(complet).isDirectory()) { visiter(complet); continue; }
      if (!nom.endsWith('.ts')) continue;
      const fichier = `src/${relative(racine, complet).split('\\').join('/')}`;
      if (fichier === 'src/meta/pricing.ts') continue;
      out.push({ fichier, texte: sansCommentaires(readFileSync(complet, 'utf8')) });
    }
  };
  visiter(racine);
  return out;
}

describe('le tarif de Meta est mis en cache court', () => {
  it('🔴 TOUS les appels à Meta passent par le point unique, aucun n est fait en direct', () => {
    let total = 0;
    for (const { fichier, texte } of sources()) {
      const tous = [...texte.matchAll(/\w+\.getPricingAnalytics\(/g)];
      // Chacun est passé à `tarifMeta`, en lambda. Le motif ne nomme AUCUNE variable receveuse.
      const parLePoint = [...texte.matchAll(/tarifMeta\([^;]*?\(\)\s*=>\s*\w+\.getPricingAnalytics\(/g)];
      expect(parLePoint.length, `${fichier} : chaque appel à Meta passe par tarifMeta`).toBe(tous.length);
      total += tous.length;
    }
    // Une garde qui ne trouve plus rien à garder passe en silence : le chiffrage appelle Meta, au moins une fois.
    expect(total, 'au moins un appel à Meta existe').toBeGreaterThan(0);
  });

  it('🔴 le cache est construit à UN seul endroit : deux caches, c est un des deux qu on oublie', () => {
    const constructions = sources().flatMap(({ fichier, texte }) =>
      [...texte.matchAll(/cacheCourt<PricingSummary \| null>\(/g)].map(() => fichier));
    expect(constructions).toEqual(['src/stats/chiffrage.ts']);
  });

  it('🔴 le chiffrage et la connexion publicitaire sont construits UNE fois par process, jamais par requête', () => {
    // Le cache vit dans la fabrique : un second appel (dans une route, par exemple) ouvrirait un second cache,
    // et le compte des constructions de cache ci-dessus resterait à un.
    const appels = (nom: string) => sources().flatMap(({ fichier, texte }) =>
      [...texte.matchAll(new RegExp(`(?<!function )\\b${nom}\\(`, 'g'))].map(() => fichier));
    expect(appels('creerChiffrage')).toEqual(['src/index.ts']);
    expect(appels('creerConnexionPub')).toEqual(['src/index.ts']);
  });
});
