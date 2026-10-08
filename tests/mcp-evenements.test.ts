import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { mcpEvenementsInertes } from './routes-inertes';
import type { DepsGestionEvenements } from '../src/evenements/gestion';
import type { AdresseVue } from '../src/evenements/store.pg';

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
