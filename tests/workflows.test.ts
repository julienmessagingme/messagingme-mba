import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { WorkflowRouteDeps } from '../src/http/workflows';
import type { WorkflowRow } from '../src/workflow/store.pg';
import { WorkflowUtiliseParLienChaine } from '../src/workflow/store.pg';
import { aucunePubliciteUtilise } from './pubs-fixtures';

const SECRET = 'test-secret';
// Un identifiant qui a la FORME d'un uuid : les routes refusent desormais en 404 ce qui n'en est pas un,
// parce qu'un id mal forme partait tel quel dans un `where id = $1` sur une colonne uuid et faisait lever
// Postgres (22P02), donc un 500 dont Cloudflare remplace le corps. Une adresse tapee de travers rend 404.
const W1 = '11111111-1111-4111-8111-111111111111';
let adminTok = '';
let agentTok = '';
let otherTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  otherTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const sampleRow = (over: Partial<WorkflowRow> = {}): WorkflowRow => ({
  id: W1, tenantId: 't1', name: 'Onboarding',
  graph: { nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: {} }], edges: [] },
  createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', ...over,
});

function app(over: Partial<WorkflowRouteDeps> = {}) {
  const cap = {
    created: [] as Array<{ name: string; graph: unknown }>, updated: [] as Array<{ id: string; patch: unknown }>,
    deleted: [] as string[], declared: [] as string[][], publies: [] as string[],
    journal: [] as Array<{ action: string; userId: string | null; target: string }>,
  };
  const deps: WorkflowRouteDeps = {
    createWorkflow: async (_t, name, graph) => { cap.created.push({ name, graph }); return { id: 'wNew' }; },
    tenantCode: async () => 'k7m2p3',
    publicitesQuiUtilisent: aucunePubliciteUtilise,
    listWorkflows: async () => [sampleRow()],
    getWorkflow: async (id) => (id === W1 ? sampleRow() : null),
    updateWorkflow: async (id, _t, patch) => { cap.updated.push({ id, patch }); return { trouve: id === W1, brouillon: true }; },
    publishWorkflow: async (id) => { cap.publies.push(id); return id === W1 ? sampleRow({ publishedAt: '2026-09-01T10:00:00.000Z' }) : null; },
    deleteWorkflow: async (id) => { cap.deleted.push(id); return id === W1; },
    declareTags: async (_t, tags) => { cap.declared.push(tags); },
    audit: async (_t, actor, action, target) => { cap.journal.push({ action, userId: actor.userId, target: target.id }); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, workflows: deps }), cap };
}

const validGraph = {
  nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip' } }, { id: 'n2', type: 'template', position: { x: 200, y: 0 }, data: { templateName: 'promo' } }],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

describe('routes workflows', () => {
  it('POST -> 201, graphe sanitisé passé au store', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string }>().id).toBe('wNew');
    expect(cap.created[0]!.name).toBe('Onb');
    await server.close();
  });

  it('POST sans graph -> 201 (démarre vide)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Vide' } });
    expect(res.statusCode).toBe(201);
    expect(cap.created[0]!.graph).toEqual({ nodes: [], edges: [] });
    await server.close();
  });

  it('POST name vide -> 400 ; graphe invalide -> 400', async () => {
    const { server } = app();
    const noName = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: '', graph: validGraph } });
    const badGraph = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'X', graph: { nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 } }], edges: [{ id: 'e', source: 'n1', target: 'ABSENT' }] } } });
    expect(noName.statusCode).toBe(400);
    expect(badGraph.statusCode).toBe(400);
    await server.close();
  });

  // Lot D : le SAVE n'impose PLUS qu'un scénario commence par un template. Un scénario qui ouvre sur un
  // formulaire / message rapide est valide et enregistrable : il est réservé aux déclenchements où la fenêtre
  // de service 24 h est garantie (contact qui vient d'écrire), et c'est `POST /campaigns` qui refuse de le
  // lancer en broadcast (garde INDÉPENDANTE, verrouillée par tests/http-campaigns.test.ts).
  it('POST/PATCH : graphe qui OUVRE sur un flow ou un message rapide -> ENREGISTRÉ (plus de 400 depuis le Lot D)', async () => {
    const { server, cap } = app();
    // tag -> flow en ouverture (la chaîne synchrone compte aussi comme ouverture).
    const flowEntry = {
      nodes: [
        { id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip' } },
        { id: 'n2', type: 'flow', position: { x: 200, y: 0 }, data: { flowId: 'fl1', flowName: 'RDV' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const post = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'X', graph: flowEntry } });
    expect(post.statusCode).toBe(201);
    const qmEntry = { nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Salut', quickReplies: ['Oui'] } }], edges: [] };
    const patch = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: qmEntry } });
    expect(patch.statusCode).toBe(200);
    // Les deux graphes sont bien PERSISTÉS (et non acceptés puis silencieusement vidés).
    expect(cap.created).toHaveLength(1);
    const saved = cap.created[0]!.graph as { nodes: Array<{ type: string }> };
    expect(saved.nodes.map((nd) => nd.type)).toEqual(['tag', 'flow']);
    expect(cap.updated).toHaveLength(1);
    await server.close();
  });

  it('POST : flow NON configuré (sans flowId) en ouverture -> 201 (le graphe reste enregistrable pendant la construction)', async () => {
    const { server } = app();
    const wip = { nodes: [{ id: 'n1', type: 'flow', position: { x: 0, y: 0 }, data: {} }], edges: [] };
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'WIP', graph: wip } });
    expect(res.statusCode).toBe(201);
    await server.close();
  });

  it('GET liste + GET un + 404', async () => {
    const { server } = app();
    const list = await server.inject({ method: 'GET', url: '/tenants/t1/workflows', ...h(adminTok) });
    expect(list.json<{ workflows: unknown[] }>().workflows).toHaveLength(1);
    const one = await server.inject({ method: 'GET', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok) });
    expect(one.statusCode).toBe(200);
    const miss = await server.inject({ method: 'GET', url: '/tenants/t1/workflows/nope', ...h(adminTok) });
    expect(miss.statusCode).toBe(404);
    await server.close();
  });

  it('PATCH graph -> 200 ; graphe invalide -> 400 ; rien à modifier -> 400', async () => {
    const { server, cap } = app();
    const ok = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: validGraph } });
    expect(ok.statusCode).toBe(200);
    expect(cap.updated[0]!.id).toBe(W1);
    const bad = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: { nodes: 'x', edges: [] } } });
    expect(bad.statusCode).toBe(400);
    const empty = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: {} });
    expect(empty.statusCode).toBe(400);
    await server.close();
  });

  it('POST : chaque node reçoit un code public nod_<client>_<ulid>, dans la réponse ET le graphe persisté', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    const g = res.json<{ graph: { nodes: Array<{ data: { code?: string } }> } }>().graph;
    for (const n of g.nodes) expect(n.data.code).toMatch(/^nod_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$/);
    const stored = cap.created[0]!.graph as { nodes: Array<{ data: { code?: string } }> };
    for (const n of stored.nodes) expect(n.data.code).toMatch(/^nod_k7m2p3_/); // mint AVANT le store
    await server.close();
  });

  it('PATCH graph : mint les codes manquants, CONSERVE un code valide du tenant', async () => {
    const { server } = app();
    const withCode = {
      nodes: [
        { id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip', code: 'nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS' } },
        { id: 'n2', type: 'template', position: { x: 200, y: 0 }, data: { templateName: 'promo' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: withCode } });
    expect(res.statusCode).toBe(200);
    const g = res.json<{ graph: { nodes: Array<{ data: { code?: string } }> } }>().graph;
    expect(g.nodes[0]!.data.code).toBe('nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS'); // conservé (stabilité)
    expect(g.nodes[1]!.data.code).toMatch(/^nod_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$/); // minté
    await server.close();
  });

  it('POST déclare les tags des blocs « ajout de tag » (Contenus > Tags)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    expect(cap.declared).toEqual([['vip']]); // le node tag 'vip', pas le node template
    await server.close();
  });

  it('PATCH graph déclare aussi les tags du graphe', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: validGraph } });
    expect(res.statusCode).toBe(200);
    expect(cap.declared).toEqual([['vip']]);
    await server.close();
  });

  it('déclaration best-effort : un échec de declareTags ne casse pas la sauvegarde', async () => {
    const { server } = app({ declareTags: async () => { throw new Error('boom'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(adminTok), payload: { name: 'Onb', graph: validGraph } });
    expect(res.statusCode).toBe(201);
    await server.close();
  });

  it('DELETE -> 200 ; inconnu -> 404', async () => {
    const { server } = app();
    const ok = await server.inject({ method: 'DELETE', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok) });
    expect(ok.statusCode).toBe(200);
    const miss = await server.inject({ method: 'DELETE', url: '/tenants/t1/workflows/nope', ...h(adminTok) });
    expect(miss.statusCode).toBe(404);
    await server.close();
  });

  it('🔴 DELETE d’un scénario utilisé par un lien de chaîne WhatsApp : 409 nommé, jamais un 500', async () => {
    // `channelsme_links.workflow_id` est en `on delete restrict` (migration 0114) : le store lève
    // `WorkflowUtiliseParLienChaine` (traduite depuis Postgres 23503), et sans cette route la violation
    // remonterait au gestionnaire d'erreur global, donc en 500, dont Cloudflare remplace le corps.
    const { server } = app({ deleteWorkflow: async () => { throw new WorkflowUtiliseParLienChaine(); } });
    const res = await server.inject({ method: 'DELETE', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('lien de chaîne WhatsApp');
    await server.close();
  });

  it('🔴 DELETE d’un scénario utilisé par une PUBLICITÉ vivante : 409 nommé, et la suppression n’a PAS lieu', async () => {
    // 🔴 LE REFUS SE POSE AVANT LA SUPPRESSION, sans quoi il ne verrait rien à refuser :
    // `publicites.workflow_id` est en `on delete set null`, donc un `delete` RÉUSSIT et laisse la
    // publicité avec une destination `scenario` et plus aucun scénario. Ses prospects, qui ont coûté un
    // clic, n’arriveraient alors nulle part, sans la moindre erreur.
    let supprime = false;
    const { server } = app({
      publicitesQuiUtilisent: async () => ['Rentrée 2026', 'Black Friday'],
      deleteWorkflow: async () => { supprime = true; return true; },
    });
    const res = await server.inject({ method: 'DELETE', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    const corps = res.json<{ error: string; code: string }>();
    expect(corps.code).toBe('utilise_par_publicite');
    // Le message NOMME les publicités : « ce scénario est utilisé » sans dire par quoi enverrait le
    // client chercher dans une liste entière.
    expect(corps.error).toContain('Rentrée 2026');
    // 🔴 LE SENS QUI COMPTE AUTANT : la suppression n’a pas eu lieu.
    expect(supprime).toBe(false);
    await server.close();
  });

  it('aucune publicité ne l’utilise : la suppression passe, comme avant ce lot', async () => {
    let supprime = false;
    const { server } = app({ deleteWorkflow: async () => { supprime = true; return true; } });
    const res = await server.inject({ method: 'DELETE', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(supprime).toBe(true);
    await server.close();
  });

  it('agent -> 403 sur écriture ; tenant croisé -> 403', async () => {
    const { server } = app();
    const agent = await server.inject({ method: 'POST', url: '/tenants/t1/workflows', ...h(agentTok), payload: { name: 'X' } });
    expect(agent.statusCode).toBe(403);
    const cross = await server.inject({ method: 'GET', url: '/tenants/t1/workflows', ...h(otherTok) });
    expect(cross.statusCode).toBe(403);
    await server.close();
  });

  it('GET /nodes : aplati les nodes de tous les scénarios, résumé field depuis fieldLabel', async () => {
    // Forme RÉELLE persistée par le builder (fieldKey/fieldLabel/value pour un bloc « ajout de champ »).
    const nodesRow = sampleRow({
      id: 'wA', name: 'Parcours',
      graph: { nodes: [
        { id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { code: 'nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS', templateName: 'promo' } },
        { id: 'n2', type: 'field', position: { x: 200, y: 0 }, data: { fieldKey: 'ville', fieldLabel: 'Ville', value: 'Paris' } },
        { id: 'n3', type: 'tag', position: { x: 400, y: 0 }, data: { tag: 'vip' } },
      ], edges: [] },
    });
    const { server } = app({ listWorkflows: async () => [nodesRow] });
    const all = await server.inject({ method: 'GET', url: '/tenants/t1/nodes', ...h(adminTok) });
    expect(all.statusCode).toBe(200);
    const nodes = all.json<{ nodes: Array<{ type: string; summary: string; code: string | null; workflowId: string }> }>().nodes;
    expect(nodes).toHaveLength(3);
    const field = nodes.find((n) => n.type === 'field')!;
    expect(field.summary).toBe('Ville = Paris'); // <- aurait échoué avec l'ancien data.key
    expect(field.code).toBeNull(); // node jamais re-sauvegardé -> pas de code
    expect(nodes.find((n) => n.type === 'template')!.code).toBe('nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS');
    expect(nodes.every((n) => n.workflowId === 'wA')).toBe(true);
    // Filtre par type
    const tags = await server.inject({ method: 'GET', url: '/tenants/t1/nodes?type=tag', ...h(adminTok) });
    expect(tags.json<{ nodes: unknown[] }>().nodes).toHaveLength(1);
    // Tenant croisé -> 403
    const cross = await server.inject({ method: 'GET', url: '/tenants/t1/nodes', ...h(otherTok) });
    expect(cross.statusCode).toBe(403);
    await server.close();
  });
});

describe('POST /tenants/:t/workflows/:id/duplicate', () => {
  const SRC_CODE = 'nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS'; // code valide du tenant t1 (k7m2p3)
  const source = (): WorkflowRow => sampleRow({
    name: 'Promo',
    graph: {
      nodes: [{ id: 'n1', type: 'template', position: { x: 5, y: 9 }, data: { code: SRC_CODE, templateName: 'x' } }],
      edges: [],
    },
  });

  it('201, nom « (copie) », graphe cloné, codes de node RE-MINTÉS (différents de la source)', async () => {
    const { server, cap } = app({ getWorkflow: async (id) => (id === W1 ? source() : null), listWorkflows: async () => [source()] });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/duplicate`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ name: string }>().name).toBe('Promo (copie)');
    expect(cap.created[0]!.name).toBe('Promo (copie)');
    const g = cap.created[0]!.graph as { nodes: Array<{ id: string; position: unknown; data: { code?: string } }> };
    expect(g.nodes[0]!.id).toBe('n1');                 // structure clonée
    expect(g.nodes[0]!.position).toEqual({ x: 5, y: 9 });
    expect(g.nodes[0]!.data.code).toMatch(/^nod_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$/); // code frais valide
    expect(g.nodes[0]!.data.code).not.toBe(SRC_CODE);  // PAS celui de la source
    await server.close();
  });

  it('incrémente « (copie 2) » si le nom est déjà pris', async () => {
    const { server, cap } = app({ getWorkflow: async (id) => (id === W1 ? source() : null), listWorkflows: async () => [source(), sampleRow({ name: 'Promo (copie)' })] });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/duplicate`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(201);
    expect(cap.created[0]!.name).toBe('Promo (copie 2)');
    await server.close();
  });

  it('id inconnu -> 404, aucune création', async () => {
    const { server, cap } = app({ getWorkflow: async () => null });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/workflows/ghost/duplicate', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(404);
    expect(cap.created).toHaveLength(0);
    await server.close();
  });

  it('🔴 copie le BROUILLON quand il y en a un (on duplique ce qu’on voit, pas ce qui tourne)', async () => {
    const avecBrouillon = (): WorkflowRow => sampleRow({
      name: 'Promo',
      graph: { nodes: [{ id: 'nEnLigne', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'en-ligne' } }], edges: [] },
      draftGraph: { nodes: [{ id: 'nBrouillon', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'brouillon' } }], edges: [] },
    });
    const { server, cap } = app({ getWorkflow: async (id) => (id === W1 ? avecBrouillon() : null), listWorkflows: async () => [avecBrouillon()] });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/duplicate`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(201);
    const g = cap.created[0]!.graph as { nodes: Array<{ id: string }> };
    expect(g.nodes[0]!.id).toBe('nBrouillon');
    await server.close();
  });

  it('sans brouillon, copie la version en ligne (l’autre sens de la même règle)', async () => {
    const { server, cap } = app({ getWorkflow: async (id) => (id === W1 ? source() : null), listWorkflows: async () => [source()] });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/duplicate`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(201);
    const g = cap.created[0]!.graph as { nodes: Array<{ id: string }> };
    expect(g.nodes[0]!.id).toBe('n1');
    await server.close();
  });

  it('agent -> 403 (admin-only) ; tenant != token -> 403', async () => {
    const { server } = app({ getWorkflow: async () => source() });
    const agent = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/duplicate`, ...h(agentTok), payload: {} });
    const cross = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/duplicate`, ...h(otherTok), payload: {} });
    expect(agent.statusCode).toBe(403);
    expect(cross.statusCode).toBe(403);
    await server.close();
  });
});

/**
 * MISE EN LIGNE (lot 7). La route est le seul chemin qui change quelque chose pour les contacts : tout le
 * reste de l'éditeur n'écrit qu'un brouillon.
 */
describe('POST /tenants/:t/workflows/:id/publish', () => {
  it('200 : publie, rend le graphe en ligne et la date, et journalise QUI a publié', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/publish`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ publishedAt: string }>().publishedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(cap.publies).toEqual([W1]);
    expect(cap.journal).toEqual([{ action: 'workflow.published', userId: 'u1', target: W1 }]);
    await server.close();
  });

  it('scénario inconnu -> 404, et un id qui n’est pas un uuid -> 404 SANS toucher au store', async () => {
    const { server, cap } = app();
    const inconnu = await server.inject({ method: 'POST', url: '/tenants/t1/workflows/22222222-2222-4222-8222-222222222222/publish', ...h(adminTok), payload: {} });
    expect(inconnu.statusCode).toBe(404);
    const malForme = await server.inject({ method: 'POST', url: '/tenants/t1/workflows/pas-un-uuid/publish', ...h(adminTok), payload: {} });
    expect(malForme.statusCode).toBe(404);
    // Le second n'a JAMAIS atteint la base : un id mal formé y ferait lever Postgres (22P02), donc un 500.
    expect(cap.publies).toEqual(['22222222-2222-4222-8222-222222222222']);
    await server.close();
  });

  it('🔴 réservée aux admins, et jamais d’un espace à l’autre', async () => {
    const { server, cap } = app();
    const agent = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/publish`, ...h(agentTok), payload: {} });
    const cross = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/publish`, ...h(otherTok), payload: {} });
    expect(agent.statusCode).toBe(403);
    expect(cross.statusCode).toBe(403);
    expect(cap.publies).toEqual([]);
    await server.close();
  });

  it('instance sans store de publication -> 503, pas un 500', async () => {
    const { server } = app({ publishWorkflow: undefined });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/workflows/${W1}/publish`, ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(503);
    await server.close();
  });

  it('le PATCH dit s’il reste un brouillon à publier : c’est lui qui allume le bouton', async () => {
    const { server } = app();
    const avec = await server.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: validGraph } });
    expect(avec.json<{ brouillon: boolean }>().brouillon).toBe(true);
    const { server: s2 } = app({ updateWorkflow: async () => ({ trouve: true, brouillon: false }) });
    const sans = await s2.inject({ method: 'PATCH', url: `/tenants/t1/workflows/${W1}`, ...h(adminTok), payload: { graph: validGraph } });
    expect(sans.json<{ brouillon: boolean }>().brouillon).toBe(false);
    await server.close();
    await s2.close();
  });
});


describe('GET /workflows : le RÉSUMÉ, jamais les graphes', () => {
  it('🔴 la liste ne transporte AUCUN graphe quand le résumé est câblé', async () => {
    // 🔴 Constat du contre-audit du 2026-09-01 : la liste renvoyait DEUX graphes complets par ligne (le
    // publié et le brouillon) pour des écrans qui n'affichent qu'un nom. Avec des centaines de scénarios,
    // chaque écran paie le transfert et l'analyse de tous les JSON. Ce que les écrans en tiraient devient
    // trois champs, et le graphe complet reste sur `GET /workflows/:id`.
    const { server } = app({
      listWorkflowsResume: async () => [{
        id: W1, tenantId: 't1', name: 'Onboarding', code: 'scn_k7m2p3_x',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: null,
        nodeCount: 4, hasDraft: true, campaignEligible: true, canalOuverture: 'whatsapp' as const,
      }],
    });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/workflows', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const [w] = res.json<{ workflows: Array<Record<string, unknown>> }>().workflows;
    expect(w).toMatchObject({ nodeCount: 4, hasDraft: true, campaignEligible: true });
    // La preuve qui compte : aucun graphe dans la charge utile.
    expect(w).not.toHaveProperty('graph');
    expect(w).not.toHaveProperty('draftGraph');
    await server.close();
  });

  it('sans résumé câblé, la route retombe sur l’ancien comportement', async () => {
    // Rétro-compatibilité assumée : une instance qui ne câble pas le résumé continue de servir les graphes,
    // et rien ne casse. C'est ce qui permet aux câblages de test de ne rien changer.
    const { server } = app({});
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/workflows', ...h(adminTok) });
    expect(res.json<{ workflows: Array<Record<string, unknown>> }>().workflows[0]).toHaveProperty('graph');
    await server.close();
  });
});
