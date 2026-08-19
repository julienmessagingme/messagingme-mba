import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import { NomDeTableauDejaPris } from '../src/workflow/reports.pg';
import type { WorkflowReportsRouteDeps } from '../src/http/workflow-reports';

/**
 * Les tableaux ENREGISTRÉS d'Analytics > Mes tableaux.
 *
 * Un tableau ne contient que la SÉLECTION, jamais des chiffres : les compteurs se recalculent à la lecture.
 * Ce qui se teste ici est donc la validation de cette sélection et le cloisonnement par espace.
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
const REPORT = { id: 'rp1', workflowId: 'wf1', name: 'Entonnoir', mesures: [{ cle: 'n1|sent', label: 'Envoyés', kind: 'sent', handle: null }], updatedAt: '2026-08-19T10:00:00.000Z' };
const url = '/tenants/t1/workflow-reports';

function app(over: Partial<WorkflowReportsRouteDeps> = {}) {
  const recus: Array<Record<string, unknown>> = [];
  const deps = {
    listReports: async () => [REPORT],
    saveReport: async (_t: string, input: Record<string, unknown>) => { recus.push(input); return REPORT; },
    removeReport: async () => true,
    ...over,
  } as unknown as WorkflowReportsRouteDeps;
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, workflowReports: deps }), recus };
}

describe('enregistrer un tableau', () => {
  it('nom + scénario + mesures -> enregistré', async () => {
    const { server, recus } = app();
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { workflowId: 'wf1', name: '  Entonnoir  ', mesures: REPORT.mesures } });
    expect(res.statusCode).toBe(200);
    expect(recus[0]).toMatchObject({ workflowId: 'wf1', name: 'Entonnoir' }); // le nom est nettoyé
    await server.close();
  });

  it('🔴 un tableau SANS mesure est refusé', async () => {
    // Il ne mesurerait rien et reviendrait vide à l'ouverture, ce qui se lirait comme une panne.
    const { server, recus } = app();
    for (const mesures of [[], undefined, 'pas un tableau']) {
      const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { workflowId: 'wf1', name: 'x', mesures } });
      expect(res.statusCode).toBe(400);
    }
    expect(recus).toEqual([]);
    await server.close();
  });

  it('nom vide ou scénario absent -> 400', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url, ...h(adminTok), payload: { workflowId: 'wf1', name: '   ', mesures: REPORT.mesures } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url, ...h(adminTok), payload: { name: 'x', mesures: REPORT.mesures } })).statusCode).toBe(400);
    await server.close();
  });

  it('🔴 les mesures reçues sont NETTOYÉES et plafonnées', async () => {
    // Donnée cliente : rien n'empêche d'envoyer mille mesures ou des champs fantaisistes.
    const { server, recus } = app();
    const brutes = [
      { cle: 'n1|sent', label: 'x', kind: 'sent', handle: '' },
      { cle: '', label: 'sans cle', kind: 'sent', handle: null },
      'pas un objet',
      ...Array.from({ length: 200 }, (_, i) => ({ cle: `n|${i}`, label: 'x', kind: 'sent', handle: null })),
    ];
    await server.inject({ method: 'POST', url, ...h(adminTok), payload: { workflowId: 'wf1', name: 'x', mesures: brutes } });
    const gardees = (recus[0]!.mesures as unknown[]);
    expect(gardees).toHaveLength(100); // plafonné
    expect((gardees[0] as { handle: unknown }).handle).toBeNull(); // chaîne vide -> null
    await server.close();
  });

  it('🔴 un nom DÉJÀ pris sort en 409, pas en 500', async () => {
    // Un 5xx verrait son corps remplacé par la page d'erreur de Cloudflare : l'opérateur ne saurait même pas
    // qu'il s'agit d'un nom déjà utilisé.
    const { server } = app({ saveReport: async () => { throw new NomDeTableauDejaPris(); } });
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { workflowId: 'wf1', name: 'Entonnoir', mesures: REPORT.mesures } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('nom');
    await server.close();
  });

  it('🔴 un identifiant inconnu -> 404, jamais une création sous cet identifiant', async () => {
    // Créer sous un id imposé par l'appelant laisserait deviner l'existence d'un tableau d'un autre espace.
    const { server } = app({ saveReport: async () => null });
    const res = await server.inject({ method: 'POST', url, ...h(adminTok), payload: { id: 'rp-autre', workflowId: 'wf1', name: 'x', mesures: REPORT.mesures } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('réservé aux admins (l’agent lit, n’écrit pas)', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url, ...h(agentTok), payload: { workflowId: 'wf1', name: 'x', mesures: REPORT.mesures } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'DELETE', url: `${url}/rp1`, ...h(agentTok) })).statusCode).toBe(403);
    await server.close();
  });
});

describe('lister et supprimer', () => {
  it('la liste rend les tableaux de l’espace', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ reports: unknown[] }>().reports).toEqual([REPORT]);
    await server.close();
  });

  it('supprimer un tableau inconnu -> 404', async () => {
    const { server } = app({ removeReport: async () => false });
    expect((await server.inject({ method: 'DELETE', url: `${url}/rp-inconnu`, ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });
});
