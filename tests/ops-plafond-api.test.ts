import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { config } from '../src/config';
import { DROIT_RELAIS } from '../src/mba/cle-relais';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { PlafondApiStore, ReglagePlafondApi } from '../src/auth/plafond-espace';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { capturerJournal } from './journal';

/**
 * LE PLAFOND DE L'API PAR ESPACE, PAR LE VRAI CÂBLAGE (`buildServer`), ET LA ROUTE QUI LE RÈGLE.
 *
 * 🔴 CE QU'UN TEST DE LA GARDE SEULE NE VOIT PAS : que `/v1` et `/mcp` partagent LE MÊME plafond (une seconde
 * instance doublerait le débit d'un espace selon la porte), que le relais du Meta Business Agent y échappe dans
 * le câblage réel, et que la route d'exploitation vide le cache que le limiteur lit : sans quoi un plafond relevé
 * ne prendrait effet qu'à l'expiration du cache, en silence.
 */
const T1 = '4169c753-311a-43bb-a334-d8a2cb7caf6f';
const T2 = '0b9f3a52-6f7e-4d1c-9a3b-2c1d0e9f8a7b';
const INCONNU = '11111111-2222-4333-8444-555555555555';

const CLE_A = cleApiDeTest('ops_plafond_a');
const CLE_B = cleApiDeTest('ops_plafond_b');
const CLE_T2 = cleApiDeTest('ops_plafond_t2');
const CLE_RELAIS = cleApiDeTest('ops_plafond_relais');

class Cles implements ApiKeyLookup {
  private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[] }>([
    [sha256Hex(CLE_A), { id: 'ka', tenantId: T1, scopes: ['contacts:write', 'mcp:read'] }],
    [sha256Hex(CLE_B), { id: 'kb', tenantId: T1, scopes: ['contacts:write'] }],
    [sha256Hex(CLE_T2), { id: 'kc', tenantId: T2, scopes: ['contacts:write'] }],
    [sha256Hex(CLE_RELAIS), { id: 'kr', tenantId: T1, scopes: [DROIT_RELAIS] }],
  ]);
  async findActiveByHash(h: string) { return this.parEmpreinte.get(h) ?? null; }
  async touchLastUsed() {}
}

class MagasinMemoire implements PlafondApiStore {
  lectures = 0;
  readonly ecritures: Array<{ tenantId: string; reglage: ReglagePlafondApi }> = [];
  readonly reglages = new Map<string, ReglagePlafondApi>([[T1, { minute: null, heure: null }], [T2, { minute: null, heure: null }]]);
  async lire(t: string) { this.lectures += 1; return this.reglages.get(t) ?? null; }
  async ecrire(t: string, r: ReglagePlafondApi) {
    if (!this.reglages.has(t)) return false;
    this.ecritures.push({ tenantId: t, reglage: r });
    this.reglages.set(t, r);
    return true;
  }
}

/**
 * Le relais ne voit aucun outil : la route rend `200 { succes: false }` sans rien appeler. C'est la GARDE qui est
 * éprouvée ici, pas la route (elle l'est dans `http-mba-relais.test.ts`).
 */
const relaisMuet = { numeroDuTenant: async () => null } as unknown as MbaRelaisDeps;

function monter(apiParMinute = 2) {
  const magasin = new MagasinMemoire();
  const server = buildServer({
    queue: new FakeQueue(),
    opsToken: 'jeton-ops',
    plafonds: { apiParMinute, apiParHeure: 1000 },
    plafondApi: magasin,
    v1: { apiKeys: new Cles(), contacts: contactsV1Muets(), mcp: {} as never, mbaRelais: relaisMuet },
  });
  return { server, magasin };
}

type Serveur = ReturnType<typeof monter>['server'];
const ops = { 'content-type': 'application/json', 'x-ops-token': 'jeton-ops' };
const cle = (c: string) => ({ authorization: `Bearer ${c}` });
/** `GET /mcp` rend 405 APRÈS la garde : c'est l'appel le plus simple qui traverse le plafond. */
const mcp = (s: Serveur, c: string) => s.inject({ method: 'GET', url: '/mcp', headers: cle(c) });
const contact = (s: Serveur, c: string) => s.inject({
  method: 'POST', url: '/v1/contacts', headers: { ...cle(c), 'content-type': 'application/json' }, payload: { phone: '+33612345678' },
});
const relais = (s: Serveur) => s.inject({
  method: 'POST', url: '/mba/relais/outils/o1',
  headers: { ...cle(CLE_RELAIS), 'content-type': 'application/json', 'x-contact-whatsapp': '+33612345678' }, payload: {},
});

describe('le plafond de l’espace, par le vrai câblage', () => {
  it('🔴 `/v1` et `/mcp` partagent LE MÊME plafond, et deux clés du même espace aussi', async () => {
    const { server } = monter(2);
    expect((await mcp(server, CLE_A)).statusCode).toBe(405);
    expect((await contact(server, CLE_B)).statusCode).toBe(200);
    const refusMcp = await mcp(server, CLE_A);
    expect(refusMcp.statusCode).toBe(429);
    expect(refusMcp.json()).toEqual({ error: 'trop de requêtes : plafond de l’espace atteint, 2 appels par minute', code: 'rate_limited' });
    expect(Number(refusMcp.headers['retry-after'])).toBeGreaterThan(0);
    expect((await contact(server, CLE_B)).statusCode).toBe(429);
    // L'espace voisin n'a rien payé.
    expect((await contact(server, CLE_T2)).statusCode).toBe(200);
    await server.close();
  });

  it('🔴 le relais du Meta Business Agent passe quand l’espace est à bout, avec les en-têtes de SA clé', async () => {
    const { server } = monter(2);
    await mcp(server, CLE_A);
    await mcp(server, CLE_A);
    expect((await mcp(server, CLE_A)).statusCode).toBe(429);
    const r = await relais(server);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ succes: false });
    expect(r.headers['x-ratelimit-limit']).toBe(String(config.API_KEY_RATE_LIMIT_MAX));
    await server.close();
  });

  it('🔴 et le relais ne consomme rien du plafond de l’espace', async () => {
    const { server } = monter(2);
    for (let i = 0; i < 5; i += 1) expect((await relais(server)).statusCode).toBe(200);
    expect((await mcp(server, CLE_A)).statusCode).toBe(405);
    expect((await mcp(server, CLE_A)).statusCode).toBe(405);
    await server.close();
  });

  it('⚠️ le réglage est lu UNE fois pour une rafale, pas une fois par appel', async () => {
    const { server, magasin } = monter(100);
    for (let i = 0; i < 10; i += 1) await mcp(server, CLE_A);
    expect(magasin.lectures).toBe(1);
    await server.close();
  });
});

describe('la route d’exploitation /ops/plafond-api/:tenantId', () => {
  it('🔴 sans le jeton d’exploitation, ou avec un faux : 401, rien n’est lu ni écrit', async () => {
    const { server, magasin } = monter();
    for (const entetes of [{}, { 'x-ops-token': 'pas-le-bon' }, { authorization: `Bearer ${CLE_A}` }]) {
      expect((await server.inject({ method: 'GET', url: `/ops/plafond-api/${T1}`, headers: entetes })).statusCode).toBe(401);
      expect((await server.inject({
        method: 'PUT', url: `/ops/plafond-api/${T1}`, headers: { ...entetes, 'content-type': 'application/json' },
        payload: { minute: 500, heure: null, note: 'intégrateur à fort volume' },
      })).statusCode).toBe(401);
    }
    expect([magasin.lectures, magasin.ecritures.length]).toEqual([0, 0]);
    await server.close();
  });

  it('GET rend le réglage, le défaut et ce qui s’applique ; 404 sur un espace inconnu ou mal formé', async () => {
    const { server, magasin } = monter(2);
    magasin.reglages.set(T1, { minute: 10, heure: null });
    const res = await server.inject({ method: 'GET', url: `/ops/plafond-api/${T1}`, headers: ops });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tenantId: T1,
      minute: { reglage: 10, defaut: 2, effectif: 10 },
      heure: { reglage: null, defaut: 1000, effectif: 1000 },
    });
    expect((await server.inject({ method: 'GET', url: `/ops/plafond-api/${INCONNU}`, headers: ops })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/ops/plafond-api/pas-un-uuid', headers: ops })).statusCode).toBe(404);
    await server.close();
  });

  it('🔴 PUT exige une NOTE et deux valeurs valides : sinon 400, et rien n’est écrit', async () => {
    const { server, magasin } = monter();
    const corps = [
      { minute: 500, heure: null },
      { minute: 500, heure: null, note: '  ' },
      { minute: 0, heure: null, note: 'intégrateur à fort volume' },
      { minute: -1, heure: null, note: 'intégrateur à fort volume' },
      { minute: 1.5, heure: null, note: 'intégrateur à fort volume' },
      { minute: '500', heure: null, note: 'intégrateur à fort volume' },
      { minute: 500, note: 'intégrateur à fort volume' },
      { minute: 2_147_483_648, heure: null, note: 'intégrateur à fort volume' },
    ];
    for (const payload of corps) {
      const res = await server.inject({ method: 'PUT', url: `/ops/plafond-api/${T1}`, headers: ops, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(magasin.ecritures).toEqual([]);
    await server.close();
  });

  it('🔴 PUT écrit, JOURNALISE le geste avec sa note et l’état d’avant, et le plafond change AU PROCHAIN appel', async () => {
    const { server, magasin } = monter(2);
    // Le cache du limiteur est rempli AVANT le réglage : c'est lui que la route doit vider.
    await mcp(server, CLE_A);
    await mcp(server, CLE_A);
    expect((await mcp(server, CLE_A)).statusCode).toBe(429);

    const { resultat: res, lignes } = await capturerJournal(() => server.inject({
      method: 'PUT', url: `/ops/plafond-api/${T1}`, headers: ops, payload: { minute: 4, heure: null, note: 'intégrateur à fort volume' },
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenantId: T1, minute: { reglage: 4, defaut: 2, effectif: 4 } });
    expect(magasin.ecritures).toEqual([{ tenantId: T1, reglage: { minute: 4, heure: null } }]);
    const traces = lignes.filter((l) => l.msg === 'ops_plafond_api');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      lvl: 'warn', tenantId: T1, note: 'intégrateur à fort volume',
      avant: { minute: null, heure: null }, apres: { minute: 4, heure: null },
    });

    // Deux places de plus dans la MÊME minute, tout de suite : le cache a été vidé.
    expect((await mcp(server, CLE_A)).statusCode).toBe(405);
    expect((await mcp(server, CLE_A)).statusCode).toBe(405);
    expect((await mcp(server, CLE_A)).statusCode).toBe(429);
    // L'espace voisin n'a pas bougé : toujours deux.
    await contact(server, CLE_T2);
    await contact(server, CLE_T2);
    expect((await contact(server, CLE_T2)).statusCode).toBe(429);
    await server.close();
  });

  it('PUT sur un espace inconnu : 404, rien d’écrit ni de journalisé', async () => {
    const { server, magasin } = monter();
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({
      method: 'PUT', url: `/ops/plafond-api/${INCONNU}`, headers: ops, payload: { minute: 4, heure: 40, note: 'intégrateur à fort volume' },
    }));
    expect(res.statusCode).toBe(404);
    expect(magasin.ecritures).toEqual([]);
    expect(lignes.filter((l) => l.msg === 'ops_plafond_api')).toEqual([]);
    await server.close();
  });

  it('⚠️ sans magasin câblé, la route n’existe pas, et le limiteur applique le défaut', async () => {
    const server = buildServer({
      queue: new FakeQueue(), opsToken: 'jeton-ops', plafonds: { apiParMinute: 1 },
      v1: { apiKeys: new Cles(), contacts: contactsV1Muets(), mcp: {} as never },
    });
    expect((await server.inject({ method: 'GET', url: `/ops/plafond-api/${T1}`, headers: ops })).statusCode).toBe(404);
    expect((await mcp(server, CLE_A)).statusCode).toBe(405);
    expect((await mcp(server, CLE_A)).statusCode).toBe(429);
    await server.close();
  });
});
