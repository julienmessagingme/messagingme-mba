import { jamaisDesabonne, toujoursDesabonne } from './consentement';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { contactsV1Muets } from './aide/contacts-v1';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { DepsMcp } from '../src/mcp/outils';
import { OUTILS } from '../src/mcp/outils';
import { VALID_API_SCOPES } from '../src/http/api-keys';
import { cleApiDeTest } from './aide/cle-api';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE } from '../src/meta/numero-delie';

/**
 * Le serveur MCP : `POST /mcp`, du JSON-RPC 2.0 sans état, autorisé par une clé d'API.
 *
 * Ce que ces tests protègent tient en trois phrases, et aucune n'est du protocole :
 *   1. une clé ne voit JAMAIS l'espace d'un autre client (le tenant vient de la clé, jamais des arguments) ;
 *   2. un outil hors des scopes de la clé n'est ni listé ni appelable, et le refus ne dit pas lequel des
 *      deux (« n'existe pas » ou « interdit »), ce qui renseignerait sur des capacités refusées ;
 *   3. un refus MÉTIER (fenêtre de 24 h fermée) revient comme un RÉSULTAT `isError: true` et pas comme une
 *      erreur de protocole, sinon l'agent en face croit l'outil cassé au lieu de lire la raison.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() { /* rien */ }
}

const CLE_TOUT = cleApiDeTest('tout');
const CLE_LECTURE = cleApiDeTest('lecture');
const CLE_AUTRE_ESPACE = cleApiDeTest('autre');

interface Traces {
  contexte: Array<{ id: string; tenant: string }>;
  envois: Array<{ tenant: string; to: string; texte: string }>;
  listes: string[];
  journal: Array<{ origine: string; auteur: string | null | undefined }>;
}

function app(over: Partial<DepsMcp> & { membres?: Array<{ id: string; name: string; email: string; role: string }> } = {}) {
  const traces: Traces = { contexte: [], envois: [], listes: [], journal: [] };
  const mcp: DepsMcp = {
    estDesabonne: jamaisDesabonne,
    listConversations: async (tenant) => {
      traces.listes.push(tenant);
      return tenant === 't1'
        ? [{ id: 'cv1', waId: '33600000001', profileName: 'Léa', lastPreview: 'bonjour', lastMessageAt: '2026-09-01T10:00:00.000Z', controlOwner: 'app_workflow', unread: true, assignedTo: null, assignedToName: null }]
        : [];
    },
    // La garde tenant vit ICI, comme dans le store réel : une conversation d'un autre espace rend `null`,
    // donc un identifiant deviné ne se distingue pas d'un identifiant inexistant.
    getConversationContext: async (id, tenant) => {
      traces.contexte.push({ id, tenant });
      if (tenant !== 't1' || id !== 'cv1') return null;
      return { waId: '33600000001', lastInboundAt: '2026-09-01T09:00:00.000Z', windowOpen: true };
    },
    getMessages: async () => [
      { id: 'm1', direction: 'in', type: 'text', body: 'bonjour', createdAt: '2026-09-01T09:00:00.000Z' },
      { id: 'm2', direction: 'out', type: 'text', body: 'bonjour à vous', createdAt: '2026-09-01T09:01:00.000Z' },
    ] as never,
    getTenantPhoneNumberId: async () => 'pn-1',
    sendReply: async (tenant, _pn, to, texte) => { traces.envois.push({ tenant, to, texte }); return 'wamid-1'; },
    recordOutbound: async (_id, _body, _msg, origine, _type, _cat, _name, auteur) => { traces.journal.push({ origine, auteur }); },
    takeControl: async () => {},
    chercherContacts: async () => [],
    contactParTelephone: async () => null,
    ajouterTags: async () => ({ touched: 1, added: ['chaud'] }),
    listerMembres: async () => over.membres ?? [{ id: 'u1', name: 'Jean', email: 'jean@test.fr', role: 'admin' }],
    ...over,
  };
  const keys = new FakeApiKeys()
    .add(CLE_TOUT, { id: 'k1', tenantId: 't1', scopes: ['mcp:read', 'mcp:write'] })
    .add(CLE_LECTURE, { id: 'k2', tenantId: 't1', scopes: ['mcp:read'] })
    .add(CLE_AUTRE_ESPACE, { id: 'k3', tenantId: 't2', scopes: ['mcp:read', 'mcp:write'] });
  const server = buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: contactsV1Muets(), mcp } });
  return { server, traces };
}

const auth = (cle: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${cle}` } });
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const appeler = (nom: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name: nom, arguments: args });

/** Le contenu texte d'un `tools/call` réussi, reparsé. */
function contenu(res: { json: <T>() => T }): { texte: string; isError: boolean } {
  const b = res.json<{ result?: { content?: Array<{ text: string }>; isError?: boolean } }>();
  return { texte: b.result?.content?.[0]?.text ?? '', isError: b.result?.isError === true };
}

describe('serveur MCP : autorisation', () => {
  it('sans clé -> 401 ; clé inconnue -> 401', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/mcp', ...auth(cleApiDeTest('inconnue')), payload: rpc('tools/list') })).statusCode).toBe(401);
    await server.close();
  });

  it('🔴 une clé LECTURE SEULE ne voit aucun outil d’écriture', async () => {
    // Ne pas les lister n'est pas cosmétique : un agent qui voit un outil l'essaie, échoue, et recommence.
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: rpc('tools/list') });
    const noms = res.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((t) => t.name);
    expect(noms).toContain('list_conversations');
    expect(noms).not.toContain('reply_in_open_window');
    expect(noms).not.toContain('tag_conversation');
    expect(noms).not.toContain('assign_conversation');
    await server.close();
  });

  it('🔴 appeler un outil d’écriture avec une clé de lecture est REFUSÉ, sans dire pourquoi', async () => {
    const { server, traces } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'coucou' }) });
    const b = res.json<{ error?: { message: string } }>();
    expect(b.error?.message).toMatch(/inconnu ou non autorisé/);
    // Le message est le MÊME que pour un outil qui n'existe pas : sinon on renseigne le porteur de la clé
    // sur des capacités qu'on lui refuse.
    const fantome = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('outil_qui_n_existe_pas') });
    expect(fantome.json<{ error?: { message: string } }>().error?.message).toMatch(/inconnu ou non autorisé/);
    // Et surtout : rien n'a été envoyé.
    expect(traces.envois).toHaveLength(0);
    await server.close();
  });

  it('🔴 le tenant vient de la CLÉ : une autre clé ne voit pas les conversations de t1', async () => {
    const { server, traces } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_AUTRE_ESPACE), payload: appeler('list_conversations') });
    expect(JSON.parse(contenu(res).texte)).toEqual({ conversations: [] });
    expect(traces.listes).toEqual(['t2']); // c'est bien t2 qui est parti au store, pas t1
    await server.close();
  });

  it('🔴 un identifiant de conversation d’un AUTRE espace se refuse comme un inexistant', async () => {
    // IDOR : la garde est le scope tenant du store, et le message ne doit pas confirmer que l'identifiant
    // existe ailleurs. Les deux cas rendent exactement la même phrase.
    const { server } = app();
    const chezLautre = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_AUTRE_ESPACE), payload: appeler('get_conversation', { conversation_id: 'cv1' }) });
    const inexistant = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_conversation', { conversation_id: 'cv-jamais-vue' }) });
    expect(contenu(chezLautre)).toEqual(contenu(inexistant));
    expect(contenu(chezLautre).isError).toBe(true);
    await server.close();
  });
});

describe('serveur MCP : protocole', () => {
  it('initialize annonce ses capacités et ÉCHO la version du client quand il la connaît', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: rpc('initialize', { protocolVersion: '2025-03-26' }) });
    const b = res.json<{ result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } }>();
    expect(b.result.protocolVersion).toBe('2025-03-26');
    expect(b.result.capabilities.tools).toBeDefined();
    expect(b.result.serverInfo.name).toBe('messagingme-mba');
    // Version inconnue -> on répond la NÔTRE, et c'est au client de décider s'il continue.
    const futur = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: rpc('initialize', { protocolVersion: '3000-01-01' }) });
    expect(futur.json<{ result: { protocolVersion: string } }>().result.protocolVersion).toBe('2025-06-18');
    await server.close();
  });

  it('une NOTIFICATION (sans id) ne reçoit pas de corps : 202', async () => {
    // `notifications/initialized` est envoyée par tout client MCP juste après l'initialisation. Répondre
    // un corps JSON-RPC à une notification est une faute de protocole, et certains clients s'en plaignent.
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
    await server.close();
  });

  it('méthode inconnue -> erreur JSON-RPC -32601, corps JSON cassé -> -32700, GET -> 405', async () => {
    const { server } = app();
    const inconnue = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: rpc('resources/list') });
    expect(inconnue.json<{ error: { code: number } }>().error.code).toBe(-32601);
    const casse = await server.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${CLE_TOUT}` }, payload: '"pas un objet"' });
    expect(casse.json<{ error: { code: number } }>().error.code).toBe(-32700);
    expect((await server.inject({ method: 'GET', url: '/mcp', ...auth(CLE_TOUT) })).statusCode).toBe(405);
    await server.close();
  });

  it('🔴 un LOT de messages est REFUSÉ, et aucun de ses appels n’est exécuté', async () => {
    // 🔴 C'est une garde de SÉCURITÉ avant d'être une conformité, et elle a été trouvée en revue. Le
    // plafond de débit se compte UNE FOIS PAR REQUÊTE HTTP, dans le preHandler de la clé. Un lot accepté
    // aurait donc laissé passer, pour une seule unité de quota, autant d'appels `reply_in_open_window` que
    // le corps de 1 Mo peut en contenir : des milliers d'envois Meta réels dans un seul POST. C'est le
    // mégaphone que ce lot dit avoir fermé en n'exposant pas `send_template`, rouvert par le volume.
    // Le protocole va dans le même sens : le lot a été retiré de MCP en 2025-06-18.
    const { server, traces } = app();
    const res = await server.inject({
      method: 'POST', url: '/mcp', ...auth(CLE_TOUT),
      payload: [
        appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'un' }),
        appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'deux' }),
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ error: { code: number; message: string } }>().error.code).toBe(-32600);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/un seul message/);
    // Et surtout : RIEN n'est parti. C'est le seul sens qui compte ici.
    expect(traces.envois).toHaveLength(0);
    await server.close();
  });

  it('un lot VIDE est refusé de la même façon, sans traitement particulier', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: [] });
    expect(res.json<{ error: { code: number } }>().error.code).toBe(-32600);
    await server.close();
  });
});

describe('serveur MCP : les outils', () => {
  it('list_conversations rend les fils de l’espace de la clé', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_conversations', { limit: 10 }) });
    const { conversations } = JSON.parse(contenu(res).texte) as { conversations: Array<{ conversation_id: string; phone: string }> };
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ conversation_id: 'cv1', phone: '33600000001' });
    await server.close();
  });

  /**
   * 🔴 `list_members` N'AVAIT AUCUNE BORNE, ET C'ÉTAIT LE SEUL (trouvé le 2026-09-14, absent de l'audit).
   * Ses trois voisins bornent leur `limit` entre 1 et 100 ou 200 ; celui-ci ne prenait aucun paramètre et
   * rendait l'équipe ENTIÈRE. Sur nos espaces d'aujourd'hui, c'est trois lignes ; sur un client à
   * plusieurs centaines de comptes, c'est une réponse que personne n'a dimensionnée, servie à chaque appel
   * et payée en jetons par le modèle qui la lit.
   */
  it('🔴 list_members est BORNÉ, et il dit quand il tronque', async () => {
    const { server } = app({ membres: Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, name: `M${i}`, email: `m${i}@test.fr`, role: 'agent' })) });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_members', { limit: 5 }) });
    const corps = JSON.parse(contenu(res).texte) as { members: unknown[]; tronque: boolean };
    expect(corps.members).toHaveLength(5);
    // ⚠️ SANS `tronque`, un modèle qui reçoit exactement `limit` membres conclut qu'il les a tous.
    expect(corps.tronque).toBe(true);
    await server.close();
  });

  it('⚠️ une demande démesurée est RAMENÉE à la borne, pas refusée', async () => {
    // Même convention que ses voisins : on borne en silence plutôt que de renvoyer une erreur à un modèle,
    // qui n'a aucun moyen de deviner le plafond et rejouerait le même appel.
    const { server } = app({ membres: Array.from({ length: 500 }, (_, i) => ({ id: `u${i}`, name: `M${i}`, email: `m${i}@test.fr`, role: 'agent' })) });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_members', { limit: 100000 }) });
    expect((JSON.parse(contenu(res).texte) as { members: unknown[] }).members).toHaveLength(200);
    await server.close();
  });

  it('🔴 reply_in_open_window envoie VRAIMENT, et par le chemin partagé avec la console', async () => {
    const { server, traces } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'je vous rappelle demain' }) });
    expect(contenu(res).isError).toBe(false);
    expect(JSON.parse(contenu(res).texte)).toMatchObject({ message_id: 'wamid-1' });
    expect(traces.envois).toEqual([{ tenant: 't1', to: '33600000001', texte: 'je vous rappelle demain' }]);
    await server.close();
  });

  it('🔴 la réponse est journalisée « mcp », JAMAIS « scenario » ni « humain »', async () => {
    // 🔴 Le bug trouvé en revue, et sa non-régression. L'origine était DÉDUITE de l'expéditeur, et comme un
    // agent tiers n'en a pas, chaque réponse MCP partait marquée « scenario ». Le tableau « qui a écrit les
    // messages de service » aurait compté tout le trafic d'agent tiers comme du scripté, et rien ne
    // l'aurait signalé : la valeur étant écrite explicitement, le repli « indéterminée » ne pouvait pas se
    // déclencher. Les deux champs répondent à deux questions : qui SIGNE (personne), et qui a ÉCRIT (mcp).
    const { server, traces } = app();
    await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'bonjour' }) });
    expect(traces.journal).toHaveLength(1);
    expect(traces.journal[0]!.origine).toBe('mcp');
    expect(traces.journal[0]!.origine).not.toBe('scenario');
    expect(traces.journal[0]!.auteur ?? null).toBeNull(); // aucun opérateur ne signe ce message
    await server.close();
  });

  it('🔴 hors de la fenêtre de 24 h, l’envoi est REFUSÉ, et le refus est un RÉSULTAT pas une panne', async () => {
    // C'est la garde qui compte le plus de tout ce lot : elle est portée par `repondreDansLaFenetre`,
    // partagé avec la route de console. Un outil MCP qui aurait sa propre copie pourrait la perdre.
    const { server, traces } = app({
      getConversationContext: async () => ({ waId: '33600000001', lastInboundAt: null, windowOpen: false }),
    });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'coucou' }) });
    expect(res.statusCode).toBe(200);
    const c = contenu(res);
    expect(c.isError).toBe(true); // un refus métier, lisible par l'agent
    expect(c.texte).toMatch(/fenêtre de 24 h fermée/);
    expect(traces.envois).toHaveLength(0); // et RIEN n'est parti
    await server.close();
  });

  /**
   * 🔴 LE CAS QUI MANQUAIT À CE CHEMIN (lot 3 du plan 2026-09-14). L'opt-out du MCP n'était gardé que par un
   * test qui relisait le source de `src/inbox/repondre.ts` à la recherche du motif : il prouvait qu'une
   * chaîne de caractères existait, jamais qu'un contact désabonné restait tranquille. Or c'est LE chemin où
   * une machine parle en notre nom, et la garde y vise `origine === 'mcp'` précisément pour ça.
   *
   * ⚠️ La fenêtre de 24 h est OUVERTE dans ce cas : sans quoi le refus viendrait d'elle, et ce test passerait
   * même si la garde d'opt-out avait disparu.
   */
  it('🔴 un contact DÉSABONNÉ ne reçoit rien du MCP, et le refus a son propre motif', async () => {
    const { server, traces } = app({ estDesabonne: toujoursDesabonne });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'coucou' }) });
    expect(res.statusCode).toBe(200);
    const c = contenu(res);
    expect(c.isError).toBe(true);
    expect(c.texte, 'l’agent doit lire la VRAIE raison').toMatch(/ne plus recevoir/i);
    expect(c.texte, 'le refus ne doit PAS se déguiser en fenêtre fermée : l’agent réessaierait plus tard').not.toMatch(/fenêtre/i);
    expect(traces.envois, 'un message est parti à un contact qui a dit STOP').toHaveLength(0);
    await server.close();
  });

  /**
   * 🔴 LE NUMÉRO DÉLIÉ EST UN REFUS, PAS UNE PANNE (relecture du 2026-09-25). `NumeroDelieError` n'étant pas un
   * `RefusOutil`, le serveur la rendait en `-32603` « échec interne de l’outil » et la journalisait comme une
   * panne : l'agent tiers ne lisait pas la raison, et réessayait sur le plafond de l'espace.
   */
  it('🔴 numéro délié : un RÉSULTAT `isError` avec la phrase, jamais une erreur JSON-RPC, et rien n’est journalisé comme parti', async () => {
    const { server, traces } = app({ sendReply: async (_t, pn) => { throw new NumeroDelieError(pn); } });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'coucou' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ error?: unknown }>().error, 'le refus ne doit pas sortir en erreur de protocole').toBeUndefined();
    const c = contenu(res);
    expect(c.isError).toBe(true);
    expect(c.texte).toBe(MESSAGE_NUMERO_DELIE);
    expect(traces.journal).toEqual([]);
    await server.close();
  });

  it('un texte vide est refusé avant tout appel Meta', async () => {
    const { server, traces } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: '   ' }) });
    expect(contenu(res).isError).toBe(true);
    expect(traces.envois).toHaveLength(0);
    await server.close();
  });

  it('get_messages garde les plus RÉCENTS et signale la troncature', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_messages', { conversation_id: 'cv1', limit: 1 }) });
    const b = JSON.parse(contenu(res).texte) as { messages: Array<{ body: string }>; tronque: boolean };
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]!.body).toBe('bonjour à vous'); // le dernier, pas le premier
    expect(b.tronque).toBe(true);
    await server.close();
  });

  it('tag_conversation rend ce qui a RÉELLEMENT changé', async () => {
    const { server } = app({ ajouterTags: async () => ({ touched: 1, added: ['chaud'] }) });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('tag_conversation', { conversation_id: 'cv1', tags: ['chaud', 'vip'] }) });
    // « vip » n'était pas nouveau : un agent qui repose un tag doit pouvoir s'en rendre compte, sinon il
    // boucle en croyant échouer.
    expect(JSON.parse(contenu(res).texte)).toMatchObject({ tags_ajoutes: ['chaud'], deja_presents: ['vip'] });
    await server.close();
  });

  it('assign_conversation : null LIBÈRE, une valeur bancale est refusée', async () => {
    const vus: Array<string | null> = [];
    const { server } = app({ setAssignee: async (_t, _id, a) => { vus.push(a); return true; } });
    await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1', member_id: 'u1' }) });
    await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1', member_id: null }) });
    expect(vus).toEqual(['u1', null]);
    // Une valeur bancale ne doit PAS se traduire par une libération silencieuse, qui rouvrirait le fil à tous.
    const bancal = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1', member_id: 42 }) });
    expect(contenu(bancal).isError).toBe(true);
    expect(vus).toHaveLength(2);
    await server.close();
  });
});

describe('serveur MCP : cohérence du catalogue', () => {
  it('🔴 aucun outil n’expose l’envoi de TEMPLATE ni de campagne', () => {
    // Décision du lot, et pas un oubli : ouvrir l'envoi de template à un modèle, c'est lui donner un
    // mégaphone facturé sur un numéro dont Meta note la qualité. Ce test est là pour qu'un ajout futur
    // soit une décision explicite (il faudra le modifier) et non un glissement.
    const noms = OUTILS.map((o) => o.nom).join(' ');
    expect(noms).not.toMatch(/template|campaign|campagne|broadcast/i);
  });

  it('🔴 chaque scope d’outil est un scope de clé RÉELLEMENT attribuable', () => {
    // Un outil rattaché à un scope absent de `VALID_API_SCOPES` serait invisible pour toujours : aucune
    // clé ne pourrait le porter, et rien ne le signalerait.
    for (const o of OUTILS) {
      expect(VALID_API_SCOPES as readonly string[], `outil « ${o.nom} »`).toContain(o.scope);
    }
  });

  it('les noms d’outils sont uniques et les schémas d’entrée bien formés', () => {
    expect(new Set(OUTILS.map((o) => o.nom)).size).toBe(OUTILS.length);
    for (const o of OUTILS) {
      expect(o.entree.type).toBe('object');
      for (const requis of o.entree.required ?? []) {
        expect(Object.keys(o.entree.properties), `outil « ${o.nom} »`).toContain(requis);
      }
    }
  });
});
