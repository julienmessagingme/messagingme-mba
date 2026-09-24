import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerV1MessagesRcs, type V1MessagesRcsRouteDeps } from '../src/http/v1-messages-rcs';
import type { DepsRcsLibre } from '../src/rcs/envoyer-libre';
import type { ClesFiche, ModeCreation, ResolutionFiche } from '../src/api/fiche';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import type { PreHandler } from '../src/auth/middleware';
import type { OrigineMessage } from '../src/inbox/origine';
import { RCS_TEXTE_MAX } from '../src/rcs/schema';

/**
 * `POST /v1/messages/rcs` (spec 2026-09-24, § 4). La route ne décide que de la FICHE (la trouver, un numéro,
 * pas bloquée) ; le reste est `envoyerRcsLibre`, partagé avec l'Inbox. Ces cas vérifient l'ORDRE des refus,
 * leurs codes, et ce qui part et s'enregistre.
 *
 * ⚠️ Les fiches portent des identifiants au FORMAT d'un vrai : le corps passe par `schemaClesFiche` (lot 1),
 * dont `contactId` est un GUID, et le schéma est STRICT. Un « c1 » rendrait 400 avant toute résolution.
 */
const cle: PreHandler = async (req) => {
  req.auth = { userId: 'apikey:k1', tenantId: 't1', role: 'api' };
  req.apiKeyId = 'k1';
};

const C1 = '11111111-1111-4111-8111-000000000001';
const SANS_NUMERO = '11111111-1111-4111-8111-000000000002';
const BLOQUEE = '11111111-1111-4111-8111-000000000003';
const BLOQUEE_SANS_NUMERO = '11111111-1111-4111-8111-000000000004';
const CONFLIT = '11111111-1111-4111-8111-000000000005';
const PERSONNE = '11111111-1111-4111-8111-000000000006';

interface Monde {
  fiches: Record<string, { phone: string | null; bloque: boolean }>;
  consentiOuEcrit: boolean;
  desabonne: boolean;
  agent: string | null;
  injoignable: boolean;
}

const MONDE: Monde = {
  fiches: {
    [C1]: { phone: '+33612345678', bloque: false },
    [SANS_NUMERO]: { phone: null, bloque: false },
    [BLOQUEE]: { phone: '+33698765432', bloque: true },
    [BLOQUEE_SANS_NUMERO]: { phone: null, bloque: true },
  },
  consentiOuEcrit: true, desabonne: false, agent: 'agent-1', injoignable: false,
};

async function app(over: Partial<Monde> = {}, garde: PreHandler = cle) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ waId: string; text: string }> = [];
  const enregistres: Array<{ conversationId: string; body: string; origine: OrigineMessage; type?: string; auteur: string | null; canal?: string }> = [];
  const prises: string[] = [];
  const creations: ModeCreation[] = [];
  /** L'ORDRE des gestes qui suivent l'envoi : ouvrir le fil, le prendre, y inscrire le message. */
  const journal: string[] = [];
  /** Les wa_id dont le fil EXISTE. Aucun au départ : le cas courant de l'API est une fiche qui n'a jamais écrit. */
  const ouverts = new Set<string>();
  const rcs: DepsRcsLibre = {
    agentIdForTenant: async () => m.agent,
    estDesabonne: async () => m.desabonne,
    estDesabonneRcs: async () => false,
    aConsentiOuEcrit: async () => m.consentiOuEcrit,
    lireJoignabilite: async () => (m.injoignable ? { reachable: false, checkedAt: Date.now() } : null),
    lireMessageRcs: async () => null,
    variablesDeLaFiche: async () => ({}),
    jetonDuContact: async () => undefined,
    envoyer: async (_t, _a, waId, msg) => { envois.push({ waId, text: msg.kind === 'text' ? msg.text : '' }); return { messageId: 'rcs-1' }; },
    nouvelId: () => 'id-1',
    maintenant: () => Date.now(),
  };
  const usage = new GardeUsageMemoire();
  const deps: V1MessagesRcsRouteDeps = {
    resoudreFiche: async (_t, cles: ClesFiche, o): Promise<ResolutionFiche> => {
      creations.push(o.creer);
      if (cles.contactId === CONFLIT) return { ok: false, code: 'identity_conflict' };
      if (cles.externalId === 'crm-7781') return { ok: true, contactId: C1, cree: false };
      if (cles.contactId && m.fiches[cles.contactId]) return { ok: true, contactId: cles.contactId, cree: false };
      return { ok: false, code: 'unknown_contact' };
    },
    etatPourEnvoi: async (_t, id) => { const f = m.fiches[id]; return f ? { phoneE164: f.phone, bloque: f.bloque } : null; },
    rcs,
    ouvrirConversation: async (_t, contactId) => {
      const tel = m.fiches[contactId]?.phone;
      if (tel) ouverts.add(tel.replace(/\D/g, ''));
      journal.push(`ouvrir:${contactId}`);
      return 'conv-1';
    },
    // COMME LE VRAI `setControlOwner` : un `update` sur (espace, wa_id), qui ne touche RIEN tant que le fil
    // n'existe pas. Un faux qui enregistrerait la prise quoi qu'il arrive ne verrait pas l'ordre fautif.
    takeControl: async (_t, waId) => {
      if (!ouverts.has(waId)) return;
      prises.push(waId);
      journal.push(`prise:${waId}`);
    },
    recordOutbound: async (conversationId, body, _id, origine, type, _cat, _nom, auteur, canal) => {
      enregistres.push({ conversationId, body, origine, type, auteur: auteur ?? null, canal });
      journal.push(`inscrit:${conversationId}`);
    },
    usage,
  };
  const server = Fastify();
  registerV1MessagesRcs(server, deps, garde);
  await server.ready();
  return { server, envois, enregistres, prises, creations, journal, usage };
}

type App = Awaited<ReturnType<typeof app>>;
const post = (a: App, payload: unknown) =>
  a.server.inject({ method: 'POST', url: '/v1/messages/rcs', headers: { 'content-type': 'application/json' }, payload: payload as object });

describe('POST /v1/messages/rcs', () => {
  it('200 : le RCS part, s’inscrit dans l’Inbox avec l’origine api, et le fil est pris', async () => {
    const a = await app();
    const res = await post(a, { externalId: 'crm-7781', text: 'Bonjour' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 'rcs-1', conversationId: 'conv-1', channel: 'rcs' });
    expect(a.envois).toEqual([{ waId: '33612345678', text: 'Bonjour' }]);
    expect(a.enregistres).toEqual([{ conversationId: 'conv-1', body: 'Bonjour', origine: 'api', type: 'rcs', auteur: null, canal: 'rcs' }]);
    expect(a.usage.compteurs().map((c) => c.operation)).toEqual(['messages.send']);
    // Un message simple ne fonde pas une relation : la fiche n'est jamais créée ici.
    expect(a.creations).toEqual(['jamais']);
    await a.server.close();
  });

  it('🔴 « écrire PREND le fil » (§ 4), même pour une fiche qui n’a jamais écrit : ouvrir, PUIS prendre, PUIS inscrire', async () => {
    const a = await app();
    await post(a, { contactId: C1, text: 'Bonjour' });
    expect(a.prises).toEqual(['33612345678']);
    expect(a.journal).toEqual([`ouvrir:${C1}`, 'prise:33612345678', 'inscrit:conv-1']);
    await a.server.close();
  });

  it('corps invalide : 400 invalid_body, et rien n’est compté ni envoyé', async () => {
    const a = await app();
    for (const corps of [
      { contactId: C1 },
      { contactId: C1, text: '' },
      { contactId: C1, text: 'x'.repeat(RCS_TEXTE_MAX + 1) },
      { contactId: C1, text: 'x', rcsMessageId: 'm1' },
      { contactId: 'c1', text: 'x' },
    ]) {
      const res = await post(a, corps);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('invalid_body');
    }
    expect(a.envois).toEqual([]);
    expect(a.usage.compteurs()).toEqual([]);
    await a.server.close();
  });

  it('aucune clé de fiche, ou un numéro illisible : 400, refusé AVANT le compteur, comme sur /v1/messages/whatsapp', async () => {
    const a = await app();
    const sansCle = await post(a, { text: 'x' });
    expect([sansCle.statusCode, sansCle.json<{ code: string }>().code]).toEqual([400, 'invalid_recipient']);
    const illisible = await post(a, { phone: 'pas un numéro', text: 'x' });
    expect([illisible.statusCode, illisible.json<{ code: string }>().code]).toEqual([400, 'invalid_phone']);
    expect(a.usage.compteurs()).toEqual([]);
    expect(a.creations).toEqual([]);
    await a.server.close();
  });

  it('fiche introuvable : 404 unknown_contact ; clés contradictoires : 409 identity_conflict', async () => {
    const a = await app();
    const inconnue = await post(a, { contactId: PERSONNE, text: 'x' });
    expect([inconnue.statusCode, inconnue.json<{ code: string }>().code]).toEqual([404, 'unknown_contact']);
    const conflit = await post(a, { contactId: CONFLIT, text: 'x' });
    expect([conflit.statusCode, conflit.json<{ code: string }>().code]).toEqual([409, 'identity_conflict']);
    expect(a.envois).toEqual([]);
    await a.server.close();
  });

  it('🔴 l’ordre du § 4 : pas de numéro (422) passe AVANT bloqué (409)', async () => {
    const a = await app();
    const r1 = await post(a, { contactId: BLOQUEE_SANS_NUMERO, text: 'x' });
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([422, 'no_phone']);
    const r2 = await post(a, { contactId: BLOQUEE, text: 'x' });
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([409, 'blocked_contact']);
    const r3 = await post(a, { contactId: SANS_NUMERO, text: 'x' });
    expect([r3.statusCode, r3.json<{ code: string }>().code]).toEqual([422, 'no_phone']);
    expect(a.envois).toEqual([]);
    await a.server.close();
  });

  it('désabonné : 409 opted_out', async () => {
    const a = await app({ desabonne: true });
    const res = await post(a, { contactId: C1, text: 'x' });
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'opted_out']);
    await a.server.close();
  });

  it('🔴 ni consenti ni écrit : 409 no_consent, rien ne part, et AUCUN fil n’est créé', async () => {
    const a = await app({ consentiOuEcrit: false });
    const res = await post(a, { contactId: C1, text: 'x' });
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'no_consent']);
    expect(a.envois).toEqual([]);
    expect(a.journal).toEqual([]);
    await a.server.close();
  });

  it('canal éteint : 409 rcs_not_enabled ; injoignable connu : 422 rcs_unreachable', async () => {
    const eteint = await app({ agent: null });
    const r1 = await post(eteint, { contactId: C1, text: 'x' });
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([409, 'rcs_not_enabled']);
    await eteint.server.close();
    const injoignable = await app({ injoignable: true });
    const r2 = await post(injoignable, { contactId: C1, text: 'x' });
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([422, 'rcs_unreachable']);
    expect(injoignable.envois).toEqual([]);
    await injoignable.server.close();
  });

  it('sans authentification : 401 unauthorized', async () => {
    const a = await app({}, async () => {});
    const res = await post(a, { contactId: C1, text: 'x' });
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([401, 'unauthorized']);
    await a.server.close();
  });
});
