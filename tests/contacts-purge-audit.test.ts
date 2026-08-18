import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { ContactsRouteDeps } from '../src/http/contacts';

/**
 * La purge d'un contact et sa trace auditable.
 *
 * Deux exigences qui se contredisent si on n'y prend pas garde : ne plus rien garder de la personne, et garder
 * une preuve de l'action. Le journal ne peut donc porter que l'identifiant interne du contact, jamais son
 * numéro. C'est ce que vérifie le test le plus important de ce fichier.
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

interface Trace { action: string; target: { kind: string; id: string }; detail: Record<string, unknown>; actor: { userId: string | null } }

function app(over: Partial<ContactsRouteDeps> = {}) {
  const journal: Trace[] = [];
  const purges: string[][] = [];
  const editsRecus: unknown[] = [];
  const deps = {
    applyEdits: async () => null,
    applyEditsMany: async (_t: string, _target: unknown, edits: unknown) => { editsRecus.push(edits); return 4; },
    createOneContact: async () => ({ status: 'created' as const, contactId: 'c-neuf' }),
    listAudit: async () => [
      { id: 'a1', at: '2026-08-18T10:00:00.000Z', actorEmail: 'julien@messagingme.fr', action: 'contact.purged' as const, targetKind: 'contact', targetId: 'c1', detail: { lot: 1 } },
    ],
    listUserFields: async () => [],
    contactIdsForTarget: async (_t: string, target: unknown) => ('ids' in (target as { ids?: string[] }) ? (target as { ids: string[] }).ids : ['c-filtre']),
    purgeMany: async (_t: string, ids: readonly string[]) => {
      purges.push([...ids]);
      return { purges: ids.length, conversations: ids.length, messages: 12, analyses: 1 };
    },
    audit: async (_t: string, actor: { userId: string | null }, action: string, target: { kind: string; id: string }, detail: Record<string, unknown> = {}) => {
      journal.push({ action, target, detail, actor });
    },
    ...over,
  } as unknown as ContactsRouteDeps;
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, contacts: deps }), journal, purges, editsRecus };
}

const url = '/tenants/t1/contacts/purge';

describe('suppression d’un contact (la seule, et elle efface)', () => {
  it('🔴 exige une confirmation explicite, et ne purge RIEN sans elle', async () => {
    // L'action est irréversible et peut viser des milliers de fiches d'un coup via des filtres : sans cette
    // garde, un appel malformé suffirait.
    const { server, purges } = app();
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { ids: ['c1'] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('SUPPRIMER');
    expect(purges).toEqual([]);
    await server.close();
  });

  it('confirmée : purge la cible et rend le détail de ce qui a été effacé', async () => {
    const { server, purges } = app();
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { ids: ['c1', 'c2'] }, confirm: 'SUPPRIMER' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ purges: 2, conversations: 2, messages: 12, analyses: 1 });
    expect(purges).toEqual([['c1', 'c2']]);
    await server.close();
  });

  it('accepte aussi une cible par FILTRES, résolue en identifiants avant purge', async () => {
    const { server, purges } = app();
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { filters: { tags: ['vip'] } }, confirm: 'SUPPRIMER' } });
    expect(res.statusCode).toBe(200);
    expect(purges).toEqual([['c-filtre']]);
    await server.close();
  });

  it('un filtre qui ne matche personne -> rien à faire, et surtout aucun appel de purge', async () => {
    // Le cas réel : un filtre qui ne ramène rien. Une liste d'identifiants vide, elle, est refusée en amont
    // comme cible invalide, au même titre que pour la suppression douce.
    const { server, purges } = app({ contactIdsForTarget: async () => [] } as never);
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { filters: { tags: ['inexistant'] } }, confirm: 'SUPPRIMER' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ purges: 0 });
    expect(purges).toEqual([]);
    await server.close();
  });

  it('réservée aux admins', async () => {
    const { server, purges } = app();
    const res = await server.inject({ method: 'POST', url, ...h(agentTok), payload: { target: { ids: ['c1'] }, confirm: 'SUPPRIMER' } });
    expect(res.statusCode).toBe(403);
    expect(purges).toEqual([]);
    await server.close();
  });

  it('instance sans purge câblée -> 503, pas un faux succès', async () => {
    const { server } = app({ purgeMany: undefined, contactIdsForTarget: undefined } as never);
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { ids: ['c1'] }, confirm: 'SUPPRIMER' } });
    expect(res.statusCode).toBe(503);
    await server.close();
  });
});

describe('journal d’audit', () => {
  it('🔴 le journal ne porte AUCUNE donnée personnelle, seulement l’identifiant interne', async () => {
    // C'est l'exigence qui fait tenir les deux promesses à la fois. Écrire le numéro au moment de la purge
    // annulerait la purge : on effacerait la personne d'un côté pour la réinscrire de l'autre, dans une table
    // conçue pour ne jamais être modifiée.
    const { server, journal } = app();
    await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { ids: ['c1'] }, confirm: 'SUPPRIMER' } });
    const trace = journal.find((t) => t.action === 'contact.purged');
    expect(trace).toBeDefined();
    expect(trace?.target).toEqual({ kind: 'contact', id: 'c1' });
    const serialise = JSON.stringify(trace);
    expect(serialise).not.toMatch(/\+?\d{9,}/); // aucun numéro de téléphone, sous aucune forme
    expect(serialise.toLowerCase()).not.toContain('phone');
    await server.close();
  });

  it('enregistre QUI a agi', async () => {
    const { server, journal } = app();
    await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { ids: ['c1'] }, confirm: 'SUPPRIMER' } });
    expect(journal[0]?.actor.userId).toBe('u1');
    await server.close();
  });

  it('🔴 un journal en échec ne fait PAS échouer la purge', async () => {
    // L'inverse serait absurde : une panne d'écriture de log empêcherait un client d'exercer son droit à
    // l'effacement. L'échec reste visible en console.
    const { server } = app({ audit: async () => { throw new Error('base indisponible'); } } as never);
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { target: { ids: ['c1'] }, confirm: 'SUPPRIMER' } });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

describe('bascule du consentement (le seul chemin qui sait écrire opted_out)', () => {
  const bulk = '/tenants/t1/contacts/bulk';

  it('🔴 opt-out : écrit le statut ET laisse une trace `contact.optout`', async () => {
    // Avant cette action, `opted_out` était une valeur que les filtres et le garde-fou de campagne savaient
    // LIRE, mais qu'aucun chemin d'écriture ne posait jamais : un client demandant à ne plus rien recevoir
    // n'était enregistrable nulle part.
    const { server, journal, editsRecus } = app();
    const res = await server.inject({ method: 'POST', url: bulk, ...h(adminTok), payload: { target: { ids: ['c1', 'c2'] }, action: { type: 'set_optin', value: 'opted_out' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ affected: 4 });
    expect(editsRecus).toEqual([{ setOptIn: 'opted_out' }]);
    expect(journal.find((t) => t.action === 'contact.optout')?.detail).toEqual({ affected: 4 });
    await server.close();
  });

  it('opt-in : même chemin, action `contact.optin`', async () => {
    const { server, journal, editsRecus } = app();
    await server.inject({ method: 'POST', url: bulk, ...h(adminTok), payload: { target: { ids: ['c1'] }, action: { type: 'set_optin', value: 'opted_in' } } });
    expect(editsRecus).toEqual([{ setOptIn: 'opted_in' }]);
    expect(journal.map((t) => t.action)).toEqual(['contact.optin']);
    await server.close();
  });

  it('🔴 valeur libre refusée : rien n’est écrit', async () => {
    // Sans cette garde, un `value` fantaisiste partirait tel quel vers un `update ... opt_in_status = $1` que
    // seule la contrainte CHECK de la table arrêterait, en 500.
    const { server, editsRecus } = app();
    for (const value of ['peut_etre', '', null, 'OPTED_OUT']) {
      const res = await server.inject({ method: 'POST', url: bulk, ...h(adminTok), payload: { target: { ids: ['c1'] }, action: { type: 'set_optin', value } } });
      expect(res.statusCode).toBe(400);
    }
    expect(editsRecus).toEqual([]);
    await server.close();
  });

  it('réservée aux admins', async () => {
    const { server, editsRecus } = app();
    const res = await server.inject({ method: 'POST', url: bulk, ...h(agentTok), payload: { target: { ids: ['c1'] }, action: { type: 'set_optin', value: 'opted_out' } } });
    expect(res.statusCode).toBe(403);
    expect(editsRecus).toEqual([]);
    await server.close();
  });
});

describe('entrée d’un contact dans la base', () => {
  it('🔴 une création à la main laisse une trace, et dit si la fiche EXISTAIT déjà', async () => {
    // L'upsert partagé met à jour un numéro déjà connu au lieu d'échouer : sans ce détail, l'historique
    // laisserait croire à une création là où il n'y a eu qu'une mise à jour.
    const { server, journal } = app({ createOneContact: async () => ({ status: 'updated', contactId: 'c-deja-la' }) } as never);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: { phone: '+33600000001', optIn: true } });
    expect(res.statusCode).toBe(200);
    const trace = journal.find((t) => t.action === 'contact.created');
    expect(trace?.target).toEqual({ kind: 'contact', id: 'c-deja-la' });
    expect(trace?.detail).toEqual({ status: 'updated', optIn: true });
    await server.close();
  });

  it('🔴 le journal dit l’opt-in RÉELLEMENT appliqué, pas celui du corps reçu', async () => {
    // Un corps sans `optIn` crée un contact OPT-IN (défaut de la saisie à la main). Le journal doit dire
    // « oui ». Il a dit « non » le temps d'un déploiement, parce que la valeur était calculée deux fois : à la
    // création avec le défaut, au journal sans. Un registre d'audit qui ment est pire que pas de registre.
    const recus: Array<{ optIn?: boolean }> = [];
    const { server, journal } = app({
      createOneContact: async (_t: string, input: { optIn?: boolean }) => { recus.push(input); return { status: 'created', contactId: 'c-neuf' }; },
    } as never);
    await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: { phone: '+33600000001' } });
    expect(recus[0]?.optIn).toBe(true);
    expect(journal.find((t) => t.action === 'contact.created')?.detail).toEqual({ status: 'created', optIn: true });
    await server.close();
  });

  it('case DÉCOCHÉE : le journal le dit aussi', async () => {
    const { server, journal } = app();
    await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: { phone: '+33600000001', optIn: false } });
    expect(journal.find((t) => t.action === 'contact.created')?.detail).toMatchObject({ optIn: false });
    await server.close();
  });

  it('une création REFUSÉE ne laisse aucune trace', async () => {
    const { server, journal } = app({ createOneContact: async () => ({ status: 'error', reason: 'numéro invalide' }) } as never);
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: { phone: 'nawak' } });
    expect(res.statusCode).toBe(400);
    expect(journal).toEqual([]);
    await server.close();
  });
});

describe('lecture du journal', () => {
  const url = '/tenants/t1/audit';

  it('rend l’historique de l’espace', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: unknown[] }>().entries).toHaveLength(1);
    await server.close();
  });

  it('🔴 instance sans journal -> 503, PAS une liste vide', async () => {
    // Une liste vide se lirait « il ne s'est rien passé », ce qui est le contraire de ce qu'un journal doit
    // savoir dire quand il est absent.
    const { server } = app({ listAudit: undefined } as never);
    const res = await server.inject({ method: 'GET', url, ...h(adminTok) });
    expect(res.statusCode).toBe(503);
    await server.close();
  });

  it('réservée aux admins', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url, ...h(agentTok) })).statusCode).toBe(403);
    await server.close();
  });
});
