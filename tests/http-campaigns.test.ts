import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { CampaignRepoLike } from '../src/campaign/create';
import type { CreateCampaignInput } from '../src/campaign/store.pg';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';
import type { WorkflowGraph } from '../src/workflow/graph';

const SECRET = 'test-secret';
let token = '';
let agentToken = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentToken = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const asAgent = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` } });

class FakeRepo implements CampaignRepoLike {
  readonly created: CreateCampaignInput[] = [];
  lastRecipients: BuiltRecipient[] = [];
  constructor(private readonly contacts: BuildContact[]) {}
  async listContactsForBuild(): Promise<BuildContact[]> {
    return this.contacts;
  }
  async createWithRecipients(input: CreateCampaignInput, recipients: BuiltRecipient[]): Promise<{ campaignId: string; recipientCount: number }> {
    this.created.push(input);
    this.lastRecipients = recipients;
    return { campaignId: 'camp-1', recipientCount: recipients.length };
  }
}

const contacts: BuildContact[] = [
  { id: 'c1', phone_e164: '+33611', profile_name: 'A', fields: {}, optInStatus: 'opted_in' },
  { id: 'c2', phone_e164: '+33622', profile_name: 'B', fields: {}, optInStatus: 'unknown' },
];

const validBody = {
  phoneNumberId: 'pn1',
  name: 'Promo été',
  category: 'marketing',
  templateName: 'promo',
  templateLanguage: 'fr',
  paramMapping: [],
};

// Graphe par défaut d'un workflow valide : bloc d'entrée = envoi de template (exigé par la route).
const TEMPLATE_ENTRY_GRAPH: WorkflowGraph = {
  nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } }],
  edges: [],
};

interface Deps {
  ownsNumber?: boolean;
  ownsWorkflow?: boolean;
  workflowGraph?: WorkflowGraph; // override du graphe renvoyé (pour tester le bloc d'entrée non-template)
  campaignTenant?: string; // tenant propriétaire de 'known'
  queue?: FakeQueue;
  runSizing?: { ratePerMinute: number | null; pendingCount: number } | null; // dimensionnement du job de run
}
function appWith(repo: FakeRepo, d: Deps = {}) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    campaigns: {
      repo,
      queue: d.queue ?? new FakeQueue(),
      phoneNumberBelongsToTenant: async () => d.ownsNumber ?? true,
      // Workflow non détenu -> null (comme un getById cross-tenant) ; sinon le graphe (override ou défaut).
      getWorkflowGraph: async () => (d.ownsWorkflow === false ? null : (d.workflowGraph ?? TEMPLATE_ENTRY_GRAPH)),
      campaignBelongsTo: async (id, tenant) => id === 'known' && tenant === (d.campaignTenant ?? 't1'),
      getRunSizing: async () => (d.runSizing !== undefined ? d.runSizing : { ratePerMinute: null, pendingCount: 0 }),
      listCampaigns: async (tenant) => [
        { id: 'camp-1', name: 'Promo', category: 'marketing', status: 'draft', phoneNumberId: 'pn1', templateName: 'promo', templateLanguage: 'fr', createdAt: '2026-07-05T00:00:00.000Z', counts: { total: 2, pending: 2, sending: 0, sent: 0, failed: 0, skipped: 0 }, _t: tenant } as never,
      ],
      getCampaignDetail: async (id, tenant) =>
        id === 'known' && tenant === 't1'
          ? ({ id: 'known', name: 'Promo', category: 'marketing', status: 'completed', phoneNumberId: 'pn1', templateName: 'promo', templateLanguage: 'fr', createdAt: '2026-07-05T00:00:00.000Z', counts: { total: 1, pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 }, recipients: [{ id: 'r1', toE164: '+33611', status: 'sent', messageId: 'm-1', error: null, sentAt: '2026-07-05T00:00:00.000Z' }] } as never)
          : null,
      listPhoneNumbers: async () => [{ id: 'pn1', displayPhoneNumber: '+33600000000', verifiedName: 'Demo' }],
    },
  });
}

describe('POST /tenants/:tenantId/campaigns', () => {
  it('crée la campagne et construit les destinataires (opt-in filtré)', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: validBody });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ campaignId: string; recipientCount: number; skipped: unknown[] }>();
    expect(body).toEqual({ campaignId: 'camp-1', recipientCount: 1, skipped: [] }); // c2 non opt-in exclu
    expect(repo.created[0]?.tenantId).toBe('t1');
    await app.close();
  });

  it('débit ratePerMinute : accepté 1..80 (persisté), rejeté 0 / 81 / décimal / négatif -> 400 ; absent -> null', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    // Valeur valide persistée telle quelle.
    const ok = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, ratePerMinute: 40 } });
    expect(ok.statusCode).toBe(201);
    expect(repo.created.at(-1)?.ratePerMinute).toBe(40);
    // Absent -> pas de débit (undefined dans l'input, colonne null).
    await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: validBody });
    expect(repo.created.at(-1)?.ratePerMinute).toBeUndefined();
    // Bornes rejetées.
    for (const bad of [0, 81, 12.5, -3]) {
      const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, ratePerMinute: bad } });
      expect(res.statusCode, `rate=${bad}`).toBe(400);
    }
    await app.close();
  });

  it('sans token -> 401', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', headers: { 'content-type': 'application/json' }, payload: validBody });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('tenant de l URL != tenant du token -> 403', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/AUTRE/campaigns', ...auth(), payload: validBody });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('role agent -> 403 sur la création (action admin)', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...asAgent(), payload: validBody });
    expect(res.statusCode).toBe(403);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });

  it('phoneNumberId non détenu par le tenant -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo, { ownsNumber: false });
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: validBody });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });

  it('campagne WORKFLOW (workflowId, sans template) -> 201', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo, { ownsWorkflow: true });
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, templateName: '', templateLanguage: '', workflowId: 'wf1' } });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('ni template ni workflow -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, templateName: '', templateLanguage: '' } });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });

  it('workflow d\'un autre tenant -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo, { ownsWorkflow: false });
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, templateName: '', templateLanguage: '', workflowId: 'wfX' } });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });

  it('workflow dont le 1er bloc n\'est PAS un template -> 400, rien inséré', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo, {
      workflowGraph: { nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip' } }], edges: [] },
    });
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, templateName: '', templateLanguage: '', workflowId: 'wf1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/commencer par un envoi de template/);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });

  it('campagne WORKFLOW avec paramMapping : résout les variables du 1er template + saute les contacts sans la valeur', async () => {
    // Le mapping cible {{1}} = champ « prenom » du 1er template du workflow : Julie l'a, Marc ne l'a pas.
    const list: BuildContact[] = [
      { id: 'ok', phone_e164: '+33611', profile_name: 'Julie', fields: { prenom: 'Julie' }, optInStatus: 'opted_in' },
      { id: 'ko', phone_e164: '+33622', profile_name: 'Marc', fields: {}, optInStatus: 'opted_in' },
    ];
    const repo = new FakeRepo(list);
    const app = appWith(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      ...auth(),
      payload: {
        ...validBody,
        templateName: '',
        templateLanguage: '',
        workflowId: 'wf1',
        paramMapping: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ recipientCount: number; skipped: Array<{ contactId: string; missing: number[] }> }>();
    expect(body.recipientCount).toBe(1);
    expect(body.skipped).toEqual([{ contactId: 'ko', toE164: '+33622', reason: 'missing_variable', missing: [1] }]);
    // Le paramMapping est stocké sur la campagne workflow (plus vidé) ET resolvedParams est calculé par contact.
    expect(repo.created[0]?.workflowId).toBe('wf1');
    expect(repo.created[0]?.paramMapping).toEqual([{ position: 1, source: { type: 'field', key: 'prenom' } }]);
    expect(repo.lastRecipients).toEqual([{ contactId: 'ok', toE164: '+33611', resolvedParams: ['Julie'] }]);
    await app.close();
  });

  it('category invalide -> 400', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: { ...validBody, category: 'promo' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('paramMapping invalide (positions non contiguës) -> 400, rien inséré', async () => {
    const repo = new FakeRepo(contacts);
    const app = appWith(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/campaigns',
      ...auth(),
      payload: { ...validBody, paramMapping: [{ position: 5, source: { type: 'literal', value: 'x' } }] },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toHaveLength(0);
    await app.close();
  });
});

describe('POST /campaigns/:campaignId/run', () => {
  it('campagne du tenant -> 202 + job campaign-run enqueué (singletonKey + expire dimensionné)', async () => {
    const q = new FakeQueue();
    const app = appWith(new FakeRepo(contacts), { queue: q });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run', ...auth() });
    expect(res.statusCode).toBe(202);
    expect(q.enqueued).toHaveLength(1);
    expect(q.enqueued[0]).toMatchObject({ name: 'campaign-run', data: { campaignId: 'known' } });
    expect(q.enqueued[0]?.opts?.singletonKey).toBe('known');
    expect(q.enqueued[0]?.opts?.expireInSeconds).toBe(900); // 0 pending -> plancher 15 min
    await app.close();
  });

  it('expireInSeconds dimensionné sur (destinataires, débit) : grosse liste à débit bas -> timeout > 15 min', async () => {
    const q = new FakeQueue();
    // 1000 destinataires à 1/min : ~1000 min -> le timeout doit COUVRIR ça (pas la constante fixe de 15 min).
    const app = appWith(new FakeRepo(contacts), { queue: q, runSizing: { ratePerMinute: 1, pendingCount: 1000 } });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run', ...auth() });
    expect(res.statusCode).toBe(202);
    // campaignJobExpireSeconds(1000, 1) = max(900, ceil(1000/1*60*1.5)+600) = 90600 s (>> 15 min et >> 2 h).
    expect(q.enqueued[0]?.opts?.expireInSeconds).toBe(90_600);
    await app.close();
  });

  it('campagne d un autre tenant / inconnue -> 404, rien enqueué', async () => {
    const q = new FakeQueue();
    const app = appWith(new FakeRepo(contacts), { queue: q, campaignTenant: 'AUTRE' });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run', ...auth() });
    expect(res.statusCode).toBe(404);
    expect(q.enqueued).toEqual([]);
    await app.close();
  });

  it('sans token -> 401', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('role agent -> 403 sur le run', async () => {
    const q = new FakeQueue();
    const app = appWith(new FakeRepo(contacts), { queue: q });
    const res = await app.inject({ method: 'POST', url: '/campaigns/known/run', ...asAgent() });
    expect(res.statusCode).toBe(403);
    expect(q.enqueued).toEqual([]);
    await app.close();
  });
});

describe('lecture campagnes (GET)', () => {
  it('GET /tenants/:t/campaigns -> liste avec compteurs', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ campaigns: Array<{ name: string; counts: { total: number } }> }>();
    expect(body.campaigns[0]?.name).toBe('Promo');
    expect(body.campaigns[0]?.counts.total).toBe(2);
    await app.close();
  });

  it('GET campagne connue -> détail + destinataires', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns/known', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; recipients: Array<{ status: string }> }>();
    expect(body.status).toBe('completed');
    expect(body.recipients[0]?.status).toBe('sent');
    await app.close();
  });

  it('GET campagne inconnue -> 404', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns/nope', ...auth() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET numéros du tenant -> liste', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/phone-numbers', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ phoneNumbers: Array<{ id: string }> }>();
    expect(body.phoneNumbers[0]?.id).toBe('pn1');
    await app.close();
  });

  it('GET campagnes tenant != token -> 403', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/AUTRE/campaigns', ...auth() });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('GET campagnes sans token -> 401', async () => {
    const app = appWith(new FakeRepo(contacts));
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/campaigns' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
