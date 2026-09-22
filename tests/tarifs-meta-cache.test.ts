import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cacheCourt } from '../src/lib/cache-court';

/**
 * LE TARIF DE META PASSE SOUS MICRO-CACHE (seul rouge de la revue finale du 2026-09-23).
 *
 * 🔴 CE QUE CE TEST FERME. `getPricingAnalytics` est un appel a une API TIERCE A QUOTA, et il n'avait aucun
 * cache. Quatre ecrans le declenchent (le graphe de cout, la synthese, le total des messages envoyes, et
 * depuis ce jour l'onglet Campagnes qu'on ouvre en permanence) : chaque montage, chaque changement de
 * periode et chaque bascule partait chez Meta pour un tarif qui ne bouge pas dans la minute.
 *
 * 🔴 ET IL SE LIT DANS LA SOURCE DU CABLAGE, parce que rien d'autre ne peut le voir : le cache est POSE au
 * cablage, aucun test de comportement ne distingue « on a rappele Meta » de « on a relu le cache ». C'est le
 * motif « une garde qu'on peut debrancher sans qu'aucun test ne tombe n'est pas une garde », que ce depot a
 * deja paye.
 */
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
/** Sans les commentaires : une explication qui CITE le bon code ferait passer un cablage absent. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('le tarif de Meta est mis en cache court', () => {
  it('🔴 TOUS les appels a Meta passent par le cache, aucun n est fait en direct', () => {
    /**
     * ⚠️ CETTE GARDE ETAIT UN FAUX NEGATIF, ET C'EST LA LECON (relevee en relecture le 2026-09-23). Elle
     * cherchait `await pricingClientT.getPricingAnalytics(`, c'est-a-dire un NOM DE VARIABLE local a une
     * seule fonction. Un CINQUIEME appelant existait, ecrit `pricing.getPricingAnalytics(` : il passait sans
     * etre vu, et le test affirmait « aucun appel direct » pendant que l'ecran le plus ouvert du produit
     * repartait chez Meta a chaque montage. Une garde ancree sur un nom de variable ne garde rien.
     *
     * On compte donc TOUS les appels, quel que soit le receveur, et on exige que chacun soit enveloppe.
     */
    const tous = [...sansCommentaires.matchAll(/(\w+)\.getPricingAnalytics\(/g)];
    expect(tous.length, 'au moins un appel a Meta existe').toBeGreaterThan(0);
    const enveloppes = [...sansCommentaires.matchAll(/cacheTarifsMeta\.lire\([^;]*?\(\)\s*=>\s*\w+\.getPricingAnalytics\(/g)];
    expect(enveloppes.length, 'chaque appel a Meta est enveloppe dans cacheTarifsMeta.lire').toBe(tous.length);
  });

  it('🔴 la cle porte l ESPACE et la FENETRE, sinon elle melange deux tarifs', () => {
    // Deux periodes sont deux tarifs moyens differents : une cle qui ne porterait que l'espace ferait lire a
    // un ecran le prix d'une autre plage. Et l'espace y est pour la raison habituelle de ce depot : le
    // filtrage en code est le SEUL controle d'isolation, la RLS etant contournee par le pooler.
    expect(sansCommentaires).toMatch(/cacheTarifsMeta\.lire\(`\$\{tenant\}:\$\{startTs\}:\$\{endTs\}`/);
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
});
