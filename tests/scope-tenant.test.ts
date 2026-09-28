import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { gardesOuvertes } from './gardes';
import { espaceVerifie, etapeEspace, monterAvecEtapeEspace, scopeTenant } from '../src/http/scope';
import { buildServer, modulesDeRoutes } from '../src/server';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import { adresse, serveurSonde, type RouteSondee, type ServeurSonde } from './serveur-sonde';

/**
 * LE CONTRÔLE D'ACCÈS TENANT, ET SON MODE DE PANNE (audit de surface publique du 2026-09-03).
 *
 * 🔴 `scopeTenant` est LE contrôle d'isolation entre clients de ce produit. La connexion passe par le pooler
 * en rôle superuser, donc la RLS de Postgres est contournée : le filtrage en code est le SEUL contrôle, et
 * cette fonction est l'endroit où il se décide, pour chaque route `:tenantId` des modules `tenant` (plus de
 * 300 ; le compte n'est pas écrit ici, la preuve dynamique plus bas le mesure). Depuis le 2026-09-26, elle
 * s'exécute dans l'étape `etapeEspace`, posée au montage, et plus en première ligne de chaque handler.
 *
 * Elle échouait OUVERT : sans `req.auth`, elle rendait le tenant pris dans l'URL. Elle n'était donc un
 * contrôle que tant que la garde d'authentification avait bien été posée au montage, dans un AUTRE fichier.
 * Ce test fige le sens inverse.
 */
describe('scopeTenant : le contrôle d’isolation entre clients', () => {
  const req = (tenantUrl: string, tenantJwt?: string) => ({
    params: { tenantId: tenantUrl },
    ...(tenantJwt === undefined ? {} : { auth: { tenantId: tenantJwt } }),
  });

  it('cas nominal : le JWT et l’URL désignent le même espace', () => {
    expect(scopeTenant(req('t1', 't1'))).toBe('t1');
  });

  it('🔴 l’URL désigne un AUTRE espace que le jeton : refusé', () => {
    // Le cas d'école de l'IDOR : changer l'identifiant dans la barre d'adresse.
    expect(scopeTenant(req('t2', 't1'))).toBeNull();
  });

  it('🔴 AUCUNE authentification : refusé, et c’est le correctif', () => {
    // Avant, ceci rendait 't2' : la fonction distribuait l'espace demandé à qui le demandait. Ce n'était pas
    // exploitable en production (le câblage fournit toujours `auth`), mais la sûreté de 235 routes reposait
    // sur un appelant lointain, et la panne aurait été MUETTE. Un contrôle d'accès qui dépend d'une
    // convention n'est pas un contrôle d'accès.
    expect(scopeTenant(req('t2'))).toBeNull();
  });

});

/**
 * LA SECONDE MOITIÉ DU CORRECTIF : le garde-fou du démarrage.
 *
 * 🔴 CE TEST N'EST PLUS UN GREP, ET C'EST TOUT SON INTÉRÊT. Il relisait le TEXTE de `src/server.ts` et
 * comparait à sa PROPRE liste de 37 noms écrite à la main : il prouvait donc une orthographe, pas un
 * comportement, et sa liste pouvait dériver exactement comme celle qu'elle surveillait (elle avait déjà trois
 * noms de retard). Il monte désormais CHAQUE module tenant, un par un, et vérifie que le serveur REFUSE de
 * démarrer sans garde d'authentification.
 *
 * 🔴 ET LA LISTE VIENT DU REGISTRE, plus d'une copie. Ajouter un 41e module `acces: 'tenant'` ajoute
 * automatiquement son cas ici ; l'oublier n'est plus possible, puisqu'il n'y a plus rien à ne pas oublier.
 */
describe('le garde-fou de buildServer : aucune route tenant sans authentification', () => {
  const queue = {} as never;
  const usage = new GardeUsageMemoire(120, 0, () => Date.now(), 0);
  /** Toutes les dépendances présentes, pour que le registre déclare ses entrées et qu'on puisse les compter. */
  const toutPresent = new Proxy({}, { get: () => ({}) }) as never;
  const tenant = modulesDeRoutes(toutPresent, usage).filter((m) => m.acces === 'tenant');

  it('garde de la garde : le registre déclare bien des modules tenant', () => {
    // Sans ce cas, une boucle sur une liste vide rendrait ce fichier VERT sans rien vérifier : c'est le mode
    // de panne le plus silencieux d'un test qui dérive sa propre table de cas.
    expect(tenant.length).toBeGreaterThan(30);
  });

  for (const m of tenant) {
    it(`🔴 ${m.nom} monté seul, sans auth : le serveur refuse de démarrer`, () => {
      // Le refus tombe AVANT la création de l'instance Fastify, donc aucune route n'est montée et des
      // dépendances vides suffisent : c'est le garde-fou qu'on exerce, pas le module.
      expect(() => buildServer({ queue, [m.nom]: {} } as never)).toThrow(/auth/);
    });
  }

  it('un module SANS espace dans ses adresses ne déclenche pas le garde-fou', () => {
    // Le pendant nécessaire : une garde qui refuserait TOUT passerait les cas ci-dessus sans rien prouver.
    // `links` sert les liens tracés, autorisés par un code opaque dans l'URL, jamais par une session.
    expect(() => buildServer({ queue, links: {} } as never)).not.toThrow();
  });

  /**
   * 🔴 L'ANGLE MORT DES CAS CI-DESSUS, ET CE QUI LE FERME. Ils dérivent leur table de cas de `acces`, donc
   * un module mal déclaré ne les fait pas ÉCHOUER : il fait DISPARAÎTRE son cas, ce qui est silencieux.
   * Cette parité compare la DÉCLARATION aux adresses réellement montées par Fastify, et elle échoue dans les
   * deux sens.
   *
   * ⚠️ `session-ops` porte AUSSI des `:tenantId` (`/ops/credits/:tenantId`), et c'est correct : l'exploitation
   * est délibérément CROSS-espace, autorisée par la session d'exploitation, et elle ne passe donc pas par
   * `scopeTenant`. C'est exactement la nuance qu'un booléen `porteDeTenant` aurait écrasée.
   */
  /**
   * 🔴 L'ESSAI DU LOT 2 : AUCUNE ROUTE D'ESPACE NE SE MONTE SANS `preHandler`.
   *
   * Le type exige désormais une garde à chaque module, mais il ne dit RIEN de ce que le module en fait : rien
   * ne l'empêche de la recevoir et de ne pas la poser. C'est exactement le défaut que ce lot a produit et que
   * seul un test a vu : sur `POST /tenants/:tenantId/rcs/media`, les options de route s'écrivaient
   * `{ ...garde, bodyLimit }`, où `garde` désignait désormais la GARDE au lieu de l'OBJET D'OPTIONS. La route
   * partait donc sans `preHandler`, `req.auth` n'était jamais posé, et `scopeTenant` rendait 403 sur un geste
   * légitime. Une route peut aussi bien perdre sa garde dans l'autre sens, et s'ouvrir.
   *
   * ⚠️ Ce test regarde ce que FASTIFY a enregistré, pas ce que le module croit avoir passé.
   *
   * ⚠️ ET IL NE VOIT PAS L'ÉTAPE D'ESPACE, délibérément. Son `onRoute` est posé AVANT `m.monte`, donc avant
   * celui du poseur (`monterAvecEtapeEspace`), et les hooks `onRoute` tournent dans leur ordre d'ajout : il lit
   * la chaîne que le MODULE a posée, avant que l'étape y soit ajoutée. Sans cela, l'étape rendrait ce test
   * vide (une chaîne n'est plus jamais `undefined` une fois l'étape ajoutée). La chaîne FINALE, étape
   * comprise, est tenue plus bas sur le serveur construit.
   */
  it('🔴 toute route portant :tenantId a un preHandler', async () => {
    const bouchon = (): unknown => new Proxy(function () {} as never, {
      get: (_c, p) => (typeof p === 'symbol' || p === 'then' ? undefined : bouchon()),
      apply: () => bouchon(),
    });
    const toutBouchonne = new Proxy({}, { get: (_c, p) => (typeof p === 'symbol' ? undefined : bouchon()) }) as never;

    const nues: string[] = [];
    for (const m of modulesDeRoutes(toutBouchonne, usage)) {
      // `/ops` porte des `:tenantId` mais son autorité est la session d'exploitation, posée par sa propre garde.
      if (m.acces !== 'tenant') continue;
      const app = Fastify({ logger: false });
      app.addHook('onRoute', (r) => {
        if (r.path.includes(':tenantId') && r.preHandler === undefined) nues.push(`${m.nom} ${r.method} ${r.path}`);
      });
      m.monte(app, gardesOuvertes);
      await app.ready();
      await app.close();
    }
    expect(nues, `ces routes d’espace se montent sans aucune garde : ${nues.join(', ')}`).toEqual([]);
  });

  it('🔴 la classe d’accès déclarée correspond aux adresses réellement montées', async () => {
    const bouchon = (): unknown => new Proxy(function () {} as never, {
      get: (_c, p) => (typeof p === 'symbol' || p === 'then' ? undefined : bouchon()),
      apply: () => bouchon(),
    });
    const toutBouchonne = new Proxy({}, { get: (_c, p) => (typeof p === 'symbol' ? undefined : bouchon()) }) as never;

    for (const m of modulesDeRoutes(toutBouchonne, usage)) {
      const app = Fastify({ logger: false });
      const chemins: string[] = [];
      app.addHook('onRoute', (r) => { chemins.push(r.path); });
      m.monte(app, gardesOuvertes);
      await app.ready();
      const porteUnEspace = chemins.some((c) => c.includes(':tenantId'));
      if (m.acces === 'tenant') {
        expect(porteUnEspace, `${m.nom} se déclare « tenant » mais aucune de ses adresses ne porte :tenantId`).toBe(true);
      }
      if (porteUnEspace) {
        expect(['tenant', 'session-ops'], `${m.nom} porte :tenantId dans une adresse mais se déclare « ${m.acces} », donc hors du garde-fou`).toContain(m.acces);
      }
      await app.close();
    }
  });
});

/**
 * 🔴 L'ÉTAPE D'ESPACE : LE CONTRÔLE POSÉ AU MONTAGE (lot 3 de l'audit ponytail, 2026-09-26).
 *
 * `const tenant = scopeTenant(req); if (tenant === null) return reply.code(403)...` était recopié en première
 * ligne de 259 handlers, avec trois corps de refus différents. Le contrôle est désormais UNE étape
 * (`etapeEspace`), ajoutée par le poseur à la fin de la chaîne de chaque route `:tenantId`, et le handler lit
 * l'espace par un accesseur qui échoue fermé. Ces cas tiennent les trois pièces une par une ; les suivants
 * tiennent ce que le serveur construit en fait.
 */
describe('🔴 l’étape d’espace, l’accesseur et le poseur', () => {
  /** Une route `:tenantId` montée par le poseur, derrière une garde qui pose (ou non) une session. */
  async function monter(session?: { tenantId: string }) {
    const app = Fastify({ logger: false });
    const pose = async (req: FastifyRequest): Promise<void> => {
      if (session) (req as { auth?: unknown }).auth = { userId: 'u1', role: 'admin', ...session };
    };
    let atteint = false;
    monterAvecEtapeEspace(app, () => {
      app.get('/tenants/:tenantId/x', { preHandler: pose }, async (req) => {
        atteint = true;
        return { espace: espaceVerifie(req) };
      });
    });
    await app.ready();
    return { app, atteint: () => atteint };
  }

  it('sans session : 403 « tenant interdit », et le handler n’est jamais atteint', async () => {
    const m = await monter();
    const r = await m.app.inject({ method: 'GET', url: '/tenants/t1/x' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('{"error":"tenant interdit"}');
    expect(m.atteint()).toBe(false);
  });

  it('🔴 une session d’un AUTRE espace : le même refus, au caractère près', async () => {
    const m = await monter({ tenantId: 't1' });
    const r = await m.app.inject({ method: 'GET', url: '/tenants/t2/x' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('{"error":"tenant interdit"}');
    expect(m.atteint()).toBe(false);
  });

  it('le même espace : l’étape laisse passer, et le handler lit l’espace VÉRIFIÉ', async () => {
    const m = await monter({ tenantId: 't1' });
    const r = await m.app.inject({ method: 'GET', url: '/tenants/t1/x' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ espace: 't1' });
  });

  it('🔴 l’accesseur ÉCHOUE FERMÉ : sans étape, il lève au lieu de rendre un espace', () => {
    // Une requête qui porte pourtant une session et un espace CONCORDANTS : ce n'est pas à l'accesseur de
    // refaire le contrôle, et il ne doit surtout pas le « deviner ». Sans marque de l'étape, il lève.
    expect(() => espaceVerifie({ params: { tenantId: 't1' }, auth: { tenantId: 't1' } })).toThrow(/aucune étape/);
  });

  it('⚠️ une route montée HORS du poseur n’a pas l’étape, et son handler échoue fermé en 500', async () => {
    const app = Fastify({ logger: false });
    app.get('/tenants/:tenantId/x', async (req) => ({ espace: espaceVerifie(req) }));
    const r = await app.inject({ method: 'GET', url: '/tenants/t1/x' });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('t1');
  });

  it('🔴 le poseur ne touche que les routes :tenantId montées SOUS lui, et ne mute jamais une chaîne partagée', async () => {
    // `requireAdmin` est UN tableau distribué à tous les modules admin : un `push` y empilerait l'étape une
    // fois par route. La chaîne partagée doit ressortir intacte, et chaque route en recevoir une COPIE.
    const app = Fastify({ logger: false });
    const options = new Map<string, { preHandler?: unknown }>();
    app.addHook('onRoute', (r) => { options.set(`${String(r.method)} ${r.url}`, r); });
    const garde = async (): Promise<void> => {};
    const partagee = [garde];
    const h = async () => ({});
    monterAvecEtapeEspace(app, () => {
      app.get('/tenants/:tenantId/a', { preHandler: partagee }, h);
      app.post('/tenants/:tenantId/b', { preHandler: partagee }, h);
      app.get('/sans-espace', { preHandler: partagee }, h);
    });
    app.get('/tenants/:tenantId/hors-poseur', { preHandler: partagee }, h);
    await app.ready();
    expect(partagee).toEqual([garde]);
    expect(options.get('GET /tenants/:tenantId/a')?.preHandler).toEqual([garde, etapeEspace]);
    // La route HEAD qu'engendre un GET reçoit l'étape elle aussi, une seule fois.
    expect(options.get('HEAD /tenants/:tenantId/a')?.preHandler).toEqual([garde, etapeEspace]);
    expect(options.get('POST /tenants/:tenantId/b')?.preHandler).toEqual([garde, etapeEspace]);
    expect(options.get('GET /sans-espace')?.preHandler).toEqual([garde]);
    expect(options.get('GET /tenants/:tenantId/hors-poseur')?.preHandler).toEqual([garde]);
  });
});

/**
 * 🔴 LA PREUVE DYNAMIQUE D'ISOLATION, SUR LE SERVEUR CONSTRUIT (lot 3 de l'audit ponytail, 2026-09-26).
 *
 * Les cas ci-dessus prouvent que chaque pièce se comporte comme voulu. Ceux-ci prouvent qu'elle est POSÉE, et
 * au bon endroit, sur ce que `buildServer` monte réellement : le vrai registre, les vraies gardes, les vraies
 * routes. Chaque route `:tenantId` d'un module `tenant` est appelée avec une session d'ADMIN de l'espace A et
 * l'espace B dans l'adresse. Admin, pour que la garde de rôle ne masque pas l'étape.
 *
 * ⚠️ LE REFUS DOIT TOMBER AVANT TOUT TRAVAIL, et ça se MESURE : handler jamais atteint, zéro appel de
 * dépendance (les dépendances sont des bouchons qui comptent). Un statut 403 seul ne dirait pas si le handler
 * a lu les données de B avant de refuser.
 *
 * ⚠️ Vérifié dans les deux sens le jour du lot : branchement retiré de `entree`, la chaîne finale échoue
 * (étape absente) ET la preuve dynamique aussi (500 de l'accesseur au lieu du 403) ; filtre `acces ===
 * 'tenant'` retiré, les routes `session-ops` portent l'étape et la chaîne finale échoue.
 */
describe('🔴 sur le serveur construit : chaque route :tenantId refuse une session d’un autre espace', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  let s: ServeurSonde;
  beforeAll(async () => { s = await serveurSonde(); }, 60_000);
  afterAll(async () => { await s.app.close(); });

  const porteUnEspace = (r: RouteSondee): boolean => r.chemin.includes(':tenantId');
  /** Les routes sondées : `:tenantId` d'un module `tenant`, HEAD exclue (sa chaîne est tenue par le cas suivant). */
  const sondees = (): RouteSondee[] => s.routes.filter((r) => r.acces === 'tenant' && porteUnEspace(r) && r.methode !== 'HEAD');
  const appeler = (r: RouteSondee, espace: string, jeton: string) => s.app.inject({
    method: r.methode as 'GET',
    url: adresse(r.chemin, espace),
    headers: { authorization: `Bearer ${jeton}` },
    ...(r.methode === 'GET' || r.methode === 'DELETE' ? {} : { payload: {} }),
  });

  it('garde de la garde : plus de 300 routes sondées, et TOUS les modules tenant du registre en ont', () => {
    // Sans ce cas, un serveur monté à moitié (une dépendance oubliée, un module non monté) rendrait les
    // boucles ci-dessous vertes sur une liste courte, sans rien dire de ce qui manque.
    const usage = new GardeUsageMemoire(120, 0, () => Date.now(), 0);
    const toutPresent = new Proxy({}, { get: () => ({}) }) as never;
    const attendus = modulesDeRoutes(toutPresent, usage).filter((m) => m.acces === 'tenant').map((m) => m.nom);
    const couverts = new Set(sondees().map((r) => r.module));
    expect(sondees().length).toBeGreaterThan(300);
    expect(attendus.filter((n) => !couverts.has(n))).toEqual([]);
  });

  it('🔴 la chaîne FINALE : l’étape une fois, EN DERNIER, derrière au moins une garde ; nulle part ailleurs', () => {
    const enChaine = (ph: unknown): unknown[] => (ph === undefined ? [] : Array.isArray(ph) ? ph : [ph]);
    const fautes: string[] = [];
    for (const r of s.routes) {
      const chaine = enChaine(r.options.preHandler);
      const n = chaine.filter((f) => f === etapeEspace).length;
      const attendue = r.acces === 'tenant' && porteUnEspace(r);
      const juste = attendue ? n === 1 && chaine.at(-1) === etapeEspace && chaine.length >= 2 : n === 0;
      if (!juste) fautes.push(`${r.module} (${r.acces}) ${r.methode} ${r.chemin} : ${chaine.length} maillon(s), étape x${n}`);
    }
    expect(fautes, `chaînes fautives : ${fautes.join(' ; ')}`).toEqual([]);
    // Les deux populations que l'étape doit ÉVITER existent bien, sans quoi leur cas serait vide : l'exploitation
    // porte des `:tenantId` sans session, et un module tenant a des routes sans espace (`/m/:fichier`).
    expect(s.routes.some((r) => r.acces === 'session-ops' && porteUnEspace(r))).toBe(true);
    expect(s.routes.some((r) => r.acces === 'tenant' && !porteUnEspace(r))).toBe(true);
  });

  it('🔴 une session d’un AUTRE espace : 403 « tenant interdit », handler jamais atteint, zéro dépendance', async () => {
    const jeton = await s.jeton(A, 'admin');
    const fautes: string[] = [];
    for (const r of sondees()) {
      s.remettreAZero();
      const res = await appeler(r, B, jeton);
      const juste = res.statusCode === 403 && res.body === '{"error":"tenant interdit"}' && !s.atteint(r) && s.appelsDeps() === 0;
      if (!juste) fautes.push(`${r.methode} ${r.chemin} -> ${res.statusCode} ${res.body.slice(0, 60)} handler=${s.atteint(r)} deps=${s.appelsDeps()}`);
    }
    expect(fautes, `routes qui ne refusent pas l’espace étranger avant tout travail : ${fautes.join(' ; ')}`).toEqual([]);
  }, 60_000);

  it('le sens inverse : sur SON espace, l’étape laisse passer et le handler lit l’espace vérifié', async () => {
    // Une étape qui refuserait TOUT passerait le cas précédent sans rien prouver. Ici chaque handler doit être
    // atteint, et aucun ne doit trouver l'accesseur vide : ses 500 (dépendances bouchonnées) sont journalisés,
    // et aucune ligne ne doit citer `espaceVerifie`.
    const jeton = await s.jeton(A, 'admin');
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fautes: string[] = [];
      for (const r of sondees()) {
        s.remettreAZero();
        const res = await appeler(r, A, jeton);
        if (!s.atteint(r) || res.body.includes('tenant interdit')) fautes.push(`${r.methode} ${r.chemin} -> ${res.statusCode}`);
      }
      expect(fautes, `routes qui refusent leur propre espace : ${fautes.join(' ; ')}`).toEqual([]);
      const accesseurVide = journal.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('espaceVerifie'));
      expect(accesseurVide).toEqual([]);
    } finally {
      journal.mockRestore();
    }
  }, 60_000);
});
