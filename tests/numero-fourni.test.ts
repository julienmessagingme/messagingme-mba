import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { creerAlertesReserve, type NumeroFourniRouteDeps } from '../src/http/numero-fourni';
import type { CleDemandee, Prise } from '../src/db/verrous-courts';
import type { NumeroFourni } from '../src/otp/store.pg';

/**
 * LE NUMÉRO FOURNI CÔTÉ CLIENT (lot 3b, spec docs/superpowers/specs/2026-10-05-numero-fourni-design.md) : la page
 * « Connecter WhatsApp » obtient un numéro de la réserve, l'affiche, puis lit le code que l'Asterisk a capté quand Meta
 * appelle ce numéro. Le client le tape lui-même dans la fenêtre de Meta : aucune de ces routes ne parle à Meta.
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const NUMERO = (numero: string): NumeroFourni => ({
  id: `id-${numero}`, numero, didwwDidId: `did-${numero}`, statut: 'attribue', tenantId: 't1', attribueLe: new Date(), creeLe: new Date(),
});

/** Des verrous courts en mémoire : une clé prise reste prise (le temps de la fenêtre du test). */
function fauxVerrous() {
  const pris = new Set<string>();
  const relaches: string[] = [];
  return {
    pris, relaches,
    prendre: async (cles: ReadonlyArray<CleDemandee>): Promise<Prise | null> => {
      if (cles.some(([c]) => pris.has(c))) return null;
      cles.forEach(([c]) => pris.add(c));
      return { jeton: 'j', cles: cles.map(([c]) => c) };
    },
    relacher: async (prise: Prise) => { prise.cles.forEach((c) => { pris.delete(c); relaches.push(c); }); },
  };
}

function monter(o: {
  /** Les chiffres du numéro WhatsApp connecté à l'espace (aucun si absent). */
  connecte?: string; reserve?: string[]; libresApres?: number; attribue?: string | null; code?: { code: string; recuLe: Date } | null;
} = {}) {
  const cap = { attribues: 0, rendus: 0, remplaces: 0, alertesReserve: [] as number[], bloques: [] as string[] };
  const reserve = [...(o.reserve ?? ['441235619343'])];
  let attribue: string | null = o.attribue ?? null;
  const deps: NumeroFourniRouteDeps = {
    numeros: {
      attribuer: async () => {
        cap.attribues += 1;
        if (attribue) return NUMERO(attribue);
        attribue = reserve.shift() ?? null;
        return attribue ? NUMERO(attribue) : null;
      },
      numeroDeLEspace: async () => (attribue ? NUMERO(attribue) : null),
      codeDeLEspace: async () => o.code ?? null,
      remplacerNumero: async () => {
        cap.remplaces += 1;
        const bloque = attribue;
        attribue = reserve.shift() ?? null;
        return { bloque, nouveau: attribue ? NUMERO(attribue) : null };
      },
      rendre: async () => { cap.rendus += 1; const r = attribue; attribue = null; return r; },
      compterLibres: async () => o.libresApres ?? reserve.length,
    },
    numeroConnecte: async () => (o.connecte !== undefined ? { chiffres: o.connecte, aActiver: false } : null),
    verrous: fauxVerrous(),
    alertes: {
      reserveBasse: async (libres) => { cap.alertesReserve.push(libres); },
      numeroBloque: async (numero) => { cap.bloques.push(numero); },
    },
    seuilReserve: 3,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, numeroFourni: deps }), cap };
}

const URL = '/tenants/t1/numero-fourni';

describe('POST /numero-fourni : obtenir un numéro de la réserve', () => {
  it('attribue un numéro et le rend avec son « + » ; la réserve encore garnie ne prévient personne', async () => {
    const { server, cap } = monter({ reserve: ['441235619343'], libresApres: 5 });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ numero: '+441235619343' });
    expect(cap.alertesReserve).toEqual([]);
    await server.close();
  });

  it('🔴 sous le seuil après l’attribution : Julien est prévenu, avec le nombre de numéros libres', async () => {
    const { server, cap } = monter({ libresApres: 2 });
    await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(cap.alertesReserve).toEqual([2]);
    await server.close();
  });

  it('🔴 réserve vide : 409 qui le dit, et l’alerte part quand même', async () => {
    const { server, cap } = monter({ reserve: [], libresApres: 0 });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'reserve_vide' });
    expect(cap.alertesReserve).toEqual([0]);
    await server.close();
  });

  it('🔴 un espace qui a déjà son numéro WhatsApp n’en reçoit pas : 409, rien n’est attribué', async () => {
    const { server, cap } = monter({ connecte: '33525680250' });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(409);
    expect(cap.attribues).toBe(0);
    await server.close();
  });

  it('agent -> 403 : obtenir un numéro reste un geste d’admin', async () => {
    const { server, cap } = monter();
    const res = await server.inject({ method: 'POST', url: URL, ...h(agentTok), payload: '{}' });
    expect(res.statusCode).toBe(403);
    expect(cap.attribues).toBe(0);
    await server.close();
  });
});

describe('GET /numero-fourni : le numéro et le code capté', () => {
  it('le numéro attribué et le dernier code, avec son heure ; jamais de transcription', async () => {
    const recuLe = new Date('2026-10-06T10:00:00.000Z');
    const { server } = monter({ attribue: '441235619343', code: { code: '345679', recuLe } });
    const res = await server.inject({ method: 'GET', url: URL, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ numero: '+441235619343', code: '345679', codeRecuLe: recuLe.toISOString() });
    await server.close();
  });

  it('aucun numéro attribué : tout est nul', async () => {
    const { server } = monter();
    const res = await server.inject({ method: 'GET', url: URL, ...h(adminTok) });
    expect(res.json()).toEqual({ numero: null, code: null, codeRecuLe: null });
    await server.close();
  });
});

describe('remplacer et abandonner', () => {
  it('🔴 Meta refuse le numéro : il est bloqué, Julien prévenu, et un autre est attribué', async () => {
    const { server, cap } = monter({ attribue: '441235619343', reserve: ['442071234567'], libresApres: 5 });
    const res = await server.inject({ method: 'POST', url: `${URL}/remplacer`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ numero: '+442071234567' });
    expect(cap.bloques).toEqual(['441235619343']);
    await server.close();
  });

  it('remplacer sans autre numéro libre : 409 réserve vide, l’ancien est quand même bloqué', async () => {
    const { server, cap } = monter({ attribue: '441235619343', reserve: [], libresApres: 0 });
    const res = await server.inject({ method: 'POST', url: `${URL}/remplacer`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'reserve_vide' });
    expect(cap.bloques).toEqual(['441235619343']);
    expect(cap.alertesReserve).toEqual([0]);
    await server.close();
  });

  it('🔴 un seul remplacement par heure et par espace : « En obtenir un autre » ne vide pas la réserve', async () => {
    const { server, cap } = monter({ attribue: '441235619343', reserve: ['442071234567', '442071234568'], libresApres: 5 });
    const r1 = await server.inject({ method: 'POST', url: `${URL}/remplacer`, ...h(adminTok), payload: '{}' });
    const r2 = await server.inject({ method: 'POST', url: `${URL}/remplacer`, ...h(adminTok), payload: '{}' });
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 429]);
    expect(r2.json()).toMatchObject({ cause: 'trop_de_remplacements' });
    expect(cap.remplaces).toBe(1);
    await server.close();
  });

  it('🔴 l’espace a connecté SON propre numéro : le numéro fourni retourne à la réserve', async () => {
    const { server, cap } = monter({ attribue: '441235619343', connecte: '33525680250' });
    const res = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(cap.rendus).toBe(1);
    await server.close();
  });

  it('abandonner rend le numéro à la réserve', async () => {
    const { server, cap } = monter({ attribue: '441235619343' });
    const res = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rendu: true });
    expect(cap.rendus).toBe(1);
    await server.close();
  });

  it('🔴 une fois le numéro connecté, ni abandonner ni remplacer : il ne retourne pas à la réserve en servant', async () => {
    const { server, cap } = monter({ attribue: '441235619343', connecte: '441235619343' });
    const a = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    const r = await server.inject({ method: 'POST', url: `${URL}/remplacer`, ...h(adminTok), payload: '{}' });
    expect([a.statusCode, r.statusCode]).toEqual([409, 409]);
    expect([cap.rendus, cap.remplaces]).toEqual([0, 0]);
    await server.close();
  });
});

describe('creerAlertesReserve : prévenir Julien sans le noyer, et sans se taire', () => {
  it('🔴 réserve basse : un message, puis le silence 24 h ; un envoi raté rend la clé (le prochain réessaie)', async () => {
    const v = fauxVerrous();
    const envois: string[] = [];
    let reussit = false;
    const a = creerAlertesReserve({ verrous: v, envoyer: async (t) => { envois.push(t); return reussit; } });
    await a.reserveBasse(2);
    expect(envois).toHaveLength(1);
    expect(v.relaches).toEqual(['numeros.reserve-basse']);
    reussit = true;
    await a.reserveBasse(2);
    await a.reserveBasse(1);
    expect(envois).toHaveLength(2);
  });

  it('🔴 la réserve VIDE a sa propre clé : une alerte « basse » de la veille ne la fait pas taire', async () => {
    const v = fauxVerrous();
    const envois: string[] = [];
    const a = creerAlertesReserve({ verrous: v, envoyer: async (t) => { envois.push(t); return true; } });
    await a.reserveBasse(2);
    await a.reserveBasse(0);
    expect(envois).toHaveLength(2);
    expect(envois[1]).toContain('vide');
    await a.reserveBasse(0);
    expect(envois).toHaveLength(2);
  });
});
