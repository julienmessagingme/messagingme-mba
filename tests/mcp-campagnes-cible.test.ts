import { describe, it, expect } from 'vitest';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { lireCibleMcp, MAX_IDENTIFIANTS_CIBLE } from '../src/mcp/cible';
import { DROITS, type Fonction } from '../src/offres/offres';
import { corpsRefusFonction } from '../src/offres/refus';
import type { ContactFilters, ContactRow } from '../src/crm/contact-store.pg';

/**
 * LA CIBLE DE L'ASSISTANT ET `find_contacts` (plan « Campagnes depuis Claude », tâche 4). La cible passe par
 * `parseBulkTarget`, le même analyseur que le mini-CRM et la création de campagne : ce fichier tient ce que l'assistant
 * ajoute devant lui. 🔴 Une cible sans critère n'existe pas (elle viserait tout l'espace), l'analyse reste à
 * l'Entreprise, et un identifiant d'un autre espace ne désigne personne.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const C1 = '11111111-1111-4111-8111-111111111111';
const CV1 = '33333333-3333-4333-8333-333333333333';
const PRO = DROITS.pro.fonctions;
const ENTREPRISE = DROITS.entreprise.fonctions;
const outil = OUTILS.find((o) => o.nom === 'find_contacts')!;

const fiche = (id: string): ContactRow => ({
  id, phoneE164: '+33600000001', profileName: 'Léa', optInStatus: 'opted_in', tags: ['vip'], fields: {}, createdAt: '2026-10-01T10:00:00.000Z',
} as unknown as ContactRow);

function deps(o: { fonctions?: ReadonlySet<Fonction>; conversations?: Record<string, string> } = {}) {
  const lus: Array<{ quoi: string; filtres?: ContactFilters; limit?: number; tenant?: string; ids?: string[] }> = [];
  const d = {
    offres: { offreDe: async () => ({ droits: { fonctions: o.fonctions ?? PRO } }) },
    inbox: {
      // La garde d'espace vit dans le store réel : ici, seules les conversations déclarées existent dans l'espace T.
      contactIdsDesConversations: async (tenant: string, ids: string[]) => {
        lus.push({ quoi: 'conversations', tenant, ids });
        return tenant === T ? ids.map((i) => o.conversations?.[i]).filter((x): x is string => x !== undefined) : [];
      },
    },
    contacts: {
      count: async (_t: string, filtres: ContactFilters) => { lus.push({ quoi: 'count', filtres }); return 238; },
      query: async (_t: string, filtres: ContactFilters, limit: number) => { lus.push({ quoi: 'query', filtres, limit }); return [fiche(C1)]; },
      analysesEtResumes: async () => { lus.push({ quoi: 'analyses' }); return new Map(); },
    },
  } as unknown as DepsMcp;
  return { d, lus };
}

describe('lireCibleMcp', () => {
  it('🔴 aucun critère : refusé, jamais « tout l’espace »', async () => {
    const { d, lus } = deps();
    for (const args of [{}, { tags: [] }, { tags: ['  '] }, { analysis: [] }, { contact_ids: [] }]) {
      await expect(lireCibleMcp(args, PRO, d, T, { identifiants: true }), JSON.stringify(args)).rejects.toThrow(RefusOutil);
    }
    expect(lus).toHaveLength(0);
  });

  it('les étiquettes, toutes ou l’une, et le consentement, en filtres du mini-CRM', async () => {
    const { d } = deps();
    expect(await lireCibleMcp({ tags: ['retard-livraison-oct', 'vip'], tag_mode: 'any', opt_in: 'opted_in' }, PRO, d, T, { identifiants: true }))
      .toEqual({ filters: { tags: ['retard-livraison-oct', 'vip'], tagMode: 'or', optIn: 'opted_in' }, excludeIds: [] });
  });

  it('🔴 l’analyse hors Entreprise : refusée avec le lien de l’offre', async () => {
    const { d } = deps();
    const args = { analysis: [{ field: 'analyse_sentiment', op: 'in', value: 'negatif' }] };
    await expect(lireCibleMcp(args, PRO, d, T, { identifiants: true })).rejects.toThrow(corpsRefusFonction('analyse').error);
    expect(await lireCibleMcp(args, ENTREPRISE, d, T, { identifiants: true }))
      .toEqual({ filters: { fieldFilters: [{ key: 'analyse_sentiment', op: 'in', value: 'negatif' }] }, excludeIds: [] });
  });

  it('🔴 un champ hors des champs d’analyse filtrables, ou un opérateur faux : refusé, jamais ignoré', async () => {
    const { d } = deps();
    for (const a of [
      { field: 'prenom', op: 'eq', value: 'Léa' },
      { field: 'analyse_sujet', op: 'in', value: 'livraison' },
      { field: 'analyse_urgence', op: 'eq', value: '7' },
      { field: 'analyse_sentiment', op: 'in', value: 'furieux' },
    ]) {
      await expect(lireCibleMcp({ analysis: [a] }, ENTREPRISE, d, T, { identifiants: true }), a.field).rejects.toThrow(RefusOutil);
    }
  });

  it('des conversations : leurs contacts, et 🔴 rien pour celles d’un autre espace', async () => {
    const { d } = deps({ conversations: { [CV1]: C1 } });
    expect(await lireCibleMcp({ conversation_ids: [CV1] }, PRO, d, T, { identifiants: true })).toEqual({ ids: [C1] });
    await expect(lireCibleMcp({ conversation_ids: [CV1] }, PRO, d, 'autre-espace', { identifiants: true })).rejects.toThrow(RefusOutil);
  });

  it('identifiants mal formés, trop nombreux, ou mêlés à des filtres : refusés', async () => {
    const { d, lus } = deps();
    const trop = Array.from({ length: MAX_IDENTIFIANTS_CIBLE + 1 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`);
    for (const args of [{ contact_ids: ['pas-un-uuid'] }, { contact_ids: trop }, { contact_ids: [C1], tags: ['vip'] }, { contact_ids: [C1], conversation_ids: [CV1] }]) {
      await expect(lireCibleMcp(args, PRO, d, T, { identifiants: true })).rejects.toThrow(RefusOutil);
    }
    expect(lus).toHaveLength(0);
    expect(MAX_IDENTIFIANTS_CIBLE).toBe(500);
  });

  it('des identifiants là où ils n’ont pas de sens : refusés', async () => {
    const { d } = deps();
    await expect(lireCibleMcp({ contact_ids: [C1] }, PRO, d, T, { identifiants: false })).rejects.toThrow(RefusOutil);
  });
});

describe('find_contacts', () => {
  it('une lecture de l’offre console (Pro), lisible avec une clé', () => {
    expect(outil.fonction).toBe('console');
    expect(outil.scope).toBe('mcp:read');
    expect(outil.exigePersonne).toBeUndefined();
    expect(outil.annotations.readOnlyHint).toBe(true);
  });

  it('rend le total et au plus 100 contacts', async () => {
    const { d, lus } = deps();
    const r = (await outil.executer(d, T, { tags: ['vip'], limit: 500 }, null)) as { total: number; contacts: unknown[] };
    expect(r.total).toBe(238);
    expect(r.contacts).toEqual([{ contact_id: C1, name: 'Léa', phone: '+33600000001', opt_in: 'opted_in', tags: ['vip'] }]);
    expect(lus.find((l) => l.quoi === 'query')?.limit).toBe(100);
  });

  it('la dernière analyse seulement en Entreprise', async () => {
    const pro = deps();
    await outil.executer(pro.d, T, { tags: ['vip'] }, null);
    expect(pro.lus.some((l) => l.quoi === 'analyses')).toBe(false);
    const ent = deps({ fonctions: ENTREPRISE });
    const r = (await outil.executer(ent.d, T, { tags: ['vip'] }, null)) as { contacts: Array<Record<string, unknown>> };
    expect(ent.lus.some((l) => l.quoi === 'analyses')).toBe(true);
    expect(r.contacts[0]).toHaveProperty('last_analysis', null);
  });

  it('🔴 sans critère, rien n’est lu', async () => {
    const { d, lus } = deps();
    await expect(outil.executer(d, T, {}, null)).rejects.toThrow(RefusOutil);
    expect(lus).toHaveLength(0);
  });
});
