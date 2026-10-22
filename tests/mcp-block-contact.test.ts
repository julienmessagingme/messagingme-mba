import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, RefusOutil, type DepsMcp } from '../src/mcp/outils';
import type { ContactRow } from '../src/crm/contact-store.pg';

/**
 * BLOQUER UN CONTACT DEPUIS CLAUDE (plan `docs/superpowers/plans/2026-10-22-mcp-marche-arriere.md`, tâche 4). La Free n'a
 * plus la fiche du contact : un importun faisait répondre l'agent IA à chaque message, donc consommait le crédit, sans
 * recours. Le MÊME geste que la fiche (`setBlocked`) ; la garde qui en découle (un contact bloqué n'est confié à aucune
 * machine) a ses propres tests (`tests/repondeur-demarrer.test.ts`, `tests/fil.test.ts`). Ce fichier tient ce que l'outil
 * ajoute : désigner le contact, signer le geste, des refus lisibles.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const C = '33333333-3333-4333-8333-333333333333';
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;
const MOI = { userId: '99999999-9999-4999-8999-999999999999' };

function contact(blockedAt: string | null): ContactRow {
  return {
    id: C, phoneE164: '+33612345678', profileName: 'Importun', optInStatus: 'unknown', tags: [], fields: {},
    createdAt: '2026-10-01T10:00:00.000Z', blockedAt,
  } as unknown as ContactRow;
}

function deps(o: { connu?: boolean; bloque?: boolean } = {}) {
  const gestes: Array<{ tenantId: string; contactId: string; bloque: boolean; par: string | null }> = [];
  const lus: string[] = [];
  const d = {
    contacts: {
      findByPhone: async (tenantId: string, phone: string) => {
        lus.push(phone);
        return (o.connu ?? true) && tenantId === T && phone === '+33612345678' ? contact(o.bloque ? '2026-10-22T10:00:00.000Z' : null) : null;
      },
      setBlocked: async (tenantId: string, contactId: string, bloque: boolean, par: string | null) => {
        if (!(o.connu ?? true) || tenantId !== T || contactId !== C) return false;
        gestes.push({ tenantId, contactId, bloque, par });
        return true;
      },
      analysesEtResumes: async () => new Map(),
      query: async () => [contact(o.bloque ? '2026-10-22T10:00:00.000Z' : null)],
    },
  } as unknown as DepsMcp;
  return { d, gestes, lus };
}

describe('block_contact : bloquer et débloquer depuis Claude (marche arrière, tâche 4)', () => {
  it('🔴 il exige une personne, dans toutes les offres : une clé d’API ne le voit pas', () => {
    expect(outil('block_contact').exigePersonne).toBe(true);
    expect(outil('block_contact').fonction).toBeNull();
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null } as never).map((o) => o.nom);
    expect(parCle).not.toContain('block_contact');
  });

  it('bloque un contact désigné par son numéro, au nom de la personne, par le geste de la fiche', async () => {
    const { d, gestes } = deps();
    expect(await outil('block_contact').executer(d, T, { phone: '+33612345678', blocked: true }, MOI)).toEqual({ contact_id: C, blocked: true });
    expect(gestes).toEqual([{ tenantId: T, contactId: C, bloque: true, par: MOI.userId }]);
  });

  it('débloque un contact désigné par sa fiche', async () => {
    const { d, gestes } = deps({ bloque: true });
    expect(await outil('block_contact').executer(d, T, { contact_id: C, blocked: false }, MOI)).toEqual({ contact_id: C, blocked: false });
    expect(gestes).toEqual([{ tenantId: T, contactId: C, bloque: false, par: MOI.userId }]);
  });

  it('🔴 un numéro ou une fiche inconnus de l’espace sont refusés, sans aucun geste', async () => {
    for (const saisie of [{ phone: '+33612345678', blocked: true }, { contact_id: C, blocked: true }]) {
      const { d, gestes } = deps({ connu: false });
      await expect(outil('block_contact').executer(d, T, saisie, MOI)).rejects.toThrow(/contact inconnu/);
      expect(gestes).toEqual([]);
    }
  });

  it('une saisie bancale est refusée avant toute lecture : ni l’un ni l’autre, les deux, blocked absent, fiche qui n’est pas un uuid', async () => {
    const saisies = [
      { blocked: true },
      { phone: '+33612345678', contact_id: C, blocked: true },
      { phone: '+33612345678' },
      { phone: '+33612345678', blocked: 'oui' },
      { contact_id: 'pas-un-uuid', blocked: true },
    ];
    for (const saisie of saisies) {
      const { d, gestes, lus } = deps();
      await expect(outil('block_contact').executer(d, T, saisie, MOI)).rejects.toBeInstanceOf(RefusOutil);
      expect(gestes).toEqual([]);
      expect(lus).toEqual([]);
    }
  });

  it('get_contact et search_contacts disent si le contact est bloqué : c’est là que Claude le retrouve pour le débloquer', async () => {
    const { d } = deps({ bloque: true });
    expect(await outil('get_contact').executer(d, T, { phone: '+33612345678' }, MOI)).toMatchObject({ id: C, blocked: true });
    expect(await outil('search_contacts').executer(d, T, { query: 'Importun' }, MOI)).toMatchObject({ contacts: [{ id: C, blocked: true }] });
  });
});
