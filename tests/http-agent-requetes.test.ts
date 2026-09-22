import { describe, it, expect, beforeAll } from 'vitest';
import { AdresseInterdite } from '../src/lib/connexion-publique';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentRequetesRouteDeps } from '../src/http/agent-requetes';
import { LabelRequeteDejaPris, type RequeteConnecteur } from '../src/agent/requetes';

/**
 * Routes des REQUÊTES de connecteur (migration 0105).
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT. Décrire une requête, c'est décider ce qu'on ENVOIE au système d'un client et
 * ce qu'on a le droit d'en LIRE. Quatre gardes se vérifient ici et nulle part ailleurs : le gabarit est éprouvé
 * À L'ÉCRITURE (une variable non déclarée ne doit pas se découvrir en pleine conversation), un en-tête
 * `authorization` est refusé (l'authentification vit sur la source, chiffrée), et supprimer une requête que
 * des outils désignent est refusé.
 *
 * ⚠️ `outputPaths` N'EST PLUS EXIGÉ NON VIDE ICI depuis le 2026-09-15 : un appel à moitié écrit doit pouvoir
 * être mis de côté. Le refus vit au RATTACHEMENT à un agent (`tests/http-agent-tools.test.ts`).
 */
const SECRET = 'test-secret';
const RQ = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const REQUETE: RequeteConnecteur = {
  id: RQ, tenantId: 't1', sourceId: SRC, label: 'Chercher une commande',
  methode: 'GET', chemin: '/commandes/{ref}',
  parametres: [], entetes: [], corps: { mode: 'aucun' },
  variables: [{ nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true }],
  outputPaths: ['statut'], valeursTest: { ref: 'CMD-1' }, outils: 0,
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function app(
  over: Partial<RequeteConnecteur> = {},
  fetchImpl?: typeof fetch,
  champs = ['ville', 'points'],
  resolution?: (url: string) => Promise<{ ok: boolean; raison?: string }>,
  delaiTestMs?: number,
) {
  const cap = {
    creations: [] as Array<Record<string, unknown>>,
    patches: [] as Array<Record<string, unknown>>,
    suppressions: [] as string[],
  };
  const requete = { ...REQUETE, ...over };
  const deps: AgentRequetesRouteDeps = {
    lister: async () => [requete],
    parId: async (tenant, id) => (tenant === 't1' && id === RQ ? requete : null),
    creer: async (_t, input) => {
      cap.creations.push(input as unknown as Record<string, unknown>);
      if (input.label === 'deja') throw new LabelRequeteDejaPris(input.label);
      return { ...requete, ...input };
    },
    patch: async (_t, id, p) => { cap.patches.push(p); return id === RQ ? { ...requete, ...p } : null; },
    supprimer: async (_t, id) => { cap.suppressions.push(id); return id === RQ; },
    sourcePourTest: async () => ({ baseUrl: 'https://api.client.fr/v1', entetes: { authorization: 'Bearer SECRET-42' }, status: 'active' }),
    clesDeChamps: async () => champs,
    ...(fetchImpl ? { fetchImpl } : {}),
    // La garde de RÉSOLUTION est injectée comme `fetch` : sans elle, ces tests partiraient interroger le DNS
    // pour un domaine d'exemple. Elle a ses tests dédiés dans `tests/lib-adresse-privee.test.ts`, et son
    // effet sur CE bouton est éprouvé plus bas.
    verifierResolution: resolution ?? (async () => ({ ok: true })),
    ...(delaiTestMs === undefined ? {} : { delaiTestMs }),
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agentRequetes: deps }) };
}

const base = (tenant = 't1') => `/tenants/${tenant}/agent-requetes`;
const corps = (over: Record<string, unknown> = {}) => ({
  sourceId: SRC, label: 'Chercher une commande', methode: 'GET', chemin: '/commandes/{ref}',
  variables: [{ nom: 'ref', type: 'string', origine: { type: 'modele' } }],
  outputPaths: ['statut'], ...over,
});

describe('requêtes : déclarer', () => {
  it('crée une requête et la rend', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps() });
    expect(res.statusCode).toBe(201);
    expect(cap.creations[0]).toMatchObject({ label: 'Chercher une commande', methode: 'GET' });
  });

  it('🔴 une variable UTILISÉE mais non déclarée est refusée À L’ÉCRITURE', async () => {
    // C'est la faute la plus fréquente. Sans cette garde, elle ne se voit qu'à l'appel, où elle refuse la
    // requête au milieu d'une conversation avec un contact.
    const { srv } = app();
    for (const p of [
      corps({ corps: { mode: 'json', gabarit: '{"v": "{{ville}}"}' } }),
      corps({ parametres: [{ cle: 'q', valeur: '{{ville}}' }] }),
      corps({ chemin: '/commandes/{ref}/{ville}' }),
      // Les EN-TÊTES aussi (revue du 2026-09-23) : sans eux dans l'inventaire, seul le test unitaire le voyait.
      corps({ entetes: [{ nom: 'X-Ville', valeur: '{{ville}}' }] }),
    ]) {
      const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: p });
      expect(res.statusCode, JSON.stringify(p)).toBe(400);
      expect(res.json().error).toContain('ville');
    }
  });

  it('🔴 un en-tête « authorization » est refusé, en le NOMMANT', async () => {
    // Le laisser saisir en ferait le chemin le plus naturel pour s'authentifier, donc le plus utilisé, et le
    // secret serait stocké EN CLAIR dans la configuration de la requête.
    const { srv } = app();
    const res = await srv.inject({
      method: 'POST', url: base(), ...h(adminTok),
      payload: corps({ entetes: [{ nom: 'Authorization', valeur: 'Bearer x' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/authorization/i);
    expect(res.json().error).toMatch(/source/i); // et on dit OÙ la déclarer
  });

  it('🔴 une variable « champ » doit désigner un champ DÉCLARÉ dans l’espace', async () => {
    // Une faute de frappe sur une clé de champ ne se verrait sinon qu'à l'appel, où elle rendrait `null`.
    const { srv } = app();
    const res = await srv.inject({
      method: 'POST', url: base(), ...h(adminTok),
      payload: corps({ variables: [{ nom: 'v', type: 'string', origine: { type: 'champ', cle: 'vile' } }], chemin: '/x' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('vile');
  });

  it('un corps JSON illisible est refusé à la saisie', async () => {
    const { srv } = app();
    const res = await srv.inject({
      method: 'POST', url: base(), ...h(adminTok),
      payload: corps({ corps: { mode: 'json', gabarit: '{pas du json' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('JSON');
  });

  it('🔴 `outputPaths` VIDE est accepté : c’est un brouillon, et il devait pouvoir être mis de côté', async () => {
    /**
     * 🔴 CE TEST ATTENDAIT 400 JUSQU'AU 2026-09-15, ET LE CAS QU'IL EXERÇAIT EST CONSERVÉ : c'est le verdict
     * qui change, pas la situation. Exiger un champ de sortie ICI refermait le cycle que la route d'essai
     * existe pour ouvrir : ces champs se cochent dans la RÉPONSE d'un essai, donc un appel qu'on n'avait pas
     * encore réussi à faire marcher ne pouvait pas être enregistré, et quitter l'écran perdait tout. Julien,
     * le jour même : « je peux pas enregistrer pour commencer, quand je vais revenir je vais devoir repartir
     * de zéro ».
     *
     * ⚠️ LA GARANTIE N'A PAS DISPARU, ELLE A BOUGÉ D'UN CRAN, et son test aussi : le refus vit désormais au
     * RATTACHEMENT à un agent (409), dans `tests/http-agent-tools.test.ts`. Tant qu'un appel n'est rattaché
     * à personne, il n'envoie rien et ne lit rien.
     */
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ outputPaths: [] }) });
    expect(res.statusCode).toBe(201);
    expect(cap.creations[0]?.outputPaths).toEqual([]);
  });

  it('🔴 vider les champs d’un appel UTILISÉ est permis : ce n’est plus qu’un défaut', async () => {
    /**
     * 🔴 CE TEST ATTENDAIT UN REFUS (409) LE MATIN MÊME, ET LE CAS QU'IL EXERCE EST INCHANGÉ : vider les
     * champs d'un appel que deux agents utilisent. Seul le verdict change, parce que ces champs ont changé
     * de rôle avec la migration 0150.
     *
     * Le matin, ils gouvernaient l'exécution : les vider rendait les agents muets sur ce connecteur, d'où le
     * refus. L'après-midi, chaque outil porte SA propre liste, copiée au rattachement ; celle de l'appel
     * n'est plus qu'un DÉFAUT de pré-remplissage. La vider ne change donc rien à aucun agent en service,
     * seulement ce qui sera proposé au prochain rattachement.
     *
     * ⚠️ ET C'EST EXACTEMENT LA GARANTIE DEMANDÉE PAR JULIEN : « changer le défaut ne touche aucun agent en
     * service ». Une garde qui refuserait encore ici protégerait contre un effet qui n'existe plus, et ferait
     * croire au prochain lecteur que le défaut se propage.
     */
    const { cap, srv } = app({ outils: 2 });
    const res = await srv.inject({ method: 'PATCH', url: `${base()}/${RQ}`, ...h(adminTok), payload: { outputPaths: [] } });
    expect(res.statusCode).toBe(200);
    expect(cap.patches[0]).toMatchObject({ outputPaths: [] });
  });

  it('⚠️ et un appel que personne n’utilise se vide aussi : le compte d’outils n’entre plus en jeu', async () => {
    // Gardé pour que la disparition de la garde soit VISIBLE des deux côtés : si quelqu'un la remettait sur
    // l'usage, ce test-ci resterait vert et l'autre tomberait, ce qui dit exactement ce qui a bougé.
    const { srv } = app({ outils: 0 });
    const res = await srv.inject({ method: 'PATCH', url: `${base()}/${RQ}`, ...h(adminTok), payload: { outputPaths: [] } });
    expect(res.statusCode).toBe(200);
  });

  it('⚠️ mais `outputPaths` ABSENT reste refusé : omettre la clé est un défaut d’appelant, pas un brouillon', async () => {
    // Un brouillon DIT qu'il ne lit rien encore (`[]`). Une clé manquante ne dit rien du tout, et l'accepter
    // ferait passer pour un brouillon un appelant qui a simplement oublié le champ.
    const { srv } = app();
    const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: { ...corps(), outputPaths: undefined } });
    expect(res.statusCode).toBe(400);
  });

  it('une méthode inconnue et un chemin qui sort de la base sont refusés', async () => {
    const { srv } = app();
    const m = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ methode: 'CONNECT' }) });
    expect(m.statusCode).toBe(400);
    const c = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ chemin: 'https://evil.test/x' }) });
    expect(c.statusCode).toBe(400);
  });

  it('un libellé déjà pris rend 409, jamais 500', async () => {
    // Un 500 afficherait la page d'erreur de Cloudflare à la place du message (cf. CLAUDE.md).
    const { srv } = app();
    const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: corps({ label: 'deja' }) });
    expect(res.statusCode).toBe(409);
  });

  it('la liste rend aussi les champs de l’espace et le catalogue des origines', async () => {
    // L'écran ne recopie pas une liste qui vit côté serveur : deux listes finiraient par diverger, et celle
    // de l'écran proposerait une origine que le serveur refuse.
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: base(), ...h(adminTok) });
    expect(res.json().champs).toEqual(['ville', 'points']);
    expect(res.json().catalogue.systeme).toContain('derniere_saisie');
    expect(res.json().catalogue.entetesReserves).toContain('authorization');
  });
});

describe('requêtes : modifier et supprimer', () => {
  it('🔴 le patch est vérifié sur l’état EFFECTIF, pas sur le seul corps envoyé', async () => {
    // Changer le corps SANS renvoyer les variables passerait la garde si on ne regardait que le patch : la
    // variable manquante ne se découvrirait qu'à l'appel.
    const { srv } = app();
    const res = await srv.inject({
      method: 'PATCH', url: `${base()}/${RQ}`, ...h(adminTok),
      payload: { corps: { mode: 'json', gabarit: '{"v": "{{inconnue}}"}' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('inconnue');
  });

  it('🔴 un patch PARTIEL n’efface pas ce qu’il ne mentionne pas', async () => {
    // Ce test vient d'un défaut RÉEL, trouvé en écrivant le précédent. `.partial()` de zod ne retire pas les
    // `.default()` : sur un patch qui omet `variables`, la clé revenait avec `[]`, et la fusion écrasait
    // l'existant. Renommer une requête aurait effacé toutes ses variables, ses paramètres et son corps, en
    // silence, et l'écran n'aurait montré la perte qu'au rechargement suivant.
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'PATCH', url: `${base()}/${RQ}`, ...h(adminTok), payload: { label: 'Autre nom' } });
    expect(res.statusCode).toBe(200);
    // Le magasin ne doit recevoir QUE ce qui change : rien d'autre ne doit apparaître dans le patch.
    expect(Object.keys(cap.patches[0]!)).toEqual(['label']);
  });

  it('🔴 supprimer une requête que des outils désignent est refusé, avec le nombre', async () => {
    const { srv } = app({ outils: 3 });
    const res = await srv.inject({ method: 'DELETE', url: `${base()}/${RQ}`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('3');
  });

  it('sans outil, la suppression passe', async () => {
    const { cap, srv } = app({ outils: 0 });
    const res = await srv.inject({ method: 'DELETE', url: `${base()}/${RQ}`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(cap.suppressions).toEqual([RQ]);
  });
});

describe('🔴 requêtes : ESSAYER UN BROUILLON, le cycle qui rendait la création impossible', () => {
  const reponse = (body: string, status = 200) => (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  /** Ce que l'écran envoie : ce qui est À L'ÉCRAN. Ni nom, ni champs de sortie : ils n'existent pas encore. */
  const BROUILLON = {
    sourceId: SRC, methode: 'GET', chemin: '/commandes/{ref}',
    parametres: [], entetes: [], corps: { mode: 'aucun' },
    variables: [{ nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true }],
    valeursTest: { ref: 'CMD-1' },
  };

  it('🔴 un brouillon SANS nom ni champs de sortie s’éprouve, et c’est tout le sujet', async () => {
    // LE CYCLE ÉTAIT FERMÉ, et il rendait la création d'un appel IMPOSSIBLE : enregistrer EXIGE au moins un
    // champ de sortie, ces champs se cochent dans la réponse d'un essai, et l'essai exigeait un appel
    // ENREGISTRÉ. Trouvé par Julien le 2026-09-10 en essayant de déclarer son premier appel.
    const { srv } = app({}, reponse(JSON.stringify({ statut: 'ok', livraison: { date: '2026-09-02' } })));
    const res = await srv.inject({ method: 'POST', url: `${base()}/test`, ...h(adminTok), payload: BROUILLON });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    // Et il rend les chemins à cocher : c'est avec eux que l'enregistrement devient possible.
    expect(b.chemins).toEqual(['statut', 'livraison.date']);
    expect(b.envoye.url).toBe('https://api.client.fr/v1/commandes/CMD-1');
  });

  it('🔴 il éprouve CE QUI EST À L’ÉCRAN, pas ce qui est en base', async () => {
    // Second défaut du même bouton, plus discret : sur un appel déjà enregistré qu'on MODIFIE, l'ancienne
    // route éprouvait la version STOCKÉE. Le client changeait son chemin, cliquait Essayer, et obtenait la
    // réponse de l'ancien. Ici le chemin du brouillon diffère de celui de la requête en base.
    const { srv } = app({}, reponse('{"a":1}'));
    const res = await srv.inject({
      method: 'POST', url: `${base()}/test`, ...h(adminTok),
      payload: { ...BROUILLON, chemin: '/v2/commandes/{ref}' },
    });
    // ⚠️ `v1/v2` et non `v2` : le chemin reste TOUJOURS sous l'adresse de base de la source, c'est la garde
    // anti-SSRF du lot. Ce que ce test prouve, c'est que le chemin du BROUILLON a servi, pas celui en base.
    expect(res.json().envoye.url).toBe('https://api.client.fr/v1/v2/commandes/CMD-1');
  });

  it('⚠️ il valide COMME la création : une variable non déclarée est refusée AVANT tout appel', async () => {
    // Un essai qui accepterait ce que l'enregistrement refuse ferait mettre au point un appel impossible à
    // sauver, ce qui est une autre façon de rendre l'écran menteur.
    let appels = 0;
    const compte = (async () => { appels += 1; return new Response('{}'); }) as unknown as typeof fetch;
    const { srv } = app({}, compte);
    const res = await srv.inject({
      method: 'POST', url: `${base()}/test`, ...h(adminTok),
      payload: { ...BROUILLON, chemin: '/commandes/{inconnue}', variables: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/inconnue/);
    expect(appels).toBe(0);
  });

  it('⚠️ un en-tête réservé est refusé sur un brouillon comme sur une création', async () => {
    const { srv } = app({}, reponse('{}'));
    const res = await srv.inject({
      method: 'POST', url: `${base()}/test`, ...h(adminTok),
      payload: { ...BROUILLON, entetes: [{ nom: 'authorization', valeur: 'Bearer x' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/authentification|authorization/i);
  });

  it('🔴 la même garde d’adresse interne que sur la route enregistrée', async () => {
    // La nouvelle route appelle une URL que le client vient de saisir, depuis notre réseau : c'est le chemin
    // le plus facile à atteindre du produit. Une garde posée sur une route et pas sur sa jumelle serait
    // simplement contournable en n'enregistrant pas.
    let appels = 0;
    const compte = (async () => { appels += 1; return new Response('{}'); }) as unknown as typeof fetch;
    const { srv } = app({}, compte, ['ville', 'points'], async () => ({ ok: false, raison: 'adresse interne' }));
    const res = await srv.inject({ method: 'POST', url: `${base()}/test`, ...h(adminTok), payload: BROUILLON });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(appels).toBe(0);
  });

  it('🔴 un agent (non admin) ne peut pas éprouver un brouillon', async () => {
    // Cette route fait partir un appel réseau depuis notre infrastructure vers une adresse SAISIE dans la
    // requête : elle doit être aussi fermée que sa jumelle.
    const { srv } = app({}, reponse('{}'));
    const res = await srv.inject({ method: 'POST', url: `${base()}/test`, ...h(agentTok), payload: BROUILLON });
    expect(res.statusCode).toBe(403);
  });

  it('⚠️ sans jeton, elle refuse', async () => {
    const { srv } = app({}, reponse('{}'));
    const res = await srv.inject({ method: 'POST', url: `${base()}/test`, payload: BROUILLON, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('requêtes : le bouton Test', () => {
  const reponse = (body: string, status = 200) => (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('éprouve la requête et rend la réponse ENTIÈRE, plus les chemins à cocher', async () => {
    // ⚠️ La réponse entière, et non les seuls `outputPaths` : c'est le point du bouton. Le client doit voir ce
    // que son système répond POUR choisir ce que l'agent aura le droit d'en lire.
    const { srv } = app({}, reponse(JSON.stringify({ statut: 'ok', livraison: { date: '2026-09-02' }, lignes: [1, 2] })));
    const res = await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ok).toBe(true);
    expect(b.httpStatus).toBe(200);
    expect(b.apercu).toContain('livraison');
    // Un tableau est proposé ENTIER : l'extracteur ne descend pas dedans, donc `lignes.0` serait une case
    // cochable qui ne rendrait jamais rien.
    expect(b.chemins).toEqual(['statut', 'livraison.date', 'lignes']);
    expect(b.envoye.url).toBe('https://api.client.fr/v1/commandes/CMD-1');
  });

  /**
   * 🔴 LE REFUS À LA CONNEXION DIT LA MÊME CHOSE QUE LA VÉRIFICATION PRÉALABLE (2026-09-21). Le nom a résolu
   * public à la vérification, puis vers l'intérieur à la connexion : `fetchPublic` lève « fetch failed » avec
   * `AdresseInterdite` en cause. Le client lisait « appel impossible : fetch failed » et cherchait une panne
   * chez lui.
   */
  it('🔴 un refus d’adresse interne À LA CONNEXION rend le message de la vérification préalable', async () => {
    const refuse = (async () => { throw new TypeError('fetch failed', { cause: new AdresseInterdite() }); }) as unknown as typeof fetch;
    const { srv } = app({}, refuse);
    const res = await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, erreur: 'cette adresse n’est pas joignable depuis notre infrastructure' });
  });

  it('🔴 une redirection refusée se dit comme telle, avec la phrase du résolveur', async () => {
    const redirige = (async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); }) as unknown as typeof fetch;
    const { srv } = app({}, redirige);
    const res = await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(res.json()).toEqual({ ok: false, erreur: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur' });
  });

  it('🔴 un nom qui résout vers l’intérieur : le test REFUSE, et aucun appel ne part', async () => {
    // Ce bouton appelle une URL que le client vient de saisir, depuis notre réseau. C'est le chemin le plus
    // facile à atteindre du produit : il devait porter la même garde que le connecteur en conversation.
    let appels = 0;
    const compte = (async () => { appels += 1; return new Response('{}'); }) as unknown as typeof fetch;
    const { srv } = app({}, compte, ['ville', 'points'], async () => ({ ok: false, raison: 'adresse interne' }));
    const res = await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    // 200 avec `ok: false` et pas un 5xx : Cloudflare remplacerait le corps d'une 5xx et le client ne saurait
    // même pas ce qui a échoué (cf. CLAUDE.md).
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(appels).toBe(0);
    // Et le message ne décrit pas notre réseau.
    expect(JSON.stringify(res.json())).not.toMatch(/172\.|169\.254|docker|localhost/i);
  });

  it('🔴 les en-têtes PARTIS sont rendus, variables substituées, sans ceux de la source (revue du 2026-09-23)', async () => {
    // C'est ce qui rend l'essai réel du lot faisable : sans eux, rien ne montrait ce qu'une variable avait produit
    // dans un en-tête.
    const { srv } = app({
      entetes: [{ nom: 'X-Ref', valeur: 'ref-{{ref}}' }],
    }, reponse('{"a":1}'));
    const res = await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    const envoye = res.json().envoye;
    expect(envoye.entetes['x-ref']).toBe('ref-CMD-1');
    expect(envoye.entetes).not.toHaveProperty('authorization');
  });

  it('🔴 le secret de la source n’apparaît nulle part dans la réponse du test', async () => {
    // L'écran affiche `envoye` pour que le client voie ce que sa configuration produit. Les en-têtes
    // d'authentification n'en font pas partie, et cette assertion est ce qui l'empêche de changer.
    const { srv } = app({}, reponse('{"a":1}'));
    const res = await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(res.body).not.toContain('SECRET-42');
  });

  it('un 404 du système du client est une RÉPONSE à montrer, pas un échec de notre côté', async () => {
    // Marquer `ok: false` ferait chercher un problème chez nous alors que l'API a répondu correctement.
    const { srv } = app({}, reponse('{"erreur":"inconnu"}', 404));
    const b = (await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} })).json();
    expect(b.ok).toBe(true);
    expect(b.httpStatus).toBe(404);
  });

  it('les valeurs d’essai du corps de la requête priment sur celles enregistrées', async () => {
    const { srv } = app({}, reponse('{"a":1}'));
    const b = (await srv.inject({
      method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: { valeurs: { ref: 'CMD-9' } },
    })).json();
    expect(b.envoye.url).toContain('CMD-9');
  });

  it('un assemblage impossible rend 200 avec sa raison, jamais un 5xx', async () => {
    // Un 5xx verrait son corps remplacé par la page d'erreur de Cloudflare : le client ne saurait même pas ce
    // qui a échoué (cf. CLAUDE.md).
    const { srv } = app({ valeursTest: {} }, reponse('{}'));
    const b = (await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} })).json();
    expect(b.ok).toBe(false);
    expect(String(b.erreur)).toContain('ref');
  });

  /**
   * 🔴 LE PLAFOND DE TEMPS, ET POURQUOI CES TESTS ONT ÉTÉ RÉÉCRITS.
   *
   * Le premier jet de ces deux tests était mauvais, et le contre-contre-rapport du 2026-09-03 a eu raison de
   * le dire. Le premier n'assertait que « un signal est passé », ce qui passe aussi bien avec un plafond de
   * dix minutes qu'avec dix secondes : son titre promettait une valeur qu'il ne vérifiait pas. Le second
   * était pire : **il passait AUSSI sans la garde qu'il prétendait tenir** (vérifié par mutation), parce que
   * son faux flux échouait sans que l'échéance soit jamais atteinte. Deux tests verts qui ne prouvaient rien,
   * exactement ce que la règle du dépôt interdit.
   *
   * ⚠️ Ce qui rendait la chose facile à rater : les faux minuteurs de vitest **ne pilotent PAS**
   * `AbortSignal.timeout` (mesuré : onze secondes de faux temps, signal toujours pas abandonné). Le seul
   * moyen honnête d'éprouver la valeur est donc un délai RÉEL très court, injecté par `delaiTestMs`.
   */
  const lent = (ms: number, corpsLent = false) => (async () => {
    if (!corpsLent) { await new Promise((r) => setTimeout(r, ms)); return new Response('{"a":1}', { status: 200 }); }
    // En-têtes rendus TOUT DE SUITE, corps distillé : c'est le cas qui atteint l'échéance PENDANT la lecture,
    // et donc celui que la seconde garde existe pour attraper.
    return new Response(new ReadableStream<Uint8Array>({
      async start(c) { await new Promise((r) => setTimeout(r, ms)); c.enqueue(new Uint8Array([123, 125])); c.close(); },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  it('🔴 l’échéance passée au fetch porte bien la DURÉE configurée, pas seulement un signal', async () => {
    // Sans `signal`, ce n'était pas illimité mais borné au défaut d'undici, mesuré à 309 s : trente fois le
    // plafond du bouton voisin, sur une adresse que le client saisit lui-même. C'est ce qui distingue ce
    // chemin des clients Meta ou Zadarma, dont les hôtes sont fixes et de confiance.
    let vu: AbortSignal | undefined;
    const capte = (async (_u: string, init?: RequestInit) => {
      vu = init?.signal ?? undefined;
      await new Promise((r) => setTimeout(r, 60));
      return new Response('{"a":1}', { status: 200 });
    }) as unknown as typeof fetch;
    const { srv } = app({}, capte, undefined, undefined, 20);
    await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(vu, 'le fetch doit recevoir une échéance').toBeInstanceOf(AbortSignal);
    // Et elle doit avoir EXPIRÉ au bout des 20 ms configurés, pas rester ouverte : c'est la seule assertion
    // qui distingue un vrai plafond d'un `AbortSignal` décoratif.
    expect(vu?.aborted, 'l’échéance doit avoir expiré après la durée configurée').toBe(true);
  });

  it('l’échéance ne se déclenche PAS quand le système répond dans les temps', async () => {
    // Le témoin. Sans lui, le test précédent serait satisfait par un signal abandonné d'entrée de jeu.
    let vu: AbortSignal | undefined;
    const capte = (async (_u: string, init?: RequestInit) => {
      vu = init?.signal ?? undefined;
      return new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const { srv } = app({}, capte, undefined, undefined, 5_000);
    const b = (await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} })).json();
    expect(vu?.aborted).toBe(false);
    expect(b.ok).toBe(true);
  });

  it('🔴 une échéance atteinte PENDANT la lecture du corps ne rend pas un faux succès', async () => {
    // Le piège que le dépôt a déjà payé une fois : `lireCorpsBorne` avale l'abandon et rend un texte vide,
    // donc sans cette garde la route répondrait `ok: true`, `httpStatus: 200`, aperçu vide et aucun chemin.
    // Un succès au corps vide fait chercher longtemps du côté du système du client.
    const { srv } = app({}, lent(60, true), undefined, undefined, 20);
    const b = (await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} })).json();
    expect(b.ok, 'un corps lu au-delà de l’échéance n’est PAS un succès').toBe(false);
    expect(String(b.erreur)).toContain('temps');
    // Et jamais un 5xx : Cloudflare en remplacerait le corps par sa page d'erreur.
    expect(b.httpStatus).toBeUndefined();
  });

  it('🔴 un flux qui CASSE en plein corps, sans échéance atteinte, n’est pas un succès non plus', async () => {
    // Le cas que ma réécriture de la veille avait CESSÉ d'exercer, et qui vivait toujours dans le code : le
    // système du client coupe la connexion en plein corps. `lireCorpsBorne` rendait alors un texte vide,
    // indistinguable d'un corps vide, donc la route répondait `ok: true`, aperçu vide, aucun chemin. Un
    // succès au corps vide fait chercher longtemps du mauvais côté.
    const coupe = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([123])); c.error(new Error('connexion coupée')); },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const { srv } = app({}, coupe);
    const b = (await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} })).json();
    expect(b.ok).toBe(false);
    expect(String(b.erreur)).toContain('interrompue');
  });

  it('🔴 un corps qui dépasse le plafond est REFUSÉ, pas rendu vide', async () => {
    // La route lisait borné, puis ignorait le drapeau : elle annonçait un succès avec un aperçu vide, là où
    // ses deux routes sœurs refusent. Un plafond qu'on ne dit pas est un plafond qui ment.
    const enorme = (async () => new Response('x'.repeat(60_000), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const { srv } = app({}, enorme);
    const b = (await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} })).json();
    expect(b.ok).toBe(false);
    expect(String(b.erreur)).toContain('volumineuse');
  });

  it('🔴 un SERVEUR MCP ne se teste pas depuis ici : ce bouton enverrait son secret n importe ou', async () => {
    /**
     * 🔴 LE CINQUIEME CHEMIN DU MEME TROU, trouve par la troisieme relecture a froid du 2026-09-17. Cette
     * route prend `sourceId` DIRECTEMENT dans le corps, et `sourcePourTest` ne filtrait pas le `kind` :
     * un administrateur y passait l identifiant d un SERVEUR MCP (que `GET /tenants/:t/mcp` lui donne) et
     * faisait partir une requete HTTP de SA composition (methode, chemin, corps) sur le point MCP de son
     * client, AVEC LE SECRET DECHIFFRE dans l en-tete, puis recevait 20 ko de reponse.
     *
     * ⚠️ LE FAUX REND `null`, COMME LE VRAI : le filtre vit dans le cablage (`src/index.ts`), qui rend
     * `null` pour une source qui n est pas `http`. Ce test eprouve donc ce que la ROUTE fait de ce
     * `null`, et `tests/sources-kind.test.ts` tient le filtre lui-meme, sur les cinq lecteurs.
     */
    const srvMcp = buildServer({
      queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
      agentRequetes: {
        lister: async () => [REQUETE], parId: async () => REQUETE,
        creer: async () => REQUETE, patch: async () => REQUETE, supprimer: async () => true,
        clesDeChamps: async () => [],
        sourcePourTest: async () => null,
      },
    });
    const res = await srvMcp.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().erreur ?? res.json().error)).toContain('source');
  });

  it('une source DÉSACTIVÉE ne se teste pas : elle a été coupée exprès', async () => {
    const deps = { sourcePourTest: async () => ({ baseUrl: 'https://api.client.fr/v1', entetes: {}, status: 'disabled' }) };
    const { srv } = app();
    // On rejoue le harnais avec une source désactivée.
    const srv2 = buildServer({
      queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
      agentRequetes: {
        lister: async () => [REQUETE], parId: async () => REQUETE,
        creer: async () => REQUETE, patch: async () => REQUETE, supprimer: async () => true,
        clesDeChamps: async () => [], ...deps,
      },
    });
    void srv;
    const res = await srv2.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(409);
  });
});

describe('requêtes : qui a le droit', () => {
  it('un agent (non admin) ne peut ni lire ni écrire', async () => {
    const { srv } = app();
    for (const r of [
      await srv.inject({ method: 'GET', url: base(), ...h(agentTok) }),
      await srv.inject({ method: 'POST', url: base(), ...h(agentTok), payload: corps() }),
      await srv.inject({ method: 'POST', url: `${base()}/${RQ}/test`, ...h(agentTok), payload: {} }),
    ]) expect(r.statusCode).toBe(403);
  });

  it('🔴 un admin d’un AUTRE espace est refusé : le scope tenant est le seul contrôle', async () => {
    // Le pooler est superuser, la RLS est bypassée : sans ce filtre, on décrirait un appel vers le système
    // d'un autre client.
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: base('t2'), ...h(adminTok) });
    expect(res.statusCode).toBe(403);
  });
});
