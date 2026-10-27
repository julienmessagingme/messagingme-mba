import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgRcsMediaStore } from '../src/rcs/media-store.pg';
import { LimiteOffreError } from '../src/offres/refus';
import { magasinFaux } from './magasin-objets-faux';

/**
 * LE DÉPÔT AU BUCKET QUAND LA FICHE ÉCHOUE (lot A des médias, relecture du 2026-10-27). L'objet part avant la
 * transaction : il ne doit rester que si une fiche le nomme, et un dépôt refusé par le quota ne doit pas l'envoyer.
 */
describe('PgRcsMediaStore.deposer au bucket', () => {
  function monter(o: { commitCasse?: boolean; ficheEcrite?: boolean; occupation?: number } = {}) {
    const client = {
      query: async (sql: string) => {
        if (/^commit/i.test(sql.trim()) && o.commitCasse) throw new Error('connexion coupée pendant le commit');
        if (/^insert into rcs_media/.test(sql.trim())) {
          return { rowCount: 1, rows: [{ id: 'm1', code: 'abcdefghjkmnpqrstvwxyz0123', mime: 'image/png', taille: 3, nom: null, created_at: new Date() }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        if (/select 1 from rcs_media where code/.test(sql)) return { rowCount: o.ficheEcrite ? 1 : 0, rows: [] };
        if (/as occupation/.test(sql)) return { rowCount: 1, rows: [{ occupation: String(o.occupation ?? 0), doublon: null }] };
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;
    let depots = 0;
    const { magasin, objets } = magasinFaux((op) => { if (op === 'deposer') depots += 1; return false; });
    return { store: new PgRcsMediaStore(pool, magasin), objets, depots: () => depots };
  }
  const fichier = { code: 'abcdefghjkmnpqrstvwxyz0123', mime: 'image/png' as const, bytes: Buffer.from('png'), nom: null };

  it('🔴 un COMMIT coupé dont la fiche EST écrite : l’objet reste, la fiche ne pointe pas un objet absent', async () => {
    const { store, objets } = monter({ commitCasse: true, ficheEcrite: true });
    await expect(store.deposer('t1', fichier, null)).rejects.toThrow(/commit/);
    expect(objets.size).toBe(1);
  });

  it('un COMMIT coupé sans fiche écrite : l’objet déposé pour rien est effacé', async () => {
    const { store, objets } = monter({ commitCasse: true, ficheEcrite: false });
    await expect(store.deposer('t1', fichier, null)).rejects.toThrow(/commit/);
    expect(objets.size).toBe(0);
  });

  it('un dépôt au-delà du quota est refusé AVANT d’envoyer quoi que ce soit au bucket', async () => {
    const { store, objets, depots } = monter({ occupation: 1000 });
    await expect(store.deposer('t1', fichier, 1001)).rejects.toBeInstanceOf(LimiteOffreError);
    expect(depots()).toBe(0);
    expect(objets.size).toBe(0);
  });
});
