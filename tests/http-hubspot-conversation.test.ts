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
import type { ModeleRelu } from '../src/http/hubspot-modeles';
import type { TemplateSummary } from '../src/meta/templates';
import type { OutboundTemplate } from '../src/http/inbox';
import { NumeroDelieError } from '../src/meta/numero-delie';
import { LimiteOffreError } from '../src/offres/refus';

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
  /** Le plafond de réponses par personne (défaut : sans limite pratique). */
  plafond?: number;
  /** La racine de la console (`APP_URL`) : une instance sans https ne donne pas de lien à la carte. */
  console?: string;
  /** L'envoi attend cette promesse : un premier appel reste EN COURS pendant que le second se présente. */
  envoiRetenu?: Promise<void>;
  /** Le contact est bloqué (sous-lot « relancer », décision B). */
  bloque?: boolean;
  /** « Envoyer des modèles depuis HubSpot » (défaut : allumé). */
  modeles?: boolean;
  /** Le consentement de la fiche (défaut : inconnu, un contact né d'un message entrant). */
  optIn?: string;
  /** Les modèles de l'espace (défaut : `CATALOGUE`). */
  catalogue?: TemplateSummary[];
  /** Le modèle relu (défaut : d'après `CATALOGUE`, approuvé). */
  relu?: (name: string) => ModeleRelu;
  /** La préparation de l'en-tête : un `media id`, un échec (`null`), ou jamais finie. */
  entete?: 'ok' | 'echec' | 'jamais';
  /** L'envoi d'un modèle lève cette erreur. */
  envoiModeleLeve?: Error;
  /** Le plafond des modèles par personne (défaut : sans limite pratique). */
  plafondModeles?: number;
  /** La filière de l'espace (défaut : l'API). */
  filiere?: 'api' | 'application';
  /** La clé est reprise entre la pose et l'envoi (bail échu). */
  clePerdue?: boolean;
  /** Le contact devient bloqué après ce nombre de lectures du blocage (un blocage arrivé pendant l'envoi). */
  bloqueApres?: number;
  /** Le scellement de la clé échoue ce nombre de fois, puis réussit (une base qui hoquette). */
  scellementEchecs?: number;
}

/** Un modèle tel que Meta le rend : approuvé, sans en-tête. */
function tpl(name: string, category: 'MARKETING' | 'UTILITY', body: string, extra: Partial<TemplateSummary> = {}): TemplateSummary {
  return { id: name, name, status: 'APPROVED', category, language: 'fr', body, headerFormat: null, isCarousel: false, ...extra } as TemplateSummary;
}

const CATALOGUE: TemplateSummary[] = [
  tpl('suivi_devis', 'UTILITY', 'Bonjour {{1}}, votre devis {{2}} est prêt.'),
  tpl('offre_rentree', 'MARKETING', 'Bonjour {{1}}, découvrez notre offre.'),
  tpl('carrousel_produits', 'MARKETING', 'Nos produits', { isCarousel: true }),
  tpl('brouillon', 'UTILITY', 'Pas encore approuvé', { status: 'PENDING' }),
];

/** Le relu par défaut : d'après le catalogue (catégorie, nombre de variables), un en-tête image pour `suivi_devis`. */
function reluDe(catalogue: TemplateSummary[]) {
  return (name: string): ModeleRelu => {
    const t = catalogue.find((c) => c.name === name);
    if (!t || t.status !== 'APPROVED') return { verdict: { statut: 'absent' }, carrousel: false, entete: null };
    const variables = (t.body.match(/\{\{\d+\}\}/g) ?? []).length;
    return {
      verdict: { statut: 'approuve', categorie: t.category === 'MARKETING' ? 'marketing' : 'utility', variables },
      carrousel: t.isCarousel,
      entete: name === 'suivi_devis' ? { url: 'https://cdn.meta.example/visuel.jpg', format: 'IMAGE' } : null,
    };
  };
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
  const debits = new Map<string, number>();
  const modelesEnvoyes: Array<{ to: string; tpl: OutboundTemplate }> = [];
  const traceModeles: Array<{ body: string; origine: string; senderUserId: string | null | undefined }> = [];
  const preparations: string[] = [];
  const debitsModeles = new Map<string, number>();
  let lecturesBloque = 0;
  let echecsScellement = 0;
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
    repondre: { ...repondre, application: o.filiere === 'application' ? { ...filiereApiSeule, filiere: async () => 'application' } : filiereApiSeule },
    estBloque: async () => {
      lecturesBloque += 1;
      return o.bloque ?? (o.bloqueApres !== undefined && lecturesBloque > o.bloqueApres);
    },
    modeles: {
      branches: async () => o.modeles ?? true,
      catalogue: async () => o.catalogue ?? CATALOGUE,
      indices: async () => [{ name: 'suivi_devis', language: 'fr', position: 1, source: { type: 'attribute', key: 'name' } }],
      fiche: async () => ({ optIn: o.optIn ?? 'unknown', fiche: { profile_name: 'Julien', phone_e164: '+33600000001', fields: {} } }),
      lire: async (_t, name) => (o.relu ?? reluDe(o.catalogue ?? CATALOGUE))(name),
      preparerEntete: async (_t, url) => {
        preparations.push(url);
        if (o.entete === 'jamais') return new Promise<string | null>(() => { /* ne finit jamais */ });
        return o.entete === 'echec' ? null : 'media-123';
      },
      delaiEnteteMs: 50,
      envoi: {
        repo: repondre.repo,
        estDesabonne: repondre.estDesabonne,
        categorieDuModele: async () => 'utility',
        prepareCarousel: async () => null,
        sendTemplateMessage: async (_t, _pn, to, modele) => {
          if (o.envoiModeleLeve) throw o.envoiModeleLeve;
          if (o.envoiRetenu) await o.envoiRetenu;
          modelesEnvoyes.push({ to, tpl: modele });
          return `wamid.tpl.${modelesEnvoyes.length}`;
        },
        takeControl: async (_t, _w, par) => { prises.push(par); },
        inbox: { recordOutbound: async (_c, body, _m, origine, _t, _cat, _nom, senderUserId) => { traceModeles.push({ body, origine, senderUserId }); } },
      },
      plafond: {
        consommer: async (cle) => {
          const n = (debitsModeles.get(cle) ?? 0) + 1;
          debitsModeles.set(cle, n);
          const max = o.plafondModeles ?? 1000;
          return { accepte: n <= max, indisponible: false, limite: max, restant: Math.max(0, max - n), resetAt: NOW + 60_000, attenteMs: 60_000 };
        },
      },
    },
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
        if (echecsScellement < (o.scellementEchecs ?? 0)) { echecsScellement += 1; throw new Error('base qui hoquette'); }
        const l = cles.get(`${tenantId}|${key}`);
        if (!l || l.jeton !== jeton) return false;
        l.reponse = response;
        return true;
      },
      release: async (tenantId, key, jeton) => {
        const k = `${tenantId}|${key}`;
        if (cles.get(k)?.jeton === jeton) { cles.delete(k); liberees.push(key); }
      },
      possede: async (tenantId, key, jeton) => {
        if (o.clePerdue) return false;
        const l = cles.get(`${tenantId}|${key}`);
        return l?.jeton === jeton && l.reponse === undefined;
      },
    },
    fil: {
      rendreLaMainSousConsentement: o.rendre ?? (async (_t, _w, par) => { rendus.push(par); return 'mba'; }),
    },
    plafondReponses: {
      consommer: async (cle) => {
        const n = (debits.get(cle) ?? 0) + 1;
        debits.set(cle, n);
        const max = o.plafond ?? 1000;
        return { accepte: n <= max, indisponible: false, limite: max, restant: Math.max(0, max - n), resetAt: NOW + 60_000, attenteMs: 60_000 };
      },
    },
    lienConversation: (id) => `${o.console ?? 'https://console.exemple.fr'}/inbox?c=${id}`,
    now: () => NOW,
  };
  const server = buildServer({ queue: new FakeQueue(), hubspotConversation: deps });
  return { server, envois, traces, prises, lectures, rendus, cles, liberees, debits, modelesEnvoyes, traceModeles, preparations, debitsModeles };
}

/** Signe un corps comme le connecteur (même format canonique, même chemin). */
function envoi(route: 'fil' | 'repondre' | 'rendre' | 'modeles' | 'modele', body: unknown, secret = SECRET) {
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
      const res = await server.inject(envoi(route, route === 'repondre' ? REPONSE : { tenantId: T1, conversationId: C1, auteurEmail: null, ...(route === 'rendre' ? { cle: 'r1' } : {}) }));
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
      escaladeeLe: '2026-10-24T10:05:00.000Z', affecteA: { id: U_AFFECTE, nom: 'Bruno' }, contactDesabonne: false, contactBloque: false, peutRepondre: false,
      lien: `https://console.exemple.fr/inbox?c=${C1}`,
      messages: [
        { id: message(1).id, direction: 'in', type: 'text', texte: 'message 1', le: message(1).createdAt, auteur: null, statut: null },
        { id: message(2).id, direction: 'out', type: 'text', texte: 'message 2', le: message(2).createdAt, auteur: 'Alice', statut: null },
      ],
      avant: null,
    });
    // L'affectataire, reconnu par son adresse quelle que soit la casse, peut répondre.
    const lui = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: 'bruno@exemple.fr' }));
    expect(lui.json<{ peutRepondre: boolean }>().peutRepondre).toBe(true);
    await server.close();
  });

  it('lot 3 : le lien « Ouvrir dans la console » ne part que s’il est en https', async () => {
    const { server } = app({ console: 'http://localhost:3000' });
    const res = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: null }));
    expect(res.json<{ lien: unknown }>().lien).toBeNull();
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
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr', cle: 'r1' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenuPar: 'mba' });
    await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'inconnu@exemple.fr', cle: 'r2' }));
    expect(rendus).toEqual([{ collaborateur: U_AGENT }, { collaborateur: null }]);
    await server.close();
  });

  it('🔴 une conversation affectée à un autre : 403, rien n’est rendu', async () => {
    const { server, rendus } = app({ assignee: U_AFFECTE });
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr', cle: 'r1' }));
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
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: null, cle: 'r1' }));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe(code);
    await server.close();
  });
});

describe('lot 3 : les prérequis avant d’allumer la carte', () => {
  it('🔴 le plafond par personne : au-delà, 429 avec son code, RIEN ne part et rien n’est réservé', async () => {
    const { server, envois, cles } = app({ plafond: 2 });
    const statuts: number[] = [];
    for (let i = 1; i <= 3; i += 1) statuts.push((await server.inject(envoi('repondre', { ...REPONSE, cle: `carte-${i}` }))).statusCode);
    expect(statuts).toEqual([200, 200, 429]);
    const refus = await server.inject(envoi('repondre', { ...REPONSE, cle: 'carte-4' }));
    expect(refus.json<{ code: string }>().code).toBe('rate_limited');
    expect(refus.headers['retry-after']).toBeDefined();
    expect(envois).toHaveLength(2);
    expect([...cles.keys()].some((k) => k.endsWith('carte-3') || k.endsWith('carte-4'))).toBe(false);
    await server.close();
  });

  it('le plafond est compté PAR PERSONNE, sous l’empreinte de son adresse, jamais l’adresse en clair', async () => {
    const { server, envois, debits } = app({ plafond: 1 });
    expect((await server.inject(envoi('repondre', { ...REPONSE, cle: 'a1' }))).statusCode).toBe(200);
    expect((await server.inject(envoi('repondre', { ...REPONSE, auteurEmail: 'admin@exemple.fr', cle: 'b1' }))).statusCode).toBe(200);
    expect(envois).toHaveLength(2);
    const cleesDuCompteur = [...debits.keys()];
    expect(cleesDuCompteur).toHaveLength(2);
    expect(cleesDuCompteur.every((k) => k.startsWith(`${T1}:`) && !k.includes('@'))).toBe(true);
    await server.close();
  });

  it('🔴 « rendre » rejoué avec la même clé : la main n’est rendue qu’UNE fois, le second appel rend la même réponse', async () => {
    const { server, rendus } = app();
    const corps = { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr', cle: 'rendre-1' };
    const a = await server.inject(envoi('rendre', corps));
    const b = await server.inject(envoi('rendre', corps));
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.json()).toEqual(a.json());
    expect(rendus).toHaveLength(1);
    await server.close();
  });

  it('la même clé de « rendre » pour une autre personne : 422, rien n’est rendu une seconde fois', async () => {
    const { server, rendus } = app();
    await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr', cle: 'rendre-1' }));
    const autre = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: 'admin@exemple.fr', cle: 'rendre-1' }));
    expect(autre.statusCode).toBe(422);
    expect(rendus).toHaveLength(1);
    await server.close();
  });

  it('🔴 un « rendre » qui n’a rien changé (contact muet) rend sa clé : le même geste peut être retenté', async () => {
    const { server, liberees, cles } = app({ rendre: async () => 'contact_muet' as const });
    const res = await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: null, cle: 'rendre-2' }));
    expect(res.statusCode).toBe(409);
    expect(liberees).toEqual(['hubspot-rendre:rendre-2']);
    expect(cles.size).toBe(0);
    await server.close();
  });

  it('🟡 un « rendre » rejoué pendant que le premier attend Meta : « en cours » (409), la main n’est rendue qu’une fois', async () => {
    let liberer!: () => void;
    const retenu = new Promise<void>((ok) => { liberer = ok; });
    let n = 0;
    const { server } = app({ rendre: async () => { n += 1; await retenu; return 'mba' as const; } });
    const corps = { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr', cle: 'rendre-3' };
    const premier = server.inject(envoi('rendre', corps));
    await new Promise((ok) => setTimeout(ok, 50));
    const second = await server.inject(envoi('rendre', corps));
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('idempotency_key_in_progress');
    liberer();
    expect((await premier).statusCode).toBe(200);
    expect(n).toBe(1);
    await server.close();
  });

  it('« rendre » sans clé : 400, rien n’est rendu', async () => {
    const { server, rendus } = app();
    expect((await server.inject(envoi('rendre', { tenantId: T1, conversationId: C1, auteurEmail: null }))).statusCode).toBe(400);
    expect(rendus).toEqual([]);
    await server.close();
  });
});

describe('le contact bloqué et le numéro délié (sous-lot « relancer », décisions B et H)', () => {
  it('🔴 un contact BLOQUÉ ne reçoit pas de réponse : 409 contact_bloque, rien ne part, aucune clé ; le fil le dit', async () => {
    const { server, envois, cles } = app({ bloque: true });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('contact_bloque');
    expect([envois, cles.size]).toEqual([[], 0]);
    const fil = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr' }));
    expect(fil.json()).toMatchObject({ contactBloque: true, peutRepondre: false });
    await server.close();
  });

  it('🔴 un numéro délié (levé AVANT Meta) rend la clé avec son code, au lieu de la laisser « en cours » cinq minutes', async () => {
    const { server, liberees } = app({ envoiLeve: new NumeroDelieError('pn1') });
    const res = await server.inject(envoi('repondre', REPONSE));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('number_unlinked');
    expect(liberees).toEqual(['hubspot:carte-1']);
    await server.close();
  });
});

const BASE_MODELE = { tenantId: T1, conversationId: C1, auteurEmail: 'alice@exemple.fr' };
const SERVICE = { ...BASE_MODELE, name: 'suivi_devis', language: 'fr', valeurs: ['Julien', 'D-42'], cle: 'modele-1' };
const MARKETING = { ...BASE_MODELE, name: 'offre_rentree', language: 'fr', valeurs: ['Julien'], cle: 'modele-2' };

describe('les modèles de la carte : la porte (sous-lot « relancer »)', () => {
  it.each(['modeles', 'modele'] as const)('🔴 %s : signature absente, 401, rien n’est lu ni envoyé', async (route) => {
    const { server, modelesEnvoyes, lectures } = app();
    const res = await server.inject({ method: 'POST', url: `/hubspot/conversation/${route}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(SERVICE) });
    expect(res.statusCode).toBe(401);
    expect([modelesEnvoyes, lectures]).toEqual([[], []]);
    await server.close();
  });

  it('🔴 « Envoyer des modèles depuis HubSpot » éteint : 403 sur la liste et l’envoi, rien ne part (décision E)', async () => {
    const { server, modelesEnvoyes } = app({ modeles: false });
    for (const [route, corps] of [['modeles', BASE_MODELE], ['modele', SERVICE]] as const) {
      const res = await server.inject(envoi(route, corps));
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('modeles_hubspot_eteints');
    }
    expect(modelesEnvoyes).toEqual([]);
    await server.close();
  });

  it('« Répondre depuis HubSpot » éteint passe AVANT : 403 reponse_hubspot_eteinte', async () => {
    const { server } = app({ reponse: false });
    expect((await server.inject(envoi('modele', SERVICE))).json<{ code: string }>().code).toBe('reponse_hubspot_eteinte');
    await server.close();
  });

  it('🔴 isolation : la conversation d’un autre espace, 404, rien ne part', async () => {
    const { server, modelesEnvoyes } = app();
    expect((await server.inject(envoi('modele', { ...SERVICE, tenantId: T2 }))).statusCode).toBe(404);
    expect(modelesEnvoyes).toEqual([]);
    await server.close();
  });

  it('🔴 STOP, bloqué, affectée à un autre, filière application : refusés sur la liste ET l’envoi, rien ne part', async () => {
    const cas: Array<[Options, number, string]> = [
      [{ desabonne: true }, 409, 'contact_desabonne'],
      [{ bloque: true }, 409, 'contact_bloque'],
      [{ assignee: U_AFFECTE }, 403, 'assigned_to_other'],
      [{ filiere: 'application' }, 409, 'whatsapp_app_no_template'],
    ];
    for (const [o, statut, code] of cas) {
      const { server, modelesEnvoyes, cles } = app(o);
      for (const [route, corps] of [['modeles', BASE_MODELE], ['modele', SERVICE]] as const) {
        const res = await server.inject(envoi(route, corps));
        expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([statut, code]);
      }
      expect([modelesEnvoyes, cles.size]).toEqual([[], 0]);
      await server.close();
    }
  });
});

describe('les modèles de la carte : la liste', () => {
  it('le catalogue sans carrousel ni modèle non approuvé, le marketing grisé pour un contact sans accord, les valeurs pré-remplies', async () => {
    const { server } = app();
    const res = await server.inject(envoi('modeles', BASE_MODELE));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      modeles: [
        {
          name: 'offre_rentree', language: 'fr', category: 'marketing', header: 'none', texte: 'Bonjour {{1}}, découvrez notre offre.',
          variables: [{ position: 1, valeur: '', libelle: '' }],
          envoyable: false, raison: 'Ce contact n’a pas donné son accord pour recevoir des messages marketing : seuls les modèles Service partent depuis HubSpot.',
        },
        {
          name: 'suivi_devis', language: 'fr', category: 'utility', header: 'none', texte: 'Bonjour {{1}}, votre devis {{2}} est prêt.',
          variables: [{ position: 1, valeur: 'Julien', libelle: 'name' }, { position: 2, valeur: '', libelle: '' }],
          envoyable: true, raison: null,
        },
      ],
    });
    await server.close();
  });

  it('un contact qui a donné son accord : le marketing peut partir', async () => {
    const { server } = app({ optIn: 'opted_in' });
    const res = await server.inject(envoi('modeles', BASE_MODELE));
    expect(res.json<{ modeles: Array<{ name: string; envoyable: boolean }> }>().modeles.every((m) => m.envoyable)).toBe(true);
    await server.close();
  });
});

describe('les modèles de la carte : l’envoi', () => {
  it('🔴 un Service part à un contact au consentement inconnu, par le chemin de l’Inbox : en-tête en media id, catégorie lue chez Meta, fil pris, signé du membre', async () => {
    const { server, modelesEnvoyes, traceModeles, prises, preparations } = app();
    const res = await server.inject(envoi('modele', SERVICE));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ messageId: 'wamid.tpl.1' });
    expect(preparations).toEqual(['https://cdn.meta.example/visuel.jpg']);
    expect(modelesEnvoyes).toEqual([{
      to: '33600000001',
      tpl: { name: 'suivi_devis', language: 'fr', bodyParams: ['Julien', 'D-42'], templateCategory: 'utility', headerMediaId: 'media-123', headerFormat: 'IMAGE' },
    }]);
    // Jamais l'URL du CDN de Meta (invariant 9).
    expect(modelesEnvoyes[0]?.tpl.headerMediaUrl).toBeUndefined();
    expect(traceModeles).toEqual([{ body: '[template] suivi_devis', origine: 'humain', senderUserId: U_AGENT }]);
    expect(prises).toEqual([{ collaborateur: U_AGENT }]);
    await server.close();
  });

  it('🔴 un Marketing vers un contact sans accord : 409 no_consent, rien ne part, ni clé ni préparation (décision C)', async () => {
    const { server, modelesEnvoyes, cles, preparations } = app();
    const res = await server.inject(envoi('modele', MARKETING));
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'no_consent']);
    expect([modelesEnvoyes, cles.size, preparations]).toEqual([[], 0, []]);
    await server.close();
  });

  it('un Marketing vers un contact qui a donné son accord part en catégorie marketing (la Marketing Messages API)', async () => {
    const { server, modelesEnvoyes } = app({ optIn: 'opted_in' });
    expect((await server.inject(envoi('modele', MARKETING))).statusCode).toBe(200);
    expect(modelesEnvoyes[0]?.tpl.templateCategory).toBe('marketing');
    await server.close();
  });

  it('🔴 la carte ne déclare pas la catégorie (champ de trop, 400) ; une valeur à retour à la ligne est refusée, codée (132018)', async () => {
    const { server, modelesEnvoyes, cles } = app();
    expect((await server.inject(envoi('modele', { ...MARKETING, templateCategory: 'utility' }))).statusCode).toBe(400);
    // Une valeur pré-remplie de la fiche peut la porter : un refus CODÉ, que le connecteur transmet et que la carte montre.
    const valeur = await server.inject(envoi('modele', { ...SERVICE, valeurs: ['Julien', 'ligne\nsuivante'] }));
    expect([valeur.statusCode, valeur.json<{ code: string }>().code]).toEqual([422, 'invalid_value']);
    expect(valeur.json<{ error: string }>().error).toContain('{{2}}');
    expect([modelesEnvoyes, cles.size]).toEqual([[], 0]);
    await server.close();
  });

  it('🔴 un contact bloqué PENDANT l’envoi (après les premières gardes) : rien ne part, la clé est rendue (décision B)', async () => {
    const { server, modelesEnvoyes, liberees } = app({ bloqueApres: 1 });
    const res = await server.inject(envoi('modele', SERVICE));
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'contact_bloque']);
    expect(modelesEnvoyes).toEqual([]);
    expect(liberees).toEqual(['hubspot-modele:modele-1']);
    await server.close();
  });

  it('modèle absent, carrousel, mauvais nombre de valeurs : refusés avant la clé, chacun avec son code', async () => {
    const { server, modelesEnvoyes, cles } = app();
    const cas: Array<[unknown, number, string]> = [
      [{ ...SERVICE, name: 'inconnu' }, 404, 'template_not_found'],
      [{ ...SERVICE, name: 'brouillon', valeurs: [] }, 404, 'template_not_found'],
      [{ ...SERVICE, name: 'carrousel_produits', valeurs: [] }, 422, 'carousel_unsupported'],
      [{ ...SERVICE, valeurs: ['Julien'] }, 422, 'unsendable_target'],
    ];
    for (const [corps, statut, code] of cas) {
      const res = await server.inject(envoi('modele', corps));
      expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([statut, code]);
    }
    expect([modelesEnvoyes, cles.size]).toEqual([[], 0]);
    await server.close();
  });

  it('🔴 la même clé envoie UNE fois : le second appel rend la réponse du premier', async () => {
    const { server, modelesEnvoyes } = app();
    const premier = await server.inject(envoi('modele', SERVICE));
    const second = await server.inject(envoi('modele', SERVICE));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(premier.json());
    expect(modelesEnvoyes).toHaveLength(1);
    await server.close();
  });

  it('🔴 une clé reprise entre la pose et l’envoi (bail échu) : rien ne part, 409 en cours', async () => {
    const { server, modelesEnvoyes } = app({ clePerdue: true });
    const res = await server.inject(envoi('modele', SERVICE));
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'idempotency_key_in_progress']);
    expect(modelesEnvoyes).toEqual([]);
    await server.close();
  });

  it('🔴 un en-tête qui traîne : refusé à la borne, AVANT la clé, rien ne part (le rouge de la relecture du plan)', async () => {
    const { server, modelesEnvoyes, cles } = app({ entete: 'jamais' });
    const res = await server.inject(envoi('modele', SERVICE));
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([422, 'header_media_slow']);
    expect([modelesEnvoyes, cles.size]).toEqual([[], 0]);
    await server.close();
    const echec = app({ entete: 'echec' });
    const r2 = await echec.server.inject(envoi('modele', SERVICE));
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([422, 'header_media_unavailable']);
    expect(echec.modelesEnvoyes).toEqual([]);
    await echec.server.close();
  });

  it('🔴 un refus levé avant Meta (numéro délié, limite du mois) rend la clé avec son code ; une coupure la garde', async () => {
    const delie = app({ envoiModeleLeve: new NumeroDelieError('pn1') });
    const r1 = await delie.server.inject(envoi('modele', SERVICE));
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([409, 'number_unlinked']);
    expect(delie.liberees).toEqual(['hubspot-modele:modele-1']);
    await delie.server.close();

    const limite = app({ envoiModeleLeve: new LimiteOffreError(T1, 'envoisModelesMois', 1000) });
    const r2 = await limite.server.inject(envoi('modele', SERVICE));
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([402, 'plan_limit_reached']);
    expect(limite.liberees).toEqual(['hubspot-modele:modele-1']);
    await limite.server.close();

    const coupure = app({ envoiModeleLeve: new Error('réseau coupé') });
    expect((await coupure.server.inject(envoi('modele', SERVICE))).statusCode).toBe(500);
    expect(coupure.liberees).toEqual([]);
    expect(coupure.cles.size).toBe(1);
    await coupure.server.close();
  });

  it('le plafond des modèles est à part de celui des réponses (décision D)', async () => {
    const { server, modelesEnvoyes, envois } = app({ plafondModeles: 1 });
    expect((await server.inject(envoi('modele', SERVICE))).statusCode).toBe(200);
    const trop = await server.inject(envoi('modele', { ...SERVICE, cle: 'modele-3' }));
    expect(trop.statusCode).toBe(429);
    expect(modelesEnvoyes).toHaveLength(1);
    expect((await server.inject(envoi('repondre', REPONSE))).statusCode).toBe(200);
    expect(envois).toHaveLength(1);
    await server.close();
  });

  it('une personne sans compte écrit à une conversation non affectée, son modèle n’est signé de personne', async () => {
    const { server, traceModeles } = app();
    expect((await server.inject(envoi('modele', { ...SERVICE, auteurEmail: 'inconnu@portail.fr' }))).statusCode).toBe(200);
    expect(traceModeles[0]?.senderUserId).toBeNull();
    await server.close();
  });

  it('les deux routes se rangent avec l’Inbox dans l’audit de latence', () => {
    for (const route of ['modeles', 'modele']) expect(groupeDeRoute(`${PREFIXE_CONVERSATION_HUBSPOT}${route}`)).toBe('inbox');
  });
});

describe('sous-lot « relancer » : les jaunes de la relecture du lot', () => {
  it('🔴 le rejeu d’un modèle déjà parti rend sa réponse sans compter dans le plafond ; un refus pour le débit rend la clé', async () => {
    const { server, modelesEnvoyes, liberees } = app({ plafondModeles: 1 });
    const premier = await server.inject(envoi('modele', SERVICE));
    expect(premier.statusCode).toBe(200);
    // Le rejeu (même clé, un 504 côté connecteur) : la réponse du premier envoi, pas un 429.
    const rejeu = await server.inject(envoi('modele', SERVICE));
    expect([rejeu.statusCode, rejeu.json()]).toEqual([200, premier.json()]);
    const autre = await server.inject(envoi('modele', { ...SERVICE, cle: 'modele-9' }));
    expect(autre.statusCode).toBe(429);
    expect(liberees).toEqual(['hubspot-modele:modele-9']);
    expect(modelesEnvoyes).toHaveLength(1);
    await server.close();
  });

  it('🔴 un scellement qui échoue une fois est réessayé : la clé est scellée, le rejeu rend la réponse du premier envoi', async () => {
    const { server, modelesEnvoyes, envois } = app({ scellementEchecs: 1 });
    const res = await server.inject(envoi('modele', SERVICE));
    expect(res.statusCode).toBe(200);
    expect((await server.inject(envoi('modele', SERVICE))).json()).toEqual(res.json());
    expect(modelesEnvoyes).toHaveLength(1);
    await server.close();
    // La réponse texte passe par le même scellement.
    const r = app({ scellementEchecs: 2 });
    const rep1 = await r.server.inject(envoi('repondre', REPONSE));
    expect((await r.server.inject(envoi('repondre', REPONSE))).json()).toEqual(rep1.json());
    expect(r.envois).toHaveLength(1);
    expect(envois).toHaveLength(0);
    await r.server.close();
  });

  it('le fil rend le statut de Meta : un modèle non délivré se lit « failed »', async () => {
    const echoue: ConversationMessage = { ...message(2), type: 'template', body: '[template] suivi_devis', statut: 'failed' };
    const { server } = app({ messages: [message(1), echoue] });
    const res = await server.inject(envoi('fil', { tenantId: T1, conversationId: C1, auteurEmail: null }));
    expect(res.json<{ messages: Array<{ statut: string | null }> }>().messages.map((m) => m.statut)).toEqual([null, 'failed']);
    await server.close();
  });
});
