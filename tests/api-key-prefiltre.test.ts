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
  constructor(private readonly valide: string | null = null) {}
  async findActiveByHash(hash: string) {
    this.appels += 1;
    if (this.valide && hash === sha256Hex(this.valide)) return { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] };
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
function monter(valide: string | null, opts: { maxPreAuth?: number; maxMetier?: number } = {}) {
  const store = new FauxStore(valide);
  const metier = new RateLimiter(opts.maxMetier ?? 100, 60_000);
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
