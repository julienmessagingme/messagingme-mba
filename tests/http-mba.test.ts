import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { MbaClient } from '../src/mba/client';
import type { MbaRouteDeps } from '../src/http/mba';
import { MetaApiError } from '../src/meta/errors';
import { mbaInerte } from './routes-inertes';
import { csvLent, retardPendant } from './boucle';

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
  // Des réglages qui GARDENT ce qu'on y écrit, comme Meta : l'allumage relit l'audience qu'il vient de poser.
  let reglages: Record<string, unknown> = { agent_id: 'AG1', channel: 'whatsapp', rollout: { enabled: false }, ai_audience: 'EVERYONE' };
  const defauts: Record<string, Methode> = {
    isEligible: () => true,
    getSettings: () => reglages,
    putSettings: (_pn: unknown, corps: unknown) => { reglages = { agent_id: 'AG1', channel: 'whatsapp', ...(corps as object) }; return {}; },
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
    ...mbaInerte,
    meta: {
      mbaClientForTenant: async () => client,
      phoneClientForTenant: async () => ({ getWabaHealth: async () => ({ ownerBusinessId: 'BM1', ownerBusinessName: 'Messaging Me' }) }),
    },
    repo: {
      getTenantPhoneNumberId: async () => null,
      getTenantWabaId: async () => 'WABA1',
      phoneNumberBelongsToTenant: async (pn, tenant) => pn === PN && tenant === 't1',
    },
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
    const res = await server.inject({ method: 'PATCH', url: url('/settings'), ...h(adminTok), payload: { neverSay: ['c’est garanti'] } });
    expect(res.statusCode).toBe(200);
    const put = appels.find((a) => a.m === 'putSettings');
    // Et l'audience de la liste, posée à CHAQUE écriture, quelle que soit celle que Meta avait (`EVERYONE` ici).
    expect(put?.args[1]).toMatchObject({ never_say_phrases: ['c’est garanti'], ai_audience: 'ALLOWLISTED_ONLY', rollout: { enabled: false } });
    // agent_id repart en QUERY (3e argument), pas dans le corps : il n'est pas au schéma de requête.
    expect(put?.args[2]).toBe('AG1');
    await server.close();
  });

  it('PATCH settings : valeurs invalides et patch vide -> 400', async () => {
    const { server } = app();
    const bad = async (payload: unknown) => (await server.inject({ method: 'PATCH', url: url('/settings'), ...h(adminTok), payload: payload as object })).statusCode;
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

  it('🔴 PATCH settings refuse `aiAudience`, en le disant, et n’écrit rien', async () => {
    // L'agent ne répond qu'aux contacts de sa liste, que la plateforme tient : « tout le monde » le ferait répondre
    // par-dessus nos scénarios, et une liste posée à la main serait ignorée de notre table.
    const { server, appels } = app();
    for (const aiAudience of ['EVERYONE', 'ALLOWLISTED_ONLY']) {
      const res = await server.inject({ method: 'PATCH', url: url('/settings'), ...h(adminTok), payload: { aiAudience, neverSay: ['x'] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/aiAudience ne se règle plus/);
    }
    expect(appels.some((a) => a.m === 'putSettings')).toBe(false);
    await server.close();
  });

  /** Notre drapeau `mba_enabled`, dans le même journal que les appels à Meta. */
  const drapeauNote = (appels: Array<{ m: string; args: unknown[] }>): Partial<MbaRouteDeps> => ({
    reglages: { setMbaEnabled: async (t, enabled) => { appels.push({ m: 'drapeau', args: [t, enabled] }); } },
  });

  it('🔴 l’allumage a sa PROPRE route, et suit l’ordre de Meta : audience, relecture, puis rollout', async () => {
    const journal: Array<{ m: string; args: unknown[] }> = [];
    const { server, appels } = app({}, drapeauNote(journal));
    const res = await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(appels.map((a) => a.m)).toEqual(['getSettings', 'putSettings', 'getSettings', 'putSettings', 'getSettings']);
    const [audience, allumage] = appels.filter((a) => a.m === 'putSettings').map((a) => a.args[1] as Record<string, unknown>);
    expect(audience).toMatchObject({ ai_audience: 'ALLOWLISTED_ONLY', rollout: { enabled: false } });
    expect(allumage).toMatchObject({ ai_audience: 'ALLOWLISTED_ONLY', rollout: { enabled: true } });
    expect((await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: {} })).statusCode).toBe(400);
    await server.close();
  });

  it('🔴 si Meta ne confirme pas l’audience à la relecture : 409 lisible, l’agent n’est pas allumé, notre drapeau non plus', async () => {
    const journal: Array<{ m: string; args: unknown[] }> = [];
    const { server, appels } = app({ getSettings: () => ({ agent_id: 'AG1', ai_audience: 'EVERYONE', rollout: { enabled: false } }) }, drapeauNote(journal));
    const res = await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: { enabled: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/pas été allumé/);
    expect(appels.filter((a) => a.m === 'putSettings')).toHaveLength(1);
    expect(journal).toEqual([]);
    await server.close();
  });

  /**
   * 🔴 L'INTERRUPTEUR DE L'APERÇU ÉCRIT NOTRE DRAPEAU, APRÈS META. Toute la mécanique de la liste lit
   * `tenant_settings.mba_enabled` (la remise à l'agent, la requalification d'un `standby`) : un espace allumé par
   * l'Aperçu avait l'agent allumé chez Meta et le drapeau à `false`, donc ses réponses en `standby` n'arrivaient à
   * personne. Vérifié dans les deux sens : l'écriture du drapeau retirée de la route, les deux cas échouent.
   */
  it('🔴 allumer puis éteindre depuis l’Aperçu : notre drapeau suit, écrit après Meta', async () => {
    // Chaque écriture du drapeau note combien d'écritures Meta l'ont précédée : 2 à l'allumage (audience, rollout),
    // 3 à l'extinction qui suit.
    const drapeaux: Array<[string, boolean, number]> = [];
    let meta: Array<{ m: string }> = [];
    const { server, appels } = app({}, {
      reglages: { setMbaEnabled: async (t, enabled) => { drapeaux.push([t, enabled, meta.filter((a) => a.m === 'putSettings').length]); } },
    });
    meta = appels;
    expect((await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: { enabled: true } })).statusCode).toBe(200);
    expect(drapeaux).toEqual([['t1', true, 2]]);
    expect((await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: { enabled: false } })).statusCode).toBe(200);
    expect(drapeaux).toEqual([['t1', true, 2], ['t1', false, 3]]);
    await server.close();
  });

  it('🔴 Meta refuse l’allumage : notre drapeau ne bouge pas', async () => {
    const journal: Array<{ m: string; args: unknown[] }> = [];
    const { server } = app({ putSettings: () => { throw new MetaApiError(400, { message: 'refusé', type: 'MbaError' }); } }, drapeauNote(journal));
    const res = await server.inject({ method: 'PUT', url: url('/rollout'), ...h(adminTok), payload: { enabled: true } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(journal).toEqual([]);
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

describe('routes MBA : FAQ', { timeout: 30_000 }, () => {
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

  it('🔴 un CSV lent à lire ne bloque pas la boucle d’événements', async () => {
    // Relevé le 2026-09-30 : lu dans le fil principal, un tel fichier figeait l'API pour tous les espaces.
    const { server } = app();
    await server.ready(); // le démarrage du serveur ne doit pas entrer dans la mesure
    const { retard, duree, resultat } = await retardPendant(() =>
      server.inject({ method: 'POST', url: url('/faq/preview'), ...h(adminTok), payload: { csv: csvLent(1_000, 200_000) } }));
    expect(resultat.statusCode).not.toBe(500);
    expect(duree).toBeGreaterThan(500);
    expect(retard).toBeLessThan(duree / 4);
    await server.close();
  }, 30_000);

  it('🔴 une page HTML lente à lire ne bloque pas la boucle d’événements', async () => {
    // Relevé par la relecture du 2026-09-30 : des `<details>` non fermés coûtaient un temps quadratique dans le fil
    // principal, sur une page de 2 Mo choisie par l'administrateur.
    const html = '<details>'.repeat(28_000);
    const { server } = app({}, { fetchUrl: async () => ({ status: 200, contentType: 'text/html', body: html }) });
    await server.ready(); // le démarrage du serveur ne doit pas entrer dans la mesure
    const { retard, duree, resultat } = await retardPendant(() =>
      server.inject({ method: 'POST', url: url('/faq/preview'), ...h(adminTok), payload: { url: 'https://www.exemple.fr/faq' } }));
    expect(resultat.statusCode).not.toBe(500);
    expect(duree).toBeGreaterThan(500);
    expect(retard).toBeLessThan(duree / 4);
    await server.close();
  }, 30_000);

  it('🔴 un CSV à l’en-tête de plus de 16 384 colonnes -> 400 lisible, par le corps comme par une URL, rien chez Meta', async () => {
    const csv = `${Array(16_385).fill('question').join(';')}\nHoraires ?`;
    const { server, appels } = app({}, { fetchUrl: async () => ({ status: 200, contentType: 'text/csv', body: csv }) });
    for (const route of ['/faq/preview', '/faq/import']) {
      for (const payload of [{ csv }, { url: 'https://www.exemple.fr/faq.csv' }]) {
        const res = await server.inject({ method: 'POST', url: url(route), ...h(adminTok), payload });
        expect(res.statusCode, `${route} ${Object.keys(payload)[0]}`).toBe(400);
        expect(res.json<{ error: string }>().error).toContain('16385 colonnes');
      }
    }
    expect(appels).toEqual([]);
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

describe('routes MBA : sites, fichiers, bac à sable', () => {
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

  it('🔴 la liste de l’agent n’a plus de route : la plateforme la tient seule', async () => {
    // Une entrée posée à la main échapperait à notre table (migration 0195) : un contact sur la liste que plus rien
    // ne retire, qui recevrait nos modèles avec l'agent qui répond.
    const { server, appels } = app();
    for (const [method, suffixe] of [['GET', '/allowlist'], ['POST', '/allowlist'], ['DELETE', '/allowlist/a1']] as const) {
      const res = await server.inject({ method, url: url(suffixe), ...h(adminTok), ...(method === 'POST' ? { payload: { phone: '0612345678' } } : {}) });
      expect(res.statusCode, `${method} ${suffixe}`).toBe(404);
    }
    expect(appels).toEqual([]);
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

describe('GET /tenants/:tenantId/mba/:phoneNumberId/messages', () => {
  it('rend le compte des messages écrits par l’agent, pour CET espace, sans fenêtre', async () => {
    const appels: unknown[][] = [];
    const { server } = app({}, { stats: { messagesEcritsParMba: async (...args: unknown[]) => { appels.push(args); return 87; } } });
    const res = await server.inject({ method: 'GET', url: url('/messages'), ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    // Plus de `jours` : le compte court depuis toujours, une fenêtre annoncée mentirait.
    expect(res.json()).toEqual({ messages: 87 });
    // L'espace vient de la session, jamais de l'URL, et rien d'autre n'est passé (aucune borne de date).
    expect(appels).toEqual([['t1']]);
    await server.close();
  });

  it('🔴 refuse un numéro qui n’appartient pas à cet espace', async () => {
    // Le `:phoneNumberId` ne filtre PAS le comptage (`conversations` ne porte aucun numéro) : il ne sert
    // qu'à ce contrôle d'isolation, hérité de `contexte()`. Ce test est là pour qu'on ne le retire pas en
    // croyant qu'il ne sert à rien.
    const { server } = app({}, {
      stats: { messagesEcritsParMba: async () => 87 },
      repo: { getTenantPhoneNumberId: async () => null, getTenantWabaId: async () => null, phoneNumberBelongsToTenant: async () => false },
    });
    const res = await server.inject({ method: 'GET', url: url('/messages'), ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});

/**
 * LE PLAFOND DE L'AGENT (2026-10-02). Il se règle chez Meta sur le BUSINESS MANAGER propriétaire du compte WhatsApp
 * (mesuré : le numéro rend 404), que le serveur résout lui-même ; et le POST de Meta REMPLACE tous les plafonds.
 */
describe('GET|PUT /tenants/:tenantId/mba-budget', () => {
  const B = '/tenants/t1/mba-budget';
  const json = (corps: unknown) => ({ ...h(adminTok), payload: JSON.stringify(corps) });

  it('lit le plafond sur le Business Manager du compte WhatsApp de l’espace, et le rend dans nos mots', async () => {
    const { server, appels } = app({ lireBudgets: () => [{ budget_id: 'b1', unit_type: 'ai_turn', time_window: 'seven_days', max_budget: 500 }] });
    const res = await server.inject({ method: 'GET', url: B, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plafond: { unite: 'ai_turn', fenetre: 'seven_days', max: 500 }, autres: 0, entreprise: 'Messaging Me' });
    expect(appels.find((a) => a.m === 'lireBudgets')?.args).toEqual(['BM1']);
    await server.close();
  });

  it('aucun plafond : `plafond: null`, c’est-à-dire illimité', async () => {
    const { server } = app({ lireBudgets: () => [] });
    expect((await server.inject({ method: 'GET', url: B, ...h(adminTok) })).json()).toEqual({ plafond: null, autres: 0, entreprise: 'Messaging Me' });
    await server.close();
  });

  it('🔴 sans compte WhatsApp, ou sans Business Manager connu : 409 qui le dit, et AUCUN appel au plafond', async () => {
    for (const over of [
      { repo: { getTenantPhoneNumberId: async () => null, getTenantWabaId: async () => null, phoneNumberBelongsToTenant: async () => true } },
      { meta: { mbaClientForTenant: async () => ({}) as never, phoneClientForTenant: async () => ({ getWabaHealth: async () => ({}) }) } },
    ] as Array<Partial<MbaRouteDeps>>) {
      const { server, appels } = app({}, over);
      const res = await server.inject({ method: 'GET', url: B, ...h(adminTok) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Business Manager');
      expect(appels.filter((a) => a.m === 'lireBudgets' || a.m === 'ecrireBudgets')).toEqual([]);
      await server.close();
    }
  });

  it('pose UN plafond : le POST porte l’unité, la fenêtre et le maximum de Meta, puis l’écran lit ce que Meta RELIT', async () => {
    const { server, appels } = app({
      ecrireBudgets: () => undefined,
      lireBudgets: () => [{ budget_id: 'b9', unit_type: 'token', time_window: 'thirty_days', max_budget: 10_000_000 }],
    });
    const res = await server.inject({ method: 'PUT', url: B, ...json({ plafond: { unite: 'token', fenetre: 'thirty_days', max: 10_000_000 } }) });
    expect(res.statusCode).toBe(200);
    expect(appels.find((a) => a.m === 'ecrireBudgets')?.args).toEqual(['BM1', [{ unit_type: 'token', time_window: 'thirty_days', max_budget: 10_000_000 }]]);
    expect(appels.map((a) => a.m)).toEqual(['ecrireBudgets', 'lireBudgets']);
    expect(res.json()).toEqual({ plafond: { unite: 'token', fenetre: 'thirty_days', max: 10_000_000 }, autres: 0, entreprise: 'Messaging Me' });
    await server.close();
  });

  it('un refus 403 de Meta devient un 409 en français, pas l’anglais de Meta', async () => {
    const { server } = app({ lireBudgets: () => Promise.reject(new MetaApiError(403, { message: 'The agent budget API is not enabled for this business integration' })) });
    const res = await server.inject({ method: 'GET', url: B, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Meta n’ouvre pas encore le plafond');
    await server.close();
  });

  it('un corps JSON primitif est un 400, jamais un 500', async () => {
    const { server } = app();
    for (const corps of ['12', '"texte"', 'null', '[1]']) {
      const res = await server.inject({ method: 'PUT', url: B, ...h(adminTok), payload: corps });
      expect(res.statusCode, corps).toBe(400);
    }
    await server.close();
  });

  it('`{ plafond: null }` retire tout : le POST part VIDE', async () => {
    const { server, appels } = app({ ecrireBudgets: () => undefined, lireBudgets: () => [] });
    const res = await server.inject({ method: 'PUT', url: B, ...json({ plafond: null }) });
    expect(res.statusCode).toBe(200);
    expect(appels.find((a) => a.m === 'ecrireBudgets')?.args).toEqual(['BM1', []]);
    await server.close();
  });

  it('🔴 un plafond invalide est refusé AVANT tout appel à Meta : il couperait l’agent de tout un Business Manager', async () => {
    const { server, appels } = app();
    for (const corps of [
      {},
      { plafond: 'beaucoup' },
      { plafond: { unite: 'euro', fenetre: 'seven_days', max: 10 } },
      { plafond: { unite: 'token', fenetre: 'one_week', max: 10 } },
      { plafond: { unite: 'token', fenetre: 'seven_days', max: 0 } },
      { plafond: { unite: 'token', fenetre: 'seven_days', max: 2.5 } },
      { plafond: { unite: 'token', fenetre: 'seven_days', max: '10' } },
    ]) {
      const res = await server.inject({ method: 'PUT', url: B, ...json(corps) });
      expect(res.statusCode, JSON.stringify(corps)).toBe(400);
    }
    expect(appels.filter((a) => a.m === 'ecrireBudgets')).toEqual([]);
    await server.close();
  });

  it('🔴 réservé aux administrateurs, et à SON espace', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url: B, ...h(agentTok) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: B, ...h(autreTok) })).statusCode).toBe(403);
    await server.close();
  });
});

/**
 * LE TABLEAU DE L'AGENT (Performance lab, 2026-10-02) : les statistiques de Meta et notre compte de ses messages, sur
 * 30 jours. Aucune ne porte de coût : l'estimation se fait au prix public, que la route rend avec les chiffres.
 */
describe('GET /tenants/:tenantId/mba-insights', () => {
  const I = '/tenants/t1/mba-insights';

  it('sans numéro : `numero: false`, et aucune lecture', async () => {
    const { server, appels } = app();
    const res = await server.inject({ method: 'GET', url: I, ...h(adminTok) });
    expect(res.json()).toEqual({ numero: false });
    expect(appels).toEqual([]);
    await server.close();
  });

  it('rend les trois lectures de Meta, notre compte sur la MÊME fenêtre, et le prix public', async () => {
    const vus: unknown[][] = [];
    const { server, appels } = app({
      insightsConversations: () => ({ traitees: 4, enAttenteEquipe: 0 }),
      insightsOutils: () => [{ nom: 'EngageMe › add_tag', brut: 'x', conversations: 2, latenceMs: 4179, succes: 1, erreurs: 0, timeouts: 0 }],
      insightsEvenements: () => [{ type: 'message_sans_suite', recus: 1, traites: 1, latenceMs: 8156 }],
    }, {
      repo: { getTenantPhoneNumberId: async () => PN, getTenantWabaId: async () => 'WABA1', phoneNumberBelongsToTenant: async () => true },
      stats: { messagesEcritsParMba: async (...args: unknown[]) => { vus.push(args); return 36; } },
    });
    const res = await server.inject({ method: 'GET', url: I, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const corps = res.json();
    expect(corps).toMatchObject({
      numero: true, conversations: { traitees: 4, enAttenteEquipe: 0 }, messages: 36,
      prixParMessageUsd: { min: 0.04, max: 0.05 },
    });
    expect(corps.outils).toHaveLength(1);
    expect(corps.evenements).toHaveLength(1);
    // La fenêtre de Meta et la nôtre : 30 jours, bornes comprises.
    const [debut, fin] = (appels.find((a) => a.m === 'insightsOutils')?.args ?? []).slice(1) as [string, string];
    expect(Date.parse(fin) - Date.parse(debut)).toBe(29 * 86_400_000);
    expect(vus[0]?.[0]).toBe('t1');
    expect(vus[0]?.[1]).toBeInstanceOf(Date);
    await server.close();
  });

  it('🔴 une lecture en panne rend `null`, jamais zéro, et n’éteint pas les autres', async () => {
    const { server } = app({
      // Une méthode `async` du vrai client REJETTE, elle ne lève pas en synchrone.
      insightsConversations: () => Promise.reject(new Error('500')),
      insightsOutils: () => [],
      insightsEvenements: () => [],
    }, {
      repo: { getTenantPhoneNumberId: async () => PN, getTenantWabaId: async () => 'WABA1', phoneNumberBelongsToTenant: async () => true },
      stats: { messagesEcritsParMba: async () => { throw new Error('base'); } },
    });
    const corps = (await server.inject({ method: 'GET', url: I, ...h(adminTok) })).json();
    expect(corps.conversations).toBeNull();
    expect(corps.messages).toBeNull();
    expect(corps.outils).toEqual([]);
    await server.close();
  });
});

/**
 * Les QUATRE suppressions (FAQ, compétence, site, fichier) lisent le contenu AVANT de supprimer et le
 * journalisent APRÈS (`supprimerAvecTrace`, audit ponytail du 2026-09-25). Chez Meta une suppression est
 * définitive : la ligne d'historique est le seul exemplaire de ce qui a été effacé.
 */
describe('routes MBA : une suppression laisse sa trace', () => {
  const cas = [
    { chemin: '/faq/f1', liste: 'listFaqs', supprime: 'deleteFaq', element: 'faq', cible: 'f1', objet: { id: 'f1', question: 'Horaires ?', answer: '9h' }, libelle: 'FAQ : Horaires ?' },
    { chemin: '/skills/s1', liste: 'listSkills', supprime: 'deleteSkill', element: 'competence', cible: 's1', objet: { id: 's1', name: 'Réserver' }, libelle: 'Compétence : Réserver' },
    { chemin: '/websites/w1', liste: 'listWebsites', supprime: 'deleteWebsite', element: 'site', cible: 'w1', objet: { id: 'w1', url: 'https://bus.fr' }, libelle: 'Site : https://bus.fr' },
    { chemin: '/files/d1', liste: 'listFiles', supprime: 'deleteFile', element: 'fichier', cible: 'd1', objet: { id: 'd1', name: 'tarifs.pdf' }, libelle: 'Document : tarifs.pdf' },
  ] as const;

  for (const c of cas) {
    it(`${c.element} : lue AVANT, supprimée, puis journalisée avec son contenu et son auteur`, async () => {
      const ordre: string[] = [];
      const lignes: Array<{ tenant: string; ligne: unknown }> = [];
      const { server, appels } = app(
        { [c.liste]: () => [{ id: 'autre' }, c.objet] },
        { journaliserSuppression: async (tenant, ligne) => { ordre.push('journal'); lignes.push({ tenant, ligne }); } },
      );
      const res = await server.inject({ method: 'DELETE', url: url(c.chemin), ...h(adminTok) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: c.cible });
      ordre.unshift(...appels.map((a) => a.m));
      expect(ordre).toEqual([c.liste, c.supprime, 'journal']);
      expect(appels.find((a) => a.m === c.supprime)?.args).toEqual([PN, c.cible]);
      expect(lignes).toEqual([{ tenant: 't1', ligne: { element: c.element, cible: c.cible, libelle: c.libelle, avant: c.objet, acteurId: 'u1' } }]);
      await server.close();
    });

    it(`${c.element} : une lecture en ÉCHEC n'empêche pas la suppression, et la trace garde l'identifiant`, async () => {
      const lignes: unknown[] = [];
      const { server, appels } = app(
        { [c.liste]: () => Promise.reject(new Error('Meta indisponible')) },
        { journaliserSuppression: async (_t, ligne) => { lignes.push(ligne); } },
      );
      const res = await server.inject({ method: 'DELETE', url: url(c.chemin), ...h(adminTok) });
      expect(res.statusCode).toBe(200);
      expect(appels.map((a) => a.m)).toContain(c.supprime);
      expect(lignes).toEqual([{ element: c.element, cible: c.cible, libelle: `${c.libelle.split(' : ')[0]} : ${c.cible}`, avant: { id: c.cible }, acteurId: 'u1' }]);
      await server.close();
    });

    it(`${c.element} : une suppression REFUSÉE par Meta n'est pas journalisée`, async () => {
      const lignes: unknown[] = [];
      const { server } = app(
        { [c.supprime]: () => Promise.reject(new Error('refus')) },
        { journaliserSuppression: async (_t, ligne) => { lignes.push(ligne); } },
      );
      const res = await server.inject({ method: 'DELETE', url: url(c.chemin), ...h(adminTok) });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(lignes).toEqual([]);
      await server.close();
    });
  }
});
