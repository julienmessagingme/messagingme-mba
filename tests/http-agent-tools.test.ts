import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentToolsRouteDeps } from '../src/http/agent-tools';
import type { OutilComplet, PatchOutil } from '../src/agent/catalog';
import { NomOutilDejaPris } from '../src/agent/catalog';
import type { SortieAgent } from '../src/agent/agent-store';

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
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: USER, tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const OUTIL: OutilComplet = {
  id: OUT, tenantId: 't1', agentId: AG, origin: 'mba', name: 'mba_terminer',
  title: 'Terminer', description: 'Termine la conversation.', nePasUtiliser: 'Pas pour escalader.',
  params: [{ name: 'sortie', type: 'string', source: 'modele', required: true }],
  binding: { handler: 'terminer' }, outputPaths: [], risk: 'read',
  timeoutMs: 8000, maxBytes: 16384, autonome: false, actif: false, activeLe: null, autonomeLe: null,
};

const SORTIES: SortieAgent[] = [{ code: 'besoin_cerne', label: 'Besoin cerné' }];

function app(sorties: SortieAgent[] | null = SORTIES, liste: OutilComplet[] = [OUTIL]) {
  const cap = {
    ajouts: [] as Array<{ tenant: string; agentId: string; outil: Record<string, unknown> }>,
    patches: [] as Array<{ tenant: string; agentId: string; id: string; patch: PatchOutil }>,
    activations: [] as Array<{ tenant: string; id: string; actif: boolean; par: string }>,
    autonomies: [] as Array<{ tenant: string; id: string; autonome: boolean; par: string }>,
    retraits: [] as Array<{ tenant: string; id: string }>,
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
    retirer: async (tenant, _a, id) => { cap.retraits.push({ tenant, id }); return id === OUT; },
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
