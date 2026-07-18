import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { V1SendsRouteDeps } from '../src/http/v1-sends';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';
import type { IdempotencyClaim } from '../src/api/idempotency-store.pg';

class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() {}
}
const SEND_KEY = 'mba_send';
const NOSCOPE_KEY = 'mba_noscope';

const contact = (id: string, optIn: BuildContact['optInStatus'] = 'opted_in'): BuildContact => ({
  id, phone_e164: `+3361234567${id.slice(-1)}`, bsuid: null, profile_name: null, fields: {}, optInStatus: optIn,
});

function app(over: Partial<V1SendsRouteDeps> = {}) {
  const cap = { sends: [] as Array<{ input: unknown; recipients: BuiltRecipient[] }>, enqueued: [] as string[] };
  const idem = new Map<string, { sendId: string; response: unknown } | 'pending'>();
  const keys = new FakeApiKeys()
    .add(SEND_KEY, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .add(NOSCOPE_KEY, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });

  const sends: V1SendsRouteDeps = {
    resolveScenario: async (_t, ref) => (ref === 'scn_ok' || ref === 'Onboarding' ? { ok: true, value: { id: 'wf1', name: 'Onboarding' } } : ref === 'Ambigu' ? { ok: false, reason: 'ambiguous', matches: [{ id: 'a', name: 'Ambigu' }, { id: 'b', name: 'Ambigu' }] } : { ok: false, reason: 'not_found' }),
    getTenantPhoneNumberId: async () => 'pn-default',
    phoneNumberBelongsToTenant: async (pn) => pn === 'pn-mine',
    findContactByPhone: async (_t, phone) => (phone === '+33612345671' ? { id: 'c1' } : null),
    createContactByPhone: async (_t, phone) => ({ id: `new-${phone}` }),
    listContactsForBuildByIds: async (_t, ids) => ids.map((id) => (id === 'c1' ? contact('c1') : { id, phone_e164: '+33698765432', bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in' as const })),
    createSend: async (input, recipients) => { cap.sends.push({ input, recipients }); return { campaignId: 'camp1', recipientCount: recipients.length }; },
    enqueue: async (id) => { cap.enqueued.push(id); },
    idempotencyClaim: async (_t, key): Promise<IdempotencyClaim> => {
      const e = idem.get(key);
      if (!e) { idem.set(key, 'pending'); return { claimed: true }; }
      if (e === 'pending') return { claimed: false, pending: true };
      return { claimed: false, sendId: e.sendId, response: e.response };
    },
    idempotencyComplete: async (_t, key, sendId, response) => { idem.set(key, { sendId, response }); },
    idempotencyRelease: async (_t, key) => { idem.delete(key); },
    getSendDetail: async (id, _t) => (id === 'camp1' ? { sendId: 'camp1', status: 'running' } : null),
    // Cible node : seul `nod_ok` existe. Par défaut la fenêtre 24 h est OUVERTE pour tous les wa_id du lot
    // (les tests qui veulent tester le hors-fenêtre surchargent getWindowOpenByWaIds).
    resolveNode: async (_t, code) => (code === 'nod_ok' ? { ok: true, value: { workflowId: 'wf1', nodeId: 'n5', label: 'Relance' } } : { ok: false, reason: 'not_found' }),
    getWindowOpenByWaIds: async (_t, waIds) => new Map(waIds.map((w) => [w, true])),
    sleep: async () => {}, // pas de temporisation réelle dans les tests de retry
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: { upsertContacts: async () => [] }, sends } }), cap, idem };
}
const H = (key: string, idemKey?: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(idemKey ? { 'idempotency-key': idemKey } : {}) } });

describe('POST /v1/sends', () => {
  it('scénario résolu -> 201, campagne créée + enfilée, rapport', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-1'), payload: { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ sendId: string; recipientCount: number; matched: number; created: number }>();
    expect(body).toMatchObject({ sendId: 'camp1', recipientCount: 1, matched: 1, created: 0 });
    expect(cap.enqueued).toEqual(['camp1']);
    expect((cap.sends[0]!.input as { workflowId?: string }).workflowId).toBe('wf1');
    await server.close();
  });

  it('sans Idempotency-Key -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY), payload: { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejeu même Idempotency-Key -> rapport caché, PAS de 2e campagne', async () => {
    const { server, cap } = app();
    const p = { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] };
    const r1 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-dup'), payload: p });
    const r2 = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-dup'), payload: p });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual(r1.json()); // même rapport rejoué
    expect(cap.sends).toHaveLength(1); // une seule campagne
    await server.close();
  });

  it('claim concurrent (pending) -> 409', async () => {
    const { server, idem } = app();
    idem.set('busy', 'pending'); // simule une requête concurrente en cours
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'busy'), payload: { target: { scenario: 'scn_ok' }, category: 'marketing', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it('scénario introuvable -> 404 ; nom ambigu -> 409 ; node inconnu -> 404', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i1'), payload: { target: { scenario: 'scn_missing' }, category: 'utility', recipients: ['+33612345671'] } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i2'), payload: { target: { scenario: 'Ambigu' }, category: 'utility', recipients: ['+33612345671'] } })).statusCode).toBe(409);
    expect((await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i3'), payload: { target: { node: 'nod_x' }, category: 'utility', recipients: ['+33612345671'] } })).statusCode).toBe(404);
    await server.close();
  });

  it('sans le scope sends:create -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(NOSCOPE_KEY, 'i4'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('upsert-then-send : téléphone invalide -> invalid_phone ; inconnu + createMissing:false -> unknown_contact', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i5'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['pas-un-numero', '+33699999999'], createMissing: false } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ skipped: Array<{ phone: string; reason: string }>; skippedTotal: number }>();
    const reasons = body.skipped.map((s) => s.reason);
    expect(reasons).toContain('invalid_phone');
    expect(reasons).toContain('unknown_contact');
    await server.close();
  });

  it('téléphone inconnu + createMissing par défaut -> contact créé (compté created)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i6'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33698765432'] } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ created: number }>().created).toBe(1);
    await server.close();
  });

  it('category invalide / recipients vide / trop de destinataires -> 400', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i7'), payload: { target: { scenario: 'scn_ok' }, category: 'spam', recipients: ['+33612345671'] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i8'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: [] } })).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, () => '+33612345671');
    expect((await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i9'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: many } })).statusCode).toBe(400);
    await server.close();
  });

  it('scelle l’idempotence AVANT enqueue : un échec d’enqueue -> 201 sans release (pas de double envoi au retry)', async () => {
    const order: string[] = [];
    let released = false;
    const { server } = app({
      createSend: async (_i, recipients) => { order.push('createSend'); return { campaignId: 'campX', recipientCount: recipients.length }; },
      idempotencyComplete: async () => { order.push('complete'); },
      enqueue: async () => { order.push('enqueue'); throw new Error('pg-boss down'); },
      idempotencyRelease: async () => { released = true; },
    });
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-seal'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(201); // renvoyé malgré l'échec d'enqueue
    // Idempotence scellée AVANT enqueue, puis 3 tentatives d'enqueue (toutes en échec ici).
    expect(order).toEqual(['createSend', 'complete', 'enqueue', 'enqueue', 'enqueue']);
    expect(released).toBe(false); // claim jamais libéré -> retry rejoue le rapport, pas de 2e campagne/envoi
    await server.close();
  });

  it('enqueue : échec TRANSITOIRE -> retry -> succès (pas de campagne orpheline)', async () => {
    let attempts = 0;
    let released = false;
    const { server } = app({
      enqueue: async () => { attempts += 1; if (attempts < 3) throw new Error('pg-boss saturé'); },
      idempotencyRelease: async () => { released = true; },
    });
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-retry'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(201);
    expect(attempts).toBe(3); // a retenté jusqu'au succès
    expect(released).toBe(false); // le retry d'enqueue ne libère JAMAIS l'idempotence
    await server.close();
  });

  it('enqueue : échec PERSISTANT -> borné à 3 tentatives, 201, idempotence toujours scellée', async () => {
    let attempts = 0;
    let released = false;
    const { server } = app({
      enqueue: async () => { attempts += 1; throw new Error('pg-boss down'); },
      idempotencyRelease: async () => { released = true; },
    });
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-retry-ko'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(201);
    expect(attempts).toBe(3); // borné : pas de boucle infinie
    expect(released).toBe(false);
    await server.close();
  });

  it('échec AVANT scellement (createSend throw) -> release (retry propre)', async () => {
    let released = false;
    const { server } = app({
      createSend: async () => { throw new Error('db down'); },
      idempotencyRelease: async () => { released = true; },
    });
    await expect(
      server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-fail'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'] } }),
    ).resolves.toMatchObject({ statusCode: 500 });
    expect(released).toBe(true); // erreur avant scellement -> clé libérée pour un vrai retry
    await server.close();
  });

  it('cible node : code résolu + contact EN fenêtre -> campagne créée avec startNodeId', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-node'), payload: { target: { node: 'nod_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ recipientCount: number }>().recipientCount).toBe(1);
    const input = cap.sends[0]!.input as { workflowId?: string; startNodeId?: string; name: string };
    expect(input.workflowId).toBe('wf1');
    expect(input.startNodeId).toBe('n5'); // le run démarrera à CE bloc
    expect(input.name).toContain('Relance'); // libellé du bloc dans le nom de campagne
    await server.close();
  });

  it('cible node : contact HORS fenêtre 24 h -> skipped out_of_window et AUCUN destinataire', async () => {
    const { server, cap } = app({ getWindowOpenByWaIds: async () => new Map() }); // aucune conversation -> tout fermé
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-node-closed'), payload: { target: { node: 'nod_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ recipientCount: number; skipped: Array<{ phone: string; reason: string }> }>();
    expect(body.recipientCount).toBe(0); // rien à envoyer
    expect(body.skipped).toEqual([{ phone: '+33612345671', reason: 'out_of_window' }]);
    expect(cap.sends[0]!.recipients).toEqual([]); // aucun destinataire créé -> aucun envoi possible
    await server.close();
  });

  it('cible node : la fenêtre est interrogée avec le wa_id (chiffres nus), pas le E.164', async () => {
    const asked: string[][] = [];
    const { server } = app({ getWindowOpenByWaIds: async (_t, waIds) => { asked.push(waIds); return new Map(waIds.map((w) => [w, true])); } });
    await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-node-waid'), payload: { target: { node: 'nod_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(asked).toEqual([['33612345671']]);
    await server.close();
  });

  it('cible node : mélange en fenêtre / hors fenêtre -> seul le contact ouvert part', async () => {
    const { server, cap } = app({
      // Les DEUX contacts existent (sinon le 2e sortirait en unknown_contact avant même le test de fenêtre).
      findContactByPhone: async (_t, phone) => ({ id: phone === '+33612345671' ? 'c1' : 'c2' }),
      getWindowOpenByWaIds: async () => new Map([['33612345671', true], ['33698765432', false]]),
    });
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-node-mix'), payload: { target: { node: 'nod_ok' }, category: 'utility', recipients: ['+33612345671', '+33698765432'] } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ recipientCount: number; skipped: Array<{ phone: string; reason: string }> }>();
    expect(body.recipientCount).toBe(1);
    expect(body.skipped).toEqual([{ phone: '+33698765432', reason: 'out_of_window' }]);
    expect(cap.sends[0]!.recipients.map((r) => r.toE164)).toEqual(['+33612345671']);
    await server.close();
  });

  it('cible node : numéro INCONNU -> unknown_contact, AUCUNE fiche créée (pas de pollution du CRM)', async () => {
    // Un contact inconnu n'a par construction aucune conversation : le créer pour l'écarter aussitôt en
    // out_of_window ne sert à rien et salit le CRM. createMissing est forcé à false sur une cible node.
    let creations = 0;
    const { server, cap } = app({ createContactByPhone: async (_t, phone) => { creations += 1; return { id: `new-${phone}` }; } });
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-node-unknown'), payload: { target: { node: 'nod_ok' }, category: 'utility', recipients: ['+33698765432'], createMissing: true } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ created: number; skipped: Array<{ phone: string; reason: string }> }>();
    expect(creations).toBe(0); // createMissing:true du client est IGNORÉ sur une cible node
    expect(body.created).toBe(0);
    expect(body.skipped).toEqual([{ phone: '+33698765432', reason: 'unknown_contact' }]);
    expect(cap.sends[0]!.recipients).toEqual([]);
    await server.close();
  });

  it('cible node : des params de template -> 400 (ils ne seraient jamais envoyés)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-node-params'), payload: { target: { node: 'nod_ok' }, category: 'utility', recipients: ['+33612345671'], params: [{ type: 'field', key: 'prenom' }] } });
    expect(res.statusCode).toBe(400);
    expect(cap.sends).toHaveLength(0); // refusé AVANT toute création
    await server.close();
  });

  it('cible node : la fenêtre n’est PAS interrogée pour un scénario ou un template', async () => {
    let called = 0;
    const { server, cap } = app({ getWindowOpenByWaIds: async (_t, waIds) => { called += 1; return new Map(waIds.map((w) => [w, true])); } });
    await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'idem-scn-nowin'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'] } });
    expect(called).toBe(0); // une campagne scénario n'est pas contrainte à la fenêtre 24 h
    expect((cap.sends[0]!.input as { startNodeId?: string }).startNodeId).toBeUndefined();
    await server.close();
  });

  it('phoneNumberId d’un autre tenant -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/v1/sends', ...H(SEND_KEY, 'i10'), payload: { target: { scenario: 'scn_ok' }, category: 'utility', recipients: ['+33612345671'], phoneNumberId: 'pn-autrui' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

describe('GET /v1/sends/:sendId', () => {
  it('trouvé -> 200 ; inconnu -> 404', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'GET', url: '/v1/sends/camp1', ...H(SEND_KEY) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/v1/sends/inconnu', ...H(SEND_KEY) })).statusCode).toBe(404);
    await server.close();
  });
});
