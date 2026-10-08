import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { creerAlertesReserve, type NumeroFourniRouteDeps } from '../src/http/numero-fourni';
import type { CleDemandee, Prise } from '../src/db/verrous-courts';
import type { NumeroFourni } from '../src/otp/store.pg';
import type { StatutAbonnement } from '../src/stripe/abonnements.pg';
import { refus, type Issue } from '../src/lib/issue';

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
  /** L'abonnement du numéro (livraison B) : `actif` par défaut, pour que les cas du 3b gardent leur sens. */
  abonnement?: StatutAbonnement | null;
  ouverture?: Issue<{ url: string }>;
  /** Les espaces abonnés qui attendent leur numéro, du plus ancien au plus récent (jaune 7 de la livraison B). */
  attente?: string[];
  portail?: Issue<{ url: string }>;
  /** La résiliation en fin de période chez Stripe (lot 4, livraison B). */
  fin?: Issue<true>;
  /** Un Pro vivant couvre l'espace (lot 6, B2b) : le numéro y est inclus. */
  pro?: boolean;
} = {}) {
  const cap = {
    attribues: 0, rendus: 0, remplaces: 0, alertesReserve: [] as number[], bloques: [] as string[],
    ouvertures: [] as Array<{ tenantId: string; retour: string; payeur: string }>,
    /** Les AUTRES espaces servis par une attribution (un abonné en attente). */
    servis: [] as string[],
    portails: [] as Array<{ tenantId: string; payeur: string }>,
    /** Les abonnements dont la fin a été programmée chez Stripe, et notée chez nous. */
    fins: [] as string[],
    finsNotees: [] as string[],
    alertesFin: [] as string[],
  };
  const statut = o.abonnement === undefined ? 'actif' : o.abonnement;
  const reserve = [...(o.reserve ?? ['441235619343'])];
  let attribue: string | null = o.attribue ?? null;
  const deps: NumeroFourniRouteDeps = {
    numeros: {
      attribuer: async (tenantId) => {
        cap.attribues += 1;
        if (tenantId !== 't1') {
          cap.servis.push(tenantId);
          const n = reserve.shift();
          return n ? NUMERO(n) : null;
        }
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
      rendre: async () => { cap.rendus += 1; const r = attribue; attribue = null; if (r) reserve.push(r); return r; },
      compterLibres: async () => o.libresApres ?? reserve.length,
    },
    numeroConnecte: async () => (o.connecte !== undefined ? { chiffres: o.connecte, aActiver: false } : null),
    verrous: fauxVerrous(),
    alertes: {
      reserveBasse: async (libres) => { cap.alertesReserve.push(libres); },
      numeroBloque: async (numero) => { cap.bloques.push(numero); },
      finNonProgrammee: async (abonnementId) => { cap.alertesFin.push(abonnementId); },
    },
    seuilReserve: 3,
    abonnements: {
      deLEspace: async (tenantId) => (statut === null ? null : { abonnementId: 'sub_1', tenantId, livemode: false, statut, periodeFin: null, premierEchecLe: null, finPrevueLe: null, finiLe: null, libereLe: null }),
      enAttenteDeNumero: async () => [...(o.attente ?? [])],
      noterFinPrevue: async (abonnementId) => { cap.finsNotees.push(abonnementId); return true; },
    },
    abonnement: {
      ouvrir: async (tenantId, retour, payeur) => {
        cap.ouvertures.push({ tenantId, retour, payeur });
        return o.ouverture ?? { ok: true, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_test_1' } };
      },
      portail: async (tenantId, payeur) => {
        cap.portails.push({ tenantId, payeur });
        return o.portail ?? { ok: true, valeur: { url: 'https://billing.stripe.com/p/session/test_1' } };
      },
      programmerFin: async (abonnementId) => { cap.fins.push(abonnementId); return o.fin ?? { ok: true, valeur: true }; },
    },
    pro: { vivant: async () => o.pro ?? false },
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

describe('POST /numero-fourni sans abonnement (lot 3c, livraison B) : pas de numéro avant le paiement', () => {
  it('🔴 sans abonnement, ou résilié : 409 « abonnement requis », rien n’est attribué', async () => {
    for (const abonnement of [null, 'resilie'] as const) {
      const { server, cap } = monter({ abonnement });
      const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ cause: 'abonnement_requis' });
      expect(cap.attribues).toBe(0);
      await server.close();
    }
  });

  it('un numéro DÉJÀ attribué se rend toujours, abonnement ou pas (l’essai du 3b, un retour de page)', async () => {
    const { server } = monter({ abonnement: null, attribue: '441235619343' });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ numero: '+441235619343' });
    await server.close();
  });

  it('🔴 en Pro (lot 6, B2b) : sans abonnement du numéro, ou résilié, le numéro s’attribue sans payer', async () => {
    for (const abonnement of [null, 'resilie'] as const) {
      const { server, cap } = monter({ abonnement, pro: true });
      const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ numero: '+441235619343' });
      expect(cap.attribues).toBe(1);
      expect(cap.ouvertures).toEqual([]);
      await server.close();
    }
  });

  it('🔴 J6 : en Pro, un numéro NEUF ne prend pas celui d’un abonné qui a payé et attend : 409 « réserve vide »', async () => {
    // Un libre, un abonné en attente : ce libre lui est dû (jaune 7 de la livraison B), comme pour un paiement.
    const { server, cap } = monter({ abonnement: null, pro: true, reserve: ['441235619343'], attente: ['t2'] });
    const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'reserve_vide' });
    expect(cap.attribues).toBe(0);
    await server.close();
  });

  it('J6 : la garde ne vise que le Pro sans numéro : un numéro déjà attribué se rend, un abonné qui attend est servi', async () => {
    for (const o of [
      { abonnement: null, pro: true, attribue: '441235619343', attente: ['t2'], libresApres: 0 },
      { abonnement: 'actif' as const, attente: ['t1'], reserve: ['441235619343'] },
    ]) {
      const { server } = monter(o);
      const res = await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ numero: '+441235619343' });
      await server.close();
    }
  });

  it('un abonnement en retard de paiement garde son droit : le numéro s’attribue', async () => {
    const { server } = monter({ abonnement: 'en_retard' });
    expect((await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' })).statusCode).toBe(200);
    await server.close();
  });
});

describe('POST /numero-fourni/abonnement : ouvrir le paiement du numéro', () => {
  const ABO = `${URL}/abonnement`;
  it('🔴 l’adresse de paiement, pour CET espace, avec le retour demandé et le payeur de la session', async () => {
    const { server, cap } = monter({ abonnement: null });
    const res = await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'console' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(cap.ouvertures).toEqual([{ tenantId: 't1', retour: 'console', payeur: 'u1' }]);
    await server.close();
  });

  it('🔴 réserve vide : 409 sans rien ouvrir chez Stripe', async () => {
    const { server, cap } = monter({ abonnement: null, libresApres: 0 });
    const res = await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'brancher' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'reserve_vide' });
    expect(cap.ouvertures).toEqual([]);
    await server.close();
  });

  it('🔴 déjà abonné (actif ou en retard), ou numéro déjà connecté : 409, pas de second paiement', async () => {
    for (const o of [{ abonnement: 'actif' as const }, { abonnement: 'en_retard' as const }, { abonnement: null, connecte: '33525680250' }]) {
      const { server, cap } = monter(o);
      const res = await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'brancher' } });
      expect(res.statusCode).toBe(409);
      expect(cap.ouvertures).toEqual([]);
      await server.close();
    }
  });

  it('🔴 en Pro (lot 6, B2b) : le numéro est inclus, aucun paiement ne s’ouvre chez Stripe (409 « inclus »)', async () => {
    for (const abonnement of [null, 'resilie'] as const) {
      const { server, cap } = monter({ abonnement, pro: true });
      const res = await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'brancher' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ cause: 'inclus_dans_le_pro' });
      expect(cap.ouvertures).toEqual([]);
      await server.close();
    }
  });

  it('résilié : on peut se réabonner', async () => {
    const { server, cap } = monter({ abonnement: 'resilie' });
    expect((await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'brancher' } })).statusCode).toBe(200);
    expect(cap.ouvertures).toHaveLength(1);
    await server.close();
  });

  it('un retour inconnu : 400 ; un refus du paiement passe tel quel, avec son code', async () => {
    const { server } = monter({ abonnement: null, ouverture: { ok: false, statut: 422, erreur: 'tarif en correction', details: { code: 'prix_incoherent' } } });
    expect((await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'ailleurs' } })).statusCode).toBe(400);
    const res = await server.inject({ method: 'POST', url: ABO, ...h(adminTok), payload: { retour: 'console' } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'tarif en correction', code: 'prix_incoherent' });
    await server.close();
  });

  it('agent -> 403', async () => {
    const { server, cap } = monter({ abonnement: null });
    expect((await server.inject({ method: 'POST', url: ABO, ...h(agentTok), payload: { retour: 'console' } })).statusCode).toBe(403);
    expect(cap.ouvertures).toEqual([]);
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
  it('🔴 « Remplacer » sans abonnement ni numéro attribué : 409, AUCUN numéro donné (relecture de la livraison B)', async () => {
    const { server, cap } = monter({ abonnement: null });
    const res = await server.inject({ method: 'POST', url: `${URL}/remplacer`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'abonnement_requis' });
    expect(cap.remplaces).toBe(0);
    await server.close();
  });

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
    // L'abonnement de la fixture court : sa fin est programmée (lot 4, livraison B).
    expect(res.json()).toEqual({ rendu: true, finProgrammee: true });
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

describe('les jaunes de la relecture de la livraison B (lot 3c)', () => {
  it('🟡 le portail Stripe depuis la console : l’adresse, pour CET espace et le payeur de la session', async () => {
    const { server, cap } = monter();
    const res = await server.inject({ method: 'POST', url: `${URL}/portail`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
    expect(cap.portails).toEqual([{ tenantId: 't1', payeur: 'u1' }]);
    await server.close();
  });

  it('🟡 le portail : un refus passe tel quel ; un agent reçoit 403 sans rien ouvrir', async () => {
    const refus = monter({ portail: { ok: false, statut: 409, erreur: 'Cet espace n’a aucun abonnement à gérer.', details: { code: 'aucun_abonnement' } } });
    const r = await refus.server.inject({ method: 'POST', url: `${URL}/portail`, ...h(adminTok), payload: '{}' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'aucun_abonnement' });
    await refus.server.close();
    const agent = monter();
    expect((await agent.server.inject({ method: 'POST', url: `${URL}/portail`, ...h(agentTok), payload: '{}' })).statusCode).toBe(403);
    expect(agent.cap.portails).toEqual([]);
    await agent.server.close();
  });

  it('🟡 les numéros libres sont DUS aux abonnés qui attendent : pas de paiement neuf qu’on ne pourrait pas servir', async () => {
    const pris = monter({ abonnement: null, reserve: ['441235619343'], attente: ['t9'] });
    const r = await pris.server.inject({ method: 'POST', url: `${URL}/abonnement`, ...h(adminTok), payload: { retour: 'console' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ cause: 'reserve_vide' });
    expect(pris.cap.ouvertures).toEqual([]);
    await pris.server.close();
    // Un numéro de plus que d'abonnés en attente : le paiement s'ouvre.
    const reste = monter({ abonnement: null, reserve: ['441235619343', '441235619344'], attente: ['t9'] });
    expect((await reste.server.inject({ method: 'POST', url: `${URL}/abonnement`, ...h(adminTok), payload: { retour: 'console' } })).statusCode).toBe(200);
    await reste.server.close();
  });

  it('🟡 l’alerte de réserve compte ce qui reste APRÈS les abonnés en attente', async () => {
    const { server, cap } = monter({ libresApres: 5, attente: ['t7', 't8', 't9'] });
    await server.inject({ method: 'POST', url: URL, ...h(adminTok), payload: '{}' });
    expect(cap.alertesReserve).toEqual([2]);
    await server.close();
  });

  it('🟡 « Abandonner » sert d’office le plus ancien abonné en attente, jamais l’espace qui vient de rendre', async () => {
    const { server, cap } = monter({ attribue: '441235619343', attente: ['t1', 't9', 't8'] });
    const res = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rendu: true, finProgrammee: true });
    expect(cap.servis).toEqual(['t9']);
    await server.close();
  });

  it('« Abandonner » sans abonné en attente, ou sans numéro rendu : personne n’est servi', async () => {
    const seul = monter({ attribue: '441235619343' });
    await seul.server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    expect(seul.cap.servis).toEqual([]);
    await seul.server.close();
    const rien = monter({ attente: ['t9'] });
    expect((await rien.server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' })).json()).toEqual({ rendu: false, finProgrammee: true });
    expect(rien.cap.servis).toEqual([]);
    await rien.server.close();
  });
});

describe('le lot 4 : se réabonner au MÊME numéro', () => {
  it('🔴 le numéro connecté EST le numéro fourni, abonnement fini : le paiement s’ouvre, sans regarder la réserve', async () => {
    const { server, cap } = monter({ abonnement: 'resilie', attribue: '441259797311', connecte: '441259797311', reserve: [], libresApres: 0 });
    const res = await server.inject({ method: 'POST', url: `${URL}/abonnement`, ...h(adminTok), payload: { retour: 'console' } });
    expect(res.statusCode).toBe(200);
    expect(cap.ouvertures).toEqual([{ tenantId: 't1', retour: 'console', payeur: 'u1' }]);
    await server.close();
  });

  it('🔴 un numéro APPORTÉ connecté : toujours refusé, rien n’est ouvert chez Stripe', async () => {
    const { server, cap } = monter({ abonnement: 'resilie', attribue: '441259797311', connecte: '33525680250' });
    const res = await server.inject({ method: 'POST', url: `${URL}/abonnement`, ...h(adminTok), payload: { retour: 'console' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ cause: 'deja_un_numero' });
    expect(cap.ouvertures).toEqual([]);
    await server.close();
  });
});

describe('« Abandonner » d’un abonné (lot 4, livraison B)', () => {
  it('🔴 l’abonnement court : sa fin est programmée chez Stripe (fin de période), et notée chez nous tout de suite', async () => {
    const { server, cap } = monter({ attribue: '441235619343' });
    const res = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rendu: true, finProgrammee: true });
    expect(cap.fins).toEqual(['sub_1']);
    // Noté sans attendre le webhook : l'abonné qui a rendu son numéro ne compte plus parmi ceux qui attendent le leur.
    expect(cap.finsNotees).toEqual(['sub_1']);
    expect(cap.alertesFin).toEqual([]);
    await server.close();
  });

  it('🔴 Stripe refuse : l’abandon se fait quand même, et Julien est prévenu pour résilier à la main', async () => {
    const { server, cap } = monter({ attribue: '441235619343', fin: refus(422, 'refus de Stripe') });
    const res = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rendu: true, finProgrammee: false });
    expect(cap.rendus).toBe(1);
    expect(cap.alertesFin).toEqual(['sub_1']);
    expect(cap.finsNotees).toEqual([]);
    await server.close();
  });

  it('sans abonnement, ou déjà résilié : rien chez Stripe', async () => {
    for (const abonnement of [null, 'resilie'] as const) {
      const { server, cap } = monter({ attribue: '441235619343', abonnement });
      const res = await server.inject({ method: 'POST', url: `${URL}/abandonner`, ...h(adminTok), payload: '{}' });
      expect(res.json()).toEqual({ rendu: true, finProgrammee: false });
      expect(cap.fins).toEqual([]);
      await server.close();
    }
  });
});
