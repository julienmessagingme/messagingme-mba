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
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

class FakeRepo implements CampaignRepoLike {
  readonly created: CreateCampaignInput[] = [];
  async listContactsForBuild(): Promise<BuildContact[]> {
    return [{ id: 'c1', phone_e164: '+33611', profile_name: 'A', fields: {}, optInStatus: 'opted_in' }];
  }
  async createWithRecipients(input: CreateCampaignInput, recipients: BuiltRecipient[]) {
    this.created.push(input);
    return { campaignId: 'camp-1', recipientCount: recipients.length };
  }
}

const TEMPLATE_ENTRY_GRAPH: WorkflowGraph = {
  nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } }],
  edges: [],
};

function appWith(
  repo: FakeRepo,
  opts: { ownsAgent?: boolean; agents?: Array<{ agentId: string; brandName: string; status: string }>; sansListe?: boolean } = {},
) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    campaigns: {
      repo,
      queue: new FakeQueue(),
      phoneNumberBelongsToTenant: async () => true,
      rcsAgentBelongsToTenant: async () => opts.ownsAgent ?? true,
      // `sansListe` simule un câblage sans canal RCS : la route doit rendre une liste vide, pas une erreur.
      ...(opts.sansListe ? {} : { listRcsAgents: async () => opts.agents ?? [] }),
      getWorkflowGraph: async () => TEMPLATE_ENTRY_GRAPH,
      campaignBelongsTo: async () => true,
      getRunSizing: async () => ({ ratePerMinute: null, pendingCount: 0 }),
      scheduleCampaign: async () => true,
      cancelSchedule: async () => true,
      listCampaigns: async () => [],
      archiveCampaign: async () => true,
      unarchiveCampaign: async () => true,
      deleteDraftCampaign: async () => true,
      getCampaignDetail: async () => null,
      resetRecipientForRetry: async () => ({ result: 'not_found' as const }),
      listPhoneNumbers: async () => [],
    },
  });
}

const rcsBody = {
  channel: 'rcs',
  name: 'Promo RCS',
  category: 'marketing',
  rcsAgentId: 'agent-1',
  rcsMessage: { kind: 'text', text: 'Offre du jour' },
  paramMapping: [],
};

async function post(app: ReturnType<typeof appWith>, payload: unknown) {
  return app.inject({ method: 'POST', url: '/tenants/t1/campaigns', ...auth(), payload: payload as object });
}

describe('GET /tenants/:tenantId/rcs-agents', () => {
  it('rend les agents du tenant', async () => {
    const app = appWith(new FakeRepo(), { agents: [{ agentId: 'agent-1', brandName: 'MessagingMe', status: 'launched' }] });
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/rcs-agents', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual([{ agentId: 'agent-1', brandName: 'MessagingMe', status: 'launched' }]);
  });

  it('rend une liste VIDE quand le canal RCS n est pas cable, jamais une erreur', async () => {
    const app = appWith(new FakeRepo(), { sansListe: true });
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/rcs-agents', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual([]);
  });

  it('refuse le tenant d un AUTRE workspace', async () => {
    const app = appWith(new FakeRepo());
    const res = await app.inject({ method: 'GET', url: '/tenants/t-autre/rcs-agents', ...auth() });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /tenants/:tenantId/campaigns sur le canal RCS', () => {
  it('accepte une campagne RCS complete SANS phoneNumberId', async () => {
    const repo = new FakeRepo();
    const res = await post(appWith(repo), rcsBody);
    expect(res.statusCode).toBe(201);
    expect(repo.created[0]).toMatchObject({
      channel: 'rcs',
      rcsAgentId: 'agent-1',
      rcsMessage: { kind: 'text', text: 'Offre du jour' },
    });
  });

  it('refuse une campagne RCS sans agent', async () => {
    const { rcsAgentId, ...sansAgent } = rcsBody;
    void rcsAgentId;
    const res = await post(appWith(new FakeRepo()), sansAgent);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('rcsAgentId');
  });

  it('refuse un agent qui n appartient PAS au tenant', async () => {
    const res = await post(appWith(new FakeRepo(), { ownsAgent: false }), rcsBody);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('rcsAgentId');
  });

  it('refuse un message RCS invalide', async () => {
    const res = await post(appWith(new FakeRepo()), { ...rcsBody, rcsMessage: { kind: 'text' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('rcsMessage');
  });

  it('refuse un message RCS d un type inconnu', async () => {
    const res = await post(appWith(new FakeRepo()), { ...rcsBody, rcsMessage: { kind: 'video', url: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('refuse une campagne RCS qui declenche un scenario (hors perimetre V1)', async () => {
    const res = await post(appWith(new FakeRepo()), { ...rcsBody, workflowId: 'w1' });
    expect(res.statusCode).toBe(400);
  });

  it('refuse un canal inconnu au lieu de retomber en silence sur WhatsApp', async () => {
    const res = await post(appWith(new FakeRepo()), { ...rcsBody, channel: 'telegram' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('channel');
  });

  it('une campagne SANS canal reste WhatsApp et exige toujours phoneNumberId', async () => {
    const res = await post(appWith(new FakeRepo()), {
      name: 'Promo', category: 'marketing', templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('phoneNumberId');
  });

  it('une campagne WhatsApp explicite garde EXACTEMENT le comportement historique', async () => {
    const repo = new FakeRepo();
    const res = await post(appWith(repo), {
      channel: 'whatsapp', phoneNumberId: 'pn1', name: 'Promo', category: 'marketing',
      templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
    });
    expect(res.statusCode).toBe(201);
    expect(repo.created[0]).toMatchObject({ channel: 'whatsapp', phoneNumberId: 'pn1', templateName: 'promo' });
  });
});
