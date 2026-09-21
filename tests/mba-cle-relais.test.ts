import { describe, it, expect } from 'vitest';
import { cleAJour, poserCleNeuve, oublierCle, type DepsCleRelais } from '../src/mba/cle-relais';

/**
 * La clé que Meta présente au relais (spec 2026-09-21-relais-mba-design.md, section 2).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : l'ORDRE, et ce qu'on laisse derrière soi. Retenir une clé avant que Meta
 * ne l'ait acceptée ferait croire à une clé posée qui ne l'est pas ; laisser vivante une autre clé
 * `mba:relais` laisserait un droit large que personne ne présente ; et après un échec, la publication
 * suivante doit REPOSER une clé, parce que l'échec était peut-être ambigu (Meta a écrit, nous avons reçu une
 * erreur).
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
    revoquerAutres: async (_t, garder) => {
      journal.push(`revoquerAutres sauf ${garder}`);
      for (const id of [...actives]) if (id !== garder) actives.delete(id);
    },
  };
  return { deps, journal, retenue: () => retenue, actives };
}

describe('la clé posée chez Meta', () => {
  it('🔴 dans l’ordre : créer, écrire chez Meta, retenir APRÈS son accusé, révoquer toutes les autres', async () => {
    const f = faux('k0');
    await poserCleNeuve(f.deps, 't1', async (cle) => { f.journal.push(`meta ${cle}`); });
    expect(f.journal).toEqual(['creer k1', 'meta mba_k1', 'retenir k1', 'revoquerAutres sauf k1']);
    expect([...f.actives]).toEqual(['k1']);
  });

  it('🔴 Meta refuse : la neuve est révoquée, PLUS AUCUNE n’est retenue, l’ancienne reste vivante, l’erreur remonte', async () => {
    // Plus aucune retenue : la publication suivante repose une clé, même si l'échec était ambigu et que Meta
    // détient la neuve. L'ancienne reste vivante : si Meta n'a rien écrit, c'est elle qu'il présente encore.
    const f = faux('k0');
    await expect(poserCleNeuve(f.deps, 't1', async () => { throw new Error('400'); })).rejects.toThrow('400');
    expect(f.journal).toEqual(['creer k1', 'revoquer k1', 'retenir null']);
    expect(f.retenue()).toBeNull();
    expect([...f.actives]).toEqual(['k0']);
    expect(await cleAJour(f.deps, 't1')).toBe(false);
  });

  it('🔴 une orpheline laissée par un échec passé est révoquée au succès suivant', async () => {
    const f = faux('k0');
    await expect(poserCleNeuve(f.deps, 't1', async () => { throw new Error('délai'); })).rejects.toThrow();
    await poserCleNeuve(f.deps, 't1', async () => {});
    expect([...f.actives]).toEqual(['k2']);
    expect(f.retenue()).toBe('k2');
  });

  it('une première clé : retenue, et rien d’autre de vivant', async () => {
    const f = faux(null);
    await poserCleNeuve(f.deps, 't1', async () => {});
    expect(f.journal).toEqual(['creer k1', 'retenir k1', 'revoquerAutres sauf k1']);
  });

  it('à jour seulement si une clé est retenue ET active', async () => {
    expect(await cleAJour(faux('k0').deps, 't1')).toBe(true);
    expect(await cleAJour(faux(null).deps, 't1')).toBe(false);
    const revoquee = faux('k0');
    await revoquee.deps.revoquer('t1', 'k0');
    expect(await cleAJour(revoquee.deps, 't1')).toBe(false);
  });

  it('oublier : toutes les clés du relais sont révoquées, et plus aucune n’est retenue', async () => {
    const f = faux('k0');
    await oublierCle(f.deps, 't1');
    expect(f.journal).toEqual(['revoquerAutres sauf null', 'retenir null']);
    expect([...f.actives]).toEqual([]);
  });
});
