import { describe, it, expect } from 'vitest';
import { cleAJour, poserCleNeuve, oublierCle, type DepsCleRelais } from '../src/mba/cle-relais';

/**
 * La clé que Meta présente au relais (spec 2026-09-21-relais-mba-design.md, section 2).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : l'ORDRE. Retenir une clé avant que Meta ne l'ait acceptée ferait croire à
 * une clé posée qui ne l'est pas ; ne pas révoquer une clé refusée laisserait traîner une clé active que
 * personne ne présente.
 */
function faux(depart: string | null = 'k0') {
  const journal: string[] = [];
  let retenue = depart;
  const actives = new Set(depart ? [depart] : []);
  let n = 0;
  const deps: DepsCleRelais = {
    creerCle: async () => { n += 1; const id = `k${n}`; actives.add(id); journal.push(`creer ${id}`); return { id, key: `mba_${id}` }; },
    revoquer: async (_t, id) => { journal.push(`revoquer ${id}`); return actives.delete(id); },
    cleRetenue: async () => retenue,
    retenir: async (_t, id) => { journal.push(`retenir ${id}`); retenue = id; },
    estActive: async (_t, id) => actives.has(id),
  };
  return { deps, journal, retenue: () => retenue };
}

describe('la clé posée chez Meta', () => {
  it('🔴 dans l’ordre : créer, écrire chez Meta, retenir APRÈS son accusé, révoquer l’ancienne', async () => {
    const f = faux('k0');
    await poserCleNeuve(f.deps, 't1', async (cle) => { f.journal.push(`meta ${cle}`); });
    expect(f.journal).toEqual(['creer k1', 'meta mba_k1', 'retenir k1', 'revoquer k0']);
  });

  it('🔴 Meta refuse : la clé neuve est révoquée, l’ancienne reste retenue, l’erreur remonte', async () => {
    const f = faux('k0');
    await expect(poserCleNeuve(f.deps, 't1', async () => { throw new Error('400'); })).rejects.toThrow('400');
    expect(f.journal).toEqual(['creer k1', 'revoquer k1']);
    expect(f.retenue()).toBe('k0');
  });

  it('une première clé : rien à révoquer derrière', async () => {
    const f = faux(null);
    await poserCleNeuve(f.deps, 't1', async () => {});
    expect(f.journal).toEqual(['creer k1', 'retenir k1']);
  });

  it('à jour seulement si une clé est retenue ET active', async () => {
    expect(await cleAJour(faux('k0').deps, 't1')).toBe(true);
    expect(await cleAJour(faux(null).deps, 't1')).toBe(false);
    const revoquee = faux('k0');
    await revoquee.deps.revoquer('t1', 'k0');
    expect(await cleAJour(revoquee.deps, 't1')).toBe(false);
  });

  it('oublier : révoquer la clé retenue et vider la colonne', async () => {
    const f = faux('k0');
    await oublierCle(f.deps, 't1');
    expect(f.journal).toEqual(['revoquer k0', 'retenir null']);
  });
});
