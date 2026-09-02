import { describe, it, expect, beforeAll } from 'vitest';
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
 * `authorization` est refusé (l'authentification vit sur la source, chiffrée), `outputPaths` est obligatoire,
 * et supprimer une requête que des outils désignent est refusé.
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

function app(over: Partial<RequeteConnecteur> = {}, fetchImpl?: typeof fetch, champs = ['ville', 'points']) {
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

  it('🔴 sans `outputPaths`, la requête est refusée : le filtre de sortie n’est pas facultatif', async () => {
    const { srv } = app();
    for (const p of [corps({ outputPaths: [] }), { ...corps(), outputPaths: undefined }]) {
      const res = await srv.inject({ method: 'POST', url: base(), ...h(adminTok), payload: p });
      expect(res.statusCode).toBe(400);
    }
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
