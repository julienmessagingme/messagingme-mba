import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { FakeQueue } from '../src/queue/fake';
import type { MbaOutilsDeps } from '../src/http/mba-outils';
import { NomOutilDejaPris, OutilNonActivable, type OutilComplet } from '../src/agent/catalog';
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
  autonomeLe: null, ...over,
});

function monter(over: Partial<MbaOutilsDeps> = {}, numero: string | null = PN) {
  const gestes: Array<{ geste: string; args: unknown[] }> = [];
  const deps: MbaOutilsDeps = {
    numeroDuTenant: async () => numero,
    lister: async () => [complet({})],
    contexte: async () => ({ requetes: new Map(), champs: new Set(['ville']), bibliotheque: new Map() }),
    requete: async (_t, id) => (id === REQ ? {
      id: REQ, sourceId: 's1', methode: 'DELETE', variables: [
        { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
        { nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } },
      ],
    } : null),
    champs: async () => ['ville'],
    creerMaison: async (...args) => { gestes.push({ geste: 'creerMaison', args }); return { id: 'nouveau' }; },
    creerConnecteur: async (...args) => { gestes.push({ geste: 'creerConnecteur', args }); return { id: 'nouveau' }; },
    modifierMaison: async (...args) => { gestes.push({ geste: 'modifierMaison', args }); return { id: OUTIL }; },
    modifierConnecteur: async (...args) => { gestes.push({ geste: 'modifierConnecteur', args }); return { id: OUTIL }; },
    retirer: async (...args) => { gestes.push({ geste: 'retirer', args }); return 'supprime'; },
    reactiver: async (...args) => { gestes.push({ geste: 'reactiver', args }); return true; },
    ...over,
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
    const { app } = monter({ creerMaison: async () => { throw new NomOutilDejaPris('espace'); } });
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
    const { app } = monter({ retirer: async () => 'detache' });
    expect((await app.inject({ method: 'DELETE', url: `${url}/${OUTIL}`, ...h() })).statusCode).toBe(204);
    const { app: autre } = monter({ retirer: async () => 'introuvable' });
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
