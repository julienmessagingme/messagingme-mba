import { describe, it, expect } from 'vitest';
import { recopierVersObjets, LOT_RECOPIE, type SourceRecopie } from '../src/medias/recopie';
import { magasinFaux } from './magasin-objets-faux';

/**
 * LA RECOPIE VERS LE BUCKET (lot A des médias, tâche 3) : rejouable, et un dépôt en échec laisse la fiche en base pour
 * la passe suivante. Le SQL de la source vit dans `tests/integration/medias-stock.integration.test.ts`.
 */
type Fiche = { id: string; tenantId: string; code: string; mime: 'image/png'; bytes: Buffer | null; cle: string | null };

function sourceFausse(n: number) {
  const fiches: Fiche[] = Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    tenantId: i % 2 === 0 ? 'espace-a' : 'espace-b',
    code: `code${i}`,
    mime: 'image/png' as const,
    bytes: Buffer.from(`octets ${i}`),
    cle: null,
  }));
  const source: SourceRecopie = {
    lot: async (apres, limite) => fiches
      .filter((f) => f.bytes !== null && (apres === null || f.id > apres))
      .slice(0, limite)
      .map((f) => ({ id: f.id, tenantId: f.tenantId, code: f.code, mime: f.mime, bytes: f.bytes! })),
    poser: async (id, cle) => {
      const f = fiches.find((x) => x.id === id && x.bytes !== null);
      if (!f) return false;
      f.cle = cle;
      f.bytes = null;
      return true;
    },
    restantes: async () => fiches.filter((f) => f.bytes !== null).length,
  };
  return { source, fiches };
}

describe('la recopie des fichiers en base vers le bucket', () => {
  it('recopie tout, sur plusieurs lots, sous le préfixe de chaque espace ; rejouée, elle ne change plus rien', async () => {
    const n = LOT_RECOPIE * 2 + 3;
    const { source, fiches } = sourceFausse(n);
    const { magasin, objets } = magasinFaux();
    expect(await recopierVersObjets(source, magasin)).toEqual({ recopiees: n, echecs: 0, restantes: 0 });
    expect(objets.size).toBe(n);
    expect(fiches[1]!.cle).toBe('tenants/espace-b/code1.png');
    expect(objets.get('tenants/espace-b/code1.png')?.octets.toString()).toBe('octets 1');
    expect(await recopierVersObjets(source, magasin)).toEqual({ recopiees: 0, echecs: 0, restantes: 0 });
    expect(objets.size).toBe(n);
  });

  it('🔴 un dépôt en échec laisse la fiche EN BASE, la recopie continue, et la passe suivante la reprend', async () => {
    const { source, fiches } = sourceFausse(5);
    let panne = true;
    const { magasin } = magasinFaux((op, cle) => panne && op === 'deposer' && cle.endsWith('code2.png'));
    const journal: string[] = [];
    expect(await recopierVersObjets(source, magasin, (l) => journal.push(l))).toEqual({ recopiees: 4, echecs: 1, restantes: 1 });
    expect(fiches[2]!.bytes).not.toBeNull();
    expect(fiches[2]!.cle).toBeNull();
    expect(journal[0]).toContain('code2.png');
    panne = false;
    expect(await recopierVersObjets(source, magasin)).toEqual({ recopiees: 1, echecs: 0, restantes: 0 });
  });

  it('🔴 un objet relu DIFFÉRENT des octets en base : la fiche reste en base, rien n’est vidé', async () => {
    const { source, fiches } = sourceFausse(2);
    const { magasin } = magasinFaux();
    const abime = { ...magasin, lireOctets: async (cle: string) => (cle.endsWith('code1.png') ? Buffer.from('abîmé') : magasin.lireOctets(cle)) };
    const journal: string[] = [];
    expect(await recopierVersObjets(source, abime, (l) => journal.push(l))).toEqual({ recopiees: 1, echecs: 1, restantes: 1 });
    expect(fiches[1]!.bytes?.toString()).toBe('octets 1');
    expect(journal[0]).toContain('relu différent');
  });
});
