import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cacheCourt } from '../src/lib/cache-court';

/**
 * LE TARIF DE META PASSE SOUS MICRO-CACHE, ET UN ECHEC N'Y RESTE PAS.
 *
 * 🔴 CE QUE CES TESTS FERMENT. `getPricingAnalytics` est un appel a une API TIERCE A QUOTA, et il n'avait
 * aucun cache : quatre ecrans le declenchent, dont l'onglet Campagnes qu'on ouvre en permanence. Chaque
 * montage repartait chez Meta pour un tarif qui ne bouge pas dans la minute.
 *
 * 🔴 ET LA PREMIERE VERSION DE CE FICHIER ETAIT UN FAUX NEGATIF, ce qui est la vraie lecon. Sa garde
 * cherchait `pricingClientT.getPricingAnalytics(`, c'est-a-dire un NOM DE VARIABLE local a une seule
 * fonction : un CINQUIEME appelant, ecrit `pricing.getPricingAnalytics(`, passait sans etre vu, et le test
 * affirmait « aucun appel direct ». Une garde ancree sur un nom de variable ne garde rien. Elle compte
 * desormais TOUS les appels, quel que soit le receveur, et exige qu'ils passent par le point unique.
 *
 * 🔴 ET LE CABLAGE SE LIT DANS LA SOURCE, parce que rien d'autre ne peut le voir : aucun test de
 * comportement ne distingue « on a rappele Meta » de « on a relu le cache ».
 */
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
/** Sans les commentaires : une explication qui CITE le bon code ferait passer un cablage absent. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('le tarif de Meta est mis en cache court', () => {
  it('🔴 TOUS les appels a Meta passent par le point unique, aucun n est fait en direct', () => {
    const tous = [...sansCommentaires.matchAll(/\w+\.getPricingAnalytics\(/g)];
    expect(tous.length, 'au moins un appel a Meta existe').toBeGreaterThan(0);
    // Chacun est passe a `tarifMeta`, en lambda. Le motif ne nomme AUCUNE variable receveuse.
    const parLePoint = [...sansCommentaires.matchAll(/tarifMeta\([^;]*?\(\)\s*=>\s*\w+\.getPricingAnalytics\(/g)];
    expect(parLePoint.length, 'chaque appel a Meta passe par tarifMeta').toBe(tous.length);
  });

  it('🔴 il n existe qu UN SEUL point de lecture du cache, et sa cle porte espace ET fenetre', () => {
    // Deux points de lecture, c'est un des deux qu'on oublie de corriger : c'est exactement ce qui est
    // arrive. Et une cle qui ne porterait que l'espace ferait lire a un ecran le tarif d'une autre plage.
    const lectures = [...sansCommentaires.matchAll(/cacheTarifsMeta\.lire\(/g)];
    expect(lectures.length, 'un seul appel a cacheTarifsMeta.lire').toBe(1);
    expect(sansCommentaires).toMatch(/const cle = `\$\{tenant\}:\$\{startTs\}:\$\{endTs\}`;/);
    expect(sansCommentaires).toMatch(/cacheTarifsMeta\.lire\(cle, appel\)/);
  });

  it('🔴 un ECHEC de Meta est OUBLIE, il n est pas resservi pendant une minute', () => {
    // `cacheCourt` ne garde jamais un REJET, il le dit en toutes lettres ; mais `getPricingAnalytics` avale
    // ses pannes et rend `null`, donc une valeur RESOLUE, que le cache gardait. Une coupure d'une seconde
    // eteignait la colonne « cout » de tous les ecrans pendant une minute.
    expect(sansCommentaires).toMatch(/if \(v === null\) cacheTarifsMeta\.invalider\(cle\);/);
  });

  it('une duree de vie courte, du meme ordre que les compteurs de l Inbox', () => {
    expect(sansCommentaires).toMatch(/cacheCourt<PricingSummary \| null>\(60_000\)/);
  });

  it('le cache MUTUALISE les appels simultanes, ce qui est la moitie de son interet', async () => {
    // Vingt-cinq onglets qui arrivent dans la meme milliseconde trouvent tous le cache vide : sans la
    // mutualisation, ils partiraient tous chez Meta, c'est-a-dire exactement au moment ou ca fait mal.
    let appels = 0;
    const cache = cacheCourt<number>(60_000);
    const calcul = async () => { appels += 1; await new Promise((r) => setTimeout(r, 5)); return 42; };
    const tous = await Promise.all(Array.from({ length: 25 }, () => cache.lire('t1:0:1', calcul)));
    expect(tous.every((v) => v === 42)).toBe(true);
    expect(appels, 'un seul aller-retour pour vingt-cinq lecteurs').toBe(1);
  });

  it('🔴 le MOTIF « oublier un null » se comporte comme annonce', () => {
    // ⚠️ CE TEST EPROUVE LE MOTIF, pas la fonction de production, qui vit dans le cablage et n'est pas
    // importable. C'est la garde de source ci-dessus qui prouve que la production le PORTE ; celui-ci
    // prouve qu'il FAIT ce qu'on en dit. Les deux ensemble, et pas l'un sans l'autre.
    const cache = cacheCourt<number | null>(60_000);
    const tarif = async (cle: string, appel: () => Promise<number | null>): Promise<number | null> => {
      const v = await cache.lire(cle, appel);
      if (v === null) cache.invalider(cle);
      return v;
    };
    return (async () => {
      let appels = 0;
      const enPanne = async () => { appels += 1; return null; };
      expect(await tarif('t:0:1', enPanne)).toBeNull();
      expect(await tarif('t:0:1', enPanne)).toBeNull();
      expect(appels, 'un echec n est pas resservi : on retente').toBe(2);

      let bons = 0;
      const ok = async () => { bons += 1; return 7; };
      expect(await tarif('t:0:2', ok)).toBe(7);
      expect(await tarif('t:0:2', ok)).toBe(7);
      expect(bons, 'un succes, lui, est bien memorise').toBe(1);
    })();
  });
});
