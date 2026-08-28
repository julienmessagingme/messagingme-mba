import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import type { AgentResume } from '../src/agent/agent-store';

/**
 * Route de lecture des agents IA. Elle sert la palette du builder : sans elle, un bloc agent ne peut pas être
 * configuré, donc pas être construit.
 *
 * Ce qu'elle verrouille : l'isolation tenant (la liste est celle du workspace du jeton, pas celle de l'URL),
 * et le fait que la lecture reste ouverte à un compte non admin, comme les templates ou les formulaires.
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

const AGENTS: Record<string, AgentResume[]> = {
  t1: [{ id: 'ag1', label: 'Conseiller séjours', sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }] }],
  t2: [{ id: 'ag9', label: 'Agent du voisin', sorties: [] }],
};

function app() {
  const vus: string[] = [];
  const deps: AgentsRouteDeps = {
    listActifs: async (tenant) => { vus.push(tenant); return AGENTS[tenant] ?? []; },
  };
  return { vus, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agents: deps }) };
}

describe('GET /tenants/:id/agents', () => {
  it('rend les agents actifs du workspace, sorties comprises', async () => {
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: '/tenants/t1/agents', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agents: [{ id: 'ag1', label: 'Conseiller séjours', sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }] }],
    });
  });

  it('🔴 le tenant vient du JETON, jamais de l URL', async () => {
    // Sans cette garde, il suffirait de changer l'identifiant dans l'adresse pour lire les agents d'un autre
    // client, et leurs règles d'arrêt disent beaucoup de son métier.
    const { vus, srv } = app();
    const res = await srv.inject({ method: 'GET', url: '/tenants/t2/agents', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(vus).toEqual([]); // la lecture n'a même pas été tentée
  });

  it('🔴 réservée aux ADMINISTRATEURS, comme le builder qu elle sert', async () => {
    // Son seul consommateur est le builder, qu'un compte non admin ne peut pas ouvrir : l'ouvrir plus
    // largement élargirait la surface sans usage, et les codes des règles d'arrêt disent le métier du client.
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: '/tenants/t1/agents', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
  });

  it('sans jeton, la route est refusée', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/agents' })).statusCode).toBe(401);
  });

  it('un workspace sans agent actif rend une liste vide, pas une erreur', async () => {
    // C'est ce cas qui GRISE la brique dans la palette : il doit être nominal.
    const tok = await signSession({ userId: 'u3', tenantId: 't-vide', role: 'admin' }, SECRET);
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: '/tenants/t-vide/agents', ...h(tok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: [] });
  });
});
