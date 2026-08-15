import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signRequest } from '../src/lib/signature';
import type { HubspotEventRouteDeps } from '../src/http/hubspot-events';
import { parseAutomationEventJob } from '../src/automation/event-job';
import { matchesTrigger, type AutomationRow } from '../src/automation/match';

/**
 * Canal ENTRANT depuis le connecteur HubSpot. C'est le SEUL endroit où un système extérieur peut provoquer un
 * envoi WhatsApp facturé : la route doit donc être avare. Elle vérifie la signature, valide le payload, et ne
 * décide de rien d'autre que « traduire en événement d'automation ».
 */
const SECRET = 'secret-partage-avec-le-connecteur';
const NOW = 1_786_000_000_000;

let baseline = 0;
beforeAll(() => { baseline = 0; });

function app(over: Partial<HubspotEventRouteDeps> = {}) {
  const publies: Array<{ tenantId: string; ev: unknown }> = [];
  const deps: HubspotEventRouteDeps = {
    secret: SECRET,
    findWaId: async (_t, waId) => waId,
    publish: async (tenantId, ev) => { publies.push({ tenantId, ev }); },
    now: () => NOW,
    ...over,
  };
  const server = buildServer({ queue: new FakeQueue(), hubspotEvents: deps });
  return { server, publies };
}

/** Signe un corps comme le fait le connecteur (même format canonique, même chemin). */
function envoi(body: unknown, secret = SECRET, ts = NOW) {
  const raw = JSON.stringify(body);
  const sig = signRequest(secret, { ts, nonce: randomBytes(8).toString('hex'), method: 'POST', path: '/hubspot/deal-stage', body: raw });
  return { headers: { 'content-type': 'application/json', 'x-mm-service-signature': sig }, payload: raw };
}

const VALIDE = { tenantId: 't1', phone: '+33612345678', stageId: 's-devis', pipelineId: 'p1', dealId: '555' };

describe('POST /hubspot/deal-stage', () => {
  it('événement signé -> publie l’événement d’automation avec le wa_id résolu', async () => {
    const { server, publies } = app();
    const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(VALIDE) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ triggered: boolean }>().triggered).toBe(true);
    expect(publies).toEqual([{ tenantId: 't1', ev: { kind: 'hubspot_deal_stage', waId: '33612345678', pipelineId: 'p1', stageId: 's-devis' } }]);
    await server.close();
  });

  it('signature absente, fausse, ou d’un autre secret -> 401 et RIEN n’est publié', async () => {
    const { server, publies } = app();
    const sans = await server.inject({
      method: 'POST', url: '/hubspot/deal-stage',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify(VALIDE),
    });
    expect(sans.statusCode).toBe(401);
    const autre = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(VALIDE, 'mauvais-secret') });
    expect(autre.statusCode).toBe(401);
    expect(publies).toEqual([]);
    await server.close();
  });

  it('signature PÉRIMÉE -> 401 (la fenêtre borne le rejeu)', async () => {
    const { server, publies } = app();
    const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(VALIDE, SECRET, NOW - 10 * 60 * 1000) });
    expect(res.statusCode).toBe(401);
    expect(publies).toEqual([]);
    await server.close();
  });

  it('corps ALTÉRÉ après signature -> 401', async () => {
    const { server, publies } = app();
    const bon = envoi(VALIDE);
    const res = await server.inject({
      method: 'POST', url: '/hubspot/deal-stage',
      headers: bon.headers, payload: JSON.stringify({ ...VALIDE, stageId: 's-gagne' }),
    });
    expect(res.statusCode).toBe(401);
    expect(publies).toEqual([]);
    await server.close();
  });

  it('payload incomplet -> 400 (safeParse, jamais de champ deviné)', async () => {
    const { server, publies } = app();
    for (const mauvais of [{ tenantId: 't1' }, { ...VALIDE, stageId: '' }, { ...VALIDE, phone: '' }]) {
      const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(mauvais) });
      expect(res.statusCode, JSON.stringify(mauvais)).toBe(400);
    }
    expect(publies).toEqual([]);
    await server.close();
  });

  it('contact INCONNU du workspace -> 200 sans déclenchement, et aucune fiche créée', async () => {
    // Un événement de CRM ne doit pas faire apparaître des fiches en silence : sans fiche, pas de
    // consentement connu ni de champ pour les variables d'un template.
    const { server, publies } = app({ findWaId: async () => null });
    const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(VALIDE) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ triggered: boolean; reason: string }>()).toMatchObject({ triggered: false, reason: 'contact inconnu' });
    expect(publies).toEqual([]);
    await server.close();
  });

  it('numéro inexploitable -> 200 sans déclenchement (ce n’est pas une panne)', async () => {
    const { server, publies } = app();
    const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi({ ...VALIDE, phone: 'pas-un-numero' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ triggered: boolean }>().triggered).toBe(false);
    expect(publies).toEqual([]);
    await server.close();
  });

  it('pipeline absent -> publié vide, l’étape suffit à décider', async () => {
    const { server, publies } = app();
    const { pipelineId: _ignore, ...sansPipeline } = VALIDE;
    const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(sansPipeline) });
    expect(res.statusCode).toBe(200);
    expect(publies[0]?.ev).toMatchObject({ pipelineId: '' });
    await server.close();
  });

  /**
   * CHAÎNE COMPLÈTE, et c'est le test qui manquait. Chaque maillon était couvert isolément, et la chaîne était
   * pourtant MORTE : la route publiait un pipeline vide (le webhook HubSpot ne le porte pas) et l'analyseur de
   * file l'écartait. 200 partout, aucune erreur, aucune automation. Tester les maillons ne teste pas la chaîne.
   */
  it('bout en bout : ce que la route publie est ACCEPTÉ par la file ET déclenche l’automation', async () => {
    const { server, publies } = app();
    const { pipelineId: _sansPipeline, ...sansPipeline } = VALIDE;
    await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(sansPipeline) });
    expect(publies).toHaveLength(1);

    // 1) le job publié survit à l'analyseur de la file (c'est ici que tout mourait)
    const job = parseAutomationEventJob({ tenantId: publies[0]!.tenantId, event: publies[0]!.ev });
    expect(job).not.toBeNull();

    // 2) et il déclenche bien une automation réglée sur cette étape
    const automation: AutomationRow = {
      id: 'a1', tenantId: 't1', name: 'Relance devis', enabled: true,
      triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1', stageId: 's-devis' },
      conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
    };
    // Pipeline configuré côté automation MAIS absent de l'événement : ça doit passer, sinon la règle
    // « le pipeline ne restreint rien » ne vaudrait que dans un sens.
    expect(matchesTrigger(automation, job!.event)).toBe(true);
    await server.close();
  });

  it('numéro au format national -> normalisé comme partout ailleurs (même contact par tous les chemins)', async () => {
    const { server, publies } = app();
    await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi({ ...VALIDE, phone: '06 12 34 56 78' }) });
    expect(publies[0]?.ev).toMatchObject({ waId: '33612345678' });
    await server.close();
  });

  it('route NON montée sans secret partagé -> 404 (jamais une route ouverte par défaut)', async () => {
    const server = buildServer({ queue: new FakeQueue() });
    const res = await server.inject({ method: 'POST', url: '/hubspot/deal-stage', ...envoi(VALIDE) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});
