import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequireAuth, makeLimiteParTenant } from '../src/auth/middleware';
import { RateLimiter } from '../src/auth/rate-limit';
import { signSession } from '../src/auth/token';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ImportRouteDeps } from '../src/http/import';
import type { MeRouteDeps } from '../src/http/me';
import type { FastifyRequest, FastifyReply } from 'fastify';

const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const entete = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

// Plafond général des routes AUTHENTIFIÉES. Il est posé DANS `makeRequireAuth` et non en hook Fastify global :
// un hook global tourne avant les preHandler de route, donc `req.auth` n'existe pas encore et la seule clé
// disponible serait `req.ip`, qui derrière Cloudflare + NPM désigne le proxy et vaut pareil pour tout le monde.

const SECRET = 'test-secret-rate-limit';

let jetonU1 = '';
let jetonU2 = '';
let jetonU1AutreTenant = '';
let jetonEmprunt = '';

beforeAll(async () => {
  jetonU1 = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  jetonU2 = await signSession({ userId: 'u2', tenantId: 't1', role: 'admin' }, SECRET);
  jetonU1AutreTenant = await signSession({ userId: 'u9', tenantId: 't2', role: 'admin' }, SECRET);
  jetonEmprunt = await signSession({ userId: 'ops1', tenantId: 't1', role: 'admin', impersonated: true }, SECRET);
});

function fakeReq(jeton: string, methode = 'GET'): FastifyRequest {
  return { headers: { authorization: `Bearer ${jeton}` }, method: methode, url: '/x' } as unknown as FastifyRequest;
}

function fakeReply() {
  const state: { statusCode: number | null; body: unknown; headers: Record<string, string> } = {
    statusCode: null, body: undefined, headers: {},
  };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply; },
    async send(b: unknown) { state.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

describe('plafond général par utilisateur, dans makeRequireAuth', () => {
  it('laisse passer les N premières requêtes et refuse la N+1 en 429', async () => {
    const garde = makeRequireAuth(SECRET, undefined, new RateLimiter(3, 60_000));
    for (let i = 0; i < 3; i++) {
      const { reply, state } = fakeReply();
      await garde(fakeReq(jetonU1), reply);
      expect(state.statusCode).toBeNull();
    }
    const { reply, state } = fakeReply();
    await garde(fakeReq(jetonU1), reply);
    expect(state.statusCode).toBe(429);
  });

  it('compte par UTILISATEUR : deux comptes du même espace ne partagent pas leur quota', async () => {
    const garde = makeRequireAuth(SECRET, undefined, new RateLimiter(1, 60_000));
    const premier = fakeReply();
    await garde(fakeReq(jetonU1), premier.reply);
    expect(premier.state.statusCode).toBeNull();

    // u1 a consommé son unique jeton ; u2 doit garder le sien.
    const deuxieme = fakeReply();
    await garde(fakeReq(jetonU2), deuxieme.reply);
    expect(deuxieme.state.statusCode).toBeNull();

    const troisieme = fakeReply();
    await garde(fakeReq(jetonU1), troisieme.reply);
    expect(troisieme.state.statusCode).toBe(429);
  });

  it('compte AUSSI les sessions d’emprunt, qui sortent par une branche anticipée', async () => {
    const garde = makeRequireAuth(SECRET, undefined, new RateLimiter(1, 60_000));
    const premier = fakeReply();
    await garde(fakeReq(jetonEmprunt), premier.reply);
    expect(premier.state.statusCode).toBeNull();

    const second = fakeReply();
    await garde(fakeReq(jetonEmprunt), second.reply);
    expect(second.state.statusCode).toBe(429);
  });

  it('pose les en-têtes x-ratelimit-* au succès, et retry-after sur le refus', async () => {
    const garde = makeRequireAuth(SECRET, undefined, new RateLimiter(1, 60_000));
    const ok = fakeReply();
    await garde(fakeReq(jetonU1), ok.reply);
    expect(ok.state.headers['x-ratelimit-limit']).toBe('1');
    expect(ok.state.headers['x-ratelimit-remaining']).toBe('0');
    expect(ok.state.headers['x-ratelimit-reset']).toMatch(/^\d+$/);

    const ko = fakeReply();
    await garde(fakeReq(jetonU1), ko.reply);
    expect(ko.state.statusCode).toBe(429);
    expect(ko.state.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(ko.state.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('le refus est un 4xx : Cloudflare remplacerait le corps d’un 5xx par sa propre page', async () => {
    const garde = makeRequireAuth(SECRET, undefined, new RateLimiter(1, 60_000));
    await garde(fakeReq(jetonU1), fakeReply().reply);
    const { reply, state } = fakeReply();
    await garde(fakeReq(jetonU1), reply);
    expect(state.statusCode).toBeGreaterThanOrEqual(400);
    expect(state.statusCode).toBeLessThan(500);
    expect(state.body).toEqual({ error: expect.stringContaining('trop de requêtes') });
  });

  it('sans limiteur, aucun plafond : le comportement d’avant est intact', async () => {
    const garde = makeRequireAuth(SECRET);
    for (let i = 0; i < 50; i++) {
      const { reply, state } = fakeReply();
      await garde(fakeReq(jetonU1), reply);
      expect(state.statusCode).toBeNull();
    }
  });

  it('le plafond se prend AVANT la relecture d’état en base, pour ne pas offrir une requête SQL par appel', async () => {
    let relectures = 0;
    const loadState = async (): Promise<{ role: string; disabled: boolean }> => {
      relectures += 1;
      return { role: 'admin', disabled: false };
    };
    const garde = makeRequireAuth(SECRET, loadState, new RateLimiter(1, 60_000));
    await garde(fakeReq(jetonU1), fakeReply().reply);
    expect(relectures).toBe(1);

    const refuse = fakeReply();
    await garde(fakeReq(jetonU1), refuse.reply);
    expect(refuse.state.statusCode).toBe(429);
    expect(relectures).toBe(1); // le refus n'a coûté aucune requête
  });
});

describe('plafond serré des routes coûteuses, par espace', () => {
  it('compte par TENANT : deux comptes du même espace partagent le quota', async () => {
    const limite = makeLimiteParTenant(new RateLimiter(1, 60_000));
    const req1 = { auth: { userId: 'u1', tenantId: 't1', role: 'admin' } } as unknown as FastifyRequest;
    const req2 = { auth: { userId: 'u2', tenantId: 't1', role: 'admin' } } as unknown as FastifyRequest;

    const premier = fakeReply();
    await limite(req1, premier.reply);
    expect(premier.state.statusCode).toBeNull();

    // Même espace, autre utilisateur : le quota est celui de l'espace, il est déjà consommé.
    const second = fakeReply();
    await limite(req2, second.reply);
    expect(second.state.statusCode).toBe(429);
  });

  it('deux espaces ne partagent pas leur quota', async () => {
    const limite = makeLimiteParTenant(new RateLimiter(1, 60_000));
    const t1 = { auth: { userId: 'u1', tenantId: 't1', role: 'admin' } } as unknown as FastifyRequest;
    const t2 = { auth: { userId: 'u9', tenantId: 't2', role: 'admin' } } as unknown as FastifyRequest;

    const premier = fakeReply();
    await limite(t1, premier.reply);
    expect(premier.state.statusCode).toBeNull();

    const second = fakeReply();
    await limite(t2, second.reply);
    expect(second.state.statusCode).toBeNull();
  });

  it('sans req.auth, refuse en 401 plutôt que de compter sur une clé vide', async () => {
    const limite = makeLimiteParTenant(new RateLimiter(1, 60_000));
    const { reply, state } = fakeReply();
    await limite({} as unknown as FastifyRequest, reply);
    expect(state.statusCode).toBe(401);
  });
});

describe('les deux plafonds sont indépendants', () => {
  it('un espace bloqué sur les routes coûteuses garde son quota général', async () => {
    const general = new RateLimiter(10, 60_000);
    const couteux = new RateLimiter(1, 60_000);
    const garde = makeRequireAuth(SECRET, undefined, general);
    const limite = makeLimiteParTenant(couteux);

    const req = fakeReq(jetonU1);
    await garde(req, fakeReply().reply);
    await limite(req, fakeReply().reply);

    const refuseCouteux = fakeReply();
    await limite(req, refuseCouteux.reply);
    expect(refuseCouteux.state.statusCode).toBe(429);

    // Le plafond général n'a pas bougé pour autant.
    const encoreOk = fakeReply();
    await garde(fakeReq(jetonU1AutreTenant), encoreOk.reply);
    expect(encoreOk.state.statusCode).toBeNull();
  });
});

describe('câblage dans buildServer', () => {
  // Les dépendances LÈVENT si on les touche : un 429 obtenu ici prouve que le refus est arrivé AVANT le
  // handler, donc avant la moindre requête en base. C'est tout l'intérêt d'un plafond posé en preHandler.
  const depsQuiLevent = new Proxy({}, {
    get: () => () => { throw new Error('le handler ne doit pas être atteint'); },
  }) as unknown as ImportRouteDeps;

  const me: MeRouteDeps = {
    getUser: async () => ({ email: 'julien@messagingme.fr', name: 'Julien Dumas', role: 'admin' }),
  };

  function serveur(plafonds: { utilisateurParMinute?: number; couteuxParMinute?: number }) {
    return buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      me,
      import: depsQuiLevent,
      plafonds,
    });
  }

  it('le plafond général est bien branché sur une route gardée', async () => {
    const server = serveur({ utilisateurParMinute: 2 });
    const url = '/tenants/t1/me';
    expect((await server.inject({ method: 'GET', url, ...entete(jetonU1) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url, ...entete(jetonU1) })).statusCode).toBe(200);
    const refuse = await server.inject({ method: 'GET', url, ...entete(jetonU1) });
    expect(refuse.statusCode).toBe(429);
    expect(refuse.headers['retry-after']).toBeDefined();
    await server.close();
  });

  it('le plafond des routes coûteuses est branché sur l’import, et compte par espace', async () => {
    const server = serveur({ utilisateurParMinute: 1000, couteuxParMinute: 1 });
    const url = '/tenants/t1/contacts/import';
    const corps = { csv: 'phone\n+33611111111', mapping: { columns: {} } };

    // u1 consomme l'unique jeton de l'espace t1. Le handler lèverait s'il était atteint, donc tout code
    // autre que 500 prouve déjà que le preHandler a tranché ; on veut ici le 429 du SECOND appel.
    await server.inject({ method: 'POST', url, ...entete(jetonU1), payload: corps });

    // u2 est un AUTRE utilisateur du MÊME espace : le quota coûteux est celui de l'espace, il est épuisé.
    const refuse = await server.inject({ method: 'POST', url, ...entete(jetonU2), payload: corps });
    expect(refuse.statusCode).toBe(429);

    // Et le plafond général de u2 n'a pas été entamé pour autant : sa console marche toujours.
    const ok = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...entete(jetonU2) });
    expect(ok.statusCode).toBe(200);
    await server.close();
  });

  it('un plafond à 0 désactive : la trappe de secours si le calibrage est mauvais en production', async () => {
    const server = serveur({ utilisateurParMinute: 0 });
    for (let i = 0; i < 20; i++) {
      const res = await server.inject({ method: 'GET', url: '/tenants/t1/me', ...entete(jetonU1) });
      expect(res.statusCode).toBe(200);
    }
    await server.close();
  });
});

describe('l’inventaire des routes coûteuses ne dérive pas', () => {
  /**
   * Ce test lit la SOURCE, comme celui de `scopeTenant`, et pour la même raison : aucun type ne peut exprimer
   * « ces routes-là, et pas d'autres, portent le plafond par espace ». Reposer un jour une de ces routes sur
   * la garde ordinaire la sortirait du plafond en silence, sans qu'aucun test de comportement ne le voie.
   *
   * ⚠️ Il ne remplace PAS le test de comportement plus haut : celui-ci vérifie que la composition est écrite,
   * l'autre qu'elle produit bien un 429. Il faut les deux, une composition juste sur le papier pouvant très
   * bien ne jamais s'exécuter (cf. le piège du tableau imbriqué que `gardeEtendue` referme).
   */
  const lire = (f: string): string => readFileSync(new URL(`../src/http/${f}`, import.meta.url), 'utf8');

  const attendus: ReadonlyArray<{ fichier: string; route: string }> = [
    { fichier: 'import.ts', route: "app.post('/tenants/:tenantId/contacts/import', optsImportCouteux," },
    { fichier: 'import.ts', route: "app.post('/tenants/:tenantId/contacts/import/preview', optsApercuCouteux," },
    { fichier: 'contacts.ts', route: "app.post('/tenants/:tenantId/contacts/bulk', couteux," },
    { fichier: 'contacts.ts', route: "app.post('/tenants/:tenantId/contacts/purge', couteux," },
    { fichier: 'contacts.ts', route: "app.get('/tenants/:tenantId/contacts/:contactId/history/export', couteux," },
    { fichier: 'campaigns.ts', route: "app.post('/campaigns/:campaignId/run', couteux," },
  ];

  it.each(attendus)('$route porte le plafond par espace', ({ fichier, route }) => {
    expect(lire(fichier)).toContain(route);
  });

  it('les trois modules construisent leur garde étendue par le composeur commun', () => {
    // `gardeEtendue` est le seul endroit qui aplatit la chaîne. Un module qui composerait à la main
    // rouvrirait le piège du tableau imbriqué, muet à l'exécution.
    for (const f of ['import.ts', 'contacts.ts', 'campaigns.ts']) {
      expect(lire(f)).toContain('gardeEtendue(');
    }
  });
});

describe('retry-after se calcule sur l’horloge DU LIMITEUR', () => {
  /**
   * 🔴 Le limiteur accepte une horloge injectée (3e argument), mais l'en-tête `retry-after` était calculé sur
   * `Date.now()`. Les deux horloges n'ont aucune raison de coïncider : le `resetAt` rendu par le limiteur est
   * daté de SON horloge, le soustraire à une AUTRE ne veut rien dire. Défaut recopié de `api-key.ts`, où il
   * dormait sans se voir parce que ses tests utilisent l'horloge réelle.
   *
   * Le symptôme est silencieux et trompeur : le calcul donne un nombre très négatif, le plancher à 1 le
   * rattrape, et l'appelant se voit annoncer « réessayez dans 1 seconde » pour une fenêtre d'une minute.
   */
  it('rend la vraie durée d’attente quand l’horloge du limiteur est injectée', async () => {
    let faux = 1_000_000;
    const limiteur = new RateLimiter(1, 60_000, () => faux);
    const garde = makeRequireAuth(SECRET, undefined, limiteur);

    await garde(fakeReq(jetonU1), fakeReply().reply);
    const refuse = fakeReply();
    await garde(fakeReq(jetonU1), refuse.reply);

    expect(refuse.state.statusCode).toBe(429);
    // La fenêtre fait 60 s et rien ne s'est écoulé sur l'horloge du limiteur : il reste 60 s, pas 1.
    expect(Number(refuse.state.headers['retry-after'])).toBe(60);

    // Et la valeur suit l'horloge du limiteur, pas l'horloge murale.
    faux += 45_000;
    const encore = fakeReply();
    await garde(fakeReq(jetonU1), encore.reply);
    expect(Number(encore.state.headers['retry-after'])).toBe(15);
  });
});
