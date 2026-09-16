import { describe, it, expect } from 'vitest';
import { ouvrirSessionMcp, type OutilAnnonce, type SessionMcp } from '../src/mcp/client';

/**
 * Le CLIENT MCP : Engage Me va chercher des outils chez un tiers.
 *
 * 🔴 CES TESTS SONT ADOSSÉS AU TEXTE DE LA SPEC 2025-06-18, pas à ce qu'on suppose d'un serveur. Trois de
 * ses exigences décident de la moitié de ce module, et chacune a son cas ici : l'en-tête `Accept` qui doit
 * annoncer les DEUX types (sinon on ne sait pas lire une réponse en flux, que le serveur a le droit de
 * rendre), le `Mcp-Session-Id` qu'il faut porter sur tout ce qui suit l'initialisation, et la PAGINATION de
 * `tools/list`, qu'on ne suivrait pas sans le savoir.
 */

const CIBLE = { url: 'https://exemple.test/mcp', enTetes: {}, timeoutMs: 5000, maxOctets: 65536 };

type Reponse =
  | { result: unknown; sse?: boolean; enTetes?: Record<string, string> }
  | { erreur: { code: number; message: string } }
  | { statut: number; corps?: string; type?: string };

interface Vue { corps: Record<string, unknown> | null; enTetes: Record<string, string>; methode: string }

/**
 * Un faux serveur MCP. Il ÉCHO l'identifiant reçu au lieu d'en inventer un : le client choisit ses
 * identifiants, et un faux qui en fixerait un en dur testerait le faux, pas l'appariement.
 */
function faussaire(scenario: Reponse[]): { impl: typeof fetch; vues: Vue[] } {
  const vues: Vue[] = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit = {}) => {
    const enTetes = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const corps = init.body === undefined || init.body === null
      ? null
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    vues.push({ corps, enTetes, methode: init.method ?? 'GET' });

    const r = scenario[i++] ?? scenario[scenario.length - 1]!;
    if ('statut' in r) {
      return new Response(r.corps ?? '', { status: r.statut, headers: { 'content-type': r.type ?? 'text/plain' } });
    }
    const id = corps?.id;
    const enveloppe = JSON.stringify(
      'erreur' in r ? { jsonrpc: '2.0', id, error: r.erreur } : { jsonrpc: '2.0', id, result: r.result },
    );
    const sse = 'sse' in r && r.sse === true;
    return new Response(sse ? `event: message\ndata: ${enveloppe}\n\n` : enveloppe, {
      status: 200,
      headers: {
        'content-type': sse ? 'text/event-stream' : 'application/json',
        ...('enTetes' in r ? r.enTetes ?? {} : {}),
      },
    });
  }) as unknown as typeof fetch;
  return { impl, vues };
}

const INIT = { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } };
const ACCUSE = { statut: 202 };
const outil = (name: string) => ({ name, inputSchema: { type: 'object', properties: {} } });

async function doitOuvrir(scenario: Reponse[]): Promise<{ session: SessionMcp; vues: Vue[] }> {
  const f = faussaire(scenario);
  const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
  if ('echec' in s) throw new Error(`ouverture refusée : ${JSON.stringify(s.echec)}`);
  return { session: s, vues: f.vues };
}

/** `lister()` peut rendre un échec : les cas qui attendent une liste le disent ici, une fois. */
async function doitLister(session: SessionMcp): Promise<{ outils: OutilAnnonce[]; tronque: boolean }> {
  const r = await session.lister();
  if ('echec' in r) throw new Error(`liste refusée : ${JSON.stringify(r.echec)}`);
  return r;
}

describe('le client MCP : le cycle de vie', () => {
  it('annonce Accept avec les DEUX types, sinon on ne sait pas lire une reponse en flux', async () => {
    const { vues } = await doitOuvrir([INIT, ACCUSE]);
    expect(vues[0]!.enTetes.accept).toContain('application/json');
    expect(vues[0]!.enTetes.accept).toContain('text/event-stream');
  });

  it('envoie initialize PUIS la notification, et la notification n a pas d identifiant', async () => {
    const { vues } = await doitOuvrir([INIT, ACCUSE]);
    expect(vues[0]!.corps!.method).toBe('initialize');
    expect(vues[1]!.corps!.method).toBe('notifications/initialized');
    // Une notification porte un identifiant chez un client naif, et le serveur lui repond alors une
    // reponse que personne n attend. La spec veut un 202 sans corps : donc aucun `id`.
    expect(vues[1]!.corps!.id).toBeUndefined();
  });

  it('porte Mcp-Session-Id sur tout ce qui SUIT l initialisation, plus la version du protocole', async () => {
    const { session, vues } = await doitOuvrir([
      { ...INIT, enTetes: { 'mcp-session-id': 'abc123' } },
      ACCUSE,
      { result: { tools: [] } },
    ]);
    await session.lister();
    expect(vues[0]!.enTetes['mcp-session-id']).toBeUndefined();
    expect(vues[1]!.enTetes['mcp-session-id']).toBe('abc123');
    expect(vues[2]!.enTetes['mcp-session-id']).toBe('abc123');
    expect(vues[2]!.enTetes['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('n invente PAS de session quand le serveur n en assigne aucun', async () => {
    // Notre propre serveur est sans etat : il ne rend aucun `Mcp-Session-Id`. Envoyer un en-tete vide
    // ferait repondre 400 a un serveur qui en exige un vrai.
    const { session, vues } = await doitOuvrir([INIT, ACCUSE, { result: { tools: [] } }]);
    await session.lister();
    expect(vues[2]!.enTetes['mcp-session-id']).toBeUndefined();
  });

  it('NOMME l ancien transport au lieu d echouer en silence', async () => {
    // La signature exacte d un serveur reste en 2024-11-05 : il refuse le POST sur l endpoint MCP.
    const f = faussaire([{ statut: 405, corps: 'Method Not Allowed' }]);
    const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    expect(s).toEqual({ echec: { genre: 'transport_ancien' } });
  });

  it('un 401 n est PAS l ancien transport : c est un refus, et le client doit pouvoir le dire', async () => {
    // 🔴 Ranger toute erreur 4xx dans « ancien transport » enverrait un client corriger son URL alors que
    // c est son jeton qui est mauvais. La distinction se lit sur le code.
    const f = faussaire([{ statut: 401, corps: 'Unauthorized' }]);
    const s = await ouvrirSessionMcp(CIBLE, { fetchImpl: f.impl });
    expect(s).toEqual({ echec: { genre: 'refus', code: 401, message: expect.any(String) } });
  });
});

describe('le client MCP : lister les outils', () => {
  it('lit une reponse rendue en FLUX d evenements, pas seulement en JSON', async () => {
    const { session } = await doitOuvrir([INIT, ACCUSE, { result: { tools: [outil('a')] }, sse: true }]);
    const r = await doitLister(session);
    expect(r.outils.map((o) => o.name)).toEqual(['a']);
  });

  it('SUIT LA PAGINATION : un catalogue sur deux pages rend deux outils, pas un', async () => {
    const { session, vues } = await doitOuvrir([
      INIT, ACCUSE,
      { result: { tools: [outil('a')], nextCursor: 'c2' } },
      { result: { tools: [outil('b')] } },
    ]);
    const r = await doitLister(session);
    expect(r.outils.map((o) => o.name)).toEqual(['a', 'b']);
    expect(r.tronque).toBe(false);
    expect((vues[3]!.corps!.params as { cursor?: string }).cursor).toBe('c2');
  });

  it('un catalogue sans fin s arrete a la borne et le DIT : un plafond muet se lit comme une couverture complete', async () => {
    // Le faussaire rejoue sa derniere reponse indefiniment : une page qui renvoie toujours un curseur.
    const { session } = await doitOuvrir([INIT, ACCUSE, { result: { tools: [outil('a')], nextCursor: 'encore' } }]);
    const r = await doitLister(session);
    expect(r.tronque).toBe(true);
    expect(r.outils.length).toBeGreaterThan(0);
  });

  it('🔴 une page qui ECHOUE rend un echec, JAMAIS la liste partielle', async () => {
    // 🔴 LE DEFAUT QUE CE CAS FERME, ET IL EST DESTRUCTEUR. Si `lister()` rendait les outils de la page 1
    // apres un echec en page 2, l import prendrait cette moitie pour le catalogue ENTIER : le
    // rafraichissement marquerait « disparus » tous les outils de la page 2 et ferait tomber leur
    // consentement. Une panne reseau d une seconde debrancherait la moitie des outils d un client.
    const { session } = await doitOuvrir([
      INIT, ACCUSE,
      { result: { tools: [outil('a')], nextCursor: 'c2' } },
      { statut: 502, corps: 'Bad Gateway' },
    ]);
    const r = await session.lister();
    expect(r).toEqual({ echec: { genre: 'refus', code: 502, message: expect.any(String) } });
  });

  it('une erreur JSON-RPC sur tools/list est un echec, pas un catalogue vide', async () => {
    // Un catalogue vide ferait disparaitre TOUS les outils du serveur au rafraichissement suivant.
    const { session } = await doitOuvrir([INIT, ACCUSE, { erreur: { code: -32603, message: 'boom' } }]);
    expect(await session.lister()).toEqual({ echec: { genre: 'refus', code: -32603, message: 'boom' } });
  });

  it('ecarte une entree illisible sans perdre les autres : le catalogue vient d un TIERS', async () => {
    const { session } = await doitOuvrir([
      INIT, ACCUSE,
      { result: { tools: [{ name: 42 }, outil('bon'), { pas: 'un outil' }] } },
    ]);
    const r = await doitLister(session);
    expect(r.outils.map((o) => o.name)).toEqual(['bon']);
  });
});

describe('le client MCP : appeler un outil', () => {
  it('rend le texte des blocs de contenu', async () => {
    const { session } = await doitOuvrir([
      INIT, ACCUSE,
      { result: { content: [{ type: 'text', text: 'il fait 22 degres' }], isError: false } },
    ]);
    expect(await session.appeler('meteo', { ville: 'Lyon' })).toEqual({ texte: 'il fait 22 degres', estErreur: false });
  });

  it('envoie le nom et les arguments tels quels', async () => {
    const { session, vues } = await doitOuvrir([INIT, ACCUSE, { result: { content: [] } }]);
    await session.appeler('meteo', { filtres: { ville: 'Lyon' } });
    expect(vues[2]!.corps!.method).toBe('tools/call');
    expect(vues[2]!.corps!.params).toEqual({ name: 'meteo', arguments: { filtres: { ville: 'Lyon' } } });
  });

  it('isError:true est un echec METIER : il rend un texte, pas une panne', async () => {
    // 🔴 La spec distingue deux mecanismes, et la distinction compte : `isError` veut dire « ta demande
    // n etait pas recevable », une erreur JSON-RPC veut dire « l appel n a pas pu se faire ». Le premier
    // est quelque chose que l agent peut dire au contact.
    const { session } = await doitOuvrir([
      INIT, ACCUSE,
      { result: { content: [{ type: 'text', text: 'quota depasse' }], isError: true } },
    ]);
    expect(await session.appeler('meteo', {})).toEqual({ texte: 'quota depasse', estErreur: true });
  });

  it('une erreur JSON-RPC rend un echec NOMME, et ne leve pas', async () => {
    const { session } = await doitOuvrir([INIT, ACCUSE, { erreur: { code: -32602, message: 'Unknown tool' } }]);
    expect(await session.appeler('inconnu', {})).toEqual({
      echec: { genre: 'refus', code: -32602, message: 'Unknown tool' },
    });
  });

  it('remplace un bloc non textuel par une mention, plutot que de le perdre en silence', async () => {
    const { session } = await doitOuvrir([
      INIT, ACCUSE,
      { result: { content: [{ type: 'text', text: 'voici' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } },
    ]);
    const r = await session.appeler('capture', {});
    expect(r).toEqual({ texte: expect.stringContaining('voici'), estErreur: false });
    expect((r as { texte: string }).texte).toContain('[image]');
  });

  it('un corps qui depasse le plafond est un echec, jamais un texte tronque', async () => {
    const gros = 'x'.repeat(5000);
    const f = faussaire([INIT, ACCUSE, { result: { content: [{ type: 'text', text: gros }] } }]);
    const s = await ouvrirSessionMcp({ ...CIBLE, maxOctets: 200 }, { fetchImpl: f.impl });
    if ('echec' in s) throw new Error('ouverture refusée');
    const r = await s.appeler('gros', {});
    expect(r).toEqual({ echec: { genre: 'protocole', message: expect.stringContaining('trop') } });
  });
});
