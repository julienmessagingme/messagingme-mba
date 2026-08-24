import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { WebhooksAdminRouteDeps } from '../src/http/webhooks-admin';
import { sha256Hex } from '../src/lib/signature';
import { toRow } from '../src/webhook-entrant/store.pg';
import type { WebhookRow, WebhookInput, RawAdmin } from '../src/webhook-entrant/store.pg';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let autreEspaceTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  autreEspaceTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

/** Le dernier payload reçu : c'est CONTRE lui que le mapping est validé à la configuration. */
const PAYLOAD = {
  client: { tel: '+33612345678', nom: 'Marie Durand' },
  lignes: [{ prix: 42.5, ref: 'A-1' }],
  meta: { source: 'zapier' },
};

const EXISTANT: WebhookRow = {
  id: 'wh1', name: 'Formulaire du site', enabled: true, code: 'ab12cd34ef56gh78jk90mn12pq',
  hasSecret: false, mapping: [{ chemin: 'client.tel', cible: 'sys:phone' }], createContact: true, optIn: true,
  workflowId: null, startNodeId: null, cooldownSeconds: null,
  lastPayload: PAYLOAD, lastReceivedAt: '2026-08-23T10:00:00.000Z', contactsCreated: 3,
  createdAt: '2026-08-20T09:00:00.000Z',
};

interface Cap { crees: WebhookInput[]; majs: Array<{ id: string; input: WebhookInput }>; supprimes: string[]; secretPose: boolean }

function app(over: Partial<WebhooksAdminRouteDeps> = {}) {
  const cap: Cap = { crees: [], majs: [], supprimes: [], secretPose: false };
  // ⚠️ Le faux store porte un ÉTAT pour le secret. Avec une fixture figée, l'assertion « le clair n'apparaît
  // pas à la relecture » ne pourrait jamais échouer : la fixture n'en porte pas, quoi que fasse le vrai code.
  const courant = (): WebhookRow => ({ ...EXISTANT, hasSecret: cap.secretPose });
  const deps: WebhooksAdminRouteDeps = {
    list: async () => [courant()],
    get: async (_t, id) => (id === 'wh1' ? courant() : null),
    create: async (_t, input) => { cap.crees.push(input); return { id: 'wh2', code: 'zz12cd34ef56gh78jk90mn12pq' }; },
    update: async (_t, id, input) => { cap.majs.push({ id, input }); return id === 'wh1'; },
    remove: async (_t, id) => { cap.supprimes.push(id); return id === 'wh1'; },
    rotateSecret: async (_t, id) => { if (id !== 'wh1') return null; cap.secretPose = true; return 'whk_le_clair'; },
    clearSecret: async (_t, id) => { if (id !== 'wh1') return false; cap.secretPose = false; return true; },
    forgetPayload: async (_t, id) => id === 'wh1',
    workflowBelongsToTenant: async (wfId) => wfId === 'wf-du-tenant',
    baseUrl: 'https://mba.messagingme.app',
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, webhooksAdmin: deps }), cap };
}

describe('webhooks : la garde', () => {
  it('🔴 un agent ne voit ni ne modifie les webhooks (garde SERVEUR, pas seulement l’UI)', async () => {
    // Une URL de webhook est un pouvoir d'écriture sur le CRM, et un pouvoir d'envoi quand un scénario y est
    // attaché. Masquer l'écran ne suffirait pas.
    const { server, cap } = app();
    for (const [method, url] of [['GET', '/tenants/t1/webhooks'], ['POST', '/tenants/t1/webhooks'], ['DELETE', '/tenants/t1/webhooks/wh1']] as const) {
      const res = await server.inject({ method, url, ...h(agentTok), payload: { name: 'x' } });
      expect(res.statusCode, url).toBe(403);
    }
    expect(cap.crees).toEqual([]);
    expect(cap.supprimes).toEqual([]);
    await server.close();
  });

  it('🔴 l’admin d’un AUTRE espace ne touche rien ici', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/webhooks/wh1', ...h(autreEspaceTok) });
    expect(res.statusCode).toBe(403);
    expect(cap.supprimes).toEqual([]);
    await server.close();
  });

  it('sans jeton -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/webhooks' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});

describe('webhooks : lecture', () => {
  it('la liste porte l’URL complète à coller chez le tiers, et jamais le secret', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/webhooks', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const [w] = res.json<{ webhooks: Array<Record<string, unknown>> }>().webhooks;
    expect(w?.url).toBe('https://mba.messagingme.app/api/backend/w/ab12cd34ef56gh78jk90mn12pq');
    expect(w?.hasSecret).toBe(false);
    await server.close();
  });

  it('🔴 c’est le STORE qui retire l’empreinte du secret, pas la route', async () => {
    // La requête de l'écran SÉLECTIONNE bien `secret_hash` (il faut savoir si un secret existe) : c'est
    // `toRow` qui n'en garde que le booléen. Un test qui passe par un faux store ne prouve rien de cette
    // frontière, puisque le faux ne porte déjà pas de secret, quoi que fasse le vrai code.
    // L'empreinte est CALCULÉE, pas recopiée : une chaîne de 64 hex dans un fichier ressemble à un secret,
    // et le hook gitleaks du poste bloque le commit (à raison, il ne peut pas savoir qu'elle est inventée).
    const empreinte = sha256Hex('un-secret-de-test');
    const brut: RawAdmin = {
      id: 'wh1', name: 'x', enabled: true, code: 'ab12cd34ef56gh78jk90mn12pq',
      secret_hash: empreinte,
      mapping: [], create_contact: true, opt_in: true, last_payload: null, last_received_at: null,
      contacts_created: 0, created_at: new Date('2026-08-20T09:00:00.000Z'),
      workflow_id: null, start_node_id: null, cooldown_seconds: null,
    };
    const ligne = toRow(brut);
    expect(ligne.hasSecret).toBe(true);
    expect(JSON.stringify(ligne)).not.toContain(brut.secret_hash);
    expect(Object.keys(ligne)).not.toContain('secret_hash');
    await Promise.resolve();
  });
});

describe('webhooks : création', () => {
  it('crée avec les défauts attendus, et rend le code une fois', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/webhooks', ...h(adminTok), payload: { name: 'Commandes' } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ url: string }>().url).toBe('https://mba.messagingme.app/api/backend/w/zz12cd34ef56gh78jk90mn12pq');
    // Actif et « créer les contacts inconnus » à vrai : un webhook éteint donnerait une URL morte au tiers,
    // et le contact ne peut venir QUE du payload.
    expect(cap.crees[0]).toMatchObject({ name: 'Commandes', enabled: true, createContact: true, mapping: [], workflowId: null });
    await server.close();
  });

  it('name manquant -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/webhooks', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('🔴 un scénario d’un AUTRE espace est refusé', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/webhooks', ...h(adminTok), payload: { name: 'x', workflowId: 'wf-ailleurs' } });
    expect(res.statusCode).toBe(400);
    expect(cap.crees).toEqual([]);
    await server.close();
  });

  it('un bloc de départ sans scénario est refusé (configuration qui s’affiche mais ne fait rien)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/webhooks', ...h(adminTok), payload: { name: 'x', startNodeId: 'n1' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

describe('webhooks : le mapping, validé À LA CONFIGURATION', () => {
  const patch = (mapping: unknown) => ({ method: 'PATCH' as const, url: '/tenants/t1/webhooks/wh1', ...h(adminTok), payload: { mapping } });

  it('accepte un mapping qui pointe des valeurs scalaires', async () => {
    const { server, cap } = app();
    const res = await server.inject(patch([
      { chemin: 'client.tel', cible: 'sys:phone' },
      { chemin: 'client.nom', cible: 'sys:name' },
      { chemin: 'lignes[0].prix', cible: 'field:montant' },
    ]));
    expect(res.statusCode).toBe(200);
    expect(cap.majs[0]?.input.mapping).toHaveLength(3);
    await server.close();
  });

  it('🔴 un chemin qui vise un OBJET est refusé, et le message dit quoi faire', async () => {
    // Les valeurs de champ sont stockées en chaîne et `contactVars` transforme en null tout ce qui n'est pas
    // primitif : accepter ici rendrait la variable VIDE dans un template, sans la moindre erreur. Le seul
    // moment où l'utilisateur peut comprendre, c'est maintenant.
    const { server, cap } = app();
    const res = await server.inject(patch([{ chemin: 'client', cible: 'field:client' }]));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/pointez un élément précis/);
    expect(cap.majs).toEqual([]);
    await server.close();
  });

  it('🔴 un chemin qui vise un TABLEAU est refusé de la même façon', async () => {
    const { server } = app();
    const res = await server.inject(patch([{ chemin: 'lignes', cible: 'field:lignes' }]));
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('un chemin qui NE RÉSOUT PAS est accepté (le dernier payload n’est qu’un échantillon)', async () => {
    // Un tiers n'envoie pas toujours ses champs facultatifs : refuser ici empêcherait de préparer un mapping.
    const { server, cap } = app();
    const res = await server.inject(patch([{ chemin: 'client.email', cible: 'field:email' }]));
    expect(res.statusCode).toBe(200);
    expect(cap.majs[0]?.input.mapping).toEqual([{ chemin: 'client.email', cible: 'field:email' }]);
    await server.close();
  });

  it('sans aucun payload reçu, le mapping reste modifiable (on ne peut rien vérifier, on n’invente rien)', async () => {
    const { server } = app({ get: async () => ({ ...EXISTANT, lastPayload: null }) });
    const res = await server.inject(patch([{ chemin: 'client', cible: 'field:client' }]));
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('chemin malformé, destination inconnue, mapping non-tableau -> 400', async () => {
    const { server } = app();
    expect((await server.inject(patch([{ chemin: 'a..b', cible: 'sys:phone' }]))).statusCode).toBe(400);
    expect((await server.inject(patch([{ chemin: 'client.tel', cible: 'sys:autre' }]))).statusCode).toBe(400);
    expect((await server.inject(patch('client.tel'))).statusCode).toBe(400);
    await server.close();
  });
});

describe('webhooks : le secret', () => {
  it('🔴 le clair n’est rendu QU’À la génération, une seule fois', async () => {
    const { server } = app();
    const cree = await server.inject({ method: 'POST', url: '/tenants/t1/webhooks/wh1/secret', ...h(adminTok) });
    expect(cree.statusCode).toBe(201);
    expect(cree.json<{ secret: string; entete: string }>()).toEqual({ secret: 'whk_le_clair', entete: 'X-Webhook-Secret' });
    // La relecture voit bien que le secret EXISTE (donc l'état a bougé)...
    const relu = await server.inject({ method: 'GET', url: '/tenants/t1/webhooks/wh1', ...h(adminTok) });
    expect(relu.json<{ webhook: { hasSecret: boolean } }>().webhook.hasSecret).toBe(true);
    // ... et ne remontre jamais le clair : on ne l'a plus, seule l'empreinte est stockée.
    expect(relu.body).not.toMatch(/whk_le_clair/);
    await server.close();
  });

  it('secret sur un webhook inconnu -> 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/webhooks/inconnu/secret', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('le secret peut être RETIRÉ (un formulaire de site ne sait souvent pas en poser)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/webhooks/wh1/secret', ...h(adminTok) });
    expect(res.statusCode).toBe(204);
    await server.close();
  });
});

describe('webhooks : RGPD et suppression', () => {
  it('« oublier ce payload » efface le JSON tiers', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/webhooks/wh1/payload', ...h(adminTok) });
    expect(res.statusCode).toBe(204);
    await server.close();
  });

  it('suppression d’un webhook inconnu -> 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/webhooks/inconnu', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('suppression -> 204', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'DELETE', url: '/tenants/t1/webhooks/wh1', ...h(adminTok) });
    expect(res.statusCode).toBe(204);
    expect(cap.supprimes).toEqual(['wh1']);
    await server.close();
  });
});

describe('webhooks : modification partielle', () => {
  it('🔴 un PATCH qui ne touche qu’un champ ne remet PAS les autres à leur défaut', async () => {
    // Le store écrit un état complet : sans la fusion avec l'existant, renommer un webhook effacerait son
    // mapping et son scénario, sans aucun message.
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/webhooks/wh1', ...h(adminTok), payload: { name: 'Nouveau nom' } });
    expect(res.statusCode).toBe(200);
    expect(cap.majs[0]?.input).toEqual({
      name: 'Nouveau nom', enabled: true, createContact: true, optIn: true,
      mapping: [{ chemin: 'client.tel', cible: 'sys:phone' }],
      workflowId: null, startNodeId: null, cooldownSeconds: null,
    });
    await server.close();
  });

  it('PATCH sur un webhook inconnu -> 404', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/webhooks/inconnu', ...h(adminTok), payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('anti-rebond hors bornes -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/webhooks/wh1', ...h(adminTok), payload: { workflowId: 'wf-du-tenant', cooldownSeconds: 999_999 } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});
