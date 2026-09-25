import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

/**
 * La fiche PROJETÉE pour un tiers (connecteur, poussée d'opt-out, relais de l'agent de Meta, modèle) : une
 * seule écriture depuis l'audit ponytail du 2026-09-25, là où quatre câblages la recopiaient. Le numéro, le
 * BSUID et le statut d'opt-in ne doivent JAMAIS en faire partie.
 */
describe('PgContactStore.projectionPourTiers', () => {
  const store = () => new PgContactStore({} as Pool);

  it('🔴 nom, tags et champs, et RIEN d’autre de la fiche', async () => {
    const s = store();
    vi.spyOn(s, 'getContactStateByWaId').mockResolvedValue({
      fields: { ville: 'Auxerre' }, tags: ['vip'], optIn: 'opted_in', name: 'Julie', phone: '+33600000001', bsuid: 'B1',
    });
    expect(await s.projectionPourTiers('t1', '33600000001')).toEqual({ nom: 'Julie', tags: ['vip'], champs: { ville: 'Auxerre' } });
    expect(s.getContactStateByWaId).toHaveBeenCalledWith('t1', '33600000001');
  });

  it('un contact sans nom rend un nom VIDE, un contact inconnu rend `null`', async () => {
    const s = store();
    vi.spyOn(s, 'getContactStateByWaId').mockResolvedValueOnce({ fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null });
    expect(await s.projectionPourTiers('t1', 'w')).toEqual({ nom: '', tags: [], champs: {} });
    vi.spyOn(s, 'getContactStateByWaId').mockResolvedValueOnce(null);
    expect(await s.projectionPourTiers('t1', 'w')).toBeNull();
  });
});
