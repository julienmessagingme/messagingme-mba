import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { FakeQueue } from './fake-queue';
import type { MbaOutilsDeps } from '../src/http/mba-outils';
import { NomOutilDejaPris, OutilNonActivable, type OutilBibliotheque, type OutilComplet } from '../src/agent/catalog';
import { risqueSelonMethode } from '../src/agent/http-cible';

/**
 * L'onglet « Outils » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 9).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : que la CIBLE et le RISQUE viennent du serveur et du catalogue, jamais du
 * navigateur ; que le numéro vienne du serveur ; que retirer DÉTACHE un connecteur partagé au lieu de le détruire.
 *
 * ⚠️ Plusieurs cas sont PORTÉS de `tests/http-agent-catalogue.test.ts`, dont les routes MBA sont parties avec
 * l'ancien écran (plan, écart 2). Leur titre le dit.
 */
const TENANT = 't1';
const SECRET = 'test-secret';
const PN = '1234840649713976';
const REQ = '33333333-3333-4333-8333-333333333333';
const OUTIL = '22222222-2222-4222-8222-222222222222';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

let adminTok = '';
let lecteurTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET);
  lecteurTok = await signSession({ userId: 'u2', tenantId: TENANT, role: 'agent' }, SECRET);
});
/** Une FONCTION : un objet figé capturerait un jeton encore vide (il est signé dans `beforeAll`). */
const h = (tok = adminTok): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
});

const complet = (over: Partial<OutilComplet>): OutilComplet => ({
  id: OUTIL, tenantId: TENANT, origin: 'mba', name: 'marquer_vip', description: 'd', nePasUtiliser: 'p', gestes: [],
  params: [], binding: { handler: 'tag_fixe', tag: 'vip' }, sourceId: null, requestId: null, nature: 'integre',
  outputPaths: [], risk: 'write', timeoutMs: 5000, maxBytes: 16384, autonome: false, mcpAnnonce: null,
  mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null, title: 'Marquer VIP', actif: true, activeLe: null,
  autonomeLe: null, inappelable: null, ...over,
});

function monter(
  over: Partial<Omit<MbaOutilsDeps, 'outils'>> & { outils?: Partial<MbaOutilsDeps['outils']> } = {},
  numero: string | null = PN,
) {
  const { outils, ...reste } = over;
  const gestes: Array<{ geste: string; args: unknown[] }> = [];
  const deps: MbaOutilsDeps = {
    repo: {
      getTenantPhoneNumberId: async () => numero,
    },
    lister: async () => [complet({})],
    contexte: async () => ({
      requetes: new Map(), champs: new Set(['ville']), bibliotheque: new Map(), workflows: new Map(), serveurs: new Map(),
    }),
    requetes: {
      parId: async (_t, id) => (id === REQ ? {
        id: REQ, sourceId: 's1', methode: 'DELETE', variables: [
          { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
          { nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } },
        ],
      } : null),
    },
    champs: async () => ['ville'],
    outils: {
      ajouterMaisonPourMba: async (...args) => { gestes.push({ geste: 'creerMaison', args }); return { id: 'nouveau' }; },
      patchMaisonPourMba: async (...args) => { gestes.push({ geste: 'modifierMaison', args }); return { id: OUTIL }; },
      retirerDeMba: async (...args) => { gestes.push({ geste: 'retirer', args }); return 'supprime'; },
      ...outils,
    },
    creerConnecteur: async (...args) => { gestes.push({ geste: 'creerConnecteur', args }); return { id: 'nouveau' }; },
    modifierConnecteur: async (...args) => { gestes.push({ geste: 'modifierConnecteur', args }); return { id: OUTIL }; },
    reactiver: async (...args) => { gestes.push({ geste: 'reactiver', args }); return true; },
    workflow: async () => null,
    blocs: async () => [],
    bibliotheque: async () => [],
    offrables: async () => [],
    serveurs: async () => new Map(),
    proposerMcp: async (...args) => { gestes.push({ geste: 'proposerMcp', args }); return { ok: true }; },
    ...reste,
  };
  const app = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, mbaOutils: deps });
  return { app, gestes };
}

const TEXTES = {
  name: 'marquer_vip', title: 'Marquer VIP',
  description: 'Appelle cet outil dès que le client le demande.', nePasUtiliser: 'Jamais sans demande.',
};
const url = `/tenants/${TENANT}/mba-outils`;

describe('la liste de l’onglet', () => {
  it('rend une ligne par outil de l’agent de Meta, avec son type, sa cible et le numéro', async () => {
    const { app } = monter();
    const res = await app.inject({ method: 'GET', url, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      phoneNumberId: PN,
      outils: [expect.objectContaining({ id: OUTIL, type: 'tag', cible: { type: 'tag', tag: 'vip' }, actif: true })],
    });
  });

  it('sans numéro connecté : une liste vide, jamais une erreur', async () => {
    const { app } = monter({}, null);
    expect((await app.inject({ method: 'GET', url, ...h() })).json()).toEqual({ outils: [], phoneNumberId: null });
  });
});

describe('créer un outil de l’agent de Meta', () => {
  it('🔴 un tag devient un geste maison, au nom de l’utilisateur du JETON', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'nouveau' });
    expect(gestes).toEqual([{ geste: 'creerMaison', args: [TENANT, PN, { ...TEXTES, cible: { handler: 'tag_fixe', tag: 'vip' } }, 'u1'] }]);
  });

  it('une information : le champ fixé et ses valeurs permises', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'champ', champ: 'ville', valeurs: ['Paris'] } } });
    expect(res.statusCode).toBe(201);
    expect(gestes[0]!.args[2]).toMatchObject({ cible: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] } });
  });

  it('🔴 un champ absent du mini-CRM est refusé en le nommant, et rien n’est créé', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'champ', champ: 'code_postal', valeurs: [] } } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('code_postal');
    expect(gestes).toEqual([]);
  });

  it('🔴 (porté) crée un connecteur ET l’active pour l’agent de Meta, avec le risque DÉRIVÉ de la méthode', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'connecteur', requeteId: REQ } } });
    expect(res.statusCode).toBe(201);
    const [t, pn, outil, par] = gestes[0]!.args as [string, string, Record<string, unknown>, string];
    expect([gestes[0]!.geste, t, pn, par]).toEqual(['creerConnecteur', TENANT, PN, 'u1']);
    expect(outil).toMatchObject({ risk: risqueSelonMethode('DELETE'), requestId: REQ, sourceId: 's1' });
  });

  it('🔴 un connecteur dont la source n’est pas active est refusé en 409 lisible, pas en 500', async () => {
    // Le catalogue refuse AVANT de créer (`ajouterConnecteurPourMba`, Julien, 2026-10-02) : créer puis activer est un
    // seul geste pour l'agent de Meta, et une activation refusée après coup laisserait un outil créé à moitié.
    const { app } = monter({ creerConnecteur: async () => {
      throw new OutilNonActivable('le connecteur de cet outil n’est pas actif : activez-le dans Tools > Connecteurs API');
    } });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'connecteur', requeteId: REQ } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Connecteurs API');
  });

  it('🔴 (porté) le MODÈLE ne voit que les variables qu’il doit remplir', async () => {
    const { app, gestes } = monter();
    await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'connecteur', requeteId: REQ } } });
    const outil = gestes[0]!.args[2] as { params: Array<Record<string, unknown>> };
    // `ville` vient du mini-CRM : ce n'est pas un paramètre du modèle.
    expect(outil.params).toEqual([{ name: 'ref', type: 'string', source: 'modele', required: true }]);
  });

  it('🔴 (porté) le risque n’est jamais accepté du navigateur : une clé `risk` est refusée', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, risk: 'read', cible: { type: 'connecteur', requeteId: REQ } } });
    expect(res.statusCode).toBe(400);
    expect(gestes).toEqual([]);
  });

  it('🔴 (porté) sans numéro connecté : 409 avec la raison, et RIEN n’est créé', async () => {
    const { app, gestes } = monter({}, null);
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('numéro');
    expect(gestes).toEqual([]);
  });

  it('🔴 (porté) une requête d’un AUTRE espace rend 404, et rien n’est écrit', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({
      method: 'POST', url, ...h(),
      payload: { ...TEXTES, cible: { type: 'connecteur', requeteId: '99999999-9999-4999-8999-999999999999' } },
    });
    expect(res.statusCode).toBe(404);
    expect(gestes).toEqual([]);
  });

  it('⚠️ (porté) un nom technique mal formé est refusé : c’est ce que le modèle de Meta verra', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, name: 'Poser Étiquette', cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(400);
    expect(gestes).toEqual([]);
  });

  it('🔴 un nom déjà pris rend 409 avec un message lisible', async () => {
    const { app } = monter({ outils: { ajouterMaisonPourMba: async () => { throw new NomOutilDejaPris('espace'); } } });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('porte déjà ce nom');
  });

  it('🔴 un type inconnu ou une clé en trop dans la cible est refusé', async () => {
    const { app, gestes } = monter();
    expect((await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'mail', tag: 'x' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip', handler: 'poser_tag' } } })).statusCode).toBe(400);
    expect(gestes).toEqual([]);
  });

  it('🔴 un utilisateur qui n’est pas administrateur ne crée rien', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(lecteurTok), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(403);
    expect(gestes).toEqual([]);
  });
});

describe('modifier, retirer, réactiver', () => {
  it('un outil maison : les mots ET la cible', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'PATCH', url: `${url}/${OUTIL}`, ...h(), payload: { title: 'Client VIP', cible: { type: 'tag', tag: 'client_vip' } } });
    expect(res.statusCode).toBe(200);
    expect(gestes).toEqual([{ geste: 'modifierMaison', args: [TENANT, PN, OUTIL, { title: 'Client VIP', cible: { handler: 'tag_fixe', tag: 'client_vip' } }] }]);
  });

  it('🔴 l’appel d’un connecteur ne se change pas (plan, écart 1), ses mots si', async () => {
    const { app, gestes } = monter({ lister: async () => [complet({ origin: 'http', requestId: REQ, binding: {} })] });
    const refus = await app.inject({ method: 'PATCH', url: `${url}/${OUTIL}`, ...h(), payload: { cible: { type: 'connecteur', requeteId: REQ } } });
    expect(refus.statusCode).toBe(400);
    expect(refus.json().error).toContain('créez un autre outil');
    expect(gestes).toEqual([]);
    const ok = await app.inject({ method: 'PATCH', url: `${url}/${OUTIL}`, ...h(), payload: { title: 'Autre' } });
    expect(ok.statusCode).toBe(200);
    expect(gestes).toEqual([{ geste: 'modifierConnecteur', args: [TENANT, PN, OUTIL, { title: 'Autre' }] }]);
  });

  it('un outil qui n’est pas à l’agent de Meta rend 404', async () => {
    const { app, gestes } = monter({ lister: async () => [] });
    expect((await app.inject({ method: 'PATCH', url: `${url}/${OUTIL}`, ...h(), payload: { title: 'x' } })).statusCode).toBe(404);
    expect(gestes).toEqual([]);
  });

  it('🔴 (porté, et le sens change) retirer un connecteur partagé le DÉTACHE : 204, jamais un refus', async () => {
    // Avant, supprimer une définition encore rattachée rendait 409. Désormais l'onglet ne retire l'outil qu'à
    // l'agent de Meta : l'agent IA qui le partage le garde.
    const { app } = monter({ outils: { retirerDeMba: async () => 'detache' } });
    expect((await app.inject({ method: 'DELETE', url: `${url}/${OUTIL}`, ...h() })).statusCode).toBe(204);
    const { app: autre } = monter({ outils: { retirerDeMba: async () => 'introuvable' } });
    expect((await autre.inject({ method: 'DELETE', url: `${url}/${OUTIL}`, ...h() })).statusCode).toBe(404);
  });

  it('🔴 réactiver un outil éteint par le départ de son auteur, au nom de celui qui clique (plan, écart 4)', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'PUT', url: `${url}/${OUTIL}/actif`, ...h(), payload: { valeur: true } });
    expect(res.statusCode).toBe(200);
    expect(gestes).toEqual([{ geste: 'reactiver', args: [TENANT, PN, OUTIL, 'u1'] }]);
    expect((await app.inject({ method: 'PUT', url: `${url}/${OUTIL}/actif`, ...h(), payload: { valeur: false } })).statusCode).toBe(400);
  });

  it('🔴 (porté) réactiver un outil qui ne peut pas s’activer rend 409 avec sa raison, jamais 500', async () => {
    const { app } = monter({ reactiver: async () => { throw new OutilNonActivable('cet outil MCP n’est pas activable'); } });
    const res = await app.inject({ method: 'PUT', url: `${url}/${OUTIL}/actif`, ...h(), payload: { valeur: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'cet outil MCP n’est pas activable' });
  });

  it('🔴 (porté) un identifiant qui n’est pas un UUID rend 404, sans toucher au magasin', async () => {
    const { app, gestes } = monter();
    expect((await app.inject({ method: 'DELETE', url: `${url}/pas-un-uuid`, ...h() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `${url}/pas-un-uuid`, ...h(), payload: { title: 'x' } })).statusCode).toBe(404);
    expect(gestes).toEqual([]);
  });

  it('🔴 (porté) sans jeton, la route REFUSE : scopeTenant échoue fermé', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'DELETE', url: `${url}/${OUTIL}` });
    expect([401, 403]).toContain(res.statusCode);
    expect(gestes).toEqual([]);
  });

  it('🔴 (porté) le NUMÉRO vient du serveur, jamais du corps', async () => {
    const { app, gestes } = monter();
    await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    const avecNumero = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, phoneNumberId: '999', cible: { type: 'tag', tag: 'vip' } } });
    expect(avecNumero.statusCode).toBe(400);
    expect(gestes.map((g) => g.args[1])).toEqual([PN]);
  });
});

describe('un bloc et un scénario', () => {
  const WF = '11111111-1111-4111-8111-111111111111';
  const CODE = `nod_abc_${'A'.repeat(26)}`;
  const graphe = (quickReplies: string[]) => ({
    nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { code: CODE, body: 'x', quickReplies } }], edges: [],
  }) as never;

  it('🔴 un bloc envoyable devient `bloc_fixe`, le navigateur ne choisit rien d’autre', async () => {
    const { app, gestes } = monter({ workflow: async () => ({ name: 'Accueil', graph: graphe([]) }) });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'bloc', workflowId: WF, code: CODE } } });
    expect(res.statusCode).toBe(201);
    expect(gestes[0]!.args[2]).toMatchObject({ cible: { handler: 'bloc_fixe', workflowId: WF, code: CODE } });
  });

  it('🔴 un bloc qui attend une réponse est refusé avec la raison, et rien n’est créé', async () => {
    const { app, gestes } = monter({ workflow: async () => ({ name: 'Accueil', graph: graphe(['Oui']) }) });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'bloc', workflowId: WF, code: CODE } } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('Lancer un scénario');
    expect(gestes).toEqual([]);
  });

  it('un scénario publié devient `scenario_fixe` ; un inconnu ou un vide est refusé', async () => {
    const ok = monter({ workflow: async () => ({ name: 'Accueil', graph: graphe([]) }) });
    const res = await ok.app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'scenario', workflowId: WF } } });
    expect(res.statusCode).toBe(201);
    expect(ok.gestes[0]!.args[2]).toMatchObject({ cible: { handler: 'scenario_fixe', workflowId: WF } });
    const inconnu = monter({ workflow: async () => null });
    expect((await inconnu.app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'scenario', workflowId: WF } } })).statusCode).toBe(422);
    const vide = monter({ workflow: async () => ({ name: 'Vide', graph: { nodes: [], edges: [] } as never }) });
    const r = await vide.app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'scenario', workflowId: WF } } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('vide');
  });

  it('🔴 GET /blocs rend les blocs du SEUL scénario demandé, et refuse sans jeton', async () => {
    const bloc = { workflowId: WF, scenario: 'Accueil', code: CODE, nom: 'Brochure', type: 'quick_message', envoyable: true, raison: null };
    const demandes: Array<[string, string]> = [];
    const { app } = monter({ blocs: async (t, id) => { demandes.push([t, id]); return [bloc]; } });
    expect((await app.inject({ method: 'GET', url: `${url}/blocs?workflowId=${WF}`, ...h() })).json()).toEqual({ blocs: [bloc] });
    // Le scénario voyage jusqu'au magasin, avec l'espace de l'URL : c'est ce qui borne la liste à un scénario.
    expect(demandes).toEqual([[TENANT, WF]]);
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: `${url}/blocs?workflowId=${WF}` })).statusCode);
  });

  it('🔴 GET /blocs sans scénario (ou avec un identifiant qui n’en est pas un) rend 400, sans rien lire', async () => {
    let lus = 0;
    const { app } = monter({ blocs: async () => { lus += 1; return []; } });
    for (const q of ['', '?workflowId=', '?workflowId=pas-un-uuid']) {
      const r = await app.inject({ method: 'GET', url: `${url}/blocs${q}`, ...h() });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain('scénario');
    }
    expect(lus).toBe(0);
  });
});

describe('les outils MCP de la bibliothèque, proposés à l’agent de Meta (2026-10-02)', () => {
  const MCP = '44444444-4444-4444-8444-444444444444';
  const entree = (over: Partial<OutilBibliotheque> = {}): OutilBibliotheque => ({
    id: MCP, name: 'notion_search', title: 'Chercher', description: 'd', nePasUtiliser: 'p', origin: 'mcp', risk: 'read',
    sourceId: 's1', mcpNonActivable: null, mcpIndisponibleLe: null, mcpPropose: true, inappelable: null, consommateurs: [], ...over,
  });
  const avec = (e: OutilBibliotheque, over: Parameters<typeof monter>[0] = {}) => monter({
    bibliotheque: async () => [e], offrables: async () => [e], serveurs: async () => new Map([['s1', { label: 'notion' }]]), ...over,
  });

  it('🔴 GET /mcp liste ce que le CATALOGUE offre à ce numéro, serveur nommé, sans refiltrer', async () => {
    // Ce qui est offrable (enregistré, appelable, pas déjà là) est la règle unique du catalogue, prouvée en intégration.
    const lus: unknown[][] = [];
    const { app } = avec(entree(), { offrables: async (...args) => { lus.push(args); return [entree()]; } });
    const res = await app.inject({ method: 'GET', url: `${url}/mcp`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().outils).toEqual([expect.objectContaining({ id: MCP, serveur: 'notion', risque: 'read' })]);
    expect(lus).toEqual([[TENANT, PN]]);
  });

  it('GET /mcp sans numéro connecté rend une liste vide, sans lire le catalogue', async () => {
    let lus = 0;
    const { app } = monter({ offrables: async () => { lus += 1; return [entree()]; } }, null);
    expect((await app.inject({ method: 'GET', url: `${url}/mcp`, ...h() })).json()).toEqual({ outils: [] });
    expect(lus).toBe(0);
  });

  it('🔴 POST /mcp/:id rattache et active pour CE numéro, au nom de l’administrateur', async () => {
    const { app, gestes } = avec(entree());
    const res = await app.inject({ method: 'POST', url: `${url}/mcp/${MCP}`, ...h(), payload: {} });
    expect(res.statusCode).toBe(201);
    expect(gestes).toEqual([{ geste: 'proposerMcp', args: [TENANT, PN, MCP, 'u1'] }]);
  });

  it('🔴 un outil qui n’est pas MCP ne passe pas par cette porte : 404, rien d’écrit', async () => {
    for (const origin of ['http', 'mba'] as const) {
      const { app, gestes } = avec(entree({ origin }));
      expect((await app.inject({ method: 'POST', url: `${url}/mcp/${MCP}`, ...h(), payload: {} })).statusCode).toBe(404);
      expect(gestes).toEqual([]);
    }
    const inconnu = avec(entree());
    expect((await inconnu.app.inject({ method: 'POST', url: `${url}/mcp/${OUTIL}`, ...h(), payload: {} })).statusCode).toBe(404);
    expect((await inconnu.app.inject({ method: 'POST', url: `${url}/mcp/pas-un-uuid`, ...h(), payload: {} })).statusCode).toBe(404);
    expect(inconnu.gestes).toEqual([]);
  });

  /**
   * 🔴 LA ROUTE NE REVÉRIFIE PLUS RIEN (règle unique du 2026-10-02) : la porte du catalogue refuse, AVANT de rattacher,
   * un outil non enregistré, mort ou déjà là, et la route traduit sa raison. Que la porte refuse vraiment avant
   * d'écrire est prouvé contre une vraie base (`tests/integration/agent-catalog.integration.test.ts`).
   */
  it.each([
    ['non enregistré', { ok: false, refus: 'non_enregistre' }, 409, 'Connecteurs MCP'],
    ['mort', { ok: false, refus: 'inappelable', inappelable: { cause: 'disparu' }, origine: 'mcp' }, 409, 'disparu'],
    ['au serveur éteint', { ok: false, refus: 'inappelable', inappelable: { cause: 'source_inactive' }, origine: 'mcp' }, 409, 'n’est pas actif'],
    ['déjà donné', { ok: false, refus: 'deja_rattache' }, 409, 'déjà donné'],
    ['effacé entre-temps', { ok: false, refus: 'introuvable' }, 404, 'introuvable'],
  ] as const)('un outil %s : le refus de la porte est traduit avec sa raison', async (_nom, refus, code, texte) => {
    const { app } = avec(entree(), { proposerMcp: async () => refus });
    const res = await app.inject({ method: 'POST', url: `${url}/mcp/${MCP}`, ...h(), payload: {} });
    expect(res.statusCode).toBe(code);
    expect(res.json().error).toContain(texte);
  });

  it('une activation refusée par le catalogue rend 409 lisible, pas 500', async () => {
    const { app } = avec(entree(), { proposerMcp: async () => { throw new OutilNonActivable('cet outil MCP n’est pas activable'); } });
    const res = await app.inject({ method: 'POST', url: `${url}/mcp/${MCP}`, ...h(), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'cet outil MCP n’est pas activable' });
  });

  it('🔴 réservé aux administrateurs, comme le reste de l’onglet', async () => {
    const { app, gestes } = avec(entree());
    expect((await app.inject({ method: 'POST', url: `${url}/mcp/${MCP}`, ...h(lecteurTok), payload: {} })).statusCode).toBe(403);
    expect(gestes).toEqual([]);
  });

  it('les mots d’un outil MCP ne se corrigent pas ici : ils sont partagés et se règlent dans Connecteurs MCP', async () => {
    const { app, gestes } = monter({ lister: async () => [complet({ origin: 'mcp', sourceId: 's1', binding: {} })] });
    const res = await app.inject({ method: 'PATCH', url: `${url}/${OUTIL}`, ...h(), payload: { title: 'Autre' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Connecteurs MCP');
    expect(gestes).toEqual([]);
  });
});
