import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { AutomationRouteDeps } from '../src/http/automations';
import type { AutomationInput } from '../src/automation/store.pg';

/**
 * Routes Automation. Une automation ACTIVE écrit à des clients réels sans qu'un humain relise : ces routes
 * sont donc un pouvoir d'envoi, au même titre qu'une campagne. Ce que ces tests verrouillent :
 *
 *  1. Une automation est créée DÉSACTIVÉE, même si le corps ne le précise pas (jamais d'envoi non voulu).
 *  2. Les écritures sont admin-only, la lecture ouverte aux comptes authentifiés.
 *  3. Isolation tenant : ni lecture croisée, ni ciblage du scénario d'un autre client.
 *  4. Une config qui ne peut PAS déclencher (aucun mot-clé) est refusée : sinon le client croit son automation
 *     active alors qu'elle ne partira jamais.
 */

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const VALID = { name: 'Demande RDV', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, workflowId: 'wf1' };

function app(over: Partial<AutomationRouteDeps> = {}) {
  const cap = {
    created: [] as Array<{ tenant: string; input: AutomationInput }>,
    updated: [] as Array<{ id: string; tenant: string; patch: Partial<AutomationInput> }>,
    removed: [] as Array<{ id: string; tenant: string }>,
  };
  const deps: AutomationRouteDeps = {
    list: async () => [],
    // État courant d'UNE automation : c'est lui que la garde anti-boucle relit sur un PATCH partiel.
    getById: async (id) => (id === 'a1' ? { id: 'a1', tenantId: 't1', name: 'A', enabled: true, triggerKind: 'conversation_analyzed', triggerConfig: {}, conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: 3600 } : null),
    create: async (tenant, input) => { cap.created.push({ tenant, input }); return { id: 'a1' }; },
    update: async (id, tenant, patch) => { cap.updated.push({ id, tenant, patch }); return id === 'a1'; },
    remove: async (id, tenant) => { cap.removed.push({ id, tenant }); return id === 'a1'; },
    // wf1 appartient à t1 ; tout le reste est refusé (scénario d'un autre client ou inexistant).
    workflowBelongsToTenant: async (wfId, tenant) => wfId === 'wf1' && tenant === 't1',
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, automations: deps }), cap };
}

describe('routes automations', () => {
  it('POST -> 201, et l’automation est créée DÉSACTIVÉE par défaut', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: VALID });
    expect(res.statusCode).toBe(201);
    expect(cap.created[0]?.input).toMatchObject({ name: 'Demande RDV', triggerKind: 'keyword', enabled: false, startNodeId: null, cooldownSeconds: null, conditionGroup: null });
    await server.close();
  });

  it('POST enabled:true explicite -> respecté (activation assumée par l’admin)', async () => {
    const { server, cap } = app();
    await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...VALID, enabled: true } });
    expect(cap.created[0]?.input.enabled).toBe(true);
    await server.close();
  });

  it('POST refuse un corps invalide SANS jamais écrire', async () => {
    const { server, cap } = app();
    const bad: Array<Record<string, unknown>> = [
      { ...VALID, name: '' },                                        // nom vide
      { ...VALID, triggerKind: 'nawak' },                            // type inconnu
      { ...VALID, triggerKind: 'tag_added', triggerConfig: {} },      // tag manquant -> partirait sur TOUS les tags
      { ...VALID, triggerKind: 'conversation_analyzed', triggerConfig: { sentiment: 'ravi' } }, // hors nomenclature
      { ...VALID, triggerKind: 'conversation_analyzed', triggerConfig: { unresolvedOnly: 'oui' } },
      { ...VALID, triggerConfig: { keywords: [] } },                 // aucun mot-clé -> ne partirait jamais
      { ...VALID, triggerConfig: { keywords: ['  '] } },             // que du vide
      { ...VALID, triggerConfig: { keywords: ['rdv'], mode: 'nawak' } },
      { ...VALID, triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1' } },            // étape manquante -> partirait sur TOUTES les étapes
      { ...VALID, triggerKind: 'hubspot_deal_stage', triggerConfig: { stageId: 's1' } },                // pipeline manquant
      { ...VALID, triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1', stageId: 's1', stageLabel: 42 } },
      { ...VALID, workflowId: '' },
      { ...VALID, cooldownSeconds: -1 },
      { ...VALID, cooldownSeconds: 1.5 },
      { ...VALID, cooldownSeconds: 8 * 24 * 3600 },                  // au-delà de la borne de 7 jours
      { ...VALID, conditionGroup: [] },                              // tableau au lieu d'objet
    ];
    for (const payload of bad) {
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(cap.created).toEqual([]);
    await server.close();
  });

  it('POST accepte les déclencheurs ajoutés par E.2 (tag posé, conversation analysée)', async () => {
    const { server, cap } = app();
    const ok: Array<Record<string, unknown>> = [
      { ...VALID, triggerKind: 'tag_added', triggerConfig: { tag: 'rappeler' } },
      { ...VALID, triggerKind: 'conversation_analyzed', triggerConfig: { sentiment: 'negatif', unresolvedOnly: true } },
      { ...VALID, triggerKind: 'conversation_analyzed', triggerConfig: {} }, // sans filtre : choix explicite
      // Étape de deal HubSpot : les deux identifiants, plus un libellé purement décoratif.
      { ...VALID, triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1', stageId: 's-devis', stageLabel: 'Devis envoyé' } },
      { ...VALID, triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1', stageId: 's-devis' } },
    ];
    for (const payload of ok) {
      const res = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(201);
    }
    expect(cap.created).toHaveLength(ok.length); // dérivé de la liste : ajouter un cas ne fait plus mentir le compte
    expect(cap.created.every((c) => c.input.enabled === false)).toBe(true); // toujours créées désactivées
    await server.close();
  });

  it('« conversation analysée » : un anti-rebond court est REFUSÉ (il ferait boucler analyse et scénario)', async () => {
    // Le scénario déclenché écrit dans la conversation, ce qui la rouvre à l'analyse (~25 min plus tard).
    // Avec un anti-rebond nul ou court, un message facturé partirait indéfiniment sans action du client.
    const { server, cap } = app();
    const anal = { ...VALID, triggerKind: 'conversation_analyzed', triggerConfig: { sentiment: 'negatif' } };
    const zero = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...anal, cooldownSeconds: 0 } });
    const court = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...anal, cooldownSeconds: 600 } });
    const ok = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...anal, cooldownSeconds: 3600 } });
    const defaut = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...anal, cooldownSeconds: null } });
    expect([zero.statusCode, court.statusCode, ok.statusCode, defaut.statusCode]).toEqual([400, 400, 201, 201]);
    expect(cap.created).toHaveLength(2);
    await server.close();
  });

  describe('garde anti-boucle : les DEUX sens du PATCH', () => {
    // Le trou attrapé en revue : la garde regardait le corps de la requête, pas l'état effectif. Elle ne
    // fermait donc qu'un sens, et il en existe deux pour rouvrir la boucle analyse <-> scénario.
    it('sens 1 : baisser le délai d’une automation DÉJÀ « conversation analysée » -> refusé', async () => {
      const { server, cap } = app(); // getById('a1') = conversation_analyzed, cooldown 3600
      const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { cooldownSeconds: 0 } });
      expect(res.statusCode).toBe(400);
      expect(cap.updated).toEqual([]);
      await server.close();
    });

    it('sens 2 : basculer vers « conversation analysée » une automation au délai DÉJÀ court -> refusé', async () => {
      const { server, cap } = app({
        getById: async () => ({ id: 'a1', tenantId: 't1', name: 'A', enabled: true, triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: 0 }),
      });
      const res = await server.inject({
        method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok),
        payload: { triggerKind: 'conversation_analyzed', triggerConfig: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(cap.updated).toEqual([]);
      await server.close();
    });

    it('délai suffisant -> accepté (la garde ne bloque pas un usage légitime)', async () => {
      const { server, cap } = app();
      const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { cooldownSeconds: 7200 } });
      expect(res.statusCode).toBe(200);
      expect(cap.updated).toHaveLength(1);
      await server.close();
    });
  });

  it('un anti-rebond nul reste permis pour les AUTRES déclencheurs (le client doit agir pour relancer)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...VALID, cooldownSeconds: 0 } });
    expect(res.statusCode).toBe(201);
    await server.close();
  });

  it('POST ciblant le scénario d’un AUTRE tenant -> 400, rien créé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(adminTok), payload: { ...VALID, workflowId: 'wf-autre' } });
    expect(res.statusCode).toBe(400);
    expect(cap.created).toEqual([]);
    await server.close();
  });

  it('un agent ne peut PAS créer / modifier / supprimer (pouvoir d’envoi = admin)', async () => {
    const { server, cap } = app();
    const post = await server.inject({ method: 'POST', url: '/tenants/t1/automations', ...h(agentTok), payload: VALID });
    const patch = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(agentTok), payload: { enabled: true } });
    const del = await server.inject({ method: 'DELETE', url: '/tenants/t1/automations/a1', ...h(agentTok) });
    expect([post.statusCode, patch.statusCode, del.statusCode]).toEqual([403, 403, 403]);
    expect([cap.created, cap.updated, cap.removed]).toEqual([[], [], []]);
    await server.close();
  });

  it('un agent PEUT lire la liste', async () => {
    const { server } = app({ list: async () => [] });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/automations', ...h(agentTok) });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('tenant de l’URL != tenant du jeton -> 403 sur toutes les routes', async () => {
    const { server } = app();
    const get = await server.inject({ method: 'GET', url: '/tenants/AUTRE/automations', ...h(adminTok) });
    const post = await server.inject({ method: 'POST', url: '/tenants/AUTRE/automations', ...h(adminTok), payload: VALID });
    const patch = await server.inject({ method: 'PATCH', url: '/tenants/AUTRE/automations/a1', ...h(adminTok), payload: { enabled: true } });
    const del = await server.inject({ method: 'DELETE', url: '/tenants/AUTRE/automations/a1', ...h(adminTok) });
    expect([get.statusCode, post.statusCode, patch.statusCode, del.statusCode]).toEqual([403, 403, 403, 403]);
    await server.close();
  });

  it('sans jeton -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/automations' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('PATCH enabled seul -> 200 (le cas courant : activer/désactiver depuis la liste)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(cap.updated[0]).toMatchObject({ id: 'a1', tenant: 't1', patch: { enabled: true } });
    await server.close();
  });

  it('PATCH d’une config SANS son type -> 400 (sinon une config invalide passerait la validation)', async () => {
    // Le trou attrapé en revue : `{triggerConfig:{keywords:[]}}` seul sautait la validation et laissait une
    // automation « active » incapable de déclencher.
    const { server, cap } = app();
    const cfgOnly = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { triggerConfig: { keywords: [] } } });
    const kindOnly = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { triggerKind: 'keyword' } });
    expect([cfgOnly.statusCode, kindOnly.statusCode]).toEqual([400, 400]);
    expect(cap.updated).toEqual([]);
    await server.close();
  });

  it('PATCH type + config ENSEMBLE -> validé comme à la création', async () => {
    const { server, cap } = app();
    const ok = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { triggerKind: 'keyword', triggerConfig: { keywords: ['facture'] } } });
    const ko = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: { triggerKind: 'keyword', triggerConfig: { keywords: [] } } });
    expect([ok.statusCode, ko.statusCode]).toEqual([200, 400]);
    expect(cap.updated).toHaveLength(1);
    await server.close();
  });

  it('PATCH vide -> 400 ; automation inconnue -> 404', async () => {
    const { server } = app();
    const empty = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/a1', ...h(adminTok), payload: {} });
    const unknown = await server.inject({ method: 'PATCH', url: '/tenants/t1/automations/zzz', ...h(adminTok), payload: { enabled: true } });
    expect([empty.statusCode, unknown.statusCode]).toEqual([400, 404]);
    await server.close();
  });

  it('DELETE -> 204 ; automation inconnue -> 404', async () => {
    const { server, cap } = app();
    const ok = await server.inject({ method: 'DELETE', url: '/tenants/t1/automations/a1', ...h(adminTok) });
    const ko = await server.inject({ method: 'DELETE', url: '/tenants/t1/automations/zzz', ...h(adminTok) });
    expect([ok.statusCode, ko.statusCode]).toEqual([204, 404]);
    expect(cap.removed).toHaveLength(2); // les deux appels sont scopés tenant, seul l'id connu renvoie true
    await server.close();
  });
});
