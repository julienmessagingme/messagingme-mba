import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { scopeTenant } from '../src/http/scope';
import { buildServer, modulesDeRoutes } from '../src/server';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';

/**
 * LE CONTRÔLE D'ACCÈS TENANT, ET SON MODE DE PANNE (audit de surface publique du 2026-09-03).
 *
 * 🔴 `scopeTenant` est LE contrôle d'isolation entre clients de ce produit. La connexion passe par le pooler
 * en rôle superuser, donc la RLS de Postgres est contournée : le filtrage en code est le SEUL contrôle, et
 * cette fonction est l'endroit où il se décide, pour 235 routes.
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
   * ⚠️ `jeton-ops` porte AUSSI des `:tenantId` (`/ops/credits/:tenantId`), et c'est correct : l'exploitation
   * est délibérément CROSS-espace, autorisée par un secret d'environnement, et elle ne passe donc pas par
   * `scopeTenant`. C'est exactement la nuance qu'un booléen `porteDeTenant` aurait écrasée.
   */
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
      m.monte(app, {});
      await app.ready();
      const porteUnEspace = chemins.some((c) => c.includes(':tenantId'));
      if (m.acces === 'tenant') {
        expect(porteUnEspace, `${m.nom} se déclare « tenant » mais aucune de ses adresses ne porte :tenantId`).toBe(true);
      }
      if (porteUnEspace) {
        expect(['tenant', 'jeton-ops'], `${m.nom} porte :tenantId dans une adresse mais se déclare « ${m.acces} », donc hors du garde-fou`).toContain(m.acces);
      }
      await app.close();
    }
  });
});
