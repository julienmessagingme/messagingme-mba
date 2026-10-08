import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LA COMMISSION, CÂBLÉE DEPUIS L'OFFRE DE L'ESPACE ET NULLE PART EN DUR (relecture du lot 1, 2026-09-28 ; lot 6,
 * livraison C, tâche 17).
 *
 * 🔴 CE QUE LE TYPAGE NE VOIT PAS : `commissionPour` est une fonction, et `commissionPour: async () => 10` compile aussi
 * bien que la lecture de l'offre. Une constante dans une racine ferait débiter un autre prix que celui que la liste des
 * modèles affiche, et un espace en Base paierait le tarif du Pro sans une erreur. Le calcul est tenu par
 * `tests/agent-devise.test.ts` et `tests/offres-commission.test.ts` ; ce fichier tient le CÂBLAGE : chaque
 * `commissionPour` des deux racines (le tour d'agent du worker, l'essai de la console et la traduction de l'API) et le
 * tarif affiché lisent la MÊME fonction, `commissionDeLEspace`, bâtie sur l'offre.
 */
function sansCommentaires(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const lire = (chemin: string): string => sansCommentaires(readFileSync(new URL(chemin, import.meta.url), 'utf8'));

/** Chaque valeur passée à `commissionPour:` dans une source, telle qu'écrite. */
function valeurs(source: string): string[] {
  return [...source.matchAll(/commissionPour:\s*([^,\n}]+)/g)].map((m) => m[1]!.trim());
}

function sources(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? sources(chemin) : chemin.endsWith('.ts') ? [chemin] : [];
  });
}

describe('la commission des débits, de l’offre aux racines', () => {
  it('🔴 l’API : la traduction et l’essai de la console lisent la commission de l’espace', () => {
    const api = lire('../src/index.ts');
    const v = valeurs(api);
    // Deux câblages attendus : sans cette borne, une racine qui cesserait de passer la commission rendrait ce test vert.
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.every((x) => x === 'commissionDeLEspace'), `valeurs lues : ${v.join(', ')}`).toBe(true);
    expect(api).toMatch(/creerTraducteur\(\{[\s\S]*?commissionPour: commissionDeLEspace,[\s\S]*?\}\)/);
    expect(api).toMatch(/const commissionDeLEspace = commissionPour\(offres\)/);
    // Le tarif AFFICHÉ lit la même fonction : c'est ce qui fait du prix annoncé le prix payé.
    expect(api).toMatch(/modelesProposables\(catalogue, config\.EUR_PER_USD, await commissionDeLEspace\(tenantId\)\)/);
  });

  it('🔴 le worker : le cerveau des tours d’agent lit la commission de l’espace', () => {
    const worker = lire('../src/worker.ts');
    const v = valeurs(worker);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => x === 'commissionDeLEspace'), `valeurs lues : ${v.join(', ')}`).toBe(true);
    expect(worker).toMatch(/creerCerveauGateway\(\{[\s\S]*?commissionPour: commissionDeLEspace,/);
    expect(worker).toMatch(/const commissionDeLEspace = commissionPour\(offres\)/);
  });

  it('🔴 `COMMISSION_MODELE_PCT` n’existe plus nulle part dans `src/` : la grille des offres est la seule source', () => {
    const racine = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const fautifs = sources(racine).filter((f) => /COMMISSION_MODELE_PCT/.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
  });
});
