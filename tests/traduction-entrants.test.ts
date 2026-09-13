import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { InboxRouteDeps } from '../src/http/inbox';
import type { ConversationMessage } from '../src/inbox/store.pg';
import { traduireFil, candidats, texteATraduire, type DepsFil, type MessageATraduire } from '../src/traduction/fil';
import { TRADUCTIONS_MAX_PAR_REQUETE, type Traducteur, type Traduction } from '../src/traduction/traduire';

/**
 * LES ENTRANTS, TRADUITS A L'OUVERTURE D'UNE CONVERSATION.
 *
 * 🔴 CE QUE CE FICHIER GARDE, et ce n'est pas « la traduction est bonne » (invérifiable et sans
 * intérêt) : QUI est traduit (les entrants, jamais les sortants), COMBIEN de fois on paie (une, la
 * première), et les TROIS ETATS que l'écran doit pouvoir distinguer, dont les deux derniers se
 * ressemblent et ne veulent pas dire la même chose.
 */

/** Un message de fil, minimal. `in` par défaut : c'est le seul sens qui se traduit. */
function msg(over: Partial<MessageATraduire> & { id: string }): MessageATraduire {
  return { direction: 'in', type: 'text', body: 'Hola', ...over };
}

/** Un traducteur de test : il compte ses appels et rend ce qu'on lui dit. */
function faux(opts: {
  reponses?: (textes: Array<{ id: string; texte: string }>) => Array<[string, Traduction]>;
  disponible?: boolean;
} = {}) {
  const appels: Array<{ tenantId: string; textes: Array<{ id: string; texte: string }>; cible: string }> = [];
  const traducteur: Traducteur = {
    disponible: async () => opts.disponible ?? true,
    traduireLot: async (tenantId, textes, cible) => {
      appels.push({ tenantId, textes: textes.map((t) => ({ ...t })), cible });
      const paires = opts.reponses
        ? opts.reponses(textes)
        : textes.map((t): [string, Traduction] => [t.id, { texte: `[${cible}] ${t.texte}`, langueSource: 'es' }]);
      return new Map(paires);
    },
    traduire: async () => null,
  };
  const ranges: Array<{ messageId: string; texte: string; langue: string }> = [];
  const languesApprises: string[] = [];
  const deps: DepsFil = {
    traducteur,
    ranger: async (_t, _c, trads) => { ranges.push(...trads); },
    apprendreLangueContact: async (_t, _c, langue) => { languesApprises.push(langue); },
  };
  return { deps, appels, ranges, languesApprises };
}

const OU = { tenantId: 't1', conversationId: 'c1' };

describe('traduction du fil : qui est traduit, et combien de fois on paie', () => {
  it('traduit un entrant et range le resultat', async () => {
    const f = faux();
    const r = await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1', body: 'Hola' })], cible: 'fr' });
    expect(r.messages[0]!.affiche).toBe('[fr] Hola');
    expect(r.messages[0]!.traduit).toBe(true);
    expect(r.messages[0]!.traductionEchouee).toBe(false);
    expect(f.ranges).toEqual([{ messageId: 'm1', texte: '[fr] Hola', langue: 'fr' }]);
  });

  it('ne retraduit pas ce qui est deja traduit dans la bonne langue', async () => {
    // 🔴 Le premier lecteur paie, les suivants lisent. Sans ce test, on paie a chaque ouverture, et
    // le fil se rouvre des dizaines de fois par jour.
    const f = faux();
    const r = await traduireFil(f.deps, {
      ...OU,
      messages: [msg({ id: 'm1', body: 'Hola', traduction: 'Bonjour', traductionLangue: 'fr' })],
      cible: 'fr',
    });
    expect(f.appels).toHaveLength(0);
    expect(r.messages[0]!.affiche).toBe('Bonjour');
    expect(r.messages[0]!.traduit).toBe(true);
  });

  it('retraduit quand la langue demandee differe de celle rangee', async () => {
    // Fil deja traduit en 'fr', un collegue anglophone l'ouvre : il lui faut du 'en'. La langue de
    // lecture vient du NAVIGATEUR, pas du compte : deux personnes lisent le meme fil autrement.
    const f = faux();
    const r = await traduireFil(f.deps, {
      ...OU,
      messages: [msg({ id: 'm1', body: 'Hola', traduction: 'Bonjour', traductionLangue: 'fr' })],
      cible: 'en',
    });
    expect(f.appels).toHaveLength(1);
    expect(r.messages[0]!.affiche).toBe('[en] Hola');
    // Et ce qui est RANGE est bien la nouvelle langue : ranger 'Hello' en disant 'fr' ferait
    // afficher de l'anglais au lecteur francophone suivant, sans jamais se corriger.
    expect(f.ranges[0]!.langue).toBe('en');
  });

  it('🔴 un SORTANT ne se traduit jamais, et s affiche avec ce que l operateur a ecrit', async () => {
    // Il n'y a rien a traduire (c'est deja notre langue) et aucun appel a payer. `body` porte ce qui
    // est PARTI, donc le traduit : l'afficher rendrait l'operateur aveugle a sa propre conversation.
    const f = faux();
    const r = await traduireFil(f.deps, {
      ...OU,
      messages: [msg({
        id: 'm1', direction: 'out', body: 'Hello, how can I help?', redactionOrigine: 'Bonjour, comment puis-je aider ?',
      })],
      cible: 'fr',
    });
    expect(f.appels).toHaveLength(0);
    expect(r.messages[0]!.affiche).toBe('Bonjour, comment puis-je aider ?');
    expect(r.messages[0]!.traduit).toBe(false);
  });

  it('un sortant SANS redaction d origine s affiche avec son body', async () => {
    // Le cas de tous les messages d'avant ce lot, et de tous ceux qui n'ont pas ete traduits.
    const f = faux();
    const r = await traduireFil(f.deps, {
      ...OU,
      messages: [msg({ id: 'm1', direction: 'out', body: 'Bonjour', redactionOrigine: null })],
      cible: 'fr',
    });
    expect(r.messages[0]!.affiche).toBe('Bonjour');
  });

  it('une traduction qui echoue rend l ORIGINAL, pas une bulle vide ni une erreur', async () => {
    const f = faux({ reponses: () => [] });
    const r = await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1', body: 'Hola' })], cible: 'fr' });
    expect(r.messages[0]!.affiche).toBe('Hola');
    expect(r.messages[0]!.traductionEchouee).toBe(true);
    expect(r.indisponible).toBe(false);
  });

  it('🔴 « jamais tente » n est PAS « a echoue »', async () => {
    // LE piege de l'ecran. Au-dela du plafond, rien n'a ete demande : dire « la traduction a rate »
    // ferait chercher une panne, et personne ne comprendrait pourquoi elle ne revient pas au
    // rechargement. Les deux drapeaux sont donc faux, et l'original s'affiche.
    const f = faux();
    const messages = Array.from({ length: TRADUCTIONS_MAX_PAR_REQUETE + 3 }, (_, i) => msg({ id: `m${i}`, body: `Hola ${i}` }));
    const r = await traduireFil(f.deps, { ...OU, messages, cible: 'fr' });
    // Le plafond mord sur le HAUT du fil : les plus anciens ne sont pas traduits.
    const premier = r.messages[0]!;
    expect(premier.traduit).toBe(false);
    expect(premier.traductionEchouee).toBe(false);
    expect(premier.affiche).toBe('Hola 0');
    // ...et les plus RECENTS, ceux que l'operateur lit, le sont.
    const dernier = r.messages[r.messages.length - 1]!;
    expect(dernier.traduit).toBe(true);
    expect(f.appels[0]!.textes).toHaveLength(TRADUCTIONS_MAX_PAR_REQUETE);
  });

  it('un espace sans cle de modele rend le fil en VO, avec son drapeau, sans rien appeler', async () => {
    const f = faux({ disponible: false });
    const r = await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1', body: 'Hola' })], cible: 'fr' });
    expect(r.indisponible).toBe(true);
    expect(f.appels).toHaveLength(0);
    expect(r.messages[0]!.affiche).toBe('Hola');
    expect(r.messages[0]!.traductionEchouee).toBe(false);
  });

  it('un espace sans cle affiche quand meme les traductions DEJA rangees', async () => {
    // Elles sont payees depuis longtemps : les cacher parce que le credit est epuise aujourd'hui
    // ferait disparaitre de l'ecran une lecture qui existe en base.
    const f = faux({ disponible: false });
    const r = await traduireFil(f.deps, {
      ...OU,
      messages: [msg({ id: 'm1', body: 'Hola', traduction: 'Bonjour', traductionLangue: 'fr' })],
      cible: 'fr',
    });
    expect(r.messages[0]!.affiche).toBe('Bonjour');
    expect(r.messages[0]!.traduit).toBe(true);
  });

  it('un echec de rangement ne prive pas l operateur de sa lecture, mais il se SIGNALE', async () => {
    const f = faux();
    const vus: string[] = [];
    const deps: DepsFil = {
      ...f.deps,
      ranger: async () => { throw new Error('base indisponible'); },
      onErreur: (_err, quoi) => { vus.push(quoi); },
    };
    const r = await traduireFil(deps, { ...OU, messages: [msg({ id: 'm1' })], cible: 'fr' });
    expect(r.messages[0]!.traduit).toBe(true);
    // Ce qui se perd est la REUTILISATION, donc de l'argent au prochain chargement : ca se dit.
    expect(vus).toEqual(['traduction_rangement']);
  });
});

describe('traduction du fil : la langue du contact s apprend', () => {
  it('elle vient du message le plus RECENT qu on vient de traduire', async () => {
    // Quelqu'un peut changer de langue en cours de conversation : c'est la derniere qui vaut.
    const f = faux({
      reponses: (textes) => textes.map((t) => [t.id, { texte: 'x', langueSource: t.id === 'm2' ? 'pt' : 'es' }]),
    });
    await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1' }), msg({ id: 'm2' })], cible: 'fr' });
    expect(f.languesApprises).toEqual(['pt']);
  });

  it('une langue source absente n ecrit rien plutot que de supposer', async () => {
    // `null` n'est pas « francais » : supposer ferait ensuite envoyer la mauvaise langue en silence,
    // et le bouton de traduction sortante nommerait une cible fausse.
    const f = faux({ reponses: (textes) => textes.map((t) => [t.id, { texte: 'x', langueSource: null }]) });
    await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1' })], cible: 'fr' });
    expect(f.languesApprises).toEqual([]);
  });

  it('elle n est ecrite qu UNE fois par ouverture, pas une par message', async () => {
    const f = faux();
    await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1' }), msg({ id: 'm2' }), msg({ id: 'm3' })], cible: 'fr' });
    expect(f.languesApprises).toEqual(['es']);
  });
});

describe('ce qu on envoie au modele : le texte, et pas le libelle d un media', () => {
  it('🔴 la source d un vocal est sa TRANSCRIPTION, jamais son body', () => {
    // `body` vaut `[audio]` ou la legende : le traduire ne produirait rien, et couterait un appel.
    expect(texteATraduire({ id: 'm', direction: 'in', body: '[audio]', transcription: 'Hola, tengo un problema' }))
      .toBe('Hola, tengo un problema');
  });

  it('un media SANS transcription n a rien a traduire, et ce n est pas un echec', () => {
    expect(texteATraduire({ id: 'm', direction: 'in', body: '[audio]' })).toBeNull();
    expect(texteATraduire({ id: 'm', direction: 'in', body: '[image]' })).toBeNull();
    expect(texteATraduire({ id: 'm', direction: 'in', body: '[formulaire]' })).toBeNull();
  });

  it('la legende d une image, elle, se traduit', () => {
    // Le sens inverse : une garde qui ecarterait tous les medias ferait perdre les legendes, qui
    // sont du texte ecrit par le client comme un autre.
    expect(texteATraduire({ id: 'm', direction: 'in', body: 'Mira esta foto' })).toBe('Mira esta foto');
  });

  it('un corps vide n a rien a traduire', () => {
    expect(texteATraduire({ id: 'm', direction: 'in', body: '   ' })).toBeNull();
    expect(texteATraduire({ id: 'm', direction: 'in', body: null })).toBeNull();
  });

  it('un vocal non transcrit n entre pas dans le lot', async () => {
    const f = faux();
    await traduireFil(f.deps, { ...OU, messages: [msg({ id: 'm1', type: 'audio', body: '[audio]' })], cible: 'fr' });
    expect(f.appels).toHaveLength(0);
  });

  it('les candidats sont les plus RECENTS, dans l ordre du fil', () => {
    const messages = [msg({ id: 'a' }), msg({ id: 'b', direction: 'out' }), msg({ id: 'c' })];
    expect(candidats(messages, 'fr').map((m) => m.id)).toEqual(['a', 'c']);
  });
});

/**
 * LA ROUTE, parce que les trois etats doivent sortir JUSQU'AU navigateur.
 *
 * ⚠️ Le module ci-dessus peut etre parfait et la route ne rien en rendre : c'est exactement ce qui
 * arrive quand un champ est calcule puis oublie dans le `send`.
 */
const SECRET = 'test-secret';
let token = '';
beforeAll(async () => { token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

function app(over: Partial<InboxRouteDeps> = {}) {
  const deps: InboxRouteDeps = {
    listConversations: async () => [],
    getConversationContext: async (id) => (id === 'c1'
      ? { waId: '33611', windowOpen: true, lastInboundAt: '2026-09-12T00:00:00.000Z', langueContact: 'es' }
      : null),
    getMessages: async (): Promise<ConversationMessage[]> => [
      { id: 'm1', direction: 'in', type: 'text', body: 'Hola', buttonPayload: null, createdAt: '2026-09-12T00:00:00.000Z' },
    ],
    recordOutbound: async () => {},
    getTenantPhoneNumberId: async () => 'pn1',
    sendReply: async () => 'wamid.OUT',
    sendTemplateMessage: async () => 'wamid.TPL',
    ...over,
  };
  return buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, inbox: deps });
}

describe('GET /messages?traduire= : ce que la route rend', () => {
  it('sans `traduire`, la reponse est celle d avant ce lot (aucun champ de traduction)', async () => {
    // Le rayon de souffle de ce lot, tenu par un test : tout ce qui lit cette route et ne sait rien
    // de la traduction doit continuer a voir exactement la meme chose.
    let appele = false;
    const a = app({ traduireFil: async () => { appele = true; throw new Error('jamais'); } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ messages: Array<Record<string, unknown>>; traductionIndisponible?: boolean }>();
    expect(appele).toBe(false);
    expect(body.traductionIndisponible).toBeUndefined();
    expect(body.messages[0]!['affiche']).toBeUndefined();
    await a.close();
  });

  it('avec `traduire=fr`, les trois etats sortent jusqu au navigateur', async () => {
    const a = app({
      traduireFil: async (_t, _c, messages) => ({
        indisponible: false,
        messages: messages.map((m) => ({ ...m, affiche: 'Bonjour', traduit: true, traductionEchouee: false })),
      }),
    });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages?traduire=fr', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ messages: Array<{ affiche: string; traduit: boolean; traductionEchouee: boolean }>; traductionIndisponible: boolean; langueContact: string }>();
    expect(body.messages[0]).toMatchObject({ affiche: 'Bonjour', traduit: true, traductionEchouee: false });
    expect(body.traductionIndisponible).toBe(false);
    // La langue APPRISE du contact : c'est elle qui permettra au bouton sortant de nommer sa cible.
    expect(body.langueContact).toBe('es');
    await a.close();
  });

  it('une langue inconnue est IGNOREE, le fil sort en VO sans erreur', async () => {
    // Un parametre mal forme ne doit jamais casser l'ecran le plus utilise du produit.
    let appele = false;
    const a = app({ traduireFil: async () => { appele = true; throw new Error('jamais'); } });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages?traduire=es', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(appele).toBe(false);
    expect(res.json<{ traductionIndisponible?: boolean }>().traductionIndisponible).toBeUndefined();
    await a.close();
  });

  it('🔴 une instance SANS traducteur rend 200 et le dit, jamais une 5xx', async () => {
    // Cloudflare remplace le corps de toute reponse 5xx par sa page d'erreur : le message se
    // perdrait exactement quand il sert. Et ce n'est pas une panne, c'est un espace sans credit.
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages?traduire=fr', ...auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ traductionIndisponible: boolean; messages: Array<{ body: string }> }>();
    expect(body.traductionIndisponible).toBe(true);
    expect(body.messages[0]!.body).toBe('Hola');
    await a.close();
  });

  it('un espace sans credit : 200, le fil en VO, et le drapeau leve', async () => {
    const a = app({
      traduireFil: async (_t, _c, messages) => ({
        indisponible: true,
        messages: messages.map((m) => ({ ...m, affiche: m.body ?? '', traduit: false, traductionEchouee: false })),
      }),
    });
    const res = await a.inject({ method: 'GET', url: '/tenants/t1/conversations/c1/messages?traduire=fr', ...auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ traductionIndisponible: boolean }>().traductionIndisponible).toBe(true);
    await a.close();
  });
});
