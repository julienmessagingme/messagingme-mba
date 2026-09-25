import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentToolsRouteDeps } from '../src/http/agent-tools';
import type { OutilComplet, PatchOutil } from '../src/agent/catalog';
import { NomOutilDejaPris } from '../src/agent/catalog';
import type { SortieAgent } from '../src/agent/agent-store';
import type { RequeteConnecteur } from '../src/agent/requetes';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE } from './gestes';

/**
 * Routes des outils d'un agent IA.
 *
 * Un outil ACTIF est exposé au modèle et exécutable par lui, donc par un texte qu'un contact influence.
 * Ce que ces routes verrouillent :
 *  1. le `handler` vient du CATALOGUE, jamais du corps : un handler inventé ferait un outil actif qui refuse
 *     à chaque appel, donc un agent qui « ne fait rien » sans trace lisible ;
 *  2. l'activation et l'autonomie portent le nom pris sur le JETON, jamais une valeur du corps ;
 *  3. le risque n'est pas modifiable : le client règle l'autonomie, pas la dangerosité ;
 *  4. l'isolation tenant, sur les six verbes.
 */
const SECRET = 'test-secret';
const AG = '11111111-1111-4111-8111-111111111111';
const OUT = '22222222-2222-4222-8222-222222222222';
const AUTRE = '33333333-3333-4333-8333-333333333333';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SRC = '44444444-4444-4444-8444-444444444444';
const RQ = '55555555-5555-4555-8555-555555555555';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: USER, tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const OUTIL: OutilComplet = { ...SANS_MCP, ...AUCUN_GESTE(),
  id: OUT, tenantId: 't1', origin: 'mba', name: 'mba_terminer',
  title: 'Terminer', description: 'Termine la conversation.', nePasUtiliser: 'Pas pour escalader.',
  params: [{ name: 'sortie', type: 'string', source: 'modele', required: true }],
  binding: { handler: 'terminer' }, sourceId: null, requestId: null, nature: 'integre' as const, outputPaths: [], risk: 'read',
  timeoutMs: 8000, maxBytes: 16384, autonome: false, actif: false, activeLe: null, autonomeLe: null,
};

const SORTIES: SortieAgent[] = [{ code: 'besoin_cerne', label: 'Besoin cerné' }];

/**
 * La REQUETE que l'outil designe (migration 0105). Ses variables couvrent les TROIS familles d origine, parce
 * que c est justement ce que la route doit trier : seule celle du modele est exposee au modele, et les trois
 * apparaissent dans le resume a confirmer.
 */
const REQUETE: RequeteConnecteur = {
  id: RQ, tenantId: 't1', sourceId: SRC, label: 'Lire une commande',
  methode: 'GET', chemin: '/commandes/{ref}',
  parametres: [], entetes: [], corps: { mode: 'aucun' },
  variables: [
    { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
    { nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } },
    { nom: 'dit', type: 'string', origine: { type: 'systeme', cle: 'derniere_saisie' } },
  ],
  outputPaths: ['statut'], valeursTest: {}, outils: 0, updatedAt: '2026-09-02T00:00:00.000Z',
};

function app(sorties: SortieAgent[] | null = SORTIES, liste: OutilComplet[] = [OUTIL], requeteOver: Partial<RequeteConnecteur> = {}) {
  const cap = {
    ajouts: [] as Array<{ tenant: string; agentId: string; outil: Record<string, unknown> }>,
    patches: [] as Array<{ tenant: string; agentId: string; id: string; patch: PatchOutil }>,
    activations: [] as Array<{ tenant: string; id: string; actif: boolean; par: string }>,
    autonomies: [] as Array<{ tenant: string; id: string; autonome: boolean; par: string }>,
    retraits: [] as Array<{ tenant: string; id: string }>,
    rattachements: [] as Array<{ tenant: string; id: string }>,
    connecteurs: [] as Array<{ tenant: string; agentId: string; outil: Record<string, unknown> }>,
  };
  const deps: AgentToolsRouteDeps = {
    // `binding.handler` compte : c'est par lui que la route retrouve le modèle de catalogue de l'outil,
    // donc les paramètres sur lesquels une liste de valeurs a le droit d'exister.
    listToutes: async () => liste,
    ajouter: async (tenant, agentId, outil) => {
      cap.ajouts.push({ tenant, agentId, outil: outil as unknown as Record<string, unknown> });
      if (outil.name === 'deja_pris') throw new NomOutilDejaPris();
      return agentId === AG ? { ...OUTIL, ...outil, params: outil.params } : null;
    },
    patch: async (tenant, agentId, id, patch) => {
      cap.patches.push({ tenant, agentId, id, patch });
      if (patch.name === 'deja_pris') throw new NomOutilDejaPris();
      return id === OUT ? { ...OUTIL, ...patch } : null;
    },
    activer: async (tenant, _a, id, actif, par) => {
      cap.activations.push({ tenant, id, actif, par });
      return id === OUT ? { ...OUTIL, actif, activeLe: actif ? '2026-08-28T10:00:00.000Z' : null } : null;
    },
    autonomie: async (tenant, _a, id, autonome, par) => {
      cap.autonomies.push({ tenant, id, autonome, par });
      return id === OUT ? { ...OUTIL, autonome } : null;
    },
    // 🔴 DÉTACHE, ne supprime plus : depuis la migration 0127 la définition appartient à l'ESPACE, et la
    // supprimer depuis l'écran d'un seul agent rendrait muets ceux qu'on ne regardait pas.
    detacher: async (tenant, _a, id) => { cap.retraits.push({ tenant, id }); return id === OUT; },
    rattacher: async (tenant, _a, id) => { cap.rattachements.push({ tenant, id }); return id === OUT; },
    ajouterConnecteur: async (tenant, agentId, outil) => {
      cap.connecteurs.push({ tenant, agentId, outil: outil as unknown as Record<string, unknown> });
      if (outil.name === 'deja_pris') throw new NomOutilDejaPris();
      // ⚠️ `[...outil.outputPaths]` : le contrat expose une liste EN LECTURE SEULE (on ne veut pas qu un
      // magasin modifie la liste de son appelant), et l outil rendu en porte une mutable. Le faux doit donc
      // la RECOPIER, comme le vrai magasin le fait en base.
      return agentId === AG ? { ...OUTIL, ...outil, outputPaths: [...outil.outputPaths], origin: 'http', sourceId: outil.sourceId } : null;
    },
    requetePourOutil: async (tenant, id) => (tenant === 't1' && id === RQ ? { ...REQUETE, ...requeteOver } : null),
    sortiesDeLAgent: async (_t, agentId) => (agentId === AG ? sorties : null),
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agentTools: deps }) };
}

const base = (tenant: string, agentId = AG) => `/tenants/${tenant}/agents/${agentId}/tools`;

describe('outils d’un agent : lecture et ajout', () => {
  it('liste les outils, le catalogue, et CE QUE LE MODÈLE VOIT', () => {
    // Le client règle des mots qui pilotent un appel de fonction. Lui montrer le schéma réel est le seul
    // moyen honnête de lui faire vérifier ce qu'il a écrit.
    return app().srv.inject({ method: 'GET', url: base('t1'), ...h(adminTok) }).then((res) => {
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.outils[0].expose.parameters.properties.sortie.enum).toEqual(['besoin_cerne']);
      expect(body.catalogue.map((c: { handler: string }) => c.handler)).toContain('envoyer_bloc');
    });
  });

  it('🔴 l’énumération de « terminer » vient de la FICHE, pas de la colonne', async () => {
    // Sans règle d'arrêt sur la fiche, le modèle ne doit RIEN voir de cet outil : offert sans énumération, il
    // accepterait n'importe quelle chaîne, et la conversation remonterait en inbox sur un handle inexistant.
    const res = await app([]).srv.inject({ method: 'GET', url: base('t1'), ...h(adminTok) });
    expect(res.json().outils[0].expose).toBeNull();
  });

  it('🔴 un handler inventé est REFUSÉ, et rien n’est écrit', async () => {
    const { cap, srv } = app();
    for (const handler of ['rm_rf', 'constructor', 'toString', '']) {
      const res = await srv.inject({ method: 'POST', url: base('t1'), ...h(adminTok), payload: { handler } });
      expect(res.statusCode, handler).toBe(400);
    }
    expect(cap.ajouts).toHaveLength(0);
  });

  it('🔴 le titre, les mots, les paramètres et le RISQUE viennent du catalogue, jamais du corps', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({
      method: 'POST', url: base('t1'), ...h(adminTok),
      // Un corps qui essaie de se donner un risque anodin et des paramètres à lui.
      payload: { handler: 'envoyer_bloc', risk: 'read', params: [{ name: 'x', type: 'string', source: 'modele' }], title: 'Inoffensif' },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.ajouts[0]!.outil.risk).toBe('irreversible');
    expect(cap.ajouts[0]!.outil.title).not.toBe('Inoffensif');
    expect(cap.ajouts[0]!.outil.params).toEqual([
      { name: 'code', type: 'string', source: 'modele', required: true, description: 'Le code du bloc à envoyer.' },
    ]);
  });

  it('accepte un nom exposé choisi par le client, et refuse un nom hors alphabet', async () => {
    const { cap, srv } = app();
    const ok = await srv.inject({ method: 'POST', url: base('t1'), ...h(adminTok), payload: { handler: 'poser_tag', name: 'tague_le' } });
    expect(ok.statusCode).toBe(201);
    expect(cap.ajouts[0]!.outil.name).toBe('tague_le');
    for (const name of ['Majuscule', 'avec-tiret', 'avec espace', 'a'.repeat(65)]) {
      const res = await srv.inject({ method: 'POST', url: base('t1'), ...h(adminTok), payload: { handler: 'poser_tag', name } });
      expect(res.statusCode, name).toBe(400);
    }
  });

  it('un nom déjà pris rend 409, pas 500', async () => {
    // 500 signifierait une page Cloudflare à la place du message, sur un geste aussi banal qu'ajouter deux
    // fois le même outil.
    const res = await app().srv.inject({ method: 'POST', url: base('t1'), ...h(adminTok), payload: { handler: 'poser_tag', name: 'deja_pris' } });
    expect(res.statusCode).toBe(409);
  });

  it('un agent d’un autre tenant rend 404', async () => {
    const res = await app().srv.inject({ method: 'GET', url: base('t1', AUTRE), ...h(adminTok) });
    expect(res.statusCode).toBe(404);
  });
});

describe('outils d’un agent : activation et autonomie', () => {
  it('🔴 activer écrit l’utilisateur du JETON, jamais une valeur du corps', async () => {
    // La spec MCP exige un consentement humain avant l'invocation d'un outil ; notre agent n'en a pas au
    // runtime, le consentement est donc déplacé vers la configuration. Lire l'identité dans le corps ferait
    // désigner à l'appelant qui a consenti à sa place.
    const { cap, srv } = app();
    const res = await srv.inject({
      method: 'PUT', url: `${base('t1')}/${OUT}/activation`, ...h(adminTok),
      payload: { valeur: true, activePar: 'quelqu-un-d-autre', userId: 'bbbb' },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.activations[0]).toEqual({ tenant: 't1', id: OUT, actif: true, par: USER });
    expect(res.json().outil.actif).toBe(true);
  });

  it('désactiver ne demande pas d’identité, et rend l’outil inactif', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'PUT', url: `${base('t1')}/${OUT}/activation`, ...h(adminTok), payload: { valeur: false } });
    expect(res.statusCode).toBe(200);
    expect(cap.activations[0]!.actif).toBe(false);
    expect(res.json().outil.activeLe).toBeNull();
  });

  it('l’autonomie se pose et se retire, et porte elle aussi le nom du jeton', async () => {
    const { cap, srv } = app();
    await srv.inject({ method: 'PUT', url: `${base('t1')}/${OUT}/autonomie`, ...h(adminTok), payload: { valeur: true } });
    expect(cap.autonomies[0]).toEqual({ tenant: 't1', id: OUT, autonome: true, par: USER });
  });

  it('🔴 l autonomie non plus ne lit pas l identité dans le corps', async () => {
    // Les deux routes partagent la même mécanique, mais c'est la garde la plus importante du lot : elle
    // mérite d'être ancrée sur les DEUX chemins, pas seulement sur celui qu'on a écrit en premier.
    const { cap, srv } = app();
    await srv.inject({
      method: 'PUT', url: `${base('t1')}/${OUT}/autonomie`, ...h(adminTok),
      payload: { valeur: true, autonomePar: 'quelqu-un-d-autre', userId: 'bbbb' },
    });
    expect(cap.autonomies[0]!.par).toBe(USER);
  });

  it('un corps sans booléen est refusé en 400', async () => {
    const { cap, srv } = app();
    for (const payload of [{}, { valeur: 'oui' }, { valeur: 1 }]) {
      const res = await srv.inject({ method: 'PUT', url: `${base('t1')}/${OUT}/activation`, ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(cap.activations).toHaveLength(0);
  });
});

describe('outils d’un agent : correction, retrait, isolation', () => {
  it('corrige les mots et les valeurs autorisées', async () => {
    const { cap, srv } = app(SORTIES, [{ ...OUTIL, binding: { handler: 'poser_tag' } }]);
    const res = await srv.inject({
      method: 'PATCH', url: `${base('t1')}/${OUT}`, ...h(adminTok),
      payload: { description: 'Appelle-moi quand c’est fini.', enums: { tag: ['vip', 'relance'] } },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.patches[0]!.patch.enums).toEqual({ tag: ['vip', 'relance'] });
  });

  it('🔴 une énumération sur un paramètre que le catalogue n ouvre PAS est refusée', async () => {
    // `poser_tag` n'ouvre que `tag`. Poser une liste sur un autre paramètre rendrait l'outil inappelable sur
    // des valeurs légitimes, et le client n'aurait aucun écran pour le défaire.
    const { cap, srv } = app(SORTIES, [{ ...OUTIL, binding: { handler: 'poser_tag' } }]);
    const res = await srv.inject({
      method: 'PATCH', url: `${base('t1')}/${OUT}`, ...h(adminTok),
      payload: { enums: { requete: ['a'], tag: ['vip'] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('requete');
    expect(cap.patches).toHaveLength(0);
  });

  it('un patch vide, ou un champ hors bornes, rend 400', async () => {
    const { srv } = app();
    for (const payload of [{}, { title: '' }, { name: 'Majuscule' }, { enums: { tag: [''] } }]) {
      const res = await srv.inject({ method: 'PATCH', url: `${base('t1')}/${OUT}`, ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('retire un outil, et rend 404 sur un outil d’ailleurs', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'DELETE', url: `${base('t1')}/${OUT}`, ...h(adminTok) })).statusCode).toBe(204);
    expect((await srv.inject({ method: 'DELETE', url: `${base('t1')}/${AUTRE}`, ...h(adminTok) })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'DELETE', url: `${base('t1')}/pas-un-uuid`, ...h(adminTok) })).statusCode).toBe(404);
  });

  it('🔴 le tenant de l’URL ne peut pas dépasser celui du jeton, et rien n’est tenté en aval', async () => {
    const { cap, srv } = app();
    for (const [method, url, payload] of [
      ['GET', base('t2'), undefined],
      ['POST', base('t2'), { handler: 'poser_tag' }],
      ['PATCH', `${base('t2')}/${OUT}`, { title: 'X' }],
      ['PUT', `${base('t2')}/${OUT}/activation`, { valeur: true }],
      ['PUT', `${base('t2')}/${OUT}/autonomie`, { valeur: true }],
      ['DELETE', `${base('t2')}/${OUT}`, undefined],
    ] as const) {
      const res = await srv.inject({ method, url, ...h(adminTok), ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(cap.ajouts).toHaveLength(0);
    expect(cap.patches).toHaveLength(0);
    expect(cap.activations).toHaveLength(0);
    expect(cap.autonomies).toHaveLength(0);
    expect(cap.retraits).toHaveLength(0);
  });

  it('les écritures sont réservées aux administrateurs', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: base('t1'), ...h(agentTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'PUT', url: `${base('t1')}/${OUT}/activation`, ...h(agentTok), payload: { valeur: true } })).statusCode).toBe(403);
  });
});

/**
 * Brancher une REQUÊTE de la bibliothèque sur un agent (migration 0105).
 *
 * 🔴 L'APPEL N'EST PLUS DÉCRIT ICI, et c'est tout le changement : la méthode, le chemin, le corps, les
 * variables et les champs à lire vivent sur la requête, mise au point une fois dans Tools. Ce qui se garde
 * encore ici, et nulle part ailleurs : la requête appartient au tenant, le risque dérive de SA méthode et ne
 * peut être que MONTÉ, ce que le modèle voit est DÉRIVÉ de ses variables, et l'écran reçoit de quoi faire
 * confirmer ce qui partira.
 */
describe('outils d’un agent : brancher une requête de connecteur', () => {
  const corps = (over: Record<string, unknown> = {}) => ({
    requeteId: RQ, name: 'lire_commande', title: 'Lire une commande',
    description: 'Donne le statut d’une commande.', nePasUtiliser: 'Jamais pour annuler.',
    // ⚠️ OBLIGATOIRES depuis la migration 0150 : l'écran POSE la question plutôt que de la deviner, donc
    // le serveur l'exige. Un défaut côté serveur aurait vidé la question de son sens.
    nature: 'integre', outputPaths: ['statut'],
    ...over,
  });

  it('déclare l’outil INACTIF, en DÉSIGNANT la requête plutôt qu’en la recopiant', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok), payload: corps() });
    expect(res.statusCode).toBe(201);
    expect(cap.connecteurs[0]!.outil).toMatchObject({ sourceId: SRC, requestId: RQ, risk: 'read' });
    // L'activation reste un geste humain séparé : la migration 0086 refuse un actif sans activateur.
    expect(res.json().outil.actif).toBe(false);
  });

  it('🔴 ce que le MODÈLE voit est DÉRIVÉ des variables de la requête, et seulement celles du modèle', async () => {
    // Exposer une variable résolue par le serveur (champ du contact, valeur système) inviterait le modèle à
    // la fournir lui-même, donc à désigner la ressource de quelqu’un d’autre. C’est la garde anti-IDOR.
    const { cap, srv } = app();
    await srv.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok), payload: corps() });
    expect(cap.connecteurs[0]!.outil.params).toEqual([
      { name: 'ref', type: 'string', source: 'modele', required: true },
    ]);
  });

  it('🔴 la réponse porte CE QUI PARTIRA, pour que l’écran le fasse confirmer', async () => {
    // Julien : « il faut bien faire confirmer au client, on envoie telle et telle valeur ». C’est le seul
    // moment où il peut s’apercevoir qu’un connecteur enverra le dernier message de ses contacts à un tiers.
    const { srv } = app();
    const res = await srv.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok), payload: corps() });
    expect(res.json().envoi).toEqual([
      { nom: 'ref', libelle: 'décidée par l’agent' },
      { nom: 'ville', libelle: 'champ « ville » du contact' },
      { nom: 'dit', libelle: 'dernier message du contact' },
    ]);
  });

  it('🔴 un appel SANS champ de sortie se donne quand même, en « pousse » : c’était le cas impossible', async () => {
    /**
     * 🔴 CE TEST ATTENDAIT UN REFUS (409) JUSQU'À LA MIGRATION 0150, ET LE CAS EXERCÉ EST CONSERVÉ : un
     * appel dont la requête ne déclare aucun champ, donné à un agent. Seul le verdict change, parce que la
     * QUESTION a changé. Le refus disait « cet appel n'est pas terminé » ; c'était vrai tant qu'on supposait
     * que tout appel rend quelque chose. Un `POST /subscriber/add-tag` ne rend rien d'utile et n'est pas
     * inachevé pour autant : il POUSSE. C'est exactement ce sur quoi Julien a buté le 2026-09-15.
     */
    const { cap, srv } = app(SORTIES, [OUTIL], { outputPaths: [] });
    const res = await srv.inject({
      method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok),
      payload: corps({ nature: 'pousse', outputPaths: [] }),
    });
    expect(res.statusCode).toBe(201);
    expect(cap.connecteurs[0]!.outil).toMatchObject({ nature: 'pousse', outputPaths: [] });
  });

  it('🔴 « intègre » sans aucun champ est refusé, là où le client peut corriger', async () => {
    // L'outil refuserait chaque appel en pleine conversation : le dire ICI, c'est le dire au bon moment.
    const { cap, srv } = app();
    const res = await srv.inject({
      method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok),
      payload: corps({ nature: 'integre', outputPaths: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/au moins une information/);
    expect(cap.connecteurs).toEqual([]);
  });

  it('🔴 et des champs cochés sur un « pousse » sont refusés aussi : l’écran ne promet pas une lecture qui n’a pas lieu', async () => {
    // Le magasin les force déjà à vide ; refuser ici en plus fait qu'aucun des deux ne porte seul la cohérence.
    const { srv } = app();
    const res = await srv.inject({
      method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok),
      payload: corps({ nature: 'pousse', outputPaths: ['statut'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 `nature` est EXIGÉE : sans elle, la question serait devinée au lieu d’être posée', async () => {
    const { srv } = app();
    const res = await srv.inject({
      method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok),
      payload: { ...corps(), nature: undefined },
    });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 une requête d’un AUTRE tenant rend 404, et rien n’est écrit', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok), payload: corps({ requeteId: AUTRE }) });
    expect(res.statusCode).toBe(404);
    expect(cap.connecteurs).toEqual([]);
  });

  it('🔴 le RISQUE ne peut pas être abaissé sous celui de la MÉTHODE DE LA REQUÊTE', async () => {
    // Un client qui déclare « read » un DELETE désarmerait la garde d’autonomie sur une action irréversible.
    // ⚠️ La méthode vient de la requête LUE, jamais du corps : sinon il suffirait de mentir dessus.
    const { cap, srv } = app(SORTIES, [OUTIL], { methode: 'DELETE' });
    for (const risk of ['read', 'write']) {
      const res = await srv.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok), payload: corps({ risk }) });
      expect(res.statusCode, risk).toBe(400);
    }
    expect(cap.connecteurs).toEqual([]);
    // Le MONTER est permis : un GET peut interroger un système sensible.
    const { cap: cap2, srv: srv2 } = app();
    const ok = await srv2.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(adminTok), payload: corps({ risk: 'write' }) });
    expect(ok.statusCode).toBe(201);
    expect(cap2.connecteurs[0]!.outil.risk).toBe('write');
  });

  it('réservé aux administrateurs, et le tenant de l’URL ne dépasse pas celui du jeton', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'POST', url: `${base('t1')}/connecteur`, ...h(agentTok), payload: corps() })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: `${base('t2')}/connecteur`, ...h(adminTok), payload: corps() })).statusCode).toBe(403);
    expect(cap.connecteurs).toEqual([]);
  });
});
