import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession, signLienNumero } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { NumeroFourniRouteDeps } from '../src/http/numero-fourni';
import type { NumeroFourni } from '../src/otp/store.pg';
import { lireEtatConnexion, empreinteEtat, type EtatConnexion } from '../src/otp/etat-connexion';

/**
 * L'ÉTAT DE LA CONNEXION DU NUMÉRO (lot 3c, livraison A, tâche 3) : où en est le branchement d'un espace. Une seule
 * lecture, qui sert la page `/brancher` (`GET /tenants/:tenantId/connexion-numero`) ET l'outil d'attente de Claude Code
 * (`watch_whatsapp_connection`), pour qu'ils ne divergent jamais.
 */
const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const NUMERO = (numero: string): NumeroFourni => ({
  id: `id-${numero}`, numero, didwwDidId: `did-${numero}`, statut: 'attribue', tenantId: 't1', attribueLe: new Date(), creeLe: new Date(),
});

function etatDe(o: { attribue?: string; code?: { code: string; recuLe: Date }; connecte?: string; aActiver?: boolean; abonnement?: 'actif' | 'resilie' }) {
  const lus: string[] = [];
  const deps = {
    numeros: {
      numeroDeLEspace: async (t: string) => { lus.push(`numero:${t}`); return o.attribue ? NUMERO(o.attribue) : null; },
      codeDeLEspace: async (t: string) => { lus.push(`code:${t}`); return o.code ?? null; },
    },
    numeroConnecte: async (t: string) => { lus.push(`connecte:${t}`); return o.connecte !== undefined ? { chiffres: o.connecte, aActiver: o.aActiver === true } : null; },
    abonnements: {
      deLEspace: async (t: string) => {
        lus.push(`abonnement:${t}`);
        return o.abonnement ? { abonnementId: 'sub_1', tenantId: t, livemode: false, statut: o.abonnement, periodeFin: new Date('2026-11-06T09:00:00Z') } : null;
      },
    },
  };
  return { deps, lus };
}

describe('lireEtatConnexion', () => {
  it('un espace sans rien : tout à null', async () => {
    const { deps } = etatDe({});
    expect(await lireEtatConnexion(deps, 't1')).toEqual({ fourni: null, code: null, connecte: null, abonnement: null });
  });

  it('le numéro attribué, au format tapé dans la fenêtre de Meta, puis le code, puis la connexion', async () => {
    const recuLe = new Date('2026-10-06T08:53:01Z');
    expect(await lireEtatConnexion(etatDe({ attribue: '441235619343' }).deps, 't1'))
      .toEqual({ fourni: '+441235619343', code: null, connecte: null, abonnement: null });
    expect(await lireEtatConnexion(etatDe({ attribue: '441235619343', code: { code: '123456', recuLe } }).deps, 't1'))
      .toEqual({ fourni: '+441235619343', code: { code: '123456', recuLe: '2026-10-06T08:53:01.000Z' }, connecte: null, abonnement: null });
    expect(await lireEtatConnexion(etatDe({ attribue: '441235619343', connecte: '441235619343' }).deps, 't1'))
      .toEqual({ fourni: '+441235619343', code: null, connecte: { chiffres: '441235619343', aActiver: false }, abonnement: null });
    expect((await lireEtatConnexion(etatDe({ abonnement: 'actif' }).deps, 't1')).abonnement)
      .toEqual({ statut: 'actif', periodeFin: '2026-11-06T09:00:00.000Z' });
    expect((await lireEtatConnexion(etatDe({ connecte: '441235619343', aActiver: true }).deps, 't1')).connecte)
      .toEqual({ chiffres: '441235619343', aActiver: true });
  });

  it('chaque lecture est filtrée sur l’espace demandé', async () => {
    const { deps, lus } = etatDe({ attribue: '441235619343' });
    await lireEtatConnexion(deps, 't-42');
    expect(lus.every((l) => l.endsWith(':t-42'))).toBe(true);
  });
});

describe('empreinteEtat', () => {
  const vide: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null };
  const paye: EtatConnexion = { ...vide, abonnement: { statut: 'actif', periodeFin: null } };
  const attribue: EtatConnexion = { ...vide, fourni: '+441235619343' };
  const avecCode: EtatConnexion = { ...attribue, code: { code: '123456', recuLe: '2026-10-06T08:53:01.000Z' } };
  const autreCode: EtatConnexion = { ...attribue, code: { code: '654321', recuLe: '2026-10-06T08:55:01.000Z' } };
  const aActiver: EtatConnexion = { ...avecCode, connecte: { chiffres: '441235619343', aActiver: true } };
  const connecte: EtatConnexion = { ...avecCode, connecte: { chiffres: '441235619343', aActiver: false } };

  it('change à chaque étape, et un second code compte comme un changement', () => {
    const e = [vide, paye, attribue, avecCode, autreCode, aActiver, connecte].map(empreinteEtat);
    expect(new Set(e).size).toBe(7);
  });

  it('reste la même pour le même état, et ne laisse pas lire le code', () => {
    expect(empreinteEtat(avecCode)).toBe(empreinteEtat({ ...avecCode }));
    expect(empreinteEtat(avecCode)).not.toContain('123456');
  });
});

describe('GET /tenants/:tenantId/connexion-numero', () => {
  let adminTok = '';
  let agentTok = '';
  beforeAll(async () => {
    adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  });
  const monter = () => {
    const deps: NumeroFourniRouteDeps = {
      numeros: {
        attribuer: async () => null,
        numeroDeLEspace: async () => NUMERO('441235619343'),
        codeDeLEspace: async () => ({ code: '123456', recuLe: new Date('2026-10-06T08:53:01Z') }),
        remplacerNumero: async () => ({ bloque: null, nouveau: null }),
        rendre: async () => null,
        compterLibres: async () => 0,
      },
      numeroConnecte: async () => null,
      verrous: { prendre: async () => null },
      alertes: { reserveBasse: async () => {}, numeroBloque: async () => {} },
      seuilReserve: 3,
      abonnements: { deLEspace: async () => null },
      abonnement: { ouvrir: async () => ({ ok: true as const, valeur: { url: 'https://x' } }) },
    };
    return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET, getUserState: async (userId) => ({ role: userId === 'u2' ? 'agent' : 'admin', disabled: false }) }, numeroFourni: deps });
  };
  const lire = (server: ReturnType<typeof monter>, tenant: string, jeton: string) =>
    server.inject({ method: 'GET', url: `/tenants/${tenant}/connexion-numero`, headers: { authorization: `Bearer ${jeton}` } });

  it('rend l’état à un admin, et le refuse à un membre', async () => {
    const server = monter();
    const r = await lire(server, 't1', adminTok);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      etat: { fourni: '+441235619343', code: { code: '123456', recuLe: '2026-10-06T08:53:01.000Z' }, connecte: null, abonnement: null },
      empreinte: expect.any(String),
    });
    expect((await lire(server, 't1', agentTok)).statusCode).toBe(403);
  });

  it('🔴 le jeton du lien lit l’état de SON espace, et pas celui d’un autre', async () => {
    const server = monter();
    const jeton = await signLienNumero({ tenantId: 't1', userId: 'u1', mode: 'fourni' }, SECRET);
    expect((await lire(server, 't1', jeton)).statusCode).toBe(200);
    expect((await lire(server, 't2', jeton)).statusCode).toBe(403);
  });
});
