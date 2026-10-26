import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signRequest } from '../src/lib/signature';
import { MESSAGES_PAR_PAGE, PREFIXE_CONVERSATION_HUBSPOT, type HubspotConversationDeps } from '../src/http/hubspot-conversation';
import { MetaApiError } from '../src/meta/errors';
import type { DepsRepondre } from '../src/inbox/repondre';
import type { AuteurDuChangement } from '../src/inbox/evenements';
import type { IdempotencyClaim } from '../src/api/idempotency-store.pg';
import type { ConversationMessage } from '../src/inbox/store.pg';
import { AgentDeMetaGardeLeFil } from '../src/inbox/fil';
import { groupeDeRoute } from '../src/ops/latence-http';
import type { Fonction } from '../src/offres/offres';
import { filiereApiSeule, aucunPremierMessage } from './gardes';

/**
 * LA CARTE HUBSPOT LIT, RÉPOND ET REND LA MAIN (lot 2 de la reprise humaine). Une porte d'ENVOI WhatsApp ouverte à un
 * système extérieur : chaque refus est vérifié par ce qui n'est PAS parti, et la réponse passe par le VRAI chemin
 * d'envoi de la console (`repondreDansLaFenetre`), seules ses dépendances sont fausses.
 */
const SECRET = 'secret-partage-avec-le-connecteur-hubspot';
const NOW = 1_786_000_000_000;
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c0000000-0000-4000-8000-000000000001';
const U_AGENT = 'a0000000-0000-4000-8000-000000000001';
const U_AFFECTE = 'a0000000-0000-4000-8000-000000000002';
const U_ADMIN = 'a0000000-0000-4000-8000-000000000003';

const MEMBRES = [
  { id: U_AGENT, name: 'Alice', email: 'alice@exemple.fr', role: 'agent', disabled: false, pending: false },
  { id: U_AFFECTE, name: 'Bruno', email: 'Bruno@Exemple.fr', role: 'agent', disabled: false, pending: false },
  { id: U_ADMIN, name: null, email: 'admin@exemple.fr', role: 'admin', disabled: false, pending: false },
  { id: 'a0000000-0000-4000-8000-000000000004', name: 'Ancien', email: 'ancien@exemple.fr', role: 'admin', disabled: true, pending: false },
  { id: 'a0000000-0000-4000-8000-000000000005', name: 'Invité', email: 'invite@exemple.fr', role: 'admin', disabled: false, pending: true },
];

function message(i: number): ConversationMessage {
  const s = String(i).padStart(2, '0');
  return {
    id: `d0000000-0000-4000-8000-0000000000${s}`, direction: i % 2 ? 'in' : 'out', type: 'text', body: `message ${i}`,
    buttonPayload: null, createdAt: `2026-10-24T10:${s}:00.000Z`, curseur: `2026-10-24T10:${s}:00.000000Z`, senderName: i % 2 ? null : 'Alice',
  };
}

interface Options {
  fonctions?: Fonction[];
  reponse?: boolean;
  fenetre?: boolean;
  assignee?: string | null;
  desabonne?: boolean;
  messages?: ConversationMessage[];
  rendre?: HubspotConversationDeps['fil']['rendreLaMainSousConsentement'];
  /** L'envoi lève cette erreur (un refus de Meta, ou une coupure). */
  envoiLeve?: Error;
  /** Le scellement de la clé lève : le message est déjà parti. */
  scellementLeve?: boolean;
  /** L'envoi attend cette promesse : un premier appel reste EN COURS pendant que le second se présente. */
  envoiRetenu?: Promise<void>;
}

/** Une conversation `C1` dans l'espace `T1`, et rien dans `T2` : l'isolation se lit sur ce que `T2` n'obtient pas. */
function app(o: Options = {}) {
  const envois: Array<{ to: string; text: string }> = [];
  const traces: Array<{ origine: string; senderUserId: string | null | undefined }> = [];
  const prises: AuteurDuChangement[] = [];
  const lectures: string[] = [];
  const rendus: AuteurDuChangement[] = [];
  const cles = new Map<string, { empreinte: string; jeton: string; reponse?: unknown }>();
  const liberees: string[] = [];
  const contexte = async (conversationId: string, tenantId: string) => {
    lectures.push(tenantId);
    return conversationId === C1 && tenantId === T1 ? { waId: '33600000001', lastInboundAt: '2026-10-24T10:00:00.000Z', windowOpen: o.fenetre ?? true } : null;
  };
  const repondre: DepsRepondre = {
    inbox: {
      getConversationContext: contexte,
      recordOutbound: async (_c, _b, _m, origine, _t, _cat, _nom, senderUserId) => { traces.push({ origine, senderUserId }); },
    },
    repo: { getTenantPhoneNumberId: async () => 'pn1' },
    sendReply: async (_t, _pn, to, text) => {
      if (o.envoiLeve) throw o.envoiLeve;
      if (o.envoiRetenu) await o.envoiRetenu;
      envois.push({ to, text });
      return `wamid.${envois.length}`;
    },
    estDesabonne: async () => o.desabonne ?? false,
    takeControl: async (_t, _w, par) => { prises.push(par); },
    filTenuParLApplication: async () => false,
    application: filiereApiSeule,
    ecrirePremier: aucunPremierMessage,
  };
  const deps: HubspotConversationDeps = {
    secret: SECRET,
    fonctions: async () => new Set<Fonction>(o.fonctions ?? ['inbox']),
    reponseBranchee: async () => o.reponse ?? true,
    inbox: {
      getConversationContext: contexte,
      getDerniersMessages: async (_c, n, avant) => {
        const tous = o.messages ?? [message(1), message(2)];
        const avantLui = avant ? tous.filter((m) => (m.curseur ?? '') < avant.at) : tous;
        return avantLui.slice(-n);
      },
      getControlOwner: async () => 'app_human',
      getAssignee: async (tenantId, conversationId) => (conversationId === C1 && tenantId === T1 ? (o.assignee ?? null) : undefined),
    },
    escaladeeLe: async () => new Date('2026-10-24T10:05:00.000Z'),
    membres: async (tenantId) => (tenantId === T1 ? MEMBRES : []),
    repondre,
    idempotence: {
      // Atomique comme la vraie pose : la vérification et l'écriture ne se séparent par aucun `await`.
      claim: async (tenantId, key, empreinte): Promise<IdempotencyClaim> => {
        const k = `${tenantId}|${key}`;
        const l = cles.get(k);
        if (!l) {
          const jeton = randomBytes(8).toString('hex');
          cles.set(k, { empreinte, jeton });
          return { claimed: true, jeton };
        }
        if (l.empreinte !== empreinte) return { claimed: false, reused: true };
        if (l.reponse === undefined) return { claimed: false, pending: true };
        return { claimed: false, sendId: 's1', response: l.reponse };
      },
      complete: async (tenantId, key, jeton, _s, response) => {
        if (o.scellementLeve) throw new Error('base indisponible');
        const l = cles.get(`${tenantId}|${key}`);
        if (!l || l.jeton !== jeton) return false;
        l.reponse = response;
        return true;
      },
      release: async (tenantId, key, jeton) => {
        const k = `${tenantId}|${key}`;
        if (cles.get(k)?.jeton === jeton) { cles.delete(k); liberees.push(key); }
      },
    },
    fil: {
      rendreLaMainSousConsentement: o.rendre ?? (async (_t, _w, par) => { rendus.push(par); return 'mba'; }),
    },
    now: () => NOW,
  };
  const server = buildServer({ queue: new FakeQueue(), hubspotConversation: deps });
  return { server, envois, traces, prises, lectures, rendus, cles, liberees };
}

/** Signe un corps comme le connecteur (même format canonique, même chemin). */
function envoi(route: 'fil' | 'repondre' | 'rendre', body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const path = `/hubspot/conversation/${route}`;
  const sig = signRequest(secret, { ts: NOW, nonce: randomBytes(8).toString('hex'), method: 'POST', path, body: raw });
  return { method: 'POST' as const, url: path, headers: { 'content-type': 'application/json', 'x-mm-service-signature': sig }, payload: raw };
}

const REPONSE = { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr', texte: 'Bonjour, je regarde votre devis.', cle: 'carte-1' };

describe('les trois routes de la carte : la porte', () => {
  it.each(['fil', 'repondre', 'rendre'] as const)('🔴 %s : signature absente ou d’un autre secret, 401, rien n’est lu ni envoyé', async (route) => {
    const { server, envois, lectures, rendus } = app();
    const sans = await server.inject({ method: 'POST', url: `/hubspot/conversation/${route}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(REPONSE) });
    const autre = await server.inject(envoi(route, REPONSE, 'un-autre-secret-de-meme-longueur-000'));
    expect([sans.statusCode, autre.statusCode]).toEqual([401, 401]);
    expect(envois).toEqual([]);
    expect(lectures).toEqual([]);
    expect(rendus).toEqual([]);
    await server.close();
  });

  it('un champ de trop ou un texte vide : 400, rien ne part', async () => {
    const { server, envois } = app();
    expect((await server.inject(envoi('repondre', { ...REPONSE, origine: 'api' }))).statusCode).toBe(400);
    expect((await server.inject(envoi('repondre', { ...REPONSE, texte: '   ' }))).statusCode).toBe(400);
    expect((await server.inject(envoi('repondre', { ...REPONSE, cle: 'a b' }))).statusCode).toBe(400);
    expect(envois).toEqual([]);
    await server.close();
  });

  it('🔴 une offre sans l’Inbox : 402 avec le corps des refus d’offre, rien n’est lu', async () => {
    const { server, envois, lectures } = app({ fonctions: ['analyse'] });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('plan_feature_unavailable');
    expect(lectures).toEqual([]);
    expect(envois).toEqual([]);
    await server.close();
  });

  it('🔴 « Répondre depuis HubSpot » éteint : 403, rien n’est lu, sur les trois routes', async () => {
    const { server, envois, lectures, rendus } = app({ reponse: false });
    for (const route of ['fil', 'repondre', 'rendre'] as const) {
      const res = await server.inject(envoi(route, route === 'repondre' ? REPONSE : { tenantId: T1, conversationId: C1, auteurEmail: null }));
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('reponse_hubspot_eteinte');
    }
    expect([envois, lectures, rendus]).toEqual([[], [], []]);
    await server.close();
  });

  it('🔴 isolation : la conversation d’un espace n’existe pas pour un autre (404), et existe pour le sien', async () => {
    const { server, envois } = app();
    const ailleurs = await server.inject(envoi('repondre', { ...REPONSE, tenantId: T2 }));
    expect(ailleurs.statusCode).toBe(404);
    expect((await server.inject(envoi('fil', { tenantId: T2, conversationId: C1, auteurEmail: null }))).statusCode).toBe(404);
    expect(envois).toEqual([]);
    const chezSoi = await server.inject(envoi('repondre', REPONSE));
    expect(chezSoi.statusCode).toBe(200);
    expect(envois).toHaveLength(1);
    await server.close();
  });

  it('les trois routes se rangent avec l’Inbox dans l’audit de latence (le préfixe recopié reste égal à la constante)', () => {
    for (const route of ['fil', 'repondre', 'rendre']) expect(groupeDeRoute(`${PREFIXE_CONVERSATION_HUBSPOT}${route}`)).toBe('inbox');
    expect(groupeDeRoute('/hubspot/deal-stage')).toBe('webhooks');
  });
});

describe('lire le fil', () => {
  it('les derniers messages, la fenêtre, qui tient le fil, l’escalade, l’affectation et ce que la personne peut faire', async () => {
    const { server } = app({ assignee: U_AFFECTE });
    const res = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      conversationId: C1, fenetreOuverte: true, dernierEntrantLe: '2026-10-24T10:00:00.000Z', tenuPar: 'app_human',
      escaladeeLe: '2026-10-24T10:05:00.000Z', affecteA: { id: U_AFFECTE, nom: 'Bruno' }, contactDesabonne: false, peutRepondre: false,
      messages: [
        { id: message(1).id, direction: 'in', type: 'text', texte: 'message 1', le: message(1).createdAt, auteur: null },
        { id: message(2).id, direction: 'out', type: 'text', texte: 'message 2', le: message(2).createdAt, auteur: 'Alice' },
      ],
      avant: null,
    });
    // L'affectataire, reconnu par son adresse quelle que soit la casse, peut répondre.
    const lui = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: 'bruno@exemple.fr' }));
    expect(lui.json<{ peutRepondre: boolean }>().peutRepondre).toBe(true);
    await server.close();
  });

  it('un affectataire sans nom est nommé par la partie locale de son adresse, jamais par l’adresse entière', async () => {
    const { server } = app({ assignee: U_ADMIN });
    const res = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: null }));
    expect(res.json<{ affecteA: unknown }>().affecteA).toEqual({ id: U_ADMIN, nom: 'admin' });
    await server.close();
  });

  it('une page pleine rend le point d’où remonter, qui ramène les messages plus anciens ; un curseur bricolé est un 400', async () => {
    const messages = Array.from({ length: MESSAGES_PAR_PAGE + 5 }, (_, i) => message(i + 1));
    const { server } = app({ messages });
    const p1 = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: null }));
    const page1 = p1.json<{ messages: Array<{ id: string }>; avant: string | null }>();
    expect(page1.messages).toHaveLength(MESSAGES_PAR_PAGE);
    expect(page1.messages[0]!.id).toBe(messages[5]!.id);
    expect(page1.avant).not.toBeNull();
    const p2 = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: null, avant: page1.avant }));
    const page2 = p2.json<{ messages: Array<{ id: string }>; avant: string | null }>();
    expect(page2.messages.map((m) => m.id)).toEqual(messages.slice(0, 5).map((m) => m.id));
    expect(page2.avant).toBeNull();
    expect((await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: null, avant: 'bricole' }))).statusCode).toBe(400);
    await server.close();
  });
});

describe('répondre', () => {
  it('🔴 la réponse part par le chemin de la console, en origine « humain », signée du membre et prenant le fil pour lui', async () => {
    const { server, envois, traces, prises } = app();
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 'wamid.1', journal: 'recorded' });
    expect(envois).toEqual([{ to: '33600000001', text: REPONSE.texte }]);
    expect(traces).toEqual([{ origine: 'humain', senderUserId: U_AGENT }]);
    expect(prises).toEqual([{ collaborateur: U_AGENT }]);
    await server.close();
  });

  it.each([
    ['une adresse qu’aucun membre ne porte', 'inconnu@exemple.fr'],
    ['un membre désactivé', 'ancien@exemple.fr'],
    ['une invitation jamais acceptée', 'invite@exemple.fr'],
    ['aucune adresse', null],
  ])('%s : la réponse part, sans auteur (décision 7)', async (_cas, auteurEmail) => {
    const { server, envois, traces } = app();
    const res = await server.inject(envoi('repondre', { ...REPONSE, auteurEmail }));
    expect(res.statusCode).toBe(200);
    expect(envois).toHaveLength(1);
    expect(traces).toEqual([{ origine: 'humain', senderUserId: null }]);
    await server.close();
  });

  it('🔴 STOP : HubSpot ne répond JAMAIS à un contact désabonné (décision 5 amendée le 2026-10-26), rien ne part ni n’est réservé', async () => {
    const { server, envois, cles } = app({ desabonne: true });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('contact_desabonne');
    expect(envois).toEqual([]);
    expect(cles.size).toBe(0);
    await server.close();
  });

  it('la lecture du fil le dit à la carte : contact désabonné, la saisie n’est pas proposée', async () => {
    const { server } = app({ desabonne: true });
    const res = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr' }));
    expect(res.json<{ contactDesabonne: boolean; peutRepondre: boolean }>()).toMatchObject({ contactDesabonne: true, peutRepondre: false });
    await server.close();
  });

  it('🔴 fenêtre fermée : 422 window_closed, rien ne part, et la clé est rendue pour un nouvel essai', async () => {
    const { server, envois, liberees, cles } = app({ fenetre: false });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('window_closed');
    expect(envois).toEqual([]);
    expect(liberees).toEqual(['hubspot:carte-1']);
    expect(cles.size).toBe(0);
    await server.close();
  });

  it('🔴 Meta REFUSE l’envoi (`MetaApiError`) : rien n’est parti, la clé est rendue, le même message peut repartir', async () => {
    const { server, envois, cles, liberees } = app({ envoiLeve: new MetaApiError(400, { message: 'Re-engagement message', code: 131047 }) });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Meta a refusé le message : Re-engagement message', code: 'meta_rejected' });
    expect(envois).toEqual([]);
    expect(liberees).toEqual(['hubspot:carte-1']);
    expect(cles.size).toBe(0);
    await server.close();
  });

  it('🔴 une COUPURE pendant l’envoi (délai, réseau) : la clé reste en cours, un nouvel essai attend au lieu d’écrire deux fois', async () => {
    const coupure = Object.assign(new Error('délai dépassé (30000 ms) sur https://graph.facebook.com/v23.0/pn1/messages'), { name: 'HttpTimeoutError' });
    const { server, liberees, cles } = app({ envoiLeve: coupure });
    expect((await server.inject(envoi('repondre', REPONSE))).statusCode).toBe(500);
    expect(liberees).toEqual([]);
    expect(cles.size).toBe(1);
    const essai = await server.inject(envoi('repondre', REPONSE));
    expect(essai.statusCode).toBe(409);
    expect(essai.json<{ code: string }>().code).toBe('idempotency_key_in_progress');
    await server.close();
  });

  it('un scellement raté ne fait pas croire à un échec : le message est parti, la réponse le dit', async () => {
    const { server, envois } = app({ scellementLeve: true });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 'wamid.1', journal: 'recorded' });
    expect(envois).toHaveLength(1);
    await server.close();
  });

  describe('l’affectation (décision 6)', () => {
    it.each([
      ['une personne du portail sans compte', 'inconnu@exemple.fr', 403],
      ['un autre agent', 'alice@exemple.fr', 403],
      ['l’affectataire', 'bruno@exemple.fr', 200],
      ['un admin', 'admin@exemple.fr', 200],
      ['un admin désactivé', 'ancien@exemple.fr', 403],
    ])('conversation affectée, %s (%s) : %i', async (_cas, auteurEmail, statut) => {
      const { server, envois } = app({ assignee: U_AFFECTE });
      const res = await server.inject(envoi('repondre', { ...REPONSE, auteurEmail }));
      expect(res.statusCode).toBe(statut);
      if (statut === 403) expect(res.json<{ code: string }>().code).toBe('assigned_to_other');
      expect(envois).toHaveLength(statut === 200 ? 1 : 0);
      await server.close();
    });
  });

  describe('🔴 une clé, un message', () => {
    it('la même clé rejouée avec le même texte : UN envoi, et le second appel rend la réponse du premier', async () => {
      const { server, envois } = app();
      const a = await server.inject(envoi('repondre', REPONSE));
      const b = await server.inject(envoi('repondre', REPONSE));
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(b.json()).toEqual(a.json());
      expect(envois).toHaveLength(1);
      await server.close();
    });

    it('un second appel avec la même clé pendant que le premier envoie : « en cours » (409), UN envoi', async () => {
      let liberer!: () => void;
      const envoiRetenu = new Promise<void>((ok) => { liberer = ok; });
      const { server, envois } = app({ envoiRetenu });
      const premier = server.inject(envoi('repondre', REPONSE));
      // Le premier est retenu dans l'envoi, sa clé posée et pas encore scellée.
      await new Promise((ok) => setTimeout(ok, 50));
      const second = await server.inject(envoi('repondre', REPONSE));
      expect(second.statusCode).toBe(409);
      expect(second.json<{ code: string }>().code).toBe('idempotency_key_in_progress');
      liberer();
      expect((await premier).statusCode).toBe(200);
      expect(envois).toHaveLength(1);
      await server.close();
    });

    it('la même clé avec un autre texte : 422, rien ne part une seconde fois', async () => {
      const { server, envois } = app();
      await server.inject(envoi('repondre', REPONSE));
      const autre = await server.inject(envoi('repondre', { ...REPONSE, texte: 'Un autre message' }));
      expect(autre.statusCode).toBe(422);
      expect(autre.json<{ code: string }>().code).toBe('idempotency_key_reused');
      expect(envois).toHaveLength(1);
      await server.close();
    });
  });
});

describe('rendre la main', () => {
  it('le geste sous consentement, signé du membre ; une personne sans compte n’est personne, jamais une cause « automatique »', async () => {
    const { server, rendus } = app();
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenuPar: 'mba' });
    await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'inconnu@exemple.fr' }));
    expect(rendus).toEqual([{ collaborateur: U_AGENT }, { collaborateur: null }]);
    await server.close();
  });

  it('🔴 une conversation affectée à un autre : 403, rien n’est rendu', async () => {
    const { server, rendus } = app({ assignee: U_AFFECTE });
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr' }));
    expect(res.statusCode).toBe(403);
    expect(rendus).toEqual([]);
    await server.close();
  });

  it.each([
    ['un contact STOP ou bloqué', async () => 'contact_muet' as const, 'contact_muet'],
    ['aucun numéro', async () => 'aucun_numero' as const, 'no_number'],
    ['Meta qui garde le fil', async (): Promise<never> => { throw new AgentDeMetaGardeLeFil(); }, 'meta_refused'],
    ['Meta qui refuse', async (): Promise<never> => { throw new Error('Meta 500'); }, 'meta_refused'],
  ])('%s : 409 avec sa raison', async (_cas, rendre, code) => {
    const { server } = app({ rendre });
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: null }));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe(code);
    await server.close();
  });
});
