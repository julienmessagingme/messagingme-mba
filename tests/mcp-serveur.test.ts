import { jamaisDesabonne, toujoursDesabonne } from './consentement';
import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server';
import { contactsV1Muets } from './aide/contacts-v1';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { CablageMcp, DepsMcp } from '../src/mcp/outils';
import { outilsPour } from '../src/mcp/outils';
import type { ContactRow } from '../src/crm/contact-store.pg';
import type { AnalyseDeFiche } from '../src/analysis/fiche';
import { OUTILS } from '../src/mcp/outils';
import * as catalogue from '../src/mcp/outils';
import { API_SCOPES } from '../web/lib/partage/droits-api';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE, NumeroSuspenduError, MESSAGE_NUMERO_SUSPENDU } from '../src/meta/numero-delie';
import { mcpAgentInerte, mcpNumeroInerte, mcpEvenementsInertes, mcpChiffresInertes, mcpMessagesInertes, mcpOffreInerte, mcpCampagnesInertes, mcpChampsInertes, mcpShopifyInerte, mcpFilInerte, mcpInerte, mcpWidgetsInertes } from './routes-inertes';
import { creerPoseEtiquette, LONGUEUR_MAX_ETIQUETTE } from '../src/crm/poser-etiquette';
import { DROITS } from '../src/offres/offres';
import { MetaTemplateClient, type FetchLike, type TemplateSummary } from '../src/meta/templates';
import { lireCible, schemaCorps, schemaDestinataire, type ResultatEnvoiPublic } from '../src/api/envoi-public';
import { validateParamMapping } from '../src/crm/template';
import { cleIdempotence } from '../src/api/idempotence';
import { modelesInertes, aucuneCampagneActive } from './routes-inertes';
import { filiereApiSeule, aucunPremierMessage } from './gardes';
import { porteEnMemoire } from './aide/porte-premier';
import { PHRASE_PREMIER_CONTACT } from '../src/application/envoi';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';

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
  /** La pose d'étiquettes, sur le VRAI module (`src/crm/poser-etiquette.ts`) : ce qui est posé, déclaré, publié. */
  poses: Array<{ tenant: string; waId: string; tags: string[] }>;
  declarees: string[];
  publiees: string[];
}

/** Ce que porte déjà la fiche du contact de `cv1` : reposer ces étiquettes ne change rien. */
const DEJA_SUR_LA_FICHE = ['vip'];

function app(
  over: Partial<Omit<CablageMcp, 'inbox' | 'contacts'>> & {
    inbox?: Partial<CablageMcp['inbox']>;
    contacts?: Partial<CablageMcp['contacts']>;
    membres?: Array<{ id: string; name: string; email: string; role: string }>;
  } = {},
) {
  const { inbox, contacts, membres, ...reste } = over;
  const traces: Traces = { contexte: [], envois: [], listes: [], journal: [], poses: [], declarees: [], publiees: [] };
  const mcp: CablageMcp = {
    estDesabonne: jamaisDesabonne,
    inbox: {
      ...mcpInerte,
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
      // Comme le store : les `n` derniers d'un fil de deux messages, dans l'ordre chronologique.
      getDerniersMessages: async (_id, n) => [
        { id: 'm1', direction: 'in', type: 'text', body: 'bonjour', createdAt: '2026-09-01T09:00:00.000Z' },
        { id: 'm2', direction: 'out', type: 'text', body: 'bonjour à vous', createdAt: '2026-09-01T09:01:00.000Z' },
      ].slice(-n) as never,
      recordOutbound: async (_id, _body, _msg, origine, _type, _cat, _name, auteur) => { traces.journal.push({ origine, auteur }); },
      ...inbox,
    },
    repo: {
      getTenantPhoneNumberId: async () => 'pn-1',
    },
    sendReply: async (tenant, _pn, to, texte) => { traces.envois.push({ tenant, to, texte }); return 'wamid-1'; },
    takeControl: async () => {},
    filTenuParLApplication: async () => false,
    application: filiereApiSeule,
    ecrirePremier: aucunPremierMessage,
    contacts: {
      query: async () => [],
      count: async () => 0,
      contactIdsForTarget: async () => [],
      applyEditsMany: async () => { throw new Error('applyEditsMany ne devrait pas être appelée'); },
      findByPhone: async () => null,
      setBlocked: async () => { throw new Error('setBlocked ne devrait pas être appelée'); },
      isBlockedByWaId: async () => false,
      analysesEtResumes: async () => new Map(),
      ...contacts,
    },
    // Le VRAI module de pose, sur de faux dépôts : c'est lui que l'outil appelle en production.
    etiquettes: creerPoseEtiquette({
      ajouterAuContact: async (tenant, waId, tags) => {
        traces.poses.push({ tenant, waId, tags });
        return { added: tags.filter((t) => !DEJA_SUR_LA_FICHE.includes(t)) };
      },
      waIdDeLaFiche: async () => { throw new Error('la fiche contact n’est pas une porte du MCP'); },
      declarer: async (tenant, tag) => { traces.declarees.push(`${tenant}:${tag}`); },
      emettre: async (tenant, waId, tag) => { traces.publiees.push(`${tenant}:${waId}:${tag}`); },
    }),
    listerMembres: async () => membres ?? [{ id: 'u1', name: 'Jean', email: 'jean@test.fr', role: 'admin' }],
    // Les outils des widgets ont leur fichier (`tests/mcp-widgets.test.ts`) : ici, ils ne servent à rien.
    ...mcpWidgetsInertes,
    ...mcpAgentInerte,
    ...mcpNumeroInerte,
    ...mcpEvenementsInertes,
    ...mcpChiffresInertes,
    ...mcpMessagesInertes,
    ...mcpOffreInerte,
    ...mcpCampagnesInertes,
    ...mcpChampsInertes,
    ...mcpShopifyInerte,
    ...mcpFilInerte,
    ...reste,
  };
  const keys = new FakeApiKeys()
    .add(CLE_TOUT, { id: 'k1', tenantId: 't1', scopes: ['mcp:read', 'mcp:write'] })
    .add(CLE_LECTURE, { id: 'k2', tenantId: 't1', scopes: ['mcp:read'] })
    .add(CLE_AUTRE_ESPACE, { id: 'k3', tenantId: 't2', scopes: ['mcp:read', 'mcp:write'] });
  const server = buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, oauth: aucunJetonOauth, contacts: contactsV1Muets(), mcp } });
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

describe('serveur MCP : le rappel de l’abonnement du numéro (lot 4)', () => {
  const suspendu = {
    abonnementId: 'sub_1', etat: 'suspendu' as const, finPrevueLe: null, coupureLe: null,
    finiLe: new Date('2026-10-06T15:14:51Z'), liberationLe: new Date('2026-10-13T15:14:51Z'), libereLe: null,
  };
  const avecAbonnement = (lire: () => Promise<typeof suspendu | null>) => ({ numero: { ...mcpNumeroInerte.numero, abonnement: lire } });

  it('🔴 suspendu : chaque réponse d’outil porte le rappel, en second bloc, refus compris', async () => {
    const { server } = app(avecAbonnement(async () => suspendu));
    const ok = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_conversations') });
    const blocs = ok.json<{ result: { content: Array<{ text: string }> } }>().result.content;
    expect(blocs).toHaveLength(2);
    expect(blocs[1]!.text).toMatch(/resubscribe_number/);
    const refus = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_conversation', { conversation_id: 'cv-jamais-vue' }) });
    expect(refus.json<{ result: { content: Array<{ text: string }> } }>().result.content.at(-1)!.text).toMatch(/resubscribe_number/);
    await server.close();
  });

  it('🔴 un rappel qui LÈVE en se formant (une date illisible) n’empêche pas l’outil non plus (jaune 7 de A)', async () => {
    const illisible = { ...suspendu, liberationLe: new Date(Number.NaN) };
    const { server } = app(avecAbonnement(async () => illisible as typeof suspendu));
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_conversations') });
    expect(res.json<{ result: { content: unknown[]; isError: boolean } }>().result).toMatchObject({ isError: false });
    expect(res.json<{ result: { content: unknown[] } }>().result.content).toHaveLength(1);
    await server.close();
  });

  it('actif ou sans abonnement : aucun rappel ; une lecture qui échoue n’empêche pas l’outil', async () => {
    for (const lire of [async () => null, async () => { throw new Error('pooler injoignable'); }]) {
      const { server } = app(avecAbonnement(lire as () => Promise<null>));
      const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_conversations') });
      expect(res.json<{ result: { content: unknown[]; isError: boolean } }>().result).toMatchObject({ isError: false });
      expect(res.json<{ result: { content: unknown[] } }>().result.content).toHaveLength(1);
      await server.close();
    }
  });
});

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

  it('🔴 get_conversation rend les actions d’agent IA de CETTE conversation, lues sur l’espace de la clé', async () => {
    const lues: string[] = [];
    const { server } = app({
      agentIa: {
        ...mcpAgentInerte.agentIa,
        actions: {
          listerDeLaConversation: async (tenant, conversationId, limite) => {
            lues.push(`${tenant}:${conversationId}:${limite}`);
            return [{ actionId: 'tool-1', nom: 'Résiliation', at: '2026-10-13T10:00:00.000Z', champs: { contrat: '12345' } }];
          },
        },
      },
    });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_conversation', { conversation_id: 'cv1' }) });
    expect(JSON.parse(contenu(res).texte).agent_actions).toEqual([
      { action_id: 'tool-1', name: 'Résiliation', at: '2026-10-13T10:00:00.000Z', fields: { contrat: '12345' } },
    ]);
    expect(lues).toEqual(['t1:cv1:10']);
    await server.close();
  });

  it('🔴 get_message_stats : une clé de LECTURE le voit et l’appelle, et il rend la période et ses séries', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('get_message_stats', { maille: 'semaine' }) });
    const r = contenu(res);
    expect(r.isError, r.texte).toBeFalsy();
    const corps = JSON.parse(r.texte);
    expect(corps.periode).toMatchObject({ maille: 'semaine', fuseau: 'Europe/Paris' });
    expect(corps.modeles.totaux).toEqual({ envoyes: 0, livres: 0, lus: 0, echecs: 0, sans_accuse: 0 });
    await server.close();
  });

  it('🔴 filière application : get_conversation dit la fenêtre et ce qu’elle change, et la réponse part par le service ou par la porte', async () => {
    // Sur l'application, répondre reste toujours possible (spec du 2026-10-22) ; hors des 24 heures, la réponse d'une
    // machine est écrite en premier, par la porte (plan 2026-10-23, tâche 3).
    for (const windowOpen of [true, false]) {
      const envoisApplication: string[] = [];
      const porte = porteEnMemoire({ optIn: 'opted_in' });
      const { server, traces } = app({
        inbox: { getConversationContext: async () => ({ waId: '33600000001', lastInboundAt: '2026-09-01T09:00:00.000Z', windowOpen }) },
        application: {
          filiere: async () => 'application',
          envoyer: async (_t, waId, texte) => { envoisApplication.push(`${waId}:${texte}`); return { ok: true, messageId: 'app:c1:WA1' }; },
        },
        ecrirePremier: porte.ecrirePremier,
      });
      const lu = JSON.parse(contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_conversation', { conversation_id: 'cv1' }) })).texte);
      expect(lu.window_open).toBe(windowOpen);
      expect(lu.note).toMatch(/outside it, it is queued, .* never writes first to someone who did not write to it/);
      const envoi = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'Bonjour' }) }));
      expect(envoi.isError, envoi.texte).toBeFalsy();
      expect(envoisApplication).toEqual(windowOpen ? ['33600000001:Bonjour'] : []);
      expect(porte.lignes.map((l) => l.texte)).toEqual(windowOpen ? [] : ['Bonjour']);
      expect(traces.envois).toEqual([]);
      await server.close();
    }
  });

  it('🔴 filière application : un outil sans objet (modèles, campagnes) refuse et propose l’API, sans rien appeler', async () => {
    const appels: string[] = [];
    const { server } = app({
      application: {
        filiere: async () => 'application',
        envoyer: async () => { appels.push('envoyer'); return { ok: false, raison: 'refuse' }; },
      },
    });
    // Ceux qu'une clé d'API atteint ; les autres exigent une personne, et passent par la même garde.
    for (const nom of ['list_templates', 'get_template_status', 'get_message_status', 'get_campaign_stats']) {
      const r = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler(nom, {}) }));
      expect(r.isError, nom).toBe(true);
      expect(r.texte, nom).toMatch(/application WhatsApp Business/);
      expect(r.texte, nom).toMatch(/API WhatsApp/);
    }
    expect(appels).toEqual([]);
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

  it('les instructions valent pour toute offre (lot 6, B2a) : elles n’imposent pas un outil de l’Inbox, et disent le refus hors offre', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: rpc('initialize', { protocolVersion: '2025-03-26' }) });
    const instructions = res.json<{ result: { instructions: string } }>().result.instructions;
    // En Base, list_conversations refuse : « commence par » enverrait chaque session vers un refus. Les instructions
    // sont en anglais depuis le 2026-10-14 (répertoire de Claude) : la même garde, dans les deux tournures.
    expect(instructions).not.toMatch(/(start|begin) with list_conversations|list_conversations is the starting point/i);
    expect(instructions).toMatch(/plan does not include .* refuses with the plan link/);
    // Le plugin et tout client qui reprend une mise en service (lot 10) partent de là.
    expect(instructions).toMatch(/get_setup_state is the starting point/);
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

  it('les deux outils rendent un envoi accepté mais non journalisé comme résultat, sans second envoi', async () => {
    const journalErreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ecritures = 0;
    let envoisMeta = 0;
    const { server, traces } = app({
      inbox: { recordOutbound: async () => { ecritures += 1; throw new Error('base indisponible'); } },
      envoyerMessage: async () => { envoisMeta += 1; return 'wamid.meta'; },
    });
    try {
      const appels = [
        appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'Bonjour' }),
        appeler('send_message', { conversation_id: 'cv1', message: { type: 'text', text: { body: 'Bonjour' } } }),
      ];
      for (const payload of appels) {
        const res = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload }));
        expect(res.isError).toBe(false);
        expect(JSON.parse(res.texte)).toMatchObject({ journal: 'unrecorded', warning: expect.stringMatching(/Do not send it again/) });
      }
      expect(traces.envois).toHaveLength(1);
      expect(envoisMeta).toBe(1);
      expect(ecritures).toBe(4);
    } finally {
      await server.close();
      journalErreur.mockRestore();
    }
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
      inbox: {
        getConversationContext: async () => ({ waId: '33600000001', lastInboundAt: null, windowOpen: false }),
      },
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

  it('🔴 numéro suspendu (lot 4) : un RÉSULTAT `isError` avec la phrase de la suspension', async () => {
    const { server } = app({ sendReply: async (_t, pn) => { throw new NumeroSuspenduError(pn); } });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'coucou' }) });
    const c = contenu(res);
    expect(c.isError).toBe(true);
    expect(c.texte).toBe(MESSAGE_NUMERO_SUSPENDU);
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

  /**
   * 🔴 get_messages LIT LA FIN DU FIL (lot 1 du plan 2026-10-03-mcp-remise-d-aplomb). Il lisait les 500 PREMIERS
   * messages et en gardait la fin : sur un fil plus long, l'assistant résumait le passé en croyant lire le présent.
   * Décision de Julien : les 50 plus récents, « c'est déjà bien assez ». Le faux store fait ce que fait le vrai
   * (`getDerniersMessages`, tenu en intégration) : les `n` derniers d'un fil, dans l'ordre chronologique.
   */
  describe('🔴 get_messages : les plus récents, 50 au plus', () => {
    /** Un fil de `n` messages, de « message 1 » (le plus ancien) à « message n ». */
    function monterFil(n: number) {
      const fil = Array.from({ length: n }, (_, i) => ({
        id: `0000000${i + 1}`.slice(-8) + '-0000-4000-8000-000000000000', direction: 'in' as const, type: 'text', body: `message ${i + 1}`,
        buttonPayload: null, createdAt: new Date(Date.UTC(2026, 8, 1, 9, 0, i)).toISOString(),
        curseur: new Date(Date.UTC(2026, 8, 1, 9, 0, i)).toISOString().replace('Z', '000Z'),
      }));
      const demandes: number[] = [];
      const avants: Array<{ at: string; id: string } | undefined> = [];
      const { server } = app({
        inbox: {
          // Le faux fait ce que fait le vrai (`getDerniersMessages`) : les `k` derniers AVANT le point donné.
          getDerniersMessages: async (_id, k, avant) => {
            demandes.push(k);
            avants.push(avant);
            const jusqua = avant ? fil.findIndex((m) => m.id === avant.id) : fil.length;
            return fil.slice(0, jusqua).slice(-k);
          },
        },
      });
      const lire = async (args: Record<string, unknown>, cle = CLE_TOUT) => {
        const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(cle), payload: appeler('get_messages', { conversation_id: 'cv1', ...args }) });
        return contenu(res);
      };
      return { server, demandes, avants, lire };
    }
    const corps = (texte: string) => JSON.parse(texte) as { messages: Array<{ body: string }>; tronque: boolean; before: string | null };

    it('🔴 before remonte le fil d’une page, sans doublon ni trou ; la dernière page rend before à null (lot 13)', async () => {
      const { server, avants, lire } = monterFil(120);
      const p1 = corps((await lire({})).texte);
      expect(p1.before).not.toBeNull();
      const p2 = corps((await lire({ before: p1.before })).texte);
      expect(p2.messages.map((m) => m.body)).toEqual(Array.from({ length: 50 }, (_, i) => `message ${21 + i}`));
      expect(avants[1]).toMatchObject({ id: '00000071-0000-4000-8000-000000000000' });
      const p3 = corps((await lire({ before: p2.before })).texte);
      expect(p3.messages.map((m) => m.body)).toEqual(Array.from({ length: 20 }, (_, i) => `message ${1 + i}`));
      expect([p3.tronque, p3.before]).toEqual([false, null]);
      await server.close();
    });

    it('un before illisible est refusé, sans rien lire', async () => {
      const { server, demandes, lire } = monterFil(10);
      expect((await lire({ before: 'bricole' })).isError).toBe(true);
      expect(demandes).toEqual([]);
      await server.close();
    });

    it('sans limite : demande 51 au store, rend les 50 DERNIERS du plus ancien au plus récent, et dit qu’il tronque', async () => {
      const { server, demandes, lire } = monterFil(120);
      const b = corps((await lire({})).texte);
      expect(demandes).toEqual([51]);
      expect(b.messages.map((m) => m.body)).toEqual(Array.from({ length: 50 }, (_, i) => `message ${71 + i}`));
      expect(b.tronque).toBe(true);
      await server.close();
    });

    it('une limite démesurée est RAMENÉE à 50, pas refusée', async () => {
      const { server, demandes, lire } = monterFil(300);
      const b = corps((await lire({ limit: 200 })).texte);
      expect(demandes).toEqual([51]);
      expect(b.messages).toHaveLength(50);
      expect(b.messages[49]!.body).toBe('message 300');
      await server.close();
    });

    it('🔴 tronque est juste dans les DEUX sens : 50 messages pile, faux ; 51, vrai', async () => {
      const pile = monterFil(50);
      const b50 = corps((await pile.lire({})).texte);
      expect(b50.messages).toHaveLength(50);
      expect(b50.tronque, 'le fil entier est rendu : rien ne manque').toBe(false);
      await pile.server.close();
      const unDePlus = monterFil(51);
      const b51 = corps((await unDePlus.lire({})).texte);
      expect(b51.messages[0]!.body).toBe('message 2');
      expect(b51.tronque, 'le premier message n’est pas rendu').toBe(true);
      await unDePlus.server.close();
    });

    it('🔴 la conversation d’un AUTRE espace est refusée, et RIEN n’est lu', async () => {
      const { server, demandes, lire } = monterFil(10);
      const c = await lire({}, CLE_AUTRE_ESPACE);
      expect(c.isError).toBe(true);
      expect(c.texte).toBe('conversation inconnue dans cet espace');
      expect(demandes, 'la garde d’espace passe AVANT toute lecture').toEqual([]);
      await server.close();
    });
  });

  it('tag_conversation rend ce qui a RÉELLEMENT changé', async () => {
    const { server, traces } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('tag_conversation', { conversation_id: 'cv1', tags: ['chaud', 'vip'] }) });
    // « vip » n'était pas nouveau : un agent qui repose un tag doit pouvoir s'en rendre compte, sinon il
    // boucle en croyant échouer.
    expect(JSON.parse(contenu(res).texte)).toMatchObject({ tags_ajoutes: ['chaud'], deja_presents: ['vip'] });
    // Sur le contact de la conversation, dans l'espace de la clé.
    expect(traces.poses).toEqual([{ tenant: 't1', waId: '33600000001', tags: ['chaud', 'vip'] }]);
    await server.close();
  });

  /**
   * 🔴 LA POSE DE L'OUTIL EST CELLE DE TOUTES LES PORTES (plan du 2026-10-04) : la même coupe à 64 caractères que la
   * fiche, le scénario et l'agent, et la déclaration dans le référentiel de l'espace. Mais SANS publier : un agent qui
   * boucle sur 500 fils déclencherait 500 automations, et la description de l'outil promet qu'il n'envoie rien.
   */
  it('🔴 tag_conversation coupe à 64 caractères et déclare dans le référentiel, sans RIEN publier', async () => {
    const { server, traces } = app();
    const long = 'x'.repeat(LONGUEUR_MAX_ETIQUETTE);
    // Deux saisies qui ne diffèrent qu'au-delà de la borne, et des espaces autour : UNE étiquette.
    const res = await server.inject({
      method: 'POST', url: '/mcp', ...auth(CLE_TOUT),
      payload: appeler('tag_conversation', { conversation_id: 'cv1', tags: [`  ${long}yz  `, `${long}w`, 'nouveau'] }),
    });
    expect(contenu(res).isError).toBe(false);
    expect(JSON.parse(contenu(res).texte)).toMatchObject({ tags_ajoutes: [long, 'nouveau'], deja_presents: [] });
    expect(traces.poses).toEqual([{ tenant: 't1', waId: '33600000001', tags: [long, 'nouveau'] }]);
    expect(traces.declarees).toEqual([`t1:${long}`, 't1:nouveau']);
    expect(traces.publiees, 'un tag posé par un assistant ne réveille aucune automation').toEqual([]);
    await server.close();
  });

  it('la borne de 64 caractères est ANNONCÉE dans le schéma de tag_conversation (un modèle ne respecte que ce qu’on lui dit)', () => {
    const outil = OUTILS.find((o) => o.nom === 'tag_conversation');
    expect(outil?.entree.properties.tags?.items).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    expect(LONGUEUR_MAX_ETIQUETTE).toBe(64);
  });

  it('assign_conversation : null LIBÈRE, une valeur bancale est refusée', async () => {
    const vus: Array<string | null> = [];
    const { server } = app({ inbox: { setAssignee: async (_t, _id, a) => { vus.push(a); return true; } } });
    await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1', member_id: 'u1' }) });
    await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1', member_id: null }) });
    expect(vus).toEqual(['u1', null]);
    // Une valeur bancale ne doit PAS se traduire par une libération silencieuse, qui rouvrirait le fil à tous.
    const bancal = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1', member_id: 42 }) });
    expect(contenu(bancal).isError).toBe(true);
    expect(vus).toHaveLength(2);
    // Un member_id OUBLIÉ non plus : seul un null écrit libère.
    const oublie = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('assign_conversation', { conversation_id: 'cv1' }) });
    expect(contenu(oublie).isError).toBe(true);
    expect(vus).toHaveLength(2);
    await server.close();
  });
});

describe('serveur MCP : cohérence du catalogue', () => {
  it('🔴 les campagnes : lire, préparer sans rien envoyer, lancer avec le code ; rien d’autre, et le seul envoi direct vise UNE personne', () => {
    // Décision du lot MCP, et pas un oubli : ouvrir l'envoi de MASSE à un modèle, c'est lui donner un mégaphone facturé
    // sur un numéro dont Meta note la qualité. Les modèles sont entrés par une décision de Julien (spec du lot 13,
    // 2026-10-08) : les créer, suivre leur validation, les lister, et en envoyer un à UN contact, réservé à une personne
    // connectée. Ce test est là pour que chaque ajout soit une décision explicite (il faudra le modifier) et non un
    // glissement.
    // Exceptions décidées par Julien : LIRE les chiffres des campagnes (2026-10-13) ; PRÉPARER une campagne sans rien
    // envoyer, puis la LANCER avec le code de son récapitulatif, au nom d'une personne (2026-10-20, spec
    // docs/superpowers/specs/2026-10-20-campagnes-depuis-claude-design.md) ; CORRIGER et SUPPRIMER un modèle, au nom d'une
    // personne (grill du 2026-10-22, plan docs/superpowers/plans/2026-10-22-mcp-marche-arriere.md) : rien n'en part chez un
    // contact ; FREINER une campagne (pause, déprogrammation) et en PRÉPARER la reprise (même grill) : `control_campaign`
    // n'envoie rien, la reprise part par `launch_campaign`, avec un code.
    const lecture = OUTILS.find((o) => o.nom === 'get_campaign_stats')!;
    expect(lecture.annotations.readOnlyHint).toBe(true);
    expect(lecture.scope).toBe('mcp:read');
    const prepare = OUTILS.find((o) => o.nom === 'prepare_campaign')!;
    expect(prepare.exigePersonne).toBe(true);
    expect(prepare.annotations.openWorldHint).toBe(false);
    const lance = OUTILS.find((o) => o.nom === 'launch_campaign')!;
    expect(lance.exigePersonne).toBe(true);
    expect(lance.entree.required).toEqual(['campaign_id', 'confirmation_code']);
    const campagnes = OUTILS.map((o) => o.nom).filter((n) => /campaign|campagne|broadcast/i.test(n)).sort();
    expect(campagnes).toEqual(['control_campaign', 'get_campaign_stats', 'launch_campaign', 'prepare_campaign']);
    const freins = OUTILS.find((o) => o.nom === 'control_campaign')!;
    expect(freins.exigePersonne).toBe(true);
    expect(freins.annotations.openWorldHint).toBe(false);
    const noms = OUTILS.map((o) => o.nom);
    expect(noms.filter((n) => /template/i.test(n)).sort())
      .toEqual(['create_template', 'delete_template', 'get_template_status', 'list_templates', 'send_template_to_contact', 'update_template']);
    const envoi = OUTILS.find((o) => o.nom === 'send_template_to_contact')!;
    expect(envoi.exigePersonne).toBe(true);
    expect(envoi.entree.properties).not.toHaveProperty('recipients');
  });

  it('🔴 chaque scope d’outil est un scope de clé RÉELLEMENT attribuable', () => {
    // Un outil rattaché à un scope absent d'`API_SCOPES` serait invisible pour toujours : aucune
    // clé ne pourrait le porter, et rien ne le signalerait.
    for (const o of OUTILS) {
      expect(API_SCOPES as readonly string[], `outil « ${o.nom} »`).toContain(o.scope);
    }
  });

  it('les noms d’outils sont uniques et les schémas d’entrée bien formés', () => {
    expect(new Set(OUTILS.map((o) => o.nom)).size).toBe(OUTILS.length);
    for (const o of OUTILS) {
      expect(o.entree.type).toBe('object');
      for (const requis of o.entree.required ?? []) {
        expect(Object.keys(o.entree.properties), `outil « ${o.nom} »`).toContain(requis);
      }
      // Une liste dit ce qu'elle contient : sans `items`, un modèle ne sait pas quoi y mettre.
      for (const [cle, p] of Object.entries(o.entree.properties)) {
        if (p.type === 'array') expect(p.items, `${o.nom}.${cle}`).toBeDefined();
      }
    }
  });

  /**
   * 🔴 LES ANNOTATIONS MCP (spécification 2025-06-18) : c'est sur elles qu'un client décide d'appeler sans demander.
   * Une lecture qui se dirait écriture ferait confirmer chaque lecture ; une écriture qui se dirait lecture
   * s'appellerait sans confirmation. Et une écriture SANS `destructiveHint` est supposée destructrice par le client.
   */
  it('🔴 chaque écriture porte les valeurs DÉCIDÉES dans le plan (destructive, idempotent, monde ouvert)', () => {
    // Recopiées du plan 2026-10-03-mcp-remise-d-aplomb : changer une valeur est une décision, pas un glissement.
    // 🔴 La PREMIÈRE valeur (destructive) vaut `true` pour TOUTE écriture depuis le 2026-10-14 : c'est la règle du
    // répertoire de Claude (« destructiveHint: true for tools that modify or delete data »), décision de Julien
    // (spec 2026-10-14-repertoire-claude-design.md), que le type `AnnotationsMcp` impose. Les deux autres restent
    // celles du plan, outil par outil.
    const ecritures = Object.fromEntries(OUTILS.filter((o) => !o.annotations.readOnlyHint).map((o) => [
      o.nom,
      o.annotations.readOnlyHint ? null : [o.annotations.destructiveHint, o.annotations.idempotentHint, o.annotations.openWorldHint],
    ]));
    expect(ecritures).toEqual({
      reply_in_open_window: [true, false, true],
      // Comme reply_in_open_window : un message part chez une personne, et prend le fil (lot 13, domaine 2).
      send_message: [true, false, true],
      tag_conversation: [true, true, false],
      assign_conversation: [true, true, false],
      // La main du fil (2026-10-22) : rejouer le même geste laisse le même détenteur, et le geste peut retirer le contact
      // de la liste de l'agent de Meta, ou l'y remettre, chez Meta.
      control_conversation: [true, true, true],
      // Le blocage (2026-10-22) : bloquer un bloqué ne change rien ; rien ne part chez un tiers.
      block_contact: [true, true, false],
      create_widget: [true, false, false],
      update_widget: [true, true, false],
      // L'agent IA et le crédit : la table de la spec du lot 8a (2026-10-03-mcp-agent-ia-design.md, section 1).
      create_agent: [true, false, true],
      update_agent: [true, true, false],
      set_agent_tools: [true, true, false],
      // Les limites d'une conversation (2026-10-23) : elles remplacent celles d'avant ; les rejouer ne change rien.
      set_agent_limits: [true, true, false],
      activate_agent: [true, true, false],
      // Monde ouvert depuis le 2026-10-05 (décision de Julien) : un connecteur GET qui intègre y interroge pour de
      // vrai le système du client.
      test_agent: [true, false, true],
      add_knowledge: [true, false, false],
      delete_knowledge: [true, true, false],
      import_site: [true, true, true],
      import_document_text: [true, true, false],
      set_transfer_mode: [true, true, false],
      // Les heures d'ouverture REMPLACENT celles d'avant ; les rejouer ne change rien.
      set_business_hours: [true, true, false],
      // Les actions de l'agent (2026-10-13) : modifier REMPLACE la cible, et sans action_id chaque appel en crée une.
      set_agent_action: [true, false, false],
      delete_agent_action: [true, true, false],
      // Le répondeur (lot 5) : il peut éteindre l'agent de Meta chez Meta, pour tous les contacts de l'espace.
      set_default_responder: [true, true, true],
      buy_credit: [true, false, true],
      // La connexion du numéro (lot 3c) : un lien signé de plus à chaque appel, et une attente qui ne change rien.
      start_whatsapp_connection: [true, false, false],
      watch_whatsapp_connection: [true, true, false],
      // L'abonnement du numéro (lot 3c, livraison B) : une session du portail est créée chez Stripe à chaque appel.
      manage_number_subscription: [true, false, true],
      // Lot 4 : une session de Stripe de plus à chaque appel, comme le portail.
      resubscribe_number: [true, false, true],
      // Lot 6, B2b : un choix en base, réversible tant que le Pro court ; rien chez Stripe.
      return_number_at_plan_end: [true, true, false],
      // Lot 12 : une adresse de plus à chaque appel ; l'essai part vers l'application du client.
      create_webhook_endpoint: [true, false, false],
      send_test_event: [true, false, true],
      // Lot 13, domaine 4 : l'envoi repart vers l'application, avec le même identifiant d'événement.
      replay_webhook_delivery: [true, true, true],
      // La marche arrière (2026-10-22) : chaque rotation tire un nouveau secret ; supprimer deux fois ne supprime rien de
      // plus ; rien ne part chez un tiers.
      update_webhook_endpoint: [true, false, false],
      delete_webhook_endpoint: [true, true, false],
      // Lot 13, domaine 3 : un modèle de plus chez Meta à chaque appel, qui y reste.
      create_template: [true, false, true],
      // La marche arrière (2026-10-22) : chaque correction use une des éditions que Meta compte ; supprimer deux fois ne
      // supprime rien de plus ; les deux se font chez Meta.
      update_template: [true, false, true],
      delete_template: [true, true, true],
      // Livraison B : un message part chez une personne ; la même clé d'idempotence ne renvoie rien ; le fil n'est pas pris.
      send_template_to_contact: [true, true, true],
      // Les campagnes depuis l'assistant (2026-10-20) : reposer les mêmes étiquettes ne change rien.
      tag_contacts: [true, true, false],
      // Un brouillon de plus à chaque appel, et rien ne part.
      prepare_campaign: [true, false, false],
      // Les messages partent (ou partiront à la date) chez des personnes ; un second appel avec le même code est refusé.
      launch_campaign: [true, false, true],
      // Les freins et la reprise (2026-10-22) : rien ne part chez un tiers ; chaque reprise préparée tire un nouveau code.
      control_campaign: [true, false, false],
      // Les champs (2026-10-20) : un champ de plus à chaque appel ; poser la même valeur ne change rien.
      create_field: [true, false, false],
      set_contact_field: [true, true, false],
      // Le connecteur Shopify (2026-10-21) : brancher et rebrancher donnent le même état ; la connexion appelle Shopify, et
      // un message branché part chez des clients ; couper ne touche personne hors de l'espace.
      connect_shopify: [true, true, true],
      set_shopify_message: [true, true, true],
      disconnect_shopify: [true, true, false],
      // L'import des clients (lot 3) : rejoué, il n'écrit que les suivants, sans doublon ; il lit chez Shopify.
      import_shopify_customers: [true, true, true],
      // Offres v2 : une clé de plus à chaque appel, rien chez un tiers ; le Pro ouvre une session chez Stripe à chaque appel.
      create_api_key: [true, false, false],
      subscribe_pro: [true, false, true],
    });
    // Une lecture ne touche personne hors de l'espace, à DEUX exceptions nommées : `preview_site` va lire un site tiers,
    // `preview_shopify_customers` les clients de la boutique chez Shopify (lot 3).
    const lecturesEnMondeOuvert = OUTILS.filter((x) => x.annotations.readOnlyHint && x.annotations.openWorldHint).map((o) => o.nom);
    expect(lecturesEnMondeOuvert.sort()).toEqual(['preview_shopify_customers', 'preview_site']);
  });

  it('🔴 readOnlyHint vaut exactement « le scope est mcp:read », et chaque écriture déclare destructiveHint et idempotentHint', () => {
    for (const o of OUTILS) {
      expect(o.annotations.readOnlyHint, `outil « ${o.nom} »`).toBe(o.scope === 'mcp:read');
      expect(o.annotations.title.trim(), `outil « ${o.nom} »`).not.toBe('');
      expect(typeof o.annotations.openWorldHint, `outil « ${o.nom} »`).toBe('boolean');
      if (o.scope === 'mcp:write') {
        expect(o.annotations, `outil « ${o.nom} »`).toEqual(expect.objectContaining({
          destructiveHint: expect.any(Boolean), idempotentHint: expect.any(Boolean),
        }));
      }
    }
  });

  it('tools/list rend le titre et les annotations de chaque outil qu’une clé peut voir', async () => {
    // Une clé ne voit pas les outils qui exigent une personne : ceux-là sont listés par un jeton OAuth
    // (`tests/mcp-agent.test.ts`).
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: rpc('tools/list') });
    const listes = res.json<{ result: { tools: Array<{ name: string }> } }>().result.tools;
    const visibles = OUTILS.filter((o) => o.exigePersonne !== true);
    expect(listes).toHaveLength(visibles.length);
    for (const o of visibles) {
      expect(listes.find((t) => t.name === o.nom), `outil « ${o.nom} »`).toMatchObject({ title: o.annotations.title, annotations: o.annotations });
    }
    await server.close();
  });
});

/**
 * 🔴 CHAQUE BORNE QU'UN OUTIL APPLIQUE EST ANNONCÉE DANS SON SCHÉMA (règle du dépôt, 2026-09-17) : un modèle ne
 * respecte que ce qu'on lui a dit. Les bornes appliquées vivent dans les appels `texteObligatoire` et `entierBorne`
 * de chaque `executer` : on les lit dans SA source, et le schéma de CET outil doit les porter avec la même valeur.
 * Un appel que l'extracteur ne sait pas lire le fait échouer, au lieu de passer à vide.
 */
describe('🔴 les bornes appliquées par un outil sont annoncées dans son schéma', () => {
  /** Un nombre écrit à l'appel, ou une constante exportée par `src/mcp/outils.ts`. Rien d'autre. */
  function valeur(brut: string): number {
    const v = /^\d+$/.test(brut) ? Number(brut) : (catalogue as Record<string, unknown>)[brut];
    if (typeof v !== 'number') throw new Error(`borne illisible : « ${brut} » n’est ni un nombre ni une constante exportée`);
    return v;
  }

  it('texteObligatoire (minLength 1, maxLength) et entierBorne (minimum, maximum), avec la même valeur', () => {
    let lus = 0;
    for (const o of OUTILS) {
      const source = o.executer.toString();
      const props = o.entree.properties;
      const textes = [...source.matchAll(/texteObligatoire\(\s*args\s*,\s*["'](\w+)["']\s*,\s*(\w+)\s*\)/g)];
      const entiers = [...source.matchAll(/entierBorne\(\s*args\s*,\s*["'](\w+)["']\s*,\s*\w+\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g)];
      expect(textes.length, `${o.nom} : un appel de texteObligatoire que l’extracteur ne lit pas`).toBe(source.split('texteObligatoire(').length - 1);
      expect(entiers.length, `${o.nom} : un appel d’entierBorne que l’extracteur ne lit pas`).toBe(source.split('entierBorne(').length - 1);
      for (const [, cle, maxi] of textes) {
        expect(props[cle!], `${o.nom}.${cle}`).toMatchObject({ minLength: 1, maxLength: valeur(maxi!) });
      }
      for (const [, cle, mini, maxi] of entiers) {
        expect(props[cle!], `${o.nom}.${cle}`).toMatchObject({ minimum: valeur(mini!), maximum: valeur(maxi!) });
      }
      lus += textes.length + entiers.length;
    }
    expect(lus, 'aucun appel lu : la forme de la source a changé, ce test est aveugle').toBeGreaterThan(0);
  });
});

const CONTACT_MCP: ContactRow = {
  id: '00000000-0000-4000-8000-0000000000a1', phoneE164: '+33612345678', bsuid: null, externalId: null, profileName: 'Camille',
  optInStatus: 'opted_in', fields: {}, tags: [], createdAt: '2026-09-01T10:00:00.000Z', blockedAt: null,
  whatsappJoignable: null, whatsappJoignableLe: null, risque: null,
};
const ANALYSE_MCP: AnalyseDeFiche = {
  intention: 'suivi_commande', sentiment: 'negatif', satisfaction: 0, urgence: 9, resolue: false, sujet: 'Colis en retard',
  traiteePar: 'humain', action: 'rappeler', analyseLe: new Date('2026-09-26T14:32:00.000Z'),
  fenetreFin: new Date('2026-09-26T14:30:00.000Z'), conversationId: '00000000-0000-4000-8000-0000000000c1',
};

describe('🔴 get_contact cherche la fiche au format de la fiche (essai réel du 2026-10-02)', () => {
  it('un identifiant WhatsApp sans « + », un E.164 et un national cherchent tous +33612345678', async () => {
    const cherches: string[] = [];
    const { server } = app({ contacts: { findByPhone: async (_t: string, p: string) => { cherches.push(p); return null; } } });
    for (const phone of ['33612345678', '+33612345678', '06 12 34 56 78']) {
      await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('get_contact', { phone }) });
    }
    expect(cherches).toEqual(['+33612345678', '+33612345678', '+33612345678']);
  });

  it('🔴 la fiche porte sa dernière analyse et son RÉSUMÉ, lus dans l’espace de la clé', async () => {
    const lus: Array<{ tenant: string; ids: readonly string[] }> = [];
    const { server } = app({
      contacts: {
        findByPhone: async () => CONTACT_MCP,
        analysesEtResumes: async (tenant: string, ids: readonly string[]) => {
          lus.push({ tenant, ids });
          return new Map([[CONTACT_MCP.id, { analyse: ANALYSE_MCP, resume: 'Le client attend son colis depuis dix jours.' }]]);
        },
      },
    });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('get_contact', { phone: '33612345678' }) });
    expect(contenu(res).isError).toBe(false);
    expect(JSON.parse(contenu(res).texte).last_analysis).toEqual({
      intent: 'suivi_commande', sentiment: 'negatif', satisfaction: 0, urgency: 9, resolved: false, topic: 'Colis en retard',
      handled_by: 'humain', action_suggestion: 'rappeler', analyzed_at: '2026-09-26T14:32:00.000Z',
      summary: 'Le client attend son colis depuis dix jours.',
    });
    expect(lus).toEqual([{ tenant: 't1', ids: [CONTACT_MCP.id] }]);
  });

  it('jamais analysée : `last_analysis` vaut null ; la recherche lit TOUTE la page en UNE fois', async () => {
    const lus: Array<readonly string[]> = [];
    const autre = { ...CONTACT_MCP, id: '00000000-0000-4000-8000-0000000000b2', phoneE164: '+33698765432' };
    const { server } = app({
      contacts: {
        query: async () => [CONTACT_MCP, autre],
        analysesEtResumes: async (_t: string, ids: readonly string[]) => {
          lus.push(ids);
          return new Map([[CONTACT_MCP.id, { analyse: ANALYSE_MCP, resume: null }]]);
        },
      },
    });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('search_contacts', { query: 'Camille' }) });
    const rendus = JSON.parse(contenu(res).texte).contacts as Array<{ id: string; last_analysis: Record<string, unknown> | null }>;
    // La recherche ne porte pas le résumé : vingt résumés dépasseraient ce qu'un outil d'agent rend.
    expect(rendus[0]?.last_analysis).toMatchObject({ sentiment: 'negatif', satisfaction: 0 });
    expect(rendus[0]?.last_analysis).not.toHaveProperty('summary');
    expect(rendus[1]?.last_analysis).toBeNull();
    expect(lus).toEqual([[CONTACT_MCP.id, autre.id]]);
  });

  it('⚠️ une lecture d’analyse ratée rend la fiche quand même, SANS la clé (et non `null`, qui dirait « jamais analysée »)', async () => {
    const { server } = app({
      contacts: { findByPhone: async () => CONTACT_MCP, analysesEtResumes: async () => { throw new Error('connexion perdue'); } },
    });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('get_contact', { phone: '33612345678' }) });
    expect(contenu(res).isError).toBe(false);
    const fiche = JSON.parse(contenu(res).texte) as Record<string, unknown>;
    expect(fiche.id).toBe(CONTACT_MCP.id);
    expect(fiche).not.toHaveProperty('last_analysis');
  });

  it('un numéro illisible est refusé avec la forme attendue, sans rien chercher', async () => {
    const cherches: string[] = [];
    const { server } = app({ contacts: { findByPhone: async (_t: string, p: string) => { cherches.push(p); return null; } } });
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('get_contact', { phone: 'n importe quoi' }) });
    expect(contenu(res).isError).toBe(true);
    expect(contenu(res).texte).toContain('+33612345678');
    expect(cherches).toEqual([]);
  });
});

/**
 * 🔴 LES OUTILS ET L'OFFRE (lot 6, livraison B2a, spec § 4 et § 8) : chaque outil déclare la fonction qu'il exige. Hors
 * offre, il RESTE listé (à la différence des droits d'une clé) et refuse avec la phrase et le lien de l'offre : l'assistant
 * peut alors l'expliquer. Écrit ici, pas dérivé du catalogue : le comparer à lui-même ne prouverait rien.
 */
// Lire les fils (lot 13) et y répondre dans la fenêtre de 24 h sont ouverts dans toutes les offres (décisions de Julien
// du 2026-10-08) : seuls étiqueter et affecter, gestes d'équipe, restent dans l'offre de l'Inbox.
const FONCTION_DES_OUTILS: Readonly<Record<string, string>> = {
  tag_conversation: 'inbox', assign_conversation: 'inbox',
  // Les chiffres du Pro (2026-10-13) : la fonction statistiques ; get_message_stats reste ouvert (l'essentiel en Free).
  // Ce que l'analyse a compris suit la fonction analyse (spec offres v2).
  get_campaign_stats: 'statistiques', get_conversation_insights: 'analyse', get_ai_stats: 'statistiques',
  // Les campagnes depuis l'assistant (2026-10-20) : la fonction qui garde les campagnes de la console.
  find_contacts: 'console', tag_contacts: 'console', prepare_campaign: 'console', launch_campaign: 'console',
  // Les freins et la reprise (2026-10-22) : la même offre que le lancement, comme dans la console.
  control_campaign: 'console',
  // Les champs (2026-10-20) : remplir un champ en masse est une action de la console ; lister et créer suivent l'API.
  set_contact_field: 'console',
};

describe('serveur MCP : les outils et l’offre (lot 6, B2a)', () => {
  const base = { offreDe: async () => ({ offre: 'base' as const, droits: DROITS.base, retourEnBaseLe: null }) };

  it('🔴 chaque outil déclare sa fonction : étiqueter, affecter, les chiffres et les campagnes du Pro, aucune pour les autres', () => {
    for (const o of OUTILS) expect([o.nom, o.fonction]).toEqual([o.nom, FONCTION_DES_OUTILS[o.nom] ?? null]);
  });

  it('🔴 en Free, un outil qui écrit dans un fil RESTE listé et refuse avec le lien de l’offre ; rien n’est posé', async () => {
    const { server, traces } = app({ offres: base });
    const liste = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: rpc('tools/list') });
    expect(liste.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((t) => t.name)).toContain('tag_conversation');
    const c = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('tag_conversation', { conversation_id: 'cv1', tags: ['chaud'] }) }));
    expect(c.isError).toBe(true);
    expect(c.texte).toMatch(/Inbox/);
    expect(c.texte).toMatch(/\/offre/);
    expect(traces.poses).toEqual([]);
    await server.close();
  });

  it('🔴 en Free, Claude LIT les fils (lot 13) : list_conversations répond', async () => {
    const { server, traces } = app({ offres: base });
    expect(contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_conversations') })).isError).toBe(false);
    expect(traces.listes).toHaveLength(1);
    await server.close();
  });

  it('🔴 get_message_status lit le message dans l’espace de la CLÉ, rend son statut, et refuse un message inconnu', async () => {
    const lus: Array<{ tenant: string; id: string }> = [];
    const { server } = app({
      messagesApi: {
        message: async (tenant, id) => {
          lus.push({ tenant, id });
          return id !== 'wamid.envoye' ? null : {
            id: 'wamid.envoye', idInterne: 'a1a1a1a1-0000-4000-8000-000000000001', conversationId: 'cv1', direction: 'out', channel: 'whatsapp',
            type: 'text', text: 'Bonjour', buttonPayload: null, transcription: null, media: null,
            status: 'failed', statusAt: '2026-10-08T10:00:00.000Z', error: { code: 131049, reason: 'bloqué par Meta' }, createdAt: '2026-10-08T09:59:00.000Z',
          };
        },
      },
    });
    const ok = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_message_status', { message_id: 'wamid.envoye' }) }));
    expect(JSON.parse(ok.texte)).toEqual({
      message_id: 'wamid.envoye', conversation_id: 'cv1', direction: 'out', status: 'failed', status_at: '2026-10-08T10:00:00.000Z',
      error: { code: 131049, reason: 'bloqué par Meta' },
    });
    const inconnu = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('get_message_status', { message_id: 'wamid.ailleurs' }) }));
    expect([inconnu.isError, inconnu.texte]).toEqual([true, 'message inconnu de cet espace']);
    expect(lus.map((l) => l.tenant)).toEqual(['t1', 't1']);
    await server.close();
  });

  it('🔴 send_message envoie le contenu de Meta TEL QUEL (lot 13, domaine 2), ouvert en Free ; un contenu invalide est refusé sans rien envoyer', async () => {
    const partis: Array<{ tenant: string; to: string; corps: Record<string, unknown> }> = [];
    const { server, traces } = app({ offres: base, envoyerMessage: async (tenant, _pn, to, corps) => { partis.push({ tenant, to, corps }); return 'wamid.meta'; } });
    const image = { type: 'image', image: { link: 'https://exemple.fr/colis.jpg', caption: 'Votre colis' } };
    const ok = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('send_message', { conversation_id: 'cv1', message: image }) }));
    expect(ok.isError, ok.texte).toBe(false);
    expect(JSON.parse(ok.texte)).toEqual({ message_id: 'wamid.meta', conversation_id: 'cv1', journal: 'recorded' });
    expect(partis).toEqual([{ tenant: 't1', to: expect.any(String), corps: image }]);
    expect(traces.journal).toEqual([{ origine: 'mcp', auteur: null }]);
    const mauvais = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('send_message', { conversation_id: 'cv1', message: { type: 'image', image: { id: '123' } } }) }));
    expect(mauvais.isError).toBe(true);
    expect(mauvais.texte).toMatch(/^message invalide/);
    expect(partis).toHaveLength(1);
    await server.close();
  });

  it('🔴 en Free, Claude RÉPOND dans la fenêtre de 24 h, comme l’API (décision du 2026-10-08)', async () => {
    const { server, traces } = app({ offres: base });
    const c = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'Bonjour, c’est noté.' }) }));
    expect(c.isError, c.texte).toBe(false);
    expect(traces.envois).toHaveLength(1);
    await server.close();
  });

  it('en Base, un outil ouvert à toutes les offres répond comme avant', async () => {
    const { server } = app({ offres: base });
    expect(contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('list_members') })).isError).toBe(false);
    await server.close();
  });
});

describe('serveur MCP : les modèles (lot 13, domaine 3)', () => {
  const base = { offreDe: async () => ({ offre: 'base' as const, droits: DROITS.base, retourEnBaseLe: null }) };

  /** Meta est un faux `fetch` qui garde le corps de chaque appel ; la création de l'écran Modèles est la vraie. */
  function modeles(reponse: unknown, liste: TemplateSummary[] = []) {
    const corps: Array<Record<string, unknown> | null> = [];
    const oublis: string[] = [];
    const fetchMeta: FetchLike = async (_url, init) => {
      corps.push(typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null);
      return { ok: true, status: 200, json: async () => reponse } as Response;
    };
    return {
      corps,
      oublis,
      modeles: {
        lister: async () => liste,
        oublier: async (tenant: string) => { oublis.push(tenant); },
        modeles: {
          ...modelesInertes,
          meta: { templateClientForTenant: async () => new MetaTemplateClient('tok', 'v23.0', fetchMeta) },
          repo: { getTenantWabaId: async () => 'waba1', listActiveCampaignsForTemplate: aucuneCampagneActive },
        },
        telechargerEntete: async () => ({ refus: 'jamais appelé ici' }),
        deposerEntete: async () => '4::h',
        placesEntete: { prendre: () => () => {} },
      },
    };
  }
  const MODELE = { name: 'commande_prete', language: 'fr', category: 'UTILITY', components: [{ type: 'BODY', text: 'Votre commande est prête.' }] };

  it('🔴 create_template est réservé à une PERSONNE : une clé d’API, même mcp:write, ne le voit pas et ne crée rien', async () => {
    expect(OUTILS.find((o) => o.nom === 'create_template')?.exigePersonne).toBe(true);
    expect(outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null }).map((o) => o.nom)).not.toContain('create_template');
    const m = modeles({ id: 'tid', status: 'PENDING', category: 'UTILITY' });
    const { server } = app({ offres: base, modeles: m.modeles });
    const parCle = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('create_template', { template: MODELE }) });
    expect(parCle.json<{ error?: unknown }>().error).toBeDefined();
    expect(m.corps).toHaveLength(0);
    await server.close();
  });

  it('🔴 pour une personne, create_template crée par la création de l’écran Modèles ; un corps invalide ne part pas chez Meta', async () => {
    const m = modeles({ id: 'tid', status: 'PENDING', category: 'UTILITY' });
    const outil = OUTILS.find((o) => o.nom === 'create_template')!;
    const deps = { modeles: m.modeles, couteux: { consommer: async () => ({ accepte: true, attenteMs: 0 }) } } as unknown as DepsMcp;
    expect(await outil.executer(deps, 't1', { template: MODELE }, { userId: 'u1' }))
      .toEqual({ id: 'tid', name: 'commande_prete', language: 'fr', category: 'utility', status: 'pending' });
    expect(m.corps).toHaveLength(1);
    // La liste en cache s'oublie : list_templates montre le modèle créé tout de suite.
    expect(m.oublis).toEqual(['t1']);
    await expect(outil.executer(deps, 't1', { template: { ...MODELE, category: 'AUTHENTICATION' } }, { userId: 'u1' })).rejects.toThrow(/category/);
    expect(m.corps).toHaveLength(1);
    expect(m.oublis).toEqual(['t1']);
  });

  it('get_template_status rend chaque langue et le motif d’un refus ; list_templates la liste en minuscules', async () => {
    const m = modeles(
      { data: [{ name: 'commande_prete', language: 'fr', status: 'REJECTED', category: 'UTILITY', rejected_reason: 'INVALID_FORMAT' }] },
      [{ id: '1', name: 'commande_prete', language: 'fr', status: 'APPROVED', category: 'UTILITY', body: 'x', headerFormat: null, isCarousel: false, editable: true }],
    );
    const { server } = app({ offres: base, modeles: m.modeles });
    const statut = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('get_template_status', { name: 'commande_prete' }) }));
    expect(JSON.parse(statut.texte)).toEqual({
      name: 'commande_prete', languages: [{ language: 'fr', status: 'rejected', category: 'utility', rejectedReason: 'INVALID_FORMAT' }],
    });
    const liste = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: appeler('list_templates') }));
    expect(JSON.parse(liste.texte)).toEqual({ templates: [{ name: 'commande_prete', language: 'fr', category: 'utility', status: 'approved' }], tronque: false });
    await server.close();
  });
});

describe('serveur MCP : envoyer un modèle à un contact (lot 13, domaine 3, livraison B)', () => {
  const outil = OUTILS.find((o) => o.nom === 'send_template_to_contact')!;
  const RAPPORT = { sendId: 'send-1', opening: 'whatsapp_template', recipientCount: 1, created: 0, matched: 1, skipped: [], skippedTotal: 0 };

  function monterEnvoi(reponse: ResultatEnvoiPublic, couteuxAccepte = true, quotaAccepte = true) {
    const corps: unknown[] = [];
    const comptes: number[] = [];
    const deps = {
      couteux: { consommer: async () => ({ accepte: couteuxAccepte, attenteMs: 4000 }) },
      quotaEnvois: async () => (quotaAccepte ? { accepte: true } : { accepte: false, raison: '2000 envois par jour, remise à zéro à minuit' }),
      envoyerModele: async (_t: string, c: unknown, compter: (n: number) => Promise<boolean>) => {
        corps.push(c);
        comptes.push(Number(await compter(1)));
        return reponse;
      },
    } as unknown as DepsMcp;
    return { deps, corps, comptes };
  }
  const ARGS = { name: 'commande_prete', language: 'fr', phone: '+33612345678', values: ['Claire', '8412'], idempotency_key: 'claude-8412' };

  it('🔴 réservé à une PERSONNE : une clé d’API, même mcp:write, ne le voit pas', () => {
    expect(outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null }).map((o) => o.nom)).not.toContain('send_template_to_contact');
  });

  it('🔴 le corps construit est un corps de POST /v1/sends que ses propres règles acceptent, pour UNE personne', async () => {
    const { deps, corps, comptes } = monterEnvoi({ statut: 201, corps: RAPPORT });
    expect(await outil.executer(deps, 't1', ARGS, { userId: 'u1' })).toEqual({ send_id: 'send-1', contact_created: false });
    expect(comptes).toEqual([1]);
    const lu = schemaCorps.safeParse(corps[0]);
    expect(lu.success).toBe(true);
    if (!lu.success) return;
    expect(cleIdempotence(undefined, lu.data)).toEqual({ ok: true, cle: 'claude-8412' });
    const params = validateParamMapping(lu.data.params ?? [], { accepterVariables: true });
    expect(params).toEqual([{ position: 1, source: { type: 'literal', value: 'Claire' } }, { position: 2, source: { type: 'literal', value: '8412' } }]);
    expect(lireCible(lu.data, params!)).toEqual({ kind: 'template', name: 'commande_prete', language: 'fr' });
    // L'accord de la personne, déclaré par le client et signé de la personne connectée (test suivant).
    expect(lu.data.recipients).toEqual([{ phone: '+33612345678', consent: 'opted_in', consentSource: 'déclaré dans Claude par u1' }]);
    expect(schemaDestinataire.safeParse(lu.data.recipients[0]).success).toBe(true);
  });

  it('🔴 envoyer par Claude, c’est le client qui déclare l’accord de la personne : opted_in, signé, par numéro comme par fiche', async () => {
    // Décision de Julien du 2026-10-25 : « si je demande d'envoyer à tel numéro, c'est le choix du client », sa
    // responsabilité. Le chemin partagé de `POST /v1/sends` l'écrit sur la fiche, refuse d'y lever un STOP
    // (`appliquerConsentement`) et écarte la personne désabonnée. Aucun paramètre : Claude ne pose jamais la question.
    expect(outil.description).toMatch(/consent is not a parameter, the send records it on the user's behalf/);
    const parFiche = monterEnvoi({ statut: 201, corps: RAPPORT });
    const { phone: _p, ...sansNumero } = ARGS;
    await outil.executer(parFiche.deps, 't1', { ...sansNumero, contact_id: '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01' }, { userId: 'u2' });
    expect((parFiche.corps[0] as { recipients: unknown[] }).recipients)
      .toEqual([{ contactId: '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01', consent: 'opted_in', consentSource: 'déclaré dans Claude par u2' }]);
    // Une personne désabonnée : écartée par le chemin partagé, et Claude le dit.
    const stop = monterEnvoi({ statut: 201, corps: { ...RAPPORT, recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }], skippedTotal: 1 } });
    await expect(outil.executer(stop.deps, 't1', ARGS, { userId: 'u1' })).rejects.toThrow(/rien n’est parti.*opted_out/);
  });

  it('🔴 un refus de l’envoi revient à Claude avec sa phrase et son code ; une personne écartée aussi', async () => {
    const refus = monterEnvoi({ statut: 402, corps: { error: 'limite de 1000 envois de modèles par mois atteinte', code: 'plan_limit_reached' } });
    await expect(outil.executer(refus.deps, 't1', ARGS, { userId: 'u1' })).rejects.toThrow(/1000 envois de modèles.*plan_limit_reached/);
    const ecarte = monterEnvoi({ statut: 201, corps: { ...RAPPORT, recipientCount: 0, created: 1, skipped: [{ index: 0, reason: 'no_consent' }], skippedTotal: 1 } });
    await expect(outil.executer(ecarte.deps, 't1', ARGS, { userId: 'u1' }))
      .rejects.toThrow(/rien n’est parti.*no_consent.*fiche a été créée.*NOUVELLE idempotency_key/);
  });

  it('phone OU contact_id, une valeur non vide par variable : sinon rien n’est appelé ; le plafond coûteux refuse aussi', async () => {
    const { deps, corps } = monterEnvoi({ statut: 201, corps: RAPPORT });
    await expect(outil.executer(deps, 't1', { ...ARGS, contact_id: '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01' }, { userId: 'u1' })).rejects.toThrow(/phone OU par contact_id/);
    const { phone: _p, ...sansPersonne } = ARGS;
    await expect(outil.executer(deps, 't1', sansPersonne, { userId: 'u1' })).rejects.toThrow(/phone OU par contact_id/);
    await expect(outil.executer(deps, 't1', { ...ARGS, values: ['Claire', ''] }, { userId: 'u1' })).rejects.toThrow(/values/);
    expect(corps).toHaveLength(0);
    const plein = monterEnvoi({ statut: 201, corps: RAPPORT }, false);
    await expect(outil.executer(plein.deps, 't1', ARGS, { userId: 'u1' })).rejects.toThrow(/réessayer dans 4 s/);
  });

  it('🔴 le quota d’envois du jour refuse aussi, avec sa phrase', async () => {
    const quota = monterEnvoi({ statut: 201, corps: RAPPORT }, true, false);
    await expect(outil.executer(quota.deps, 't1', ARGS, { userId: 'u1' })).rejects.toThrow(/2000 envois par jour/);
  });

  it('🔴 une valeur que Meta refuserait à l’envoi (retour à la ligne, tabulation, cinq espaces) est refusée avant', async () => {
    const { deps, corps } = monterEnvoi({ statut: 201, corps: RAPPORT });
    for (const v of ['Claire\nDupont', 'Claire\tDupont', 'Claire     Dupont']) {
      await expect(outil.executer(deps, 't1', { ...ARGS, values: [v] }, { userId: 'u1' }), v).rejects.toThrow(/retour à la ligne/);
    }
    expect(corps).toHaveLength(0);
    // Quatre espaces passent ; le schéma annoncé dit la même règle.
    expect(await outil.executer(deps, 't1', { ...ARGS, values: ['Claire    Dupont'] }, { userId: 'u1' })).toMatchObject({ send_id: 'send-1' });
    const motif = new RegExp((outil.entree.properties.values as { items: { pattern: string } }).items.pattern);
    expect(['Claire\nDupont', 'Claire     Dupont'].map((v) => motif.test(v))).toEqual([false, false]);
    expect(motif.test('Claire    Dupont')).toBe(true);
  });
});

/**
 * 🔴 `write_first_message` EST RETIRÉ (décision de Julien du 2026-10-24) : un numéro relié par QR code n'écrit plus en
 * premier, l'outil ne pouvait plus jamais réussir. Ni au catalogue, ni dans la liste d'une personne connectée.
 */
describe('serveur MCP : plus d’outil pour écrire en premier', () => {
  it('🔴 write_first_message n’est plus listé, ni pour une clé, ni pour une personne', () => {
    expect(OUTILS.map((o) => o.nom)).not.toContain('write_first_message');
    expect(Object.keys(CATALOGUE_MCP)).not.toContain('write_first_message');
    for (const personne of [null, { userId: 'u1' }]) {
      expect(outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne }).map((o) => o.nom)).not.toContain('write_first_message');
    }
  });
});

/** Hors des 24 heures sur un numéro relié par QR code, `reply_in_open_window` passe par la porte (plan 2026-10-23, tâche 3). */
describe('serveur MCP : reply_in_open_window hors des 24 heures sur un numéro relié par QR code', () => {
  const surApplication = (porte: ReturnType<typeof porteEnMemoire>, lastInboundAt: string | null = '2026-09-01T09:00:00.000Z') => app({
    application: { filiere: async () => 'application', envoyer: async () => { throw new Error('aucun envoi direct attendu'); } },
    ecrirePremier: porte.ecrirePremier,
    inbox: { getConversationContext: async (id, tenant) => (tenant === 't1' && id === 'cv1' ? { waId: '33600000001', lastInboundAt, windowOpen: false } : null) },
  });

  it('🔴 le message est mis en file par la porte et le dit, sans rien envoyer ni tracer tout de suite', async () => {
    const porte = porteEnMemoire({ optIn: 'opted_in' });
    const { server, traces } = surApplication(porte);
    const c = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'Bonjour' }) }));
    expect(c.isError).toBe(false);
    const ligne = porte.lignes[0]!;
    expect(JSON.parse(c.texte)).toEqual({
      conversation_id: 'cv1', queued_id: ligne.id, scheduled_at: ligne.prevuLe.toISOString(),
      message: expect.stringMatching(/^message en file : il part vers 12:00 \(heure de Paris\)/),
    });
    // Le contact nous a écrit : la réponse différée part sans accord coché (décision de Julien, 2026-10-24).
    expect(porte.demandes[0]).toMatchObject({ origine: 'reponse', telephone: '33600000001', consentement: { mode: 'conversation' } });
    expect([traces.envois, traces.journal]).toEqual([[], []]);
    await server.close();
  });

  it('🔴 un contact qui ne nous a jamais écrit, même consentant : refusé avec la phrase du QR code, rien en file (2026-10-24)', async () => {
    const porte = porteEnMemoire({ optIn: 'opted_in' });
    const { server } = surApplication(porte, null);
    const c = contenu(await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_TOUT), payload: appeler('reply_in_open_window', { conversation_id: 'cv1', text: 'Bonjour' }) }));
    expect(c.isError).toBe(true);
    expect(c.texte).toContain(PHRASE_PREMIER_CONTACT);
    expect([porte.lignes, porte.gestes]).toEqual([[], []]);
    await server.close();
  });
});
