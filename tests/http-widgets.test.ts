import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { newTrackingCode } from '../src/ids/code';
import { lienWaMe } from '../src/lib/wa-me';
import { registerWidgetPublic } from '../src/http/widget-public';
import { SCRIPT_INERTE } from '../src/widgets/script';
import { RateLimiter } from '../src/auth/rate-limit';
import { LIMITE_WIDGETS_PAR_ESPACE, DEVENIR_AGENT_A_VENIR, type DepsGestionWidgets } from '../src/widgets/gestion';
import type { NumeroDuWidget } from '../src/widgets/adresses';
import type { WidgetInput, WidgetRow } from '../src/widgets/store.pg';
import type { PhoneNumberRecord } from '../src/account/types';

/**
 * Les routes des widgets côté console (lot 4 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md), montées par
 * `buildServer` avec de faux dépôts : la garde est donc celle que le REGISTRE pose, pas une garde choisie ici.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. 🔴 Un widget de l'espace A ne peut pas désigner un scénario de l'espace B : la clé étrangère de 0200 dit qu'il
 *     existe, pas à qui il est. Sans le contrôle, les visiteurs de A recevraient les messages de B.
 *  2. 🔴 L'espace des phrases est widgets ET liens de chaîne, dans les deux sens : une phrase qui en contient une
 *     autre fait déclencher les deux sur un seul message.
 *  3. La modification ne se compare pas à elle-même, et ne recompte pas les messages reçus d'une phrase inchangée
 *     (ses propres arrivées la contiennent).
 *  4. Le devenir « agent IA » est refusé par l'API, pas seulement grisé à l'écran : le MCP du lot 5 appellera les
 *     mêmes fonctions.
 *  5. Cinq widgets au plus, et les écritures réservées aux administrateurs.
 */

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

/** Le scénario de l'espace t1, et celui de l'espace t2 : le second ne doit jamais être désignable depuis t1. */
const WF_T1 = '11111111-1111-4111-8111-111111111111';
const WF_T2 = '22222222-2222-4222-8222-222222222222';
const BASE_API = 'https://api.exemple.test';
const NUMERO: NumeroDuWidget = { displayPhoneNumber: '+33 5 25 68 02 50', delieLe: null };
/** Le même numéro, en entier, pour la route publique, qui lit un `PhoneNumberRecord`. */
const NUMERO_COMPLET: PhoneNumberRecord = {
  id: 'eeeeeeee-5555-4555-8555-000000000005', displayPhoneNumber: NUMERO.displayPhoneNumber, status: 'CONNECTED',
  qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', nameStatus: 'APPROVED', codeVerificationStatus: 'VERIFIED',
  throughputLevel: 'STANDARD', verifiedName: 'Exemple', wabaHealthStatus: 'AVAILABLE', accountReviewStatus: 'APPROVED',
  businessVerificationStatus: 'verified', marketingMessagesLiteApiStatus: null, ownerBusinessName: 'Exemple SAS',
  hubspotConnected: false, hubspotPausedAt: null, delieLe: null,
};
const URL_WIDGETS = '/tenants/t1/widgets';

function ligne(sur: Partial<WidgetRow> = {}): WidgetRow {
  return {
    id: randomUUID(), tenantId: 't1', code: newTrackingCode(), nom: 'Site vitrine', phrase: 'Bonjour, je viens du site',
    devenir: null, agentId: null, workflowId: null, couleur: '#25d366', position: 'bas_droite', libelle: null,
    avatarUrl: null, badge: true, actif: true, maxParHeure: null,
    createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    ...sur,
  };
}

/** Une erreur de la base telle que `pg` la lève : un code, et le nom de la contrainte. */
class ErreurPg extends Error {
  constructor(readonly code: string, readonly constraint: string) { super(`${code} ${constraint}`); }
}

function monter(o: {
  widgets?: WidgetRow[];
  liens?: string[];
  dejaVus?: number;
  creer?: DepsGestionWidgets['widgets']['creer'];
  numero?: NumeroDuWidget | null;
} = {}) {
  const lignes = [...(o.widgets ?? [])];
  const cap = {
    creations: [] as WidgetInput[],
    modifications: [] as Array<{ id: string; w: WidgetInput }>,
    suppressions: [] as string[],
    comptages: [] as string[],
  };
  const gestion: DepsGestionWidgets = {
    widgets: {
      lister: async (t) => lignes.filter((w) => w.tenantId === t),
      creer: o.creer ?? (async (t, w) => {
        cap.creations.push(w);
        const cree = ligne({ ...w, tenantId: t });
        lignes.unshift(cree);
        return cree;
      }),
      modifier: async (t, id, w) => {
        cap.modifications.push({ id, w });
        const i = lignes.findIndex((x) => x.id === id && x.tenantId === t);
        if (i < 0) return null;
        lignes[i] = { ...lignes[i]!, ...w };
        return lignes[i]!;
      },
      supprimer: async (t, id) => {
        const i = lignes.findIndex((x) => x.id === id && x.tenantId === t);
        if (i < 0) return false;
        cap.suppressions.push(id);
        lignes.splice(i, 1);
        return true;
      },
    },
    phrasesDesLiens: async () => o.liens ?? [],
    messagesContenantLaPhrase: async (_t, phrase) => { cap.comptages.push(phrase); return o.dejaVus ?? 0; },
    scenarioDeLEspace: async (t, id) => (t === 't1' && id === WF_T1) || (t === 't2' && id === WF_T2),
  };
  const server = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    widgets: { gestion, numero: async () => (o.numero === undefined ? NUMERO : o.numero), baseApi: BASE_API },
  });
  return { server, cap, lignes };
}

const creer = (server: ReturnType<typeof monter>['server'], payload: Record<string, unknown>, tok = adminTok) =>
  server.inject({ method: 'POST', url: URL_WIDGETS, ...h(tok), payload });
const erreur = (res: { json: <T>() => T }): string => res.json<{ error: string }>().error;

describe('lister, et ce qu’il faut pour poser la bulle', () => {
  it('rend l’adresse du script, la balise et le lien wa.me, composés par le serveur', async () => {
    const w = ligne();
    const { server } = monter({ widgets: [w] });
    const res = await server.inject({ method: 'GET', url: URL_WIDGETS, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ widgets: Array<Record<string, unknown>>; limite: number }>();
    expect(corps.limite).toBe(LIMITE_WIDGETS_PAR_ESPACE);
    const vue = corps.widgets[0]!;
    expect(vue.adresseScript).toBe(`${BASE_API}/widget/${w.code}.js`);
    expect(vue.balise).toBe(`<script src="${BASE_API}/widget/${w.code}.js" async></script>`);
    expect(vue.waMeUrl).toBe(lienWaMe(NUMERO.displayPhoneNumber, w.phrase));
    expect(vue.scenarioSupprime).toBe(false);
    // Ni l'espace ni l'agent : la vue est construite champ par champ.
    expect(vue).not.toHaveProperty('tenantId');
    expect(vue).not.toHaveProperty('agentId');
    await server.close();
  });

  it('🔴 l’adresse distribuée est bien celle que la route publique sert (une seule vérité)', async () => {
    const w = ligne();
    const { server } = monter({ widgets: [w] });
    const vue = (await server.inject({ method: 'GET', url: URL_WIDGETS, ...h(adminTok) }))
      .json<{ widgets: Array<{ adresseScript: string }> }>().widgets[0]!;
    await server.close();
    const publique = Fastify({ logger: false });
    registerWidgetPublic(publique, {
      widgets: { parCode: async (code) => (code === w.code ? w : null) },
      numero: async () => NUMERO_COMPLET,
      qrSvg: async () => '<svg/>',
      budgetInconnus: new RateLimiter(0, 60_000),
    });
    const res = await publique.inject({ method: 'GET', url: new URL(vue.adresseScript).pathname });
    expect(res.statusCode).toBe(200);
    // Le script SERVI, pas l'inerte : l'adresse a bien retrouvé ce widget.
    expect(res.body).not.toBe(SCRIPT_INERTE);
    expect(res.body).toContain('wa.me');
    await publique.close();
  });

  it('un numéro délié, ou aucun numéro : pas de lien, la bulle s’affichera grisée', async () => {
    for (const numero of [null, { ...NUMERO, delieLe: '2026-10-01T00:00:00.000Z' }]) {
      const { server } = monter({ widgets: [ligne()], numero });
      const vue = (await server.inject({ method: 'GET', url: URL_WIDGETS, ...h(adminTok) }))
        .json<{ widgets: Array<{ waMeUrl: unknown }> }>().widgets[0]!;
      expect(vue.waMeUrl).toBeNull();
      await server.close();
    }
  });

  it('un scénario supprimé après coup se lit sur le widget : il ne démarre plus rien', async () => {
    const { server } = monter({ widgets: [ligne({ devenir: 'scenario', workflowId: null })] });
    const vue = (await server.inject({ method: 'GET', url: URL_WIDGETS, ...h(adminTok) }))
      .json<{ widgets: Array<{ scenarioSupprime: boolean }> }>().widgets[0]!;
    expect(vue.scenarioSupprime).toBe(true);
    await server.close();
  });
});

describe('créer', () => {
  it('crée avec les défauts : le réglage de l’espace, le vert de WhatsApp, le badge', async () => {
    const { server, cap } = monter();
    const res = await creer(server, { nom: 'Blog', phrase: 'Je viens du blog' });
    expect(res.statusCode).toBe(201);
    expect(cap.creations).toEqual([{
      nom: 'Blog', phrase: 'Je viens du blog', devenir: null, agentId: null, workflowId: null, couleur: '#25d366',
      position: 'bas_droite', libelle: null, avatarUrl: null, badge: true, actif: true, maxParHeure: null,
    }]);
    expect(res.json<{ widget: { balise: string } }>().widget.balise).toContain('/widget/');
    await server.close();
  });

  it('🔴 un scénario d’un AUTRE espace est refusé, et rien n’est écrit', async () => {
    const { server, cap } = monter();
    const res = await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario', workflowId: WF_T2 });
    expect(res.statusCode).toBe(400);
    expect(erreur(res)).toContain('n’existe pas dans cet espace');
    expect(cap.creations).toEqual([]);
    // Le pendant : le scénario de l'espace passe, sinon le refus ci-dessus ne prouverait rien.
    const ok = await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario', workflowId: WF_T1 });
    expect(ok.statusCode).toBe(201);
    expect(cap.creations[0]).toMatchObject({ devenir: 'scenario', workflowId: WF_T1 });
    await server.close();
  });

  it('🔴 le devenir agent IA est refusé (400, « à venir »)', async () => {
    const { server, cap } = monter();
    const res = await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'agent' });
    expect(res.statusCode).toBe(400);
    expect(erreur(res)).toBe(DEVENIR_AGENT_A_VENIR);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('le devenir et son scénario vont ensemble, dans les deux sens', async () => {
    const { server, cap } = monter();
    expect((await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario' })).statusCode).toBe(400);
    expect((await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'mba', workflowId: WF_T1 })).statusCode).toBe(400);
    expect((await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', workflowId: WF_T1 })).statusCode).toBe(400);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('🔴 le sixième widget est refusé (409), et rien n’est écrit', async () => {
    const cinq = Array.from({ length: LIMITE_WIDGETS_PAR_ESPACE }, (_, i) => ligne({ phrase: `Phrase numero ${i} du site` }));
    const { server, cap } = monter({ widgets: cinq });
    const res = await creer(server, { nom: 'Sixième', phrase: 'Une toute autre phrase' });
    expect(res.statusCode).toBe(409);
    expect(erreur(res)).toContain(`${LIMITE_WIDGETS_PAR_ESPACE} widgets`);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('les widgets d’un AUTRE espace ne comptent pas dans la limite', async () => {
    const ailleurs = Array.from({ length: LIMITE_WIDGETS_PAR_ESPACE }, (_, i) => ligne({ tenantId: 't2', phrase: `Ailleurs ${i}` }));
    const { server } = monter({ widgets: ailleurs });
    expect((await creer(server, { nom: 'Blog', phrase: 'Je viens du blog' })).statusCode).toBe(201);
    await server.close();
  });

  it('une saisie hors bornes, ou une clé inconnue, est refusée en 400 avec le champ en cause', async () => {
    const { server, cap } = monter();
    const cas: Array<[Record<string, unknown>, string]> = [
      [{ phrase: 'Je viens du blog' }, 'le nom'],
      [{ nom: 'Blog', phrase: 'x'.repeat(301) }, 'la phrase'],
      [{ nom: 'Blog', phrase: 'Je viens du blog', couleur: 'red;display:none' }, 'la couleur'],
      [{ nom: 'Blog', phrase: 'Je viens du blog', position: 'milieu' }, 'la position'],
      [{ nom: 'Blog', phrase: 'Je viens du blog', libelle: 'x'.repeat(61) }, 'le libellé'],
      [{ nom: 'Blog', phrase: 'Je viens du blog', avatarUrl: 'http://exemple.test/a.png' }, 'l’avatar'],
      [{ nom: 'Blog', phrase: 'Je viens du blog', avatarUrl: 'javascript:alert(1)' }, 'l’avatar'],
      [{ nom: 'Blog', phrase: 'Je viens du blog', maxParHeure: 0 }, 'le plafond horaire'],
      // Le badge tient à l'offre, pas à un réglage : la clé n'existe pas pour la console.
      [{ nom: 'Blog', phrase: 'Je viens du blog', badge: false }, 'Champ inconnu : badge'],
    ];
    for (const [payload, attendu] of cas) {
      const res = await creer(server, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(erreur(res), JSON.stringify(payload)).toContain(attendu);
    }
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('un libellé ou un avatar vidé vaut « rien » (null), pas une chaîne vide', async () => {
    const { server, cap } = monter();
    expect((await creer(server, { nom: 'Blog', phrase: 'Je viens du blog', libelle: '  ', avatarUrl: '' })).statusCode).toBe(201);
    expect(cap.creations[0]).toMatchObject({ libelle: null, avatarUrl: null });
    await server.close();
  });
});

describe('🔴 la phrase : l’espace des phrases est widgets ET liens de chaîne', () => {
  it('une phrase qui CONTIENT celle d’un lien de chaîne est refusée (409)', async () => {
    const { server, cap } = monter({ liens: ['Je veux le guide'] });
    const res = await creer(server, { nom: 'Blog', phrase: 'Je veux le guide 2026' });
    expect(res.statusCode).toBe(409);
    expect(erreur(res)).toContain('lien de chaîne');
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('une phrase CONTENUE dans celle d’un lien de chaîne est refusée aussi (l’autre sens)', async () => {
    const { server, cap } = monter({ liens: ['Je veux le guide 2026'] });
    expect((await creer(server, { nom: 'Blog', phrase: 'je veux le GUIDE' })).statusCode).toBe(409);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('entre deux widgets, dans les deux sens, et le refus nomme le widget en cause', async () => {
    const { server, cap } = monter({ widgets: [ligne({ nom: 'Blog', phrase: 'Je viens du blog' })] });
    const contient = await creer(server, { nom: 'Autre', phrase: 'Bonjour, je viens du blog' });
    expect(contient.statusCode).toBe(409);
    expect(erreur(contient)).toContain('« Blog »');
    expect((await creer(server, { nom: 'Autre', phrase: 'du blog' })).statusCode).toBe(409);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('un widget ÉTEINT compte aussi : il se rallume, et sa balise est toujours posée', async () => {
    const { server } = monter({ widgets: [ligne({ phrase: 'Je viens du blog', actif: false })] });
    expect((await creer(server, { nom: 'Autre', phrase: 'Je viens du blog !' })).statusCode).toBe(409);
    await server.close();
  });

  it('une phrase déjà vue dans des messages reçus est refusée, AVEC son compte', async () => {
    const { server, cap } = monter({ dejaVus: 7 });
    const res = await creer(server, { nom: 'Blog', phrase: 'bonjour' });
    expect(res.statusCode).toBe(409);
    expect(erreur(res)).toContain('7 message(s)');
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('une phrase que la normalisation réduit à rien est refusée (400)', async () => {
    const { server, cap } = monter();
    // Des diacritiques seuls : ils passent `trim().min(1)`, `normalizeText` les efface.
    const res = await creer(server, { nom: 'Blog', phrase: String.fromCharCode(0x301, 0x300) });
    expect(res.statusCode).toBe(400);
    expect(erreur(res)).toContain('aucun caractère exploitable');
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('une course entre deux créations (23505 sur `widgets_phrase_key`) sort en 409, pas en 500', async () => {
    const { server } = monter({ creer: async () => { throw new ErreurPg('23505', 'widgets_phrase_key'); } });
    const res = await creer(server, { nom: 'Blog', phrase: 'Je viens du blog' });
    expect(res.statusCode).toBe(409);
    expect(erreur(res)).toContain('porte déjà cette phrase');
    await server.close();
  });

  it('une collision sur un AUTRE index n’est pas une phrase prise : elle n’est pas maquillée en 409', async () => {
    // Le gestionnaire global journalise la panne : attendu ici, donc tu.
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server } = monter({ creer: async () => { throw new ErreurPg('23505', 'widgets_code_key'); } });
    expect((await creer(server, { nom: 'Blog', phrase: 'Je viens du blog' })).statusCode).toBe(500);
    journal.mockRestore();
    await server.close();
  });
});

describe('modifier', () => {
  it('🔴 sans changer la phrase : accepté, sans se comparer à soi-même ni recompter les messages reçus', async () => {
    const w = ligne({ phrase: 'Je viens du blog' });
    const { server, cap } = monter({ widgets: [w], dejaVus: 12 });
    const res = await server.inject({
      method: 'PATCH', url: `${URL_WIDGETS}/${w.id}`, ...h(adminTok),
      // La même phrase, à la casse et aux espaces près : elle ne CHANGE pas.
      payload: { couleur: '#123abc', phrase: '  je viens du BLOG ' },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.comptages).toEqual([]);
    expect(cap.modifications[0]?.w).toMatchObject({ couleur: '#123abc' });
    await server.close();
  });

  it('🔴 une phrase qui prolonge la sienne : acceptée, le widget ne se heurte pas à lui-même', async () => {
    const w = ligne({ phrase: 'Je viens du blog' });
    const { server, cap } = monter({ widgets: [w] });
    const res = await server.inject({
      method: 'PATCH', url: `${URL_WIDGETS}/${w.id}`, ...h(adminTok), payload: { phrase: 'Je viens du blog cuisine' },
    });
    expect(res.statusCode).toBe(200);
    // Elle CHANGE : le comptage s'applique.
    expect(cap.comptages).toEqual(['Je viens du blog cuisine']);
    await server.close();
  });

  it('une phrase qui change se heurte aux AUTRES widgets et aux liens', async () => {
    const w = ligne({ phrase: 'Je viens du blog' });
    const voisin = ligne({ nom: 'Tarifs', phrase: 'Je viens de la page tarifs' });
    const { server, cap } = monter({ widgets: [w, voisin], liens: ['Je veux le guide'] });
    const url = `${URL_WIDGETS}/${w.id}`;
    expect((await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { phrase: 'tarifs' } })).statusCode).toBe(409);
    expect((await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { phrase: 'Je veux le guide !' } })).statusCode).toBe(409);
    expect(cap.modifications).toEqual([]);
    await server.close();
  });

  it('🔴 un scénario d’un AUTRE espace est refusé à la modification aussi', async () => {
    const w = ligne();
    const { server, cap } = monter({ widgets: [w] });
    const res = await server.inject({
      method: 'PATCH', url: `${URL_WIDGETS}/${w.id}`, ...h(adminTok), payload: { devenir: 'scenario', workflowId: WF_T2 },
    });
    expect(res.statusCode).toBe(400);
    expect(cap.modifications).toEqual([]);
    await server.close();
  });

  it('🔴 le devenir agent IA est refusé à la modification aussi', async () => {
    const w = ligne();
    const { server, cap } = monter({ widgets: [w] });
    const res = await server.inject({ method: 'PATCH', url: `${URL_WIDGETS}/${w.id}`, ...h(adminTok), payload: { devenir: 'agent' } });
    expect(res.statusCode).toBe(400);
    expect(erreur(res)).toBe(DEVENIR_AGENT_A_VENIR);
    expect(cap.modifications).toEqual([]);
    await server.close();
  });

  it('un widget inerte (scénario supprimé) se modifie sans exiger d’abord un scénario ; le CHOISIR l’exige', async () => {
    const w = ligne({ devenir: 'scenario', workflowId: null });
    const { server } = monter({ widgets: [w] });
    const url = `${URL_WIDGETS}/${w.id}`;
    expect((await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { couleur: '#000000' } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { devenir: 'scenario' } })).statusCode).toBe(400);
    const repare = await server.inject({ method: 'PATCH', url, ...h(adminTok), payload: { workflowId: WF_T1 } });
    expect(repare.statusCode).toBe(200);
    expect(repare.json<{ widget: { scenarioSupprime: boolean } }>().widget.scenarioSupprime).toBe(false);
    await server.close();
  });

  it('changer de devenir efface le scénario, et le badge en base est gardé', async () => {
    const w = ligne({ devenir: 'scenario', workflowId: WF_T1, badge: false });
    const { server, cap } = monter({ widgets: [w] });
    const res = await server.inject({ method: 'PATCH', url: `${URL_WIDGETS}/${w.id}`, ...h(adminTok), payload: { devenir: 'mba' } });
    expect(res.statusCode).toBe(200);
    expect(cap.modifications[0]?.w).toMatchObject({ devenir: 'mba', workflowId: null, badge: false });
    await server.close();
  });

  it('un widget inconnu, d’un autre espace, ou un identifiant mal formé : 404', async () => {
    const ailleurs = ligne({ tenantId: 't2' });
    const { server } = monter({ widgets: [ailleurs] });
    for (const id of [randomUUID(), ailleurs.id, 'pas-un-uuid']) {
      const res = await server.inject({ method: 'PATCH', url: `${URL_WIDGETS}/${id}`, ...h(adminTok), payload: { actif: false } });
      expect(res.statusCode, id).toBe(404);
    }
    await server.close();
  });
});

describe('supprimer', () => {
  it('supprime le widget de l’espace ; un inconnu ou celui d’un autre espace rend 404', async () => {
    const w = ligne();
    const ailleurs = ligne({ tenantId: 't2' });
    const { server, cap } = monter({ widgets: [w, ailleurs] });
    expect((await server.inject({ method: 'DELETE', url: `${URL_WIDGETS}/${w.id}`, ...h(adminTok) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'DELETE', url: `${URL_WIDGETS}/${ailleurs.id}`, ...h(adminTok) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: `${URL_WIDGETS}/pas-un-uuid`, ...h(adminTok) })).statusCode).toBe(404);
    expect(cap.suppressions).toEqual([w.id]);
    await server.close();
  });
});

describe('🔴 qui peut faire quoi', () => {
  it('un non-admin ne peut ni écrire ni lire, et rien n’est écrit', async () => {
    const w = ligne();
    const { server, cap } = monter({ widgets: [w] });
    const reponses = [
      await creer(server, { nom: 'Blog', phrase: 'Je viens du blog' }, agentTok),
      await server.inject({ method: 'PATCH', url: `${URL_WIDGETS}/${w.id}`, ...h(agentTok), payload: { actif: false } }),
      await server.inject({ method: 'DELETE', url: `${URL_WIDGETS}/${w.id}`, ...h(agentTok) }),
      await server.inject({ method: 'GET', url: URL_WIDGETS, ...h(agentTok) }),
    ];
    expect(reponses.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(cap).toEqual({ creations: [], modifications: [], suppressions: [], comptages: [] });
    await server.close();
  });

  it('l’espace d’un autre client est refusé', async () => {
    const { server } = monter();
    const res = await server.inject({ method: 'GET', url: '/tenants/t2/widgets', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await server.close();
  });
});

describe('le câblage', () => {
  /** Le bloc d'une clé de `buildServer` dans `src/index.ts`, sans ses commentaires (qui citent ce qu'on cherche). */
  function bloc(cle: string): string {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const debut = src.indexOf(`\n    ${cle}: {`);
    expect(debut, `bloc « ${cle} » introuvable`).toBeGreaterThan(0);
    return src.slice(debut, src.indexOf('\n    },', debut)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('les widgets de la console sont câblés sur l’assemblage de production et la base des routes d’API', () => {
    const b = bloc('widgets');
    expect(b).toContain('gestion: gestionDesWidgetsEnBase(pool)');
    // La même base que l'adresse d'un webhook entrant : la route vit sur l'API.
    expect(b).toContain('baseApi: adressesApi.avecPrefixe');
    // Le même numéro que le script public, donc le même lien que la bulle ouvrira.
    expect(b).toContain('numero: (tenant) => phoneStatusStore.getPhoneNumber(tenant)');
  });

  it('🔴 le contrôle des liens de chaîne lit les phrases des widgets', () => {
    const b = bloc('channelsMe');
    expect(b).toContain('phraseEnConflit: conflitDansLEspace(');
    expect(b).toContain('phrasesDesWidgets: (tenant) => widgetStore.phrasesDesWidgets(tenant)');
  });
});
