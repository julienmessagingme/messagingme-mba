import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeRequireApiKey } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';

/**
 * CE QU'UNE FAUSSE CLÉ COÛTE AVANT D'ÊTRE REFUSÉE.
 *
 * 🔴 L'ORDRE MESURÉ AVANT CE LOT : lire le bearer, tester le préfixe `mba_`, SHA-256, `findActiveByHash`
 * EN BASE, puis consommer le quota. Le limiteur étant indexé sur `found.id`, il n'était atteint qu'après
 * un lookup RÉUSSI : une rafale de `mba_x` n'était comptée par AUCUN plafond, et chacune coûtait un
 * SHA-256 et une requête Postgres. Le budget de connexions de ce process est de 8, partagé avec la console
 * et le worker : c'est là que l'amplification fait mal, pas dans le CPU.
 *
 * 🔴 LE CONTRÔLE DE FORMAT EST SÛR, ET ÇA SE VÉRIFIE PLUTÔT QUE ÇA NE SE SUPPOSE. On ne peut PAS mesurer
 * les clés en circulation (seul leur hash est stocké, c'est le but), donc la vérification a porté sur le
 * GÉNÉRATEUR : `git log` sur `api-key-store.pg.ts` ne montre qu'UNE seule version depuis la création du
 * fichier, `randomBytes(32).toString('base64url')`, soit exactement 43 caractères de l'alphabet
 * base64url. Toute clé jamais émise respecte donc le format exigé ici. Mesuré en base le 2026-09-14 :
 * 2 clés existent, 1 est active, elle a servi le jour même.
 */
class FauxStore implements ApiKeyLookup {
  appels = 0;
  touches: string[] = [];
  /** Révoquer en cours de route, comme un admin le ferait depuis la console. */
  revoquee = false;
  constructor(private valide: string | null = null) {}
  async findActiveByHash(hash: string) {
    this.appels += 1;
    if (!this.revoquee && this.valide && hash === sha256Hex(this.valide)) return { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] };
    return null;
  }
  async touchLastUsed(id: string) { this.touches.push(id); }
}

/** Une clé au FORMAT réel : `mba_` + 43 caractères base64url. */
const cleBienFormee = (graine: string): string => `mba_${graine.padEnd(43, 'x').slice(0, 43)}`;

function fausseReponse(): { reply: FastifyReply; code: () => number | null; entetes: Record<string, string> } {
  let statut: number | null = null;
  const entetes: Record<string, string> = {};
  const reply = {
    code(c: number) { statut = c; return this; },
    async send() { return this; },
    header(n: string, v: string) { entetes[n] = v; return this; },
  } as unknown as FastifyReply;
  return { reply, code: () => statut, entetes };
}

const requete = (bearer?: string): FastifyRequest =>
  ({ headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } } as FastifyRequest);

/** Monte le préhandler avec ses deux limiteurs, et rend de quoi observer les deux. */
function monter(valide: string | null, opts: { maxPreAuth?: number; maxMetier?: number; maxClesMetier?: number } = {}) {
  const store = new FauxStore(valide);
  const metier = new RateLimiter(opts.maxMetier ?? 100, 60_000, () => Date.now(), opts.maxClesMetier ?? 0);
  // ⚠️ AUCUN PLAFOND DE CLÉS ICI : la clé du budget spéculatif est FIXE, donc la table ne grossit pas.
  const preAuth = new RateLimiter(opts.maxPreAuth ?? 100, 60_000);
  return { store, metier, preAuth, garde: makeRequireApiKey(store, metier, preAuth) };
}

describe('le pré-filtre des clés d’API', () => {
  it('🔴 un bearer au bon préfixe mais au mauvais FORMAT ne touche pas la base', async () => {
    const { store, garde } = monter(null);
    const r = fausseReponse();
    await garde(requete('mba_x'), r.reply);
    expect(r.code()).toBe(401);
    // 🔴 LE CŒUR DU CAS : zéro requête Postgres. Sans ce compte, le test passerait aussi sur le code
    // d'avant, qui refusait bien... mais après être allé en base.
    expect(store.appels).toBe(0);
  });

  it('🔴 un bearer sans préfixe, vide ou absent ne touche pas la base non plus', async () => {
    const { store, garde } = monter(null);
    for (const bearer of [undefined, '', 'jwt_de_session', 'mba_', `mba_${'x'.repeat(200)}`, `mba_${'é'.repeat(43)}`]) {
      const r = fausseReponse();
      await garde(requete(bearer), r.reply);
      expect(r.code(), `bearer « ${String(bearer)} » aurait dû être refusé`).toBe(401);
    }
    expect(store.appels).toBe(0);
  });

  /**
   * 🔴 CE CAS A FAIT CHANGER LA CONCEPTION DU LOT, ET IL RESTE POUR ÇA. Le plan prévoyait un limiteur
   * « indexé sur l'empreinte SHA-256 du bearer ». Écrit, puis MESURÉ : trente fausses clés TOUTES
   * DIFFÉRENTES produisent trente compteurs à 1, dont aucun n'atteint son plafond, et les trente requêtes
   * Postgres partent quand même. Or une rafale de clés distinctes EST le scénario qu'on ferme. Le budget
   * est donc GLOBAL : il borne le nombre de lookups spéculatifs, pas les tentatives d'une empreinte.
   */
  it('🔴 une rafale de fausses clés TOUTES DIFFÉRENTES est freinée, et la base ne voit que le budget', async () => {
    // Le format seul ne suffit pas : rien n'empêche d'engendrer des chaînes bien formées.
    const { store, garde } = monter(null, { maxPreAuth: 5 });
    let refus429 = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = fausseReponse();
      await garde(requete(cleBienFormee(`fausse${i}`)), r.reply);
      if (r.code() === 429) refus429 += 1;
    }
    expect(refus429).toBeGreaterThan(0);
    expect(store.appels).toBeLessThanOrEqual(5);
  });

  it('🔴 rien de ce que retient le pré-filtre ne contient la valeur du bearer', async () => {
    /**
     * ⚠️ UNE TENTATIVE EST PRESQUE TOUJOURS UN SECRET VOISIN DU VRAI (un caractère de trop, une clé d'un
     * autre environnement). Ce que le limiteur retient vit en mémoire et se retrouve dans un dump de tas
     * ou un journal de diagnostic : le bearer n'a rien à y faire. C'est la règle de `/ops`, où le jeton
     * présenté n'est jamais journalisé.
     */
    const vues: string[] = [];
    const espion = new RateLimiter(100, 60_000);
    const vraiTake = espion.take.bind(espion);
    espion.take = (cle: string) => { vues.push(cle); return vraiTake(cle); };
    const store = new FauxStore(null);
    const garde = makeRequireApiKey(store, new RateLimiter(100, 60_000), espion);

    const bearer = cleBienFormee('secret_a_ne_pas_ecrire');
    await garde(requete(bearer), fausseReponse().reply);

    expect(vues).toHaveLength(1);
    expect(vues.join('|')).not.toContain('secret_a_ne_pas_ecrire');
  });

  it('🔴 API_KEY_PREFILTRE_MAX=0 le DÉSACTIVE vraiment : des clés distinctes passent toutes', async () => {
    // Le levier d'urgence documenté. Avant le correctif du limiteur, la PREMIÈRE empreinte passait et toutes
    // les suivantes prenaient un 429 : à 0, le préfiltre coupait l'API au lieu de la libérer.
    const { store, garde } = monter(null, { maxPreAuth: 0 });
    let refus429 = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = fausseReponse();
      await garde(requete(cleBienFormee(`distincte${i}`)), r.reply);
      if (r.code() === 429) refus429 += 1;
    }
    expect(refus429, 'à 0, le préfiltre ne doit refuser personne').toBe(0);
    expect(store.appels).toBe(10);
  });

  it('⚠️ le budget global ne fait pas grossir la mémoire : UNE entrée, quel que soit le flot', async () => {
    // Le corollaire heureux du budget global : sa clé est FIXE, donc la table du limiteur ne grossit pas
    // avec le nombre de bearers distincts. La borne en nombre de clés, indispensable quand la clé est
    // choisie par l'appelant, devient sans objet ici.
    const { garde, preAuth } = monter(null, { maxPreAuth: 1000 });
    for (let i = 0; i < 50; i += 1) await garde(requete(cleBienFormee(`variante${i}`)), fausseReponse().reply);
    expect(preAuth.remaining('lookups-speculatifs').remaining).toBe(950);
  });
});

describe('ce que le pré-filtre ne doit PAS casser', () => {
  const VRAIE = cleBienFormee('cle_valide_de_production');

  it('🔴 une clé valide passe, et le tenant vient d’elle', async () => {
    const { store, garde } = monter(VRAIE);
    const req = requete(VRAIE);
    const r = fausseReponse();
    await garde(req, r.reply);
    expect(r.code()).toBeNull();
    expect(req.auth).toMatchObject({ tenantId: 't1', role: 'api' });
    expect(store.appels).toBe(1);
  });

  /**
   * 🔴 UN TROU RELEVÉ EN REVUE, ET QU'AUCUN CAS NE COUVRAIT. L'exception des empreintes déjà résolues
   * est un laissez-passer : si elle survivait à la RÉVOCATION, le porteur d'une clé coupée échapperait au
   * budget spéculatif (il est « connu ») tout en échouant au lookup à chaque appel. Il pourrait donc
   * marteler Postgres sans qu'aucun plafond ne le compte, puisque le plafond métier n'est atteint
   * qu'après un lookup RÉUSSI. Un ancien client, ou une intégration qu'on vient de couper, rouvrait
   * exactement ce que ce lot ferme.
   */
  it('🔴 une clé RÉVOQUÉE perd son laissez-passer et repasse sous le budget', async () => {
    const { store, garde } = monter(VRAIE, { maxPreAuth: 2 });
    await garde(requete(VRAIE), fausseReponse().reply);
    store.revoquee = true;

    // Le premier appel après révocation consomme le budget (elle est encore « connue »), le suivant la
    // trouve oubliée, et le budget finit par la refuser AVANT la base.
    const avant = store.appels;
    let refus = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = fausseReponse();
      await garde(requete(VRAIE), r.reply);
      if (r.code() === 429) refus += 1;
    }
    expect(refus, 'une clé révoquée doit finir par être freinée avant la base').toBeGreaterThan(0);
    expect(store.appels - avant, 'elle ne doit plus pouvoir marteler le lookup').toBeLessThanOrEqual(3);
  });

  it('🔴 le plafond MÉTIER par clé reste actif EN PLUS du pré-filtre', async () => {
    // Les deux se complètent et ne se remplacent pas : le pré-filtre protège la BASE d'appels anonymes,
    // celui-ci borne le travail qu'une clé RÉSOLUE peut demander. Retirer l'un en gardant l'autre laisse
    // l'une des deux portes ouverte.
    const { garde } = monter(VRAIE, { maxMetier: 3, maxPreAuth: 1000 });
    let refus = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = fausseReponse();
      await garde(requete(VRAIE), r.reply);
      if (r.code() === 429) refus += 1;
    }
    expect(refus).toBe(3);
  });

  /**
   * 🔴 UNE CLÉ VALIDE AU-DELÀ DE SON PLAFOND NE COÛTE PLUS DE LECTURE EN BASE (contre-audit du 2026-09-14).
   * Le plafond par clé était compté sur l'identifiant de la clé RÉSOLUE, donc APRÈS le lookup : chaque 429
   * payait quand même une requête Postgres, sur un pool de 8 connexions partagé avec la console et le worker.
   * Il est désormais compté sur l'EMPREINTE, AVANT la base dès que la clé a été résolue une fois par ce
   * process ; son tout premier appel est compté après la lecture (cf. le cas des bearers inventés, plus bas).
   * Une clé et son empreinte sont en bijection, donc le quota d'un porteur ne change pas.
   */
  it('🔴 une clé valide qui dépasse son plafond est refusée AVANT la base', async () => {
    const { store, garde } = monter(VRAIE, { maxMetier: 3, maxPreAuth: 1000 });
    let refus = 0;
    for (let i = 0; i < 103; i += 1) {
      const r = fausseReponse();
      await garde(requete(VRAIE), r.reply);
      if (r.code() === 429) refus += 1;
    }
    expect(refus).toBe(100);
    expect(store.appels, 'chaque 429 payait une requête Postgres').toBe(3);
  });

  /**
   * 🔴 LE LEVIER D'URGENCE NE DOIT PAS PERMETTRE D'ÉVINCER UN VRAI CLIENT (2026-09-21, même défaut que sur
   * `/w/:code` et les rappels RCS). Le plafond par clé était pris AVANT la base, sur l'empreinte PRÉSENTÉE,
   * donc sur une valeur choisie par l'appelant, et sa table porte un plafond de clés. Tant que le pré-filtre
   * tourne, il borne le nombre d'empreintes inconnues qui l'atteignent ; à `API_KEY_PREFILTRE_MAX=0`, plus
   * rien. Des bearers inventés remplissaient alors la table, et un vrai client qui s'y présentait comme une clé
   * NEUVE recevait 429 : c'est son premier appel après un redémarrage, et c'est aussi tout client dont l'entrée
   * a expiré puis a été purgée, puisqu'il revient comme une clé neuve.
   *
   * ⚠️ LES CODES DES BEARERS INVENTÉS SE VÉRIFIENT APRÈS LA VRAIE CLÉ : vérifiés dans la boucle, le code fautif
   * échouerait sur le troisième bearer inventé (429 au lieu de 401), sans montrer le symptôme qui compte.
   */
  it('🔴 préfiltre coupé, des bearers inventés en masse n’évincent pas une vraie clé du plafond par clé', async () => {
    const { garde } = monter(VRAIE, { maxPreAuth: 0, maxClesMetier: 2 });
    const codes: Array<number | null> = [];
    for (let i = 0; i < 50; i += 1) {
      const r = fausseReponse();
      await garde(requete(cleBienFormee(`inventee${i}`)), r.reply);
      codes.push(r.code());
    }

    const r = fausseReponse();
    const req = requete(VRAIE);
    await garde(req, r.reply);
    expect(r.code(), 'la vraie clé du client').toBeNull();
    expect(req.auth?.tenantId).toBe('t1');
    // Refusés comme clés invalides, pas comme clés trop pressées : ils n'ont jamais compté dans la table.
    expect(codes.filter((c) => c !== 401), 'les bearers inventés').toEqual([]);
  });

  it('🔴 ce que retient le plafond par clé ne contient pas non plus la valeur du bearer', async () => {
    const vues: string[] = [];
    const espion = new RateLimiter(100, 60_000);
    const vraiTake = espion.take.bind(espion);
    espion.take = (cle: string) => { vues.push(cle); return vraiTake(cle); };
    const bearer = cleBienFormee('secret_de_production');
    const garde = makeRequireApiKey(new FauxStore(bearer), espion, new RateLimiter(100, 60_000));
    await garde(requete(bearer), fausseReponse().reply);
    expect(vues).toHaveLength(1);
    expect(vues.join('|')).not.toContain('secret_de_production');
  });

  it('🔴 la révocation reste IMMÉDIATE sous le plafond : le lookup a lieu à chaque appel accepté', async () => {
    const { store, garde } = monter(VRAIE, { maxMetier: 100, maxPreAuth: 1000 });
    await garde(requete(VRAIE), fausseReponse().reply);
    store.revoquee = true;
    const r = fausseReponse();
    await garde(requete(VRAIE), r.reply);
    expect(r.code()).toBe(401);
  });

  it('🔴 un porteur DÉJÀ RECONNU traverse une attaque qui a épuisé le budget', async () => {
    /**
     * 🔴 SANS CETTE EXCEPTION, L'ATTAQUANT OBTIENDRAIT DE NOUS LE DÉNI DE SERVICE QU'IL CHERCHE : un
     * budget global épuisé refuserait aussi les clients légitimes. Une empreinte déjà résolue n'y est
     * donc plus soumise.
     *
     * ⚠️ ELLE NE MET RIEN EN CACHE : le lookup a lieu à chaque appel (le faux store le compte), donc une
     * clé révoquée cesse de passer immédiatement. C'est la différence entre « ne sert pas à sonder » et
     * « est valide », et c'est toute la sécurité de ce raccourci.
     */
    const { store, garde } = monter(VRAIE, { maxPreAuth: 3 });
    await garde(requete(VRAIE), fausseReponse().reply);
    const apresPremier = store.appels;
    for (let i = 0; i < 20; i += 1) await garde(requete(cleBienFormee(`bruit${i}`)), fausseReponse().reply);

    const r = fausseReponse();
    const req = requete(VRAIE);
    await garde(req, r.reply);
    expect(r.code(), 'un client déjà reconnu doit passer malgré le budget épuisé').toBeNull();
    expect(req.auth?.tenantId).toBe('t1');
    expect(store.appels, 'la base est RE-interrogée : ce n’est pas un cache de validité').toBeGreaterThan(apresPremier);
  });
});

describe('ce que les en-têtes de plafond disent, et à qui', () => {
  const VRAIE = cleBienFormee('cle_valide_pour_les_entetes');

  /**
   * 🔴 LE BUDGET SPÉCULATIF EST PARTAGÉ PAR TOUS, IL NE S'ANNONCE À PERSONNE (2026-09-21). Ses en-têtes
   * partaient sur le 401 d'une fausse clé : mesuré en production, `x-ratelimit-limit: 30` et
   * `x-ratelimit-remaining: 29`. N'importe qui y lisait l'état d'un budget commun, donc le moment exact où
   * l'épuiser. Les plafonds se distinguent ici (7 contre 11) pour qu'un en-tête du budget ne puisse pas se
   * faire passer pour celui de la clé.
   */
  it('🔴 une fausse clé au bon format prend son 401 SANS en-tête de plafond', async () => {
    const { garde } = monter(VRAIE, { maxPreAuth: 7, maxMetier: 11 });
    const r = fausseReponse();
    await garde(requete(cleBienFormee('inventee_pour_les_entetes')), r.reply);
    expect(r.code()).toBe(401);
    expect(Object.keys(r.entetes).filter((k) => k.startsWith('x-ratelimit')), 'l’état du budget commun').toEqual([]);
  });

  it('🔴 le budget épuisé refuse en 429 avec Retry-After, et toujours sans rien annoncer', async () => {
    const { garde } = monter(VRAIE, { maxPreAuth: 1, maxMetier: 11 });
    await garde(requete(cleBienFormee('premiere_inventee')), fausseReponse().reply);
    const r = fausseReponse();
    await garde(requete(cleBienFormee('seconde_inventee')), r.reply);
    expect(r.code()).toBe(429);
    expect(Number(r.entetes['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Object.keys(r.entetes).filter((k) => k.startsWith('x-ratelimit'))).toEqual([]);
  });

  it('une vraie clé lit les en-têtes de SON plafond, au premier appel comme aux suivants', async () => {
    const { garde } = monter(VRAIE, { maxPreAuth: 7, maxMetier: 11 });
    for (const [rang, restant] of [[1, '10'], [2, '9']] as const) {
      const r = fausseReponse();
      await garde(requete(VRAIE), r.reply);
      expect(r.code(), `appel ${rang}`).toBeNull();
      expect(r.entetes['x-ratelimit-limit'], `appel ${rang} : le plafond de la clé, pas celui du budget`).toBe('11');
      expect(r.entetes['x-ratelimit-remaining'], `appel ${rang}`).toBe(restant);
    }
  });
});

describe('le plafond par clé est PAR clé', () => {
  /**
   * 🔴 CE CAS MANQUAIT, ET SANS LUI LA CLÉ DU LIMITEUR POUVAIT DEVENIR UNE CONSTANTE SANS QU'AUCUN TEST NE
   * TOMBE (relevé par la relecture finale du 2026-09-21). Deux clés réelles : la première au-delà de son
   * plafond ne doit rien retirer à la seconde. Un intégrateur trop pressé ne coupe pas l'API de ses voisins.
   */
  it('🔴 une clé au-delà de son plafond ne freine pas une autre clé', async () => {
    const A = cleBienFormee('cle_du_client_a');
    const B = cleBienFormee('cle_du_client_b');
    const store: ApiKeyLookup = {
      async findActiveByHash(hash: string) {
        if (hash === sha256Hex(A)) return { id: 'ka', tenantId: 'ta', scopes: ['contacts:write'] };
        if (hash === sha256Hex(B)) return { id: 'kb', tenantId: 'tb', scopes: ['contacts:write'] };
        return null;
      },
      async touchLastUsed() {},
    };
    const garde = makeRequireApiKey(store, new RateLimiter(2, 60_000), new RateLimiter(100, 60_000));
    const codesA: Array<number | null> = [];
    for (let i = 0; i < 4; i += 1) {
      const r = fausseReponse();
      await garde(requete(A), r.reply);
      codesA.push(r.code());
    }
    expect(codesA, 'la clé A épuise son propre plafond').toEqual([null, null, 429, 429]);
    const r = fausseReponse();
    const req = requete(B);
    await garde(req, r.reply);
    expect(r.code(), 'la clé B ne doit rien payer pour A').toBeNull();
    expect(req.auth?.tenantId).toBe('tb');
  });
});
