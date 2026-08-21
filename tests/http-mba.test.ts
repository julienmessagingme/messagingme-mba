import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { MbaClient } from '../src/mba/client';
import { fetchUrlBorne } from '../src/http/mba';
import type { MbaRouteDeps } from '../src/http/mba';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let autreTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  autreTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const PN = '1305301719324792';

type Methode = (...args: unknown[]) => unknown;

/** Faux client MBA : chaque appel est enregistré, chaque méthode surchargeable. Aucun réseau. */
function fauxClient(over: Record<string, Methode> = {}) {
  const appels: Array<{ m: string; args: unknown[] }> = [];
  const defauts: Record<string, Methode> = {
    isEligible: () => true,
    getSettings: () => ({ agent_id: 'AG1', channel: 'whatsapp', rollout: { enabled: false }, ai_audience: 'EVERYONE' }),
    putSettings: () => ({}),
    getBusinessInfo: () => ({ business_description: 'Réseau de bus', contact_info: { email: 'contact@bus.fr' } }),
    putBusinessInfo: (_pn: unknown, info: unknown) => info,
    listFaqs: () => [],
    createFaq: (_pn: unknown, f: unknown) => ({ id: 'f-neuf', ...(f as object) }),
    updateFaq: (_pn: unknown, id: unknown, f: unknown) => ({ id, ...(f as object) }),
    deleteFaq: () => undefined,
    listSkills: () => [],
    createSkill: (_pn: unknown, _a: unknown, s: unknown) => ({ id: 's1', ...(s as object) }),
    updateSkill: () => ({ id: 's1' }),
    deleteSkill: () => undefined,
    listWebsites: () => [],
    createWebsite: (_pn: unknown, url: unknown) => ({ id: 'w1', url }),
    deleteWebsite: () => undefined,
    listFiles: () => [],
    uploadFile: (_pn: unknown, nom: unknown) => ({ id: 'file1', file_name: nom }),
    deleteFile: () => undefined,
    listAllowlist: () => [],
    addToAllowlist: (_pn: unknown, tel: unknown) => ({ id: 'a1', consumer_phone_number: tel }),
    removeFromAllowlist: () => undefined,
    test: () => ({ agent_response: 'Bonjour', conversation_id: 'c1' }),
  };
  const table = { ...defauts, ...over };
  const client: Record<string, Methode> = {};
  for (const [nom, fn] of Object.entries(table)) {
    client[nom] = (...args: unknown[]): unknown => {
      appels.push({ m: nom, args });
      return Promise.resolve(fn(...args));
    };
  }
  return { client: client as unknown as MbaClient, appels };
}

function app(overClient: Record<string, Methode> = {}, overDeps: Partial<MbaRouteDeps> = {}) {
  const { client, appels } = fauxClient(overClient);
  const deps: MbaRouteDeps = {
    clientFor: async () => client,
    phoneNumberBelongsToTenant: async (pn, tenant) => pn === PN && tenant === 't1',
    ...overDeps,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, mba: deps }), appels };
}
const url = (suffixe: string) => `/tenants/t1/mba/${PN}${suffixe}`;

describe('routes MBA : isolation', () => {
  it('agent -> 403 (groupe admin-only)', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url: url('/status'), ...h(agentTok) })).statusCode).toBe(403);
    await server.close();
  });

  it('tenant croisé -> 403', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url: url('/status'), ...h(autreTok) })).statusCode).toBe(403);
    await server.close();
  });

  it('🔴 numéro d’un AUTRE tenant -> 404, et aucun appel Meta', async () => {
    // La surface MBA est indexée par NUMÉRO : sans ce contrôle, un admin authentifié piloterait l'agent
    // d'un autre client rien qu'en changeant l'id dans l'URL.
    const { server, appels } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/mba/999/status', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    expect(appels).toHaveLength(0);
    await server.close();
  });
});

describe('routes MBA : état et réglages', () => {
  it('numéro non éligible -> onboarded false, settings non lus', async () => {
    const { server, appels } = app({ isEligible: () => false });
    const res = await server.inject({ method: 'GET', url: url('/status'), ...h(adminTok) });
    expect(res.json()).toMatchObject({ eligible: false, onboarded: false, agentId: null, settings: null });
    expect(appels.map((a) => a.m)).toEqual(['isEligible']);
    await server.close();
  });

  it('PATCH settings ne touche QUE les clés demandées (lecture-modification-écriture)', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'PATCH', url: url('/settings'), ...h(adminTok), payload: { aiAudience: 'ALLOWLISTED_ONLY' } });
    expect(res.statusCode).toBe(200);
    const put = appels.find((a) => a.m === 'putSettings');
    expect(put?.args[1]).toMatchObject({ ai_audience: 'ALLOWLISTED_ONLY', rollout: { enabled: false } });
    // agent_id repart en QUERY (3e argument), pas dans le corps : il n'est pas au schéma de requête.
    expect(put?.args[2]).toBe('AG1');
    await server.close();
  });

  it('PATCH settings : valeurs invalides et patch vide -> 400', async () => {
    const { server } = app();
    const bad = async (payload: unknown) => (await server.inject({ method: 'PATCH', url: url('/settings'), ...h(adminTok), payload: payload as object })).statusCode;
    expect(await bad({ aiAudience: 'TOUT_LE_MONDE' })).toBe(400);
    expect(await bad({ neverSay: ['ok', ''] })).toBe(400);
    expect(await bad({})).toBe(400);
    await server.close();
  });

  it('PATCH settings écrit le passage de main, les trois champs dans le MÊME sous-objet', async () => {
    const { server, appels } = app();
    const res = await server.inject({
      method: 'PATCH',
      url: url('/settings'),
      ...h(adminTok),
      payload: { handoffEnabled: true, handoffMessage: 'Je transmets à un conseiller.', handoffMessageSelection: 'CUSTOM' },
    });
    expect(res.statusCode).toBe(200);
    const put = appels.find((a) => a.m === 'putSettings');
    expect(put?.args[1]).toMatchObject({
      handoff: { enabled: true, message: 'Je transmets à un conseiller.', message_selection: 'CUSTOM' },
    });
    await server.close();
  });

  it('PATCH settings : passage de main mal formé -> 400', async () => {
    const { server } = app();
    const bad = async (payload: unknown) => (await server.inject({ method: 'PATCH', url: url('/settings'), ...h(adminTok), payload: payload as object })).statusCode;
    expect(await bad({ handoffEnabled: 'oui' })).toBe(400);
    expect(await bad({ handoffMessage: '   ' })).toBe(400);
    expect(await bad({ handoffMessageSelection: 'MAISON' })).toBe(400);
    // CUSTOM sans texte : l'agent annoncerait le transfert avec une phrase qu'on ne choisit pas.
    expect(await bad({ handoffMessageSelection: 'CUSTOM' })).toBe(400);
    await server.close();
  });

  it('l’allumage a sa PROPRE route (effet asymétrique documenté par Meta)', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect((appels.find((a) => a.m === 'putSettings')?.args[1] as { rollout: unknown }).rollout).toEqual({ enabled: true });
    expect((await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: {} })).statusCode).toBe(400);
    await server.close();
  });
});

describe('routes MBA : informations business', () => {
  it('🔴 un patch partiel ne PERD pas les champs absents', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'PATCH', url: url('/business-info'), ...h(adminTok), payload: { returnPolicy: 'Aucun remboursement.' } });
    expect(res.statusCode).toBe(200);
    const envoye = appels.find((a) => a.m === 'putBusinessInfo')?.args[1] as Record<string, unknown>;
    expect(envoye.return_policy).toBe('Aucun remboursement.');
    expect(envoye.business_description).toBe('Réseau de bus'); // effacé par un PUT naïf
    expect(envoye.contact_info).toEqual({ email: 'contact@bus.fr' });
    await server.close();
  });

  it('fusionne contact champ par champ, et refuse un corps vide', async () => {
    const { server, appels } = app();
    await server.inject({ method: 'PATCH', url: url('/business-info'), ...h(adminTok), payload: { contact: { address: 'Auxerre' } } });
    expect((appels.find((a) => a.m === 'putBusinessInfo')?.args[1] as { contact_info: unknown }).contact_info)
      .toEqual({ email: 'contact@bus.fr', address: 'Auxerre' });
    expect((await server.inject({ method: 'PATCH', url: url('/business-info'), ...h(adminTok), payload: {} })).statusCode).toBe(400);
    await server.close();
  });
});

describe('routes MBA : FAQ', () => {
  const existantes = [{ id: '1', question: 'Horaires ?', answer: '6h-21h' }];

  it('création : question ET réponse obligatoires', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: url('/faq'), ...h(adminTok), payload: { question: 'Q' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: url('/faq'), ...h(adminTok), payload: { question: 'Q', answer: 'R' } })).statusCode).toBe(201);
    await server.close();
  });

  it('la liste renvoie le compteur (Meta dégrade en silence au-delà de quelques centaines)', async () => {
    const { server } = app({ listFaqs: () => existantes });
    const res = await server.inject({ method: 'GET', url: url('/faq'), ...h(adminTok) });
    expect(res.json()).toEqual({ faqs: existantes, count: 1 });
    await server.close();
  });

  it('aperçu : n’écrit RIEN et classe création / mise à jour / inchangé', async () => {
    const { server, appels } = app({ listFaqs: () => existantes });
    const res = await server.inject({
      method: 'POST',
      url: url('/faq/preview'),
      ...h(adminTok),
      payload: { csv: 'question,answer\nHoraires ?,6h-21h\nLes chiens ?,Oui en laisse.\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2, inchangees: 1, aCreer: [{ question: 'Les chiens ?', answer: 'Oui en laisse.' }] });
    expect(appels.some((a) => a.m === 'createFaq' || a.m === 'updateFaq')).toBe(false);
    await server.close();
  });

  it('import : crée le neuf, met à jour le changé, ne retouche pas l’identique', async () => {
    const { server, appels } = app({ listFaqs: () => existantes });
    const res = await server.inject({
      method: 'POST',
      url: url('/faq/import'),
      ...h(adminTok),
      payload: { items: [{ question: 'Horaires ?', answer: '6h-22h' }, { question: 'Les chiens ?', answer: 'Oui.' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 1, updated: 1, unchanged: 0, remaining: 0 });
    expect(appels.filter((a) => a.m === 'createFaq')).toHaveLength(1);
    await server.close();
  });

  it('🔴 import interrompu -> 207, ce qui reste est chiffré, et le rejeu reprend là où il s’est arrêté', async () => {
    // Meta n'a ni création en lot ni transaction : sans ce compte-rendu, un import à moitié passé serait
    // indiscernable d'un import réussi, et le relancer doublerait ce qui était déjà écrit.
    let n = 0;
    const { server } = app({
      listFaqs: () => existantes,
      createFaq: () => { n += 1; if (n === 2) throw new Error('rate limit'); return { id: `f${n}` }; },
    });
    const res = await server.inject({
      method: 'POST',
      url: url('/faq/import'),
      ...h(adminTok),
      payload: { items: [{ question: 'A ?', answer: '1' }, { question: 'B ?', answer: '2' }, { question: 'C ?', answer: '3' }] },
    });
    expect(res.statusCode).toBe(207);
    expect(res.json()).toMatchObject({ created: 1, remaining: 2, failed: { question: 'B ?' } });
    await server.close();
  });

  it('source vide ou absente -> message clair, jamais un import silencieux', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: url('/faq/import'), ...h(adminTok), payload: {} })).statusCode).toBe(400);
    const vide = await server.inject({ method: 'POST', url: url('/faq/import'), ...h(adminTok), payload: { csv: 'a,b\n' } });
    expect(vide.statusCode).toBe(422);
    await server.close();
  });

  it('🔴 import depuis une URL : hôte interne REFUSÉ (SSRF)', async () => {
    const { server } = app({}, { fetchUrl: async () => ({ status: 200, contentType: 'text/html', body: '<dl><dt>Q</dt><dd>R</dd></dl>' }) });
    for (const u of ['http://192.168.1.10/faq', 'http://127.0.0.1:8080/faq', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
      const res = await server.inject({ method: 'POST', url: url('/faq/preview'), ...h(adminTok), payload: { url: u } });
      expect(res.statusCode, u).toBe(400);
    }
    await server.close();
  });

  it('import depuis une URL publique : le HTML est extrait', async () => {
    const { server } = app({}, { fetchUrl: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: '<dl><dt>Q ?</dt><dd>R.</dd></dl>' }) });
    const res = await server.inject({ method: 'POST', url: url('/faq/preview'), ...h(adminTok), payload: { url: 'https://www.exemple.fr/faq' } });
    expect(res.json()).toMatchObject({ source: 'url (html)', total: 1 });
    await server.close();
  });
});

describe('fetchUrlBorne', () => {
  const reponse = (status: number, entetes: Record<string, string>, corps = '') =>
    new Response(corps, { status, headers: entetes }) as Response;

  it('🔴 une redirection vers un hôte interne est REFUSÉE', async () => {
    // Le contrôle d'origine ne porte que sur l'URL saisie : en suivi automatique, une page publique qui
    // renvoie un 302 vers l'adresse de métadonnées du cloud contournerait tout le garde-fou.
    const impl = (async () => reponse(302, { location: 'http://169.254.169.254/latest/meta-data' })) as unknown as typeof fetch;
    await expect(fetchUrlBorne(1000, impl)('https://www.exemple.fr/faq')).rejects.toThrow('hôte non autorisé');
  });

  it('suit une redirection vers un hôte public, et s’arrête après 3 sauts', async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      return n === 1
        ? reponse(301, { location: 'https://www.exemple.fr/faq-v2' })
        : reponse(200, { 'content-type': 'text/html' }, '<dl><dt>Q</dt><dd>R</dd></dl>');
    }) as unknown as typeof fetch;
    expect(await fetchUrlBorne(1000, impl)('https://www.exemple.fr/faq')).toMatchObject({ status: 200 });

    const boucle = (async () => reponse(302, { location: 'https://www.exemple.fr/encore' })) as unknown as typeof fetch;
    await expect(fetchUrlBorne(1000, boucle)('https://www.exemple.fr/faq')).rejects.toThrow('trop de redirections');
  });

  it('refuse une page qui dépasse le plafond, même si elle ment sur sa taille', async () => {
    const gros = 'x'.repeat(2_000_001);
    const impl = (async () => reponse(200, { 'content-type': 'text/html' }, gros)) as unknown as typeof fetch;
    await expect(fetchUrlBorne(1000, impl)('https://www.exemple.fr/faq')).rejects.toThrow('trop lourde');
  });
});

describe('routes MBA : skills', () => {
  it('titre au format Meta exigé (minuscules, chiffres, tirets)', async () => {
    const { server } = app();
    const post = async (payload: object) => (await server.inject({ method: 'POST', url: url('/skills'), ...h(adminTok), payload })).statusCode;
    expect(await post({ title: 'Politique de retour', description: 'd', skill: 's' })).toBe(400);
    expect(await post({ title: '-retours-', description: 'd', skill: 's' })).toBe(400);
    expect(await post({ title: 'politique-de-retour', description: 'd', skill: 's' })).toBe(201);
    await server.close();
  });

  it('🔴 agent_id TOUJOURS passé explicitement', async () => {
    // Sans lui, Meta écrit sous « les settings les plus récemment créés », pas forcément les nôtres.
    const { server, appels } = app();
    await server.inject({ method: 'POST', url: url('/skills'), ...h(adminTok), payload: { title: 'ne-pas-inventer', description: 'd', skill: 's' } });
    expect(appels.find((a) => a.m === 'createSkill')?.args[1]).toBe('AG1');
    await server.close();
  });

  it('agent pas encore configuré -> 409 sur l’écriture, liste vide en lecture', async () => {
    const { server } = app({ getSettings: () => null });
    expect((await server.inject({ method: 'POST', url: url('/skills'), ...h(adminTok), payload: { title: 'x', description: 'd', skill: 's' } })).statusCode).toBe(409);
    const liste = await server.inject({ method: 'GET', url: url('/skills'), ...h(adminTok) });
    expect(liste.json()).toEqual({ skills: [], agentId: null });
    await server.close();
  });
});

describe('routes MBA : sites, fichiers, allowlist, bac à sable', () => {
  it('site : adresse sans schéma refusée avant l’appel Meta', async () => {
    const { server, appels } = app();
    expect((await server.inject({ method: 'POST', url: url('/websites'), ...h(adminTok), payload: { url: 'www.exemple.fr' } })).statusCode).toBe(400);
    expect(appels.some((a) => a.m === 'createWebsite')).toBe(false);
    expect((await server.inject({ method: 'POST', url: url('/websites'), ...h(adminTok), payload: { url: 'https://www.exemple.fr' } })).statusCode).toBe(201);
    await server.close();
  });

  it('🔴 fichier : le nom doit correspondre au contenu, et le format être accepté par Meta', async () => {
    // `file_name` est un champ séparé du binaire : rien ne garantit que Meta déduise le type du contenu,
    // et une extension incohérente peut passer en 201 sans jamais être indexée.
    const { server } = app();
    const post = async (payload: object) => await server.inject({ method: 'POST', url: url('/files'), ...h(adminTok), payload });
    expect((await post({ fileName: 'guide.docx', dataUrl: 'data:application/pdf;base64,JVBERi0=' })).statusCode).toBe(400);
    expect((await post({ fileName: 'notes.txt', dataUrl: 'data:text/plain;base64,YWJj' })).statusCode).toBe(400);
    const ok = await post({ fileName: 'guide.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ id: 'file1', indexationInconnue: true });
    await server.close();
  });

  it('allowlist : numéro normalisé en E.164, doublon idempotent', async () => {
    const { server, appels } = app({ listAllowlist: () => [{ id: 'a1', consumer_phone_number: '+33633921577' }] });
    const deja = await server.inject({ method: 'POST', url: url('/allowlist'), ...h(adminTok), payload: { phone: '06 33 92 15 77' } });
    expect(deja.statusCode).toBe(200);
    expect(appels.some((a) => a.m === 'addToAllowlist')).toBe(false);
    const neuf = await server.inject({ method: 'POST', url: url('/allowlist'), ...h(adminTok), payload: { phone: '0612345678' } });
    expect(neuf.json()).toMatchObject({ consumer_phone_number: '+33612345678' });
    expect((await server.inject({ method: 'POST', url: url('/allowlist'), ...h(adminTok), payload: { phone: 'bonjour' } })).statusCode).toBe(400);
    await server.close();
  });

  it('bac à sable : message requis, réponse de l’agent relayée', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: url('/test'), ...h(adminTok), payload: {} })).statusCode).toBe(400);
    const res = await server.inject({ method: 'POST', url: url('/test'), ...h(adminTok), payload: { message: 'Bonjour' } });
    expect(res.json()).toMatchObject({ agent_response: 'Bonjour', conversation_id: 'c1' });
    await server.close();
  });
});
