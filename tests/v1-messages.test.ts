import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import { estLourde, unitesDe } from '../src/api/usage-guard';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { DepsRepondre } from '../src/inbox/repondre';
import type { OrigineMessage } from '../src/inbox/origine';
import { cleApiDeTest } from './aide/cle-api';

/**
 * `POST /v1/messages` : UN SIMPLE TEXTE DANS LA FENÊTRE DE 24 H (lot 7 du 2026-09-23).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT VRAIMENT, ET CE N'EST PAS LA ROUTE. La route ne décide de rien : elle
 * résout un contact, ouvre son fil, et appelle `repondreDansLaFenetre`, partagé avec la console et le
 * serveur MCP. Ce qui mérite un test, c'est que ce TROISIÈME appelant hérite bien des mêmes garde-fous,
 * parce qu'il est arrivé exactement l'inverse : la garde de désabonnement se lisait `origine === 'mcp'`,
 * donc en LISTE D'APPELANTS, et l'API publique serait passée au travers sans qu'aucun test existant ne
 * tombe. Un garde-fou écrit en liste d'appelants s'ouvre en grand au quatrième.
 *
 * ⚠️ LES ASSERTIONS PORTENT SUR CE QUI PART ET SUR CE QUI EST ENREGISTRÉ, pas sur ce que la fonction rend :
 * une garde qu'on peut débrancher sans qu'aucun test ne tombe n'est pas une garde.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed(): Promise<void> {}
}

const VALID = cleApiDeTest('valide');
const NOSCOPE = cleApiDeTest('sans_scope');
const NUMERO = '+33612345678';

interface Monde {
  /** Le contact existe-t-il pour ce numéro ? */
  contact: { id: string } | null;
  /** `null` = contact bloqué ou supprimé : `ouvrirConversationDuContact` refuse. */
  conversation: string | null;
  fenetreOuverte: boolean;
  desabonne: boolean;
  numeroDeLEspace: string | null;
}

const MONDE: Monde = { contact: { id: 'c1' }, conversation: 'conv-1', fenetreOuverte: true, desabonne: false, numeroDeLEspace: 'pn1' };

function app(over: Partial<Monde> = {}) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ to: string; text: string }> = [];
  const enregistres: Array<{ body: string; origine: OrigineMessage; auteur: string | null; type?: string }> = [];
  const desabonneLu: string[] = [];
  const prises: string[] = [];

  const repondre: DepsRepondre = {
    getConversationContext: async (id, tenant) => (
      // L'isolation : un fil d'un autre espace n'existe pas pour celui-ci.
      tenant === 't1' && id === m.conversation
        ? { waId: '33612345678', lastInboundAt: null, windowOpen: m.fenetreOuverte }
        : null
    ),
    getTenantPhoneNumberId: async () => m.numeroDeLEspace,
    sendReply: async (_t, _pn, to, text) => { envois.push({ to, text }); return 'wamid.envoye'; },
    estDesabonne: async (_t, waId) => { desabonneLu.push(waId); return m.desabonne; },
    recordOutbound: async (_id, body, _msgId, origine, type, _cat, _name, sender) => {
      enregistres.push({ body, origine, auteur: sender ?? null, type });
    },
    takeControl: async (_t, waId) => { prises.push(waId); },
  };

  const keys = new FakeApiKeys()
    .add(VALID, { id: 'k1', tenantId: 't1', scopes: ['sends:create'] })
    .add(NOSCOPE, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] });

  const server = buildServer({
    queue: new FakeQueue(),
    v1: {
      apiKeys: keys,
      contacts: { upsertContacts: async () => [] },
      messages: {
        repondre,
        findContactByPhone: async (tenant, phone) => (tenant === 't1' && phone === NUMERO ? m.contact : null),
        ouvrirConversation: async (tenant, contactId) => (tenant === 't1' && contactId === 'c1' ? m.conversation : null),
      },
    },
  });
  return { server, envois, enregistres, desabonneLu, prises };
}

const auth = (key: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });
const post = (server: ReturnType<typeof app>['server'], payload: unknown, key = VALID) =>
  server.inject({ method: 'POST', url: '/v1/messages', ...auth(key), payload: payload as object });

describe('POST /v1/messages', () => {
  it('clé valide -> 200, le texte PART et il est enregistré avec l origine `api`', async () => {
    const { server, envois, enregistres, prises } = app();
    const res = await post(server, { to: NUMERO, text: 'bonjour' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ messageId: string; conversationId: string }>()).toEqual({ messageId: 'wamid.envoye', conversationId: 'conv-1' });
    expect(envois).toEqual([{ to: '33612345678', text: 'bonjour' }]);
    // 🔴 L'ORIGINE EST LE SUJET DE LA MIGRATION 0166 : sans elle, cet envoi serait indiscernable d'une
    // réponse de scénario en base, et l'écran « qui a écrit les messages de service » mentirait.
    // `auteur` à null : personne ne SIGNE ce message, aucun opérateur ne l'a écrit.
    expect(enregistres).toEqual([{ body: 'bonjour', origine: 'api', auteur: null, type: 'text' }]);
    // Le fil est PRIS : le scénario cesse d'avancer seul, l'agent de Meta cesse de répondre.
    expect(prises).toEqual(['33612345678']);
    await server.close();
  });

  it('🔴 un contact DÉSABONNÉ est refusé, et RIEN ne part', async () => {
    /**
     * LE CAS QUI JUSTIFIE CE FICHIER. La règle est « une MACHINE ne parle pas à quelqu'un qui a dit STOP,
     * un opérateur si ». Elle s'écrivait `origine === 'mcp'`, donc elle ne couvrait qu'un appelant : cette
     * route serait partie sans la garde, et c'est la troisième fois en deux semaines que ce dépôt paie le
     * motif « une garde câblée sur un consommateur sur trois ».
     */
    const { server, envois, enregistres, desabonneLu } = app({ desabonne: true });
    const res = await post(server, { to: NUMERO, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('contact_desabonne');
    expect(desabonneLu, 'la garde doit avoir été INTERROGÉE').toEqual(['33612345678']);
    expect(envois, 'aucun message ne part').toEqual([]);
    expect(enregistres, 'et rien n est enregistré').toEqual([]);
    await server.close();
  });

  it('🔴 hors fenêtre de 24 h -> 422 `window_closed`, et rien ne part', async () => {
    const { server, envois } = app({ fenetreOuverte: false });
    const res = await post(server, { to: NUMERO, text: 'bonjour' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('window_closed');
    // Le message DIT l'autre chemin : sans ça, un intégrateur cherche un défaut de son côté.
    expect(res.json<{ error: string }>().error).toContain('/v1/sends');
    expect(envois).toEqual([]);
    await server.close();
  });

  it('🔴 un contact BLOQUÉ ou SUPPRIMÉ -> 409, et la fenêtre n est même pas consultée', async () => {
    // `ouvrirConversation` EST la garde de blocage, la même que le bouton du mini-CRM. Elle se pose AVANT
    // l'envoi : une garde ne garde que ce qui vient après elle.
    const { server, envois, desabonneLu } = app({ conversation: null });
    const res = await post(server, { to: NUMERO, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('contact_indisponible');
    expect(envois).toEqual([]);
    expect(desabonneLu, 'on s arrête avant, donc aucune lecture de plus').toEqual([]);
    await server.close();
  });

  it('un numéro inconnu de cet espace -> 404 `contact_inconnu`', async () => {
    const { server } = app({ contact: null });
    const res = await post(server, { to: NUMERO, text: 'bonjour' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('contact_inconnu');
    await server.close();
  });

  it('aucun numéro WhatsApp sur l espace -> 409, pas un 500', async () => {
    const { server, envois } = app({ numeroDeLEspace: null });
    const res = await post(server, { to: NUMERO, text: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('aucun_numero');
    expect(envois).toEqual([]);
    await server.close();
  });

  it('corps invalide -> 400, et le numéro est normalisé avant tout', async () => {
    const { server } = app();
    for (const corps of [{}, { to: NUMERO }, { text: 'x' }, { to: NUMERO, text: '' }, { to: NUMERO, text: 'x'.repeat(4097) }, { to: 123, text: 'x' }]) {
      expect((await post(server, corps)).statusCode, JSON.stringify(corps)).toBe(400);
    }
    // Un numéro syntaxiquement acceptable mais invalide : refusé par `normalizePhone`, pas par le schéma.
    expect((await post(server, { to: '00', text: 'x' })).statusCode).toBe(400);
    await server.close();
  });

  it('🔴 un numéro au format NATIONAL désigne le même contact : la normalisation est faite ici', async () => {
    // Sans elle, `06 12 34 56 78` ne trouverait aucun contact et l intégrateur recevrait un 404 trompeur.
    const { server, envois } = app();
    expect((await post(server, { to: '06 12 34 56 78', text: 'salut' })).statusCode).toBe(200);
    expect(envois).toEqual([{ to: '33612345678', text: 'salut' }]);
    await server.close();
  });

  it('sans Bearer -> 401 ; clé sans le droit `sends:create` -> 403', async () => {
    const { server } = app();
    const sans = await server.inject({ method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' }, payload: { to: NUMERO, text: 'x' } });
    expect(sans.statusCode).toBe(401);
    expect((await post(server, { to: NUMERO, text: 'x' }, NOSCOPE)).statusCode).toBe(403);
    await server.close();
  });

  it('🔴 le tenant vient de la CLÉ, jamais du corps', async () => {
    // Le filtrage en code est le SEUL contrôle d'isolation (la RLS est contournée par le pooler superuser).
    const { server, envois } = app();
    const res = await post(server, { to: NUMERO, text: 'x', tenantId: 'autre-espace' });
    expect(res.statusCode).toBe(200);
    expect(envois).toHaveLength(1); // résolu sur `t1`, celui de la clé
    await server.close();
  });

  it('le garde d usage compte UNE unité, et l opération n est pas « lourde »', () => {
    // Un message, une personne : c'est la seule opération de l'API dont le travail ne dépend pas du corps.
    expect(unitesDe('messages.send', 999)).toBe(1);
    // ⚠️ DÉLIBÉRÉMENT hors des lourdes : elle fait trois requêtes, comme `mcp.call` qui en est exclu pour
    // la même raison. L'y mettre ferait refuser un message pendant qu'un lot de contacts s'écrit, ce qui
    // transformerait une protection du pool en panne d'envoi.
    expect(estLourde('messages.send')).toBe(false);
  });
});
