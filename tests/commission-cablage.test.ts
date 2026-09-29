import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LA COMMISSION, CÂBLÉE DEPUIS LA CONFIGURATION ET NULLE PART EN DUR (relecture du lot 1, 2026-09-28).
 *
 * 🔴 CE QUE LE TYPAGE NE VOIT PAS : `commissionPct` est un `number`, et `commissionPct: 10` compile aussi bien que
 * `commissionPct: config.COMMISSION_MODELE_PCT`. Une constante dans une racine ferait débiter un autre prix que celui
 * que la liste des modèles affiche (le prix annoncé ne serait plus le prix payé), et `COMMISSION_MODELE_PCT` changé en
 * production ne changerait qu'une moitié des débits, sans une erreur. Le calcul, lui, est tenu par
 * `tests/agent-devise.test.ts` ; ce fichier tient le CÂBLAGE : chaque `commissionPct` des deux racines (le tour
 * d'agent du worker, l'essai de la console et la traduction de l'API) lit la configuration.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const lire = (chemin: string): string => sansCommentaires(readFileSync(new URL(chemin, import.meta.url), 'utf8'));

/** Chaque valeur passée à `commissionPct:` dans une source, telle qu'écrite. */
function valeurs(source: string): string[] {
  return [...source.matchAll(/commissionPct:\s*([^,\n}]+)/g)].map((m) => m[1]!.trim());
}

describe('la commission des débits, de la configuration aux racines', () => {
  it('🔴 l’API : la traduction et l’essai de la console lisent `config.COMMISSION_MODELE_PCT`', () => {
    const api = lire('../src/index.ts');
    const v = valeurs(api);
    // Deux câblages attendus : sans cette borne, une racine qui cesserait de passer la commission rendrait ce test vert.
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.every((x) => x === 'config.COMMISSION_MODELE_PCT'), `valeurs lues : ${v.join(', ')}`).toBe(true);
    expect(api).toMatch(/creerTraducteur\(\{[\s\S]*?commissionPct: config\.COMMISSION_MODELE_PCT,[\s\S]*?\}\)/);
    // Le tarif AFFICHÉ lit la même variable : c'est ce qui fait du prix annoncé le prix payé.
    expect(api).toMatch(/modelesProposables\(catalogue, config\.EUR_PER_USD, config\.COMMISSION_MODELE_PCT\)/);
  });

  it('🔴 le worker : le cerveau des tours d’agent lit `config.COMMISSION_MODELE_PCT`', () => {
    const worker = lire('../src/worker.ts');
    const v = valeurs(worker);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => x === 'config.COMMISSION_MODELE_PCT'), `valeurs lues : ${v.join(', ')}`).toBe(true);
    expect(worker).toMatch(/creerCerveauGateway\(\{[\s\S]*?commissionPct: config\.COMMISSION_MODELE_PCT,/);
  });
});
