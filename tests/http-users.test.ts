import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import { DuplicateEmailError } from '../src/user/store.pg';
import type { UserRow } from '../src/user/store.pg';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { UsersRouteDeps } from '../src/http/users';
import { detailSansDonneesPersonnelles } from '../src/audit/store.pg';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const EXISTING: UserRow = { id: 'u1', email: 'boss@demo.test', name: 'Boss', role: 'admin', disabled: false, pending: false, createdAt: '2026-07-01T00:00:00.000Z', lastLoginAt: '2026-07-17T09:30:00.000Z' };

interface Captured {
  roleSet: Array<{ tenant: string; userId: string; role: string }>;
  disabledSet: Array<{ tenant: string; userId: string; disabled: boolean }>;
  deleted: Array<{ tenant: string; userId: string }>;
  invited: Array<{ tenant: string; email: string; role: string; name?: string }>;
  nameSet: Array<{ tenant: string; userId: string; name: string }>;
  emails: string[];
  emailObjs: Array<{ to: string; subject: string; text: string; html?: string }>;
}

function app(over: Partial<UsersRouteDeps> = {}): { server: ReturnType<typeof buildServer>; cap: Captured } {
  const cap: Captured = { roleSet: [], disabledSet: [], deleted: [], invited: [], emails: [], emailObjs: [], nameSet: [] };
  const deps: UsersRouteDeps = {
    listUsers: async () => [EXISTING],
    createPendingUser: async (tenant, email, role, name) => {
      if (email === 'taken@demo.test') throw new DuplicateEmailError();
      cap.invited.push({ tenant, email, role, ...(name ? { name } : {}) });
      // Une invitation en attente n'a par construction jamais servi à se connecter.
      return { id: 'pending1', email, name: null, role, disabled: false, pending: true, createdAt: '2026-07-10T00:00:00.000Z', lastLoginAt: null };
    },
    createInviteToken: async () => 'INVITE_RAW',
    sendEmail: async (e) => { cap.emails.push(e.text); cap.emailObjs.push(e); },
    getInviterName: async () => 'Julien',
    getWorkspaceName: async () => 'Acme Corp',
    appUrl: 'https://mba.messagingme.app',
    setUserName: async (tenant, userId, name) => {
      cap.nameSet.push({ tenant, userId, name });
      return userId === 'known' ? 'ok' : 'not_found';
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

describe('users route — création par mot de passe RETIRÉE (invitations only)', () => {
  it('POST /users -> 404 (route supprimée)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/users', ...h(adminTok), payload: { email: 'a@b.fr', password: 'motdepasse123', role: 'agent' } });
    expect(res.statusCode).toBe(404);
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

  it('🔴 PATCH role manager -> 200 (le 3e statut est attribuable)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/role', ...h(adminTok), payload: { role: 'manager' } });
    expect(res.statusCode).toBe(200);
    expect(cap.roleSet[0]).toEqual({ tenant: 't1', userId: 'known', role: 'manager' });
    await server.close();
  });

  it('🔴 un manager n’est PAS un admin : il ne change aucun rôle', async () => {
    // Le statut existe, il n'ouvre aucune écriture. Si cette barrière tombait, « manager » deviendrait un
    // second admin sans que personne ne l'ait décidé.
    const managerTok = await signSession({ userId: 'u3', tenantId: 't1', role: 'manager' }, SECRET);
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/role', ...h(managerTok), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(403);
    expect(cap.roleSet).toHaveLength(0);
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
  it('🔴 POST /invitations manager -> 201 (on peut inviter au 3e statut)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok), payload: { email: 'chef@demo.test', role: 'manager' } });
    expect(res.statusCode).toBe(201);
    expect(cap.invited[0]).toEqual({ tenant: 't1', email: 'chef@demo.test', role: 'manager' });
    // Et l'email d'invitation le nomme, plutôt que de recracher la valeur technique.
    expect(cap.emailObjs[0]?.html).toContain('manager');
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

/**
 * LE NOM AFFICHÉ D'UN MEMBRE.
 *
 * 🔴 CE QUE CETTE ROUTE RÉPARE : la colonne `users.name` existait depuis toujours, tous les écrans font déjà
 * `name ?? email`, et RIEN ne permettait de l'écrire. L'Inbox affichait donc des adresses e-mail partout,
 * jusque dans « suivi par… ». Demandé par Julien le 2026-09-11.
 */
describe('users route — le nom affiché', () => {
  it('un admin renomme un membre', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/name', ...h(adminTok), payload: { name: '  Camille  ' } });
    expect(res.statusCode).toBe(200);
    // ⚠️ Le nom rendu est le nom EFFECTIF, espaces retirés : l'écran affiche ce qui est en base, pas ce qui a
    // été tapé.
    expect(res.json()).toEqual({ id: 'known', name: 'Camille' });
    expect(cap.nameSet).toEqual([{ tenant: 't1', userId: 'known', name: '  Camille  ' }]);
  });

  it('🔴 une chaîne VIDE efface le nom, elle n’enregistre pas un nom vide', async () => {
    // Sans ça, le repli `name ?? email` cesserait de s'appliquer et les écrans afficheraient du blanc à la
    // place de l'adresse, ce qui est pire que l'adresse.
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/name', ...h(adminTok), payload: { name: '   ' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'known', name: null });
  });

  it('un membre inconnu (ou d’un autre espace) rend 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/inconnu/name', ...h(adminTok), payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);
  });

  it('⚠️ un nom trop long est refusé, avec la limite dans le message', async () => {
    // C'est un libellé d'écran : il s'affiche dans la liste des membres, dans le sélecteur d'affectation de
    // l'Inbox et dans « suivi par… ». Trop long, il déborde des trois à la fois.
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/name', ...h(adminTok), payload: { name: 'a'.repeat(61) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/60/);
  });

  it('un corps sans `name` est refusé', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/name', ...h(adminTok), payload: {} })).statusCode).toBe(400);
  });

  it('🔴 un MANAGER ne renomme personne : ce module est admin-only', async () => {
    const managerTok = await signSession({ userId: 'u3', tenantId: 't1', role: 'manager' }, SECRET);
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/users/known/name', ...h(managerTok), payload: { name: 'X' } });
    expect(res.statusCode).toBe(403);
    expect(cap.nameSet).toEqual([]);
  });

  it('⚠️ le nom peut être posé DÈS L’INVITATION', async () => {
    // Sans lui, le nouveau membre apparaît sous son adresse e-mail dans toute l'Inbox jusqu'à ce que
    // quelqu'un pense à le renommer.
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok),
      payload: { email: 'nouveau@demo.test', role: 'agent', name: 'Camille' },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.invited[0]).toMatchObject({ email: 'nouveau@demo.test', name: 'Camille' });
  });

  it('une invitation SANS nom reste possible, exactement comme avant', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/invitations', ...h(adminTok),
      payload: { email: 'sansnom@demo.test', role: 'agent' },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.invited[0]?.name).toBeUndefined();
  });
});

/**
 * LE NOM DE L'ESPACE (2026-09-25) : la carte « Espace » de Compte & équipe.
 *
 * 🔴 `tenants.name` s'affichait à la connexion et dans /ops, et rien ne permettait de le changer. Ce qui compte
 * ici : un agent ne renomme rien, un admin ne renomme que SON espace, un nom illisible est refusé avant toute
 * écriture, et un renommage laisse une ligne de journal qui survit au filtre des données personnelles.
 */
describe('users route : le nom de l’espace', () => {
  interface Trace { ecrits: Array<{ tenant: string; nom: string }>; audit: Array<{ action: string; target: { kind: string; id: string }; detail: Record<string, unknown> }> }
  function appEspace(nomActuel: string | null = 'Demo +33 5 25 68 02 50') {
    const trace: Trace = { ecrits: [], audit: [] };
    const { server } = app({
      getWorkspaceName: async () => nomActuel,
      renommerEspace: async (tenant, nom) => { trace.ecrits.push({ tenant, nom }); return true; },
      audit: async (_t, _acteur, action, target, detail) => { trace.audit.push({ action, target, detail: detail ?? {} }); },
    });
    return { server, trace };
  }
  const renommer = (tok: string, nom: unknown, tenant = 't1') =>
    ({ method: 'PATCH' as const, url: `/tenants/${tenant}/nom`, ...h(tok), payload: { nom } });

  it('un admin lit le nom de son espace', async () => {
    const { server } = appEspace();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/nom', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nom: 'Demo +33 5 25 68 02 50' });
  });

  it('🔴 un admin renomme son espace : 200, le nom ROGNÉ est écrit et rendu, et une ligne de journal part', async () => {
    const { server, trace } = appEspace();
    const res = await server.inject(renommer(adminTok, '  Maison Dupont  '));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nom: 'Maison Dupont' });
    expect(trace.ecrits).toEqual([{ tenant: 't1', nom: 'Maison Dupont' }]);
    expect(trace.audit).toEqual([{ action: 'espace.renomme', target: { kind: 'tenant', id: 't1' }, detail: {} }]);
  });

  /**
   * 🔴 LE JOURNAL NE GARDE NI L'ANCIEN NOM NI LE NOUVEAU (relecture du 2026-09-25). Il les portait sous `ancien` et
   * `nouveau`, deux clés choisies pour échapper au filtre des données personnelles, alors qu'un nom d'espace peut
   * être celui d'une personne (« Espace de Jean Dupont », construit par l'inscription Google) ou porter un numéro
   * (celui de ce test). `audit_log` est gardé deux ans et ne suit pas le départ de la personne.
   */
  it('🔴 aucun des deux noms n’entre dans le journal, sous aucune clé', async () => {
    const { server, trace } = appEspace('Espace de Jean Dupont');
    await server.inject(renommer(adminTok, 'Demo +33 5 25 68 02 50'));
    expect(trace.audit).toHaveLength(1);
    const brut = JSON.stringify(trace.audit[0]!.detail);
    expect(brut).not.toContain('Jean Dupont');
    expect(brut).not.toContain('+33');
    expect(detailSansDonneesPersonnelles(trace.audit[0]!.detail).refuses).toEqual([]);
  });

  it('🔴 un AGENT et un MANAGER ne lisent ni ne renomment rien : 403, aucune écriture, aucun journal', async () => {
    const managerTok = await signSession({ userId: 'u3', tenantId: 't1', role: 'manager' }, SECRET);
    const { server, trace } = appEspace();
    for (const tok of [agentTok, managerTok]) {
      expect((await server.inject(renommer(tok, 'Pirate'))).statusCode).toBe(403);
      expect((await server.inject({ method: 'GET', url: '/tenants/t1/nom', ...h(tok) })).statusCode).toBe(403);
    }
    expect(trace.ecrits).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  it('🔴 isolation : un admin de l’espace t1 ne renomme pas l’espace t2', async () => {
    const { server, trace } = appEspace();
    expect((await server.inject(renommer(adminTok, 'Pirate', 't2'))).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/tenants/t2/nom', ...h(adminTok) })).statusCode).toBe(403);
    expect(trace.ecrits).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  it('🔴 400 : vide, blanc, trop long, caractère de contrôle (C0, DEL, C1), pas une chaîne, absent ; rien n’est écrit', async () => {
    const { server, trace } = appEspace();
    for (const nom of ['', '   ', 'a'.repeat(81), 'Maison\nDupont', 'Maison\u0000', 'Maison\u007f', 'Maison\u0085Dupont', 42, null]) {
      const res = await server.inject(renommer(adminTok, nom));
      expect(res.statusCode, JSON.stringify(nom)).toBe(400);
      expect(res.json().error).toMatch(/80/);
    }
    expect((await server.inject({ method: 'PATCH', url: '/tenants/t1/nom', ...h(adminTok), payload: {} })).statusCode).toBe(400);
    expect(trace.ecrits).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  /**
   * 🔴 LES INVISIBLES ET LES INVERSIONS DE SENS D'ÉCRITURE (relecture du 2026-09-25). Le nom est le seul repère de
   * l'écran de choix d'espace : un admin qui y invite quelqu'un pouvait renommer son espace en un nom invisible,
   * inversé, ou fait de caractères de remplissage, et la sonde de la relecture les a tous vus passer en 200.
   */
  it('🔴 400 : espace de largeur nulle, inversion du sens (RLO), isolat bidirectionnel, séparateur de ligne, remplissage hangul, ponctuation seule', async () => {
    const { server, trace } = appEspace();
    for (const nom of ['\u200B', 'Acme\u202Eevil', '\u2066x', 'A\u2028B', 'A\u2029B', '\u3164', 'Acme\u115F', '---', '\u00A0\u00A0']) {
      const res = await server.inject(renommer(adminTok, nom));
      expect(res.statusCode, JSON.stringify(nom)).toBe(400);
      expect(res.json().error, JSON.stringify(nom)).toMatch(/80/);
    }
    expect(trace.ecrits).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  it('un nom accentué, avec un chiffre, une apostrophe, une esperluette ou un émoji simple passe', async () => {
    const { server, trace } = appEspace();
    for (const nom of ['Hôtel d’Été & Cie', 'Garage 2000', 'Café ☕', '東京']) {
      expect((await server.inject(renommer(adminTok, nom))).statusCode, nom).toBe(200);
    }
    expect(trace.ecrits.map((e) => e.nom)).toEqual(['Hôtel d’Été & Cie', 'Garage 2000', 'Café ☕', '東京']);
  });

  it('la borne est incluse : 80 caractères passent, et les espaces autour ne comptent pas', async () => {
    const { server, trace } = appEspace();
    expect((await server.inject(renommer(adminTok, ` ${'a'.repeat(80)} `))).statusCode).toBe(200);
    expect(trace.ecrits).toEqual([{ tenant: 't1', nom: 'a'.repeat(80) }]);
  });

  it('un nom inchangé ne réécrit rien et ne journalise rien', async () => {
    const { server, trace } = appEspace('Maison Dupont');
    const res = await server.inject(renommer(adminTok, ' Maison Dupont '));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nom: 'Maison Dupont' });
    expect(trace.ecrits).toEqual([]);
    expect(trace.audit).toEqual([]);
  });

  it('espace introuvable : 404, rien n’est écrit', async () => {
    const { server, trace } = appEspace(null);
    expect((await server.inject(renommer(adminTok, 'Maison Dupont'))).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/nom', ...h(adminTok) })).statusCode).toBe(404);
    expect(trace.ecrits).toEqual([]);
  });

  it('câblage sans l’écriture : 503, et la lecture reste possible', async () => {
    const { server } = app({ getWorkspaceName: async () => 'Acme Corp' });
    expect((await server.inject(renommer(adminTok, 'X'))).statusCode).toBe(503);
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/nom', ...h(adminTok) })).statusCode).toBe(200);
  });
});
