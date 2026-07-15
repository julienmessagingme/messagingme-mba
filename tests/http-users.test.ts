import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import { DuplicateEmailError } from '../src/user/store.pg';
import type { UserRow, CreateUserInput } from '../src/user/store.pg';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { UsersRouteDeps } from '../src/http/users';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const EXISTING: UserRow = { id: 'u1', email: 'boss@demo.test', name: 'Boss', role: 'admin', disabled: false, pending: false, createdAt: '2026-07-01T00:00:00.000Z' };

interface Captured {
  created: Array<{ tenant: string; input: CreateUserInput }>;
  roleSet: Array<{ tenant: string; userId: string; role: string }>;
  disabledSet: Array<{ tenant: string; userId: string; disabled: boolean }>;
  deleted: Array<{ tenant: string; userId: string }>;
  invited: Array<{ tenant: string; email: string; role: string }>;
  emails: string[];
  emailObjs: Array<{ to: string; subject: string; text: string; html?: string }>;
}

function app(over: Partial<UsersRouteDeps> = {}): { server: ReturnType<typeof buildServer>; cap: Captured } {
  const cap: Captured = { created: [], roleSet: [], disabledSet: [], deleted: [], invited: [], emails: [], emailObjs: [] };
  const deps: UsersRouteDeps = {
    listUsers: async () => [EXISTING],
    createPendingUser: async (tenant, email, role) => {
      if (email === 'taken@demo.test') throw new DuplicateEmailError();
      cap.invited.push({ tenant, email, role });
      return { id: 'pending1', email, name: null, role, disabled: false, pending: true, createdAt: '2026-07-10T00:00:00.000Z' };
    },
    createInviteToken: async () => 'INVITE_RAW',
    sendEmail: async (e) => { cap.emails.push(e.text); cap.emailObjs.push(e); },
    getInviterName: async () => 'Julien',
    getWorkspaceName: async () => 'Acme Corp',
    appUrl: 'https://mba.messagingme.app',
    createUser: async (tenant, input) => {
      cap.created.push({ tenant, input });
      return { id: 'new', email: input.email, name: input.name, role: input.role, disabled: false, pending: false, createdAt: '2026-07-10T00:00:00.000Z' };
    },
    setUserRole: async (tenant, userId, role) => {
      cap.roleSet.push({ tenant, userId, role });
      return userId === 'known' ? 'ok' : 'not_found'; // 'known' existe, tout le reste -> 404
    },
    setUserDisabled: async (tenant, userId, disabled) => {
      cap.disabledSet.push({ tenant, userId, disabled });
      return userId === 'known' ? 'ok' : 'not_found';
    },
    deleteUser: async (tenant, userId) => {
      cap.deleted.push({ tenant, userId });
      return userId === 'known' ? 'ok' : 'not_found';
    },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, admin: deps }), cap };
}

describe('users route — lecture', () => {
  it('GET /users admin -> 200 + liste sans password_hash', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/users', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: UserRow[] }>();
    expect(body.users[0]?.email).toBe('boss@demo.test');
    expect(JSON.stringify(body)).not.toContain('password');
    await server.close();
  });

  it('GET /users agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/users', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('GET /users sans token -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/users' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('GET /users tenant != token -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/AUTRE/users', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

describe('users route — création', () => {
  it('POST /users admin -> 201, email normalisé + password hashé (jamais en clair)', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/users', ...h(adminTok),
      payload: { email: '  Agent@Demo.TEST ', password: 'motdepasse123', role: 'agent', name: 'Marie' },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.created).toHaveLength(1);
    const input = cap.created[0]!.input;
    expect(input.email).toBe('agent@demo.test'); // trim + lowercase
    expect(input.role).toBe('agent');
    expect(input.name).toBe('Marie');
    expect(input.passwordHash.startsWith('scrypt$')).toBe(true); // hashé, pas en clair
    expect(input.passwordHash).not.toContain('motdepasse123');
    await server.close();
  });

  it('POST /users email invalide -> 400', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/users', ...h(adminTok), payload: { email: 'pasunemail', password: 'motdepasse123', role: 'agent' } });
    expect(res.statusCode).toBe(400);
    expect(cap.created).toHaveLength(0);
    await server.close();
  });

  it('POST /users mot de passe trop court -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/users', ...h(adminTok), payload: { email: 'a@b.fr', password: 'court', role: 'agent' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('POST /users role invalide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/users', ...h(adminTok), payload: { email: 'a@b.fr', password: 'motdepasse123', role: 'superadmin' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('POST /users email déjà pris -> 409', async () => {
    const { server } = app({ createUser: async () => { throw new DuplicateEmailError(); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/users', ...h(adminTok), payload: { email: 'a@b.fr', password: 'motdepasse123', role: 'agent' } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it('POST /users agent -> 403 (ne crée rien)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/users', ...h(agentTok), payload: { email: 'a@b.fr', password: 'motdepasse123', role: 'agent' } });
    expect(res.statusCode).toBe(403);
    expect(cap.created).toHaveLength(0);
    await server.close();
  });
});

describe('users route — changement de rôle', () => {
  it('PATCH role admin -> 200', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/role', ...h(adminTok), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(200);
    expect(cap.roleSet[0]).toEqual({ tenant: 't1', userId: 'known', role: 'admin' });
    await server.close();
  });

  it('PATCH role sur soi-même -> 400 (self-block, ne modifie rien)', async () => {
    const { server, cap } = app();
    // adminTok a userId 'u1'
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/u1/role', ...h(adminTok), payload: { role: 'agent' } });
    expect(res.statusCode).toBe(400);
    expect(cap.roleSet).toHaveLength(0);
    await server.close();
  });

  it('PATCH role invalide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/role', ...h(adminTok), payload: { role: 'root' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH role user inconnu -> 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/ghost/role', ...h(adminTok), payload: { role: 'agent' } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('PATCH rétrograder le dernier admin -> 409 (invariant >=1 admin)', async () => {
    const { server } = app({ setUserRole: async () => 'last_admin' });
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/role', ...h(adminTok), payload: { role: 'agent' } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it('PATCH role agent -> 403 (ne modifie rien)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/role', ...h(agentTok), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(403);
    expect(cap.roleSet).toHaveLength(0);
    await server.close();
  });
});

describe('users route — révocation', () => {
  it('PATCH disabled=true admin -> 200 (révoque)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/disabled', ...h(adminTok), payload: { disabled: true } });
    expect(res.statusCode).toBe(200);
    expect(cap.disabledSet[0]).toEqual({ tenant: 't1', userId: 'known', disabled: true });
    await server.close();
  });

  it('PATCH disabled=false -> 200 (réactive)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/disabled', ...h(adminTok), payload: { disabled: false } });
    expect(res.statusCode).toBe(200);
    expect(cap.disabledSet[0]?.disabled).toBe(false);
    await server.close();
  });

  it('PATCH disabled body invalide -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/disabled', ...h(adminTok), payload: { disabled: 'oui' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH disabled sur soi-même -> 400 (self-block, ne modifie rien)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/u1/disabled', ...h(adminTok), payload: { disabled: true } });
    expect(res.statusCode).toBe(400);
    expect(cap.disabledSet).toHaveLength(0);
    await server.close();
  });

  it('PATCH disabled dernier admin actif -> 409', async () => {
    const { server } = app({ setUserDisabled: async () => 'last_admin' });
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/disabled', ...h(adminTok), payload: { disabled: true } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it('PATCH disabled user inconnu -> 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/ghost/disabled', ...h(adminTok), payload: { disabled: true } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('PATCH disabled agent -> 403 (ne modifie rien)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/disabled', ...h(agentTok), payload: { disabled: true } });
    expect(res.statusCode).toBe(403);
    expect(cap.disabledSet).toHaveLength(0);
    await server.close();
  });
});

describe('users route — suppression', () => {
  it('DELETE admin -> 200 (supprime)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/users/known', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(cap.deleted[0]).toEqual({ tenant: 't1', userId: 'known' });
    await server.close();
  });

  it('DELETE sur soi-même -> 400 (self-block, ne supprime rien)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/users/u1', ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    expect(cap.deleted).toHaveLength(0);
    await server.close();
  });

  it('DELETE dernier admin actif -> 409', async () => {
    const { server } = app({ deleteUser: async () => 'last_admin' });
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/users/known', ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it('DELETE user inconnu -> 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/users/ghost', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('DELETE agent -> 403 (ne supprime rien)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/users/known', ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    expect(cap.deleted).toHaveLength(0);
    await server.close();
  });
});

describe('users route — invitation', () => {
  it('POST /invitations admin -> 201, compte en attente créé + email envoyé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok), payload: { email: 'New@Demo.test', role: 'agent' } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ emailSent: boolean; user: { pending: boolean } }>()).toMatchObject({ emailSent: true, user: { pending: true } });
    expect(cap.invited).toEqual([{ tenant: 't1', email: 'new@demo.test', role: 'agent' }]); // email normalisé
    expect(cap.emails[0]).toContain('/invite/INVITE_RAW');
    // Email HTML brandé + personnalisé (invitant + espace), sans jamais « UChat ».
    const sent = cap.emailObjs[0]!;
    expect(sent.html).toBeDefined();
    expect(sent.html).toContain('Julien');
    expect(sent.html).toContain('Acme Corp');
    expect(sent.html).toContain('/invite/INVITE_RAW');
    expect(sent.html!.toLowerCase()).not.toContain('uchat');
    expect(sent.subject).toContain('Acme Corp');
  });
  it('POST /invitations email déjà pris -> 409', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok), payload: { email: 'taken@demo.test', role: 'agent' } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
  it('POST /invitations email/role invalide -> 400', async () => {
    const { server } = app();
    const bad = await server.inject({ method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok), payload: { email: 'x', role: 'agent' } });
    const role = await server.inject({ method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok), payload: { email: 'a@b.co', role: 'root' } });
    expect([bad.statusCode, role.statusCode]).toEqual([400, 400]);
    await server.close();
  });
  it('POST /invitations agent -> 403 (admin-only)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/invitations', ...h(agentTok), payload: { email: 'a@b.co', role: 'agent' } });
    expect(res.statusCode).toBe(403);
    expect(cap.invited).toHaveLength(0);
    await server.close();
  });
});
