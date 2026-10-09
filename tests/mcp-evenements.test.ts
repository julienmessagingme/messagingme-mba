import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { mcpEvenementsInertes } from './routes-inertes';
import { JOURNAL_PAGE_MAX, type DepsGestionEvenements } from '../src/evenements/gestion';
import type { AdresseVue, EnvoiVue } from '../src/evenements/store.pg';

/**
 * LES WEBHOOKS SORTANTS DEPUIS CLAUDE CODE (lot 12, livraison A) : deux outils, qui appellent la MÊME gestion que la
 * console (`src/evenements/gestion.ts`, testée à part) et n'exigent rien de plus qu'une personne.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const A = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;

function deps(o: { limite?: number | null; couteuxAccepte?: boolean } = {}) {
  const audit: Array<{ action: string; userId: string | null; detail: unknown }> = [];
  const vue: AdresseVue = {
    id: A, url: 'https://app.client.fr/hook', description: '', types: ['message.received'], active: true, creeLe: '2026-10-08T10:00:00.000Z',
    ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 0,
  };
  const gestion: DepsGestionEvenements = {
    ...mcpEvenementsInertes.evenements.gestion,
    limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
  };
  gestion.adresses = {
    ...mcpEvenementsInertes.evenements.gestion.adresses,
    compterActives: async () => 1,
    creer: async (_t, a) => ({ ...vue, types: [...a.types] }),
    pourEnvoi: async () => ({ url: vue.url, active: true, rang: 1, secretChiffre: 'c:whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', secretPrecedentChiffre: null, secretPrecedentJusqua: null }),
  };
  gestion.envois = { ...gestion.envois, noterEssai: async () => {} };
  gestion.chiffrer = (c) => `c:${c}`;
  gestion.dechiffrer = (c) => c.slice(2);
  gestion.appeler = async () => ({ livre: false, definitif: false, code: 401, extrait: 'signature invalide' });
  const d = {
    evenements: { gestion, audit: async (_t: string, acteur: { userId: string | null }, action: string, _c: unknown, detail: unknown) => { audit.push({ action, userId: acteur.userId, detail }); } },
    couteux: { consommer: async () => ({ accepte: o.couteuxAccepte ?? true, attenteMs: 3000 }) },
  } as unknown as DepsMcp;
  return { d, audit };
}

describe('les outils MCP des webhooks sortants', () => {
  it('🔴 les deux exigent une personne : une clé d’API (un connecteur d’agent) ne les voit pas', () => {
    for (const nom of ['create_webhook_endpoint', 'send_test_event']) expect(outil(nom).exigePersonne).toBe(true);
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null } as never).map((o) => o.nom);
    expect(parCle).not.toContain('create_webhook_endpoint');
    expect(parCle).not.toContain('send_test_event');
  });

  it('🔴 la création rend le secret une fois, et l’audit signe la personne et l’origine, sans le secret', async () => {
    const { d, audit } = deps();
    const r = await outil('create_webhook_endpoint').executer(d, T, { url: 'https://app.client.fr/hook' }, { userId: 'u1' }) as { secret: string; adresse: { types: string[] } };
    expect(r.secret).toMatch(/^whsec_/);
    expect(r.adresse.types).not.toContain('message.delivered');
    expect(audit).toEqual([{ action: 'evenements.adresse_creee', userId: 'u1', detail: { url: 'https://app.client.fr/hook', types: r.adresse.types, via: 'mcp' } }]);
    expect(JSON.stringify(audit)).not.toContain(r.secret.slice(6));
  });

  it('un refus de la gestion garde sa phrase : la limite de l’offre', async () => {
    const { d } = deps({ limite: 1 });
    await expect(outil('create_webhook_endpoint').executer(d, T, { url: 'https://app.client.fr/hook' }, { userId: 'u1' }))
      .rejects.toThrow(/Limite de votre offre atteinte : 1 adresse de webhook sortant/);
  });

  it('l’essai rend ce que l’application a répondu, et compte dans les opérations lourdes', async () => {
    const r = await outil('send_test_event').executer(deps().d, T, { adresse_id: A }, { userId: 'u1' });
    expect(r).toMatchObject({ livre: false, code: 401, reponse: 'signature invalide' });
    await expect(outil('send_test_event').executer(deps({ couteuxAccepte: false }).d, T, { adresse_id: A }, { userId: 'u1' }))
      .rejects.toBeInstanceOf(RefusOutil);
  });
});

describe('la liste, le journal et le rejeu depuis Claude (lot 13, domaine 4)', () => {
  const ENVOI: EnvoiVue = {
    id: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a', evenementId: 'evt_0123456789abcdef0123456789abcdef', type: 'message.received', statut: 'livre',
    tentatives: 1, dernierCode: 200, derniereReponse: 'ok', prochainEssaiLe: null, creeLe: '2026-10-09T10:00:00.000Z', livreLe: '2026-10-09T10:00:01.000Z', corps: '{}',
  };
  function avecJournal() {
    const { d, audit } = deps();
    const vus: Array<{ tenant: string; avant: string | null; limite: number }> = [];
    d.evenements.gestion.adresses = {
      ...d.evenements.gestion.adresses,
      lister: async () => [{
        id: A, url: 'https://app.client.fr/hook', description: '', types: ['message.received'], active: true, creeLe: '2026-10-08T10:00:00.000Z',
        ancienSecretJusqua: null, derniereLivraisonLe: null, enReessai: 0, echecs: 2,
      }],
      existe: async (t, id) => t === T && id === A,
    };
    d.evenements.gestion.envois = {
      ...d.evenements.gestion.envois,
      journal: async (t, _id, p) => { vus.push({ tenant: t, avant: p.avant?.toISOString() ?? null, limite: p.limite }); return [ENVOI]; },
      rejouer: async (t, id) => (t === T && id === ENVOI.id ? { tentative: 2 } : null),
    };
    d.evenements.gestion.enfiler = async () => {};
    return { d, audit, vus };
  }

  it('la page du journal annoncée à Claude est celle de la gestion', () => {
    expect(JOURNAL_PAGE_MAX).toBe(100);
  });

  it('🔴 la liste, le journal et le rejeu exigent une personne : une adresse peut porter un jeton dans son chemin', () => {
    expect(outil('list_webhook_endpoints').exigePersonne).toBe(true);
    expect(outil('get_webhook_deliveries').exigePersonne).toBe(true);
    expect(outil('replay_webhook_delivery').exigePersonne).toBe(true);
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null } as never).map((o) => o.nom);
    expect(parCle).not.toContain('list_webhook_endpoints');
    expect(parCle).not.toContain('get_webhook_deliveries');
    expect(parCle).not.toContain('replay_webhook_delivery');
  });

  it('la liste et le journal ont les vues de l’API (webhookV1, deliveryV1)', async () => {
    const { d, vus } = avecJournal();
    expect(await outil('list_webhook_endpoints').executer(d, T, {}, { userId: 'u1' })).toMatchObject({
      adresses: [{ id: A, url: 'https://app.client.fr/hook', active: true, failed: 2 }], limite: null, types: expect.arrayContaining(['template.status_changed']),
    });
    const j = await outil('get_webhook_deliveries').executer(d, T, { adresse_id: A, limit: 1, before: '2026-10-09T11:00:00Z' }, { userId: 'u1' });
    expect(j).toEqual({
      envois: [expect.objectContaining({ id: ENVOI.id, status: 'delivered', eventId: ENVOI.evenementId })],
      next_before: ENVOI.creeLe,
    });
    expect(vus).toEqual([{ tenant: T, avant: '2026-10-09T11:00:00.000Z', limite: 1 }]);
    await expect(outil('get_webhook_deliveries').executer(d, T, { adresse_id: A, before: 'hier' }, { userId: 'u1' })).rejects.toThrow(/before/);
  });

  it('🔴 le rejeu repart, signé de la personne dans l’audit ; un envoi inconnu est un refus lisible', async () => {
    const { d, audit } = avecJournal();
    expect(await outil('replay_webhook_delivery').executer(d, T, { envoi_id: ENVOI.id }, { userId: 'u1' })).toEqual({ rejoue: true });
    expect(audit).toEqual([{ action: 'evenements.envoi_rejoue', userId: 'u1', detail: { via: 'mcp' } }]);
    await expect(outil('replay_webhook_delivery').executer(d, T, { envoi_id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b' }, { userId: 'u1' }))
      .rejects.toThrow(/rien à rejouer/);
  });
});
