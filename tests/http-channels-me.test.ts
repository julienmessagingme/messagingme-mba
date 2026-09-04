import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ChannelsMeRouteDeps } from '../src/http/channels-me';
import type { Connexion, Organisation, MessageChannel, Message } from '../src/channels-me/types';
import type { LienRow } from '../src/channels-me/link-store.pg';
import type { PostRow } from '../src/channels-me/post-store.pg';
import { lienWaMe } from '../src/lib/wa-me';
import { textePreRempli } from '../src/channels-me/jeton';
import { ChannelsMeClient, ChannelsMeApiError } from '../src/channels-me/client';

/**
 * Les routes de la chaine WhatsApp (Channels Me). Aucune base, aucun reseau : de faux stores et un faux
 * client, injectes dans `buildServer`.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Les deux secrets de la connexion (cle d'API et secret HMAC) ne ressortent JAMAIS. La projection
 *     publique ne porte que `hasApiKey` / `hasSecret` : une fuite ici circulerait chez tous les clients.
 *  2. 🔴 Un post publie circule POUR TOUJOURS. Publier sur un scenario sans version publiee poserait un
 *     bouton mort et irreparable : le refus est AVANT la publication, jamais apres.
 *  3. 🔴 L'automation compagnon ne s'allume qu'APRES une publication reussie. Un echec distant doit laisser
 *     le lien eteint, donc inerte, meme si son jeton a fuite.
 *  4. Une panne du tiers ne doit pas effacer la connexion de l'ecran : GET /connection reste en 200 et dit
 *     `distant: 'injoignable'`, ce qui n'est pas la meme chose que `non_configuree`.
 *  5. 🔴 Allumer/eteindre passe par le LIEN (`allumerAutomationLien`/`eteindreAutomationLien`, id de lien),
 *     jamais par un identifiant d'automation : c'est `PgChannelsMeLinkStore` qui resout et garde
 *     l'automation compagnon (`possede_par`), la route ne connait que le lien. Les assertions ci-dessous
 *     verifient l'id CAPTURE, pas seulement l'appel : passer AUTO_ID au lieu de LINK_ID les ferait echouer.
 *  6. 🔴 Une panne APRES la publication (allumage ou tracage) ne doit JAMAIS ressembler a un echec de
 *     publication : le post est reellement parti, `createMessage` n'a aucune cle d'idempotence, donc un
 *     5xx ferait reessayer et republierait le meme message a toute l'audience. `POST /posts` repond 201
 *     dans les deux cas, avec un `avertissements` qui dit ce qui a echoue ; les deux pannes sont
 *     INDEPENDANTES (celle d'un appel ne doit pas empecher l'autre). `POST /links/:id/enable` est la
 *     contrepartie de `disable` qui ferme le chemin de reparation d'un allumage rate.
 *
 * ⚠️ Le `enabled: false` de la CREATION de l'automation vit dans le cablage (`src/index.ts`), pas dans la
 * route : ce fichier prouve seulement qu'AUCUNE bascule n'a lieu a la creation d'un lien. Le cablage est
 * garde par son propre cas, plus bas (lecture de la source, comme `tests/scope-tenant.test.ts`). La garde
 * `possede_par` elle-meme (l'automation NON possedee reste inaccessible) est deja prouvee contre un vrai
 * Postgres par `tests/integration/channels-me-stores.integration.test.ts`.
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

// Identifiants FICTIFS (aucun secret reel) : valeurs figees pour rendre les assertions lisibles.
const CX: Connexion = { orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-fictive', secret: 'secret-fictif' };
const WF_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const AUTO_ID = '33333333-3333-4333-8333-333333333333';

const LIEN: LienRow = {
  id: LINK_ID, tenantId: 't1', workflowId: WF_ID, startNodeId: null,
  token: 'cm-a7k2m9p3', phrase: 'Je veux recevoir la newsletter',
  automationId: AUTO_ID, maxParHeure: 2000, createdAt: '2026-09-04T00:00:00.000Z',
};
const POST: PostRow = {
  id: '44444444-4444-4444-8444-444444444444', tenantId: 't1',
  cmMessageId: 'cm-msg-1', linkId: LINK_ID, createdAt: '2026-09-04T00:00:00.000Z',
};

// Objets rendus par le tiers. Seul `Message.id` est lu par ces routes (c'est ce que `cm_message_id`
// stocke) : on ne rejoue pas ici le schema complet de `src/channels-me/types.ts`.
const ORGA = { id: 'org-1', name: 'Demo' } as unknown as Organisation;
const CANAL = { id: 'chan-1', name: 'Ma chaine' } as unknown as MessageChannel;
const MESSAGE = { id: 'cm-msg-1' } as unknown as Message;

function app(over: Partial<ChannelsMeRouteDeps> = {}) {
  const cap = {
    upserts: [] as Connexion[],
    verifies: [] as string[],
    liens: [] as Array<Record<string, unknown>>,
    automations: [] as Array<Record<string, unknown>>,
    allumees: [] as string[],
    eteintes: [] as string[],
    publies: [] as Array<{ text: string; mediaUrl?: string }>,
    posts: [] as Array<{ cmMessageId: string; linkId: string | null }>,
    demandes: [] as Array<{ message: string }>,
    ordre: [] as string[],
    automationsSupprimees: [] as string[],
  };
  const deps: ChannelsMeRouteDeps = {
    getConnection: async () => ({ orgId: 'org-1', channelId: 'chan-1', hasApiKey: true, hasSecret: true, verifiedAt: null }),
    getSecrets: async () => CX,
    upsertConnection: async (_t, c) => { cap.upserts.push(c); },
    markVerified: async (t) => { cap.verifies.push(t); },
    getOrganisation: async () => ORGA,
    listChannels: async () => [CANAL],
    getMessages: async () => [MESSAGE],
    createMessage: async (_cx, m) => { cap.publies.push(m); cap.ordre.push('publie'); return MESSAGE; },
    listLinks: async () => [LIEN],
    createLink: async (_t, l) => { cap.liens.push(l); return { ...LIEN, ...l }; },
    linkById: async (_t, id) => (id === LINK_ID ? LIEN : null),
    supprimerAutomationCompagnon: async (_t, id) => { cap.automationsSupprimees.push(id); },
    listPosts: async () => [POST],
    createPost: async (_t, p) => { cap.posts.push(p); cap.ordre.push('trace'); },
    creerAutomationCompagnon: async (_t, input) => { cap.automations.push(input); return { id: AUTO_ID }; },
    allumerAutomationLien: async (_t, id) => { cap.allumees.push(id); cap.ordre.push('allume'); },
    eteindreAutomationLien: async (_t, id) => { cap.eteintes.push(id); cap.ordre.push('eteint'); },
    scenarioEtat: async (_t, wf) => (wf === WF_ID ? 'ok' : 'inconnu'),
    getDisplayPhoneNumber: async () => '+33 5 25 68 02 50',
    demanderActivation: async ({ message }) => { cap.demandes.push({ message }); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, channelsMe: deps }), cap };
}

describe('Channels Me : la connexion', () => {
  it('🔴 rend l etat de la chaine SANS jamais laisser sortir la cle ni le secret', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/connection', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ distant: string }>().distant).toBe('ok');
    expect(res.json<{ connection: Record<string, unknown> }>().connection).toMatchObject({ hasApiKey: true, hasSecret: true });
    // La projection publique ne porte que des booleens : les deux valeurs fictives ne doivent apparaitre
    // nulle part dans le corps, pas meme dans un champ oublie.
    expect(JSON.stringify(res.json())).not.toContain('cle-fictive');
    expect(JSON.stringify(res.json())).not.toContain('secret-fictif');
    await server.close();
  });

  it('tiers muet : la connexion enregistree reste visible, en 200, avec distant = injoignable', async () => {
    const { server } = app({ getOrganisation: async () => { throw new Error('reseau'); } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/connection', ...h(adminTok) });
    // 200 et pas 5xx : dire « rien de configure » alors que le tiers a simplement echoue enverrait le client
    // ressaisir des identifiants qui sont bons.
    expect(res.statusCode).toBe(200);
    expect(res.json<{ distant: string }>().distant).toBe('injoignable');
    expect(res.json<{ connection: unknown }>().connection).not.toBeNull();
    await server.close();
  });

  it('refuse l espace d un AUTRE tenant', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t-autre/channels-me/connection', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('tenant interdit');
    await server.close();
  });
});

describe('Channels Me : provisionner et verifier les identifiants', () => {
  it('PUT enregistre les quatre identifiants et ne les renvoie pas', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'PUT', url: '/tenants/t1/channels-me/connection', ...h(adminTok),
      payload: { orgId: '  org-1  ', channelId: 'chan-1', apiKey: 'cle-fictive', secret: 'secret-fictif' },
    });
    expect(res.statusCode).toBe(200);
    // Detourees des espaces, comme la cle du canal RCS.
    expect(cap.upserts).toEqual([{ orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-fictive', secret: 'secret-fictif' }]);
    expect(JSON.stringify(res.json())).not.toContain('cle-fictive');
    await server.close();
  });

  it('PUT avec un champ manquant : 400, et RIEN n est enregistre', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'PUT', url: '/tenants/t1/channels-me/connection', ...h(adminTok),
      payload: { orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-fictive' },
    });
    expect(res.statusCode).toBe(400);
    expect(cap.upserts).toEqual([]);
    await server.close();
  });

  it('un AGENT peut LIRE l etat mais ne peut ni enregistrer ni tester', async () => {
    const { server, cap } = app();
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/connection', ...h(agentTok) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'PUT', url: '/tenants/t1/channels-me/connection', ...h(agentTok), payload: CX })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(agentTok) })).statusCode).toBe(403);
    expect(cap.upserts).toEqual([]);
    await server.close();
  });

  it('le test des identifiants marque la connexion verifiee', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(cap.verifies).toEqual(['t1']);
    await server.close();
  });

  it('🔴 identifiants refuses par le tiers : 422 avec la marche a suivre, et AUCUNE verification posee', async () => {
    const { server, cap } = app({ listChannels: async () => { throw new Error('401 unauthorized'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(adminTok) });
    // 422 et non 5xx : c'est une saisie a corriger, et Cloudflare remplacerait le corps d'un 5xx par sa page
    // d'erreur, donc le message n'atteindrait jamais l'operateur.
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('secret');
    expect(cap.verifies).toEqual([]);
    await server.close();
  });

  it('tester sans rien avoir enregistre : 409, pas un 500', async () => {
    const { server } = app({ getSecrets: async () => null });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});

describe('Channels Me : les liens de chaine', () => {
  it('la liste rend le lien wa.me PRET A L EMPLOI (le front ne recompose jamais une URL publique)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/links', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const lien = res.json<{ links: Array<{ waMeUrl: string; texteRempli: string }> }>().links[0]!;
    expect(lien.texteRempli).toBe('Je veux recevoir la newsletter (cm-a7k2m9p3)');
    expect(lien.waMeUrl).toBe('https://wa.me/33525680250?text=Je%20veux%20recevoir%20la%20newsletter%20(cm-a7k2m9p3)');
    await server.close();
  });

  it('cree le lien et son automation compagnon, SANS rien allumer', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: WF_ID, phrase: 'Je veux recevoir la newsletter', maxParHeure: 2000 },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.automations[0]).toMatchObject({ workflowId: WF_ID, cooldownSeconds: 300, maxParHeure: 2000 });
    // Le jeton est tire par le SERVEUR, jamais fourni par le client, et il est le meme dans l'automation et
    // dans le lien : deux tirages donneraient un bouton qui ne declenche rien.
    expect(cap.liens[0]!.token).toBe(cap.automations[0]!.jeton);
    // 🔴 Rien n'est allume a la creation : un lien cree mais jamais publie doit rester inerte.
    expect(cap.allumees).toEqual([]);
    expect(cap.eteintes).toEqual([]);
    await server.close();
  });

  // 🔴 L'automation compagnon nait AVANT le lien (son id doit deja exister pour etre pose dans la ligne du
  // lien). Sans rattrapage, un `createLink` qui echoue APRES laisse cette automation POSSEDEE
  // (`possede_par = 'channelsme_link'`) sans qu'aucun lien ne la reference jamais : exclue du predicat de
  // `PgAutomationStore`, elle devient invisible et inaccessible depuis l'ecran Automation, orpheline pour
  // toujours.
  it('🔴 createLink echoue : l automation compagnon qu on vient de creer est DEFAITE, pas laissee orpheline', async () => {
    const { server, cap } = app({
      createLink: async () => { throw new Error('connexion base perdue'); },
    });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: WF_ID, phrase: 'Je veux recevoir la newsletter' },
    });
    // L'echec de createLink remonte tel quel : ce test protege le RATTRAPAGE de l'automation, pas le code de
    // statut d'une panne de base generique (deja opaque en 500 par le gestionnaire d'erreur global).
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(cap.automationsSupprimees).toEqual([AUTO_ID]);
    await server.close();
  });

  it('scenario d un AUTRE tenant : 400, et ni lien ni automation', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: '99999999-9999-4999-8999-999999999999', phrase: 'Bonjour' },
    });
    expect(res.statusCode).toBe(400);
    expect(cap.liens).toEqual([]);
    expect(cap.automations).toEqual([]);
    await server.close();
  });

  it('aucun numero WhatsApp connecte : 409 explicite plutot qu un lien casse', async () => {
    const { server, cap } = app({ getDisplayPhoneNumber: async () => null });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: WF_ID, phrase: 'Bonjour' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('numero WhatsApp');
    expect(cap.automations).toEqual([]);
    await server.close();
  });

  it('🔴 eteindre un lien appelle eteindreAutomationLien avec l id du LIEN, jamais celui de l automation', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/disable`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    // C'est PgChannelsMeLinkStore.eteindreAutomation (id de LIEN) qui resout et garde l'automation
    // compagnon : passer AUTO_ID ici serait un identifiant de la mauvaise table.
    expect(cap.eteintes).toEqual([LINK_ID]);
    expect(cap.allumees).toEqual([]);
    await server.close();
  });

  it('un lien deja sans automation compagnon : 409, et rien n est appele', async () => {
    const { server, cap } = app({ linkById: async () => ({ ...LIEN, automationId: null }) });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/disable`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(cap.eteintes).toEqual([]);
    await server.close();
  });

  it('identifiant mal forme ou lien d un autre espace : 404, jamais une page d incident', async () => {
    const { server } = app();
    // Un id non-uuid partirait tel quel dans un `where id = $1` sur une colonne uuid : Postgres leverait
    // 22P02, donc 500, donc page Cloudflare au lieu d'un 404.
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/links/pas-un-uuid/disable', ...h(adminTok) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${WF_ID}/disable`, ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });

  // La contrepartie de `disable` : sans elle, un lien dont l'allumage automatique a echoue apres une
  // publication reussie (POST /posts) restait un bouton mort a jamais, sans aucun moyen de le reparer.
  it('🔴 rallume un lien : appelle allumerAutomationLien avec l id du LIEN, jamais celui de l automation', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/enable`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(cap.allumees).toEqual([LINK_ID]);
    expect(cap.eteintes).toEqual([]);
    await server.close();
  });

  it('rallumer sans authentification : 401', async () => {
    const { server } = app();
    const res = await server.inject({
      method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/enable`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('rallumer en AGENT (non admin) : 403, rien n est appele', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/enable`, ...h(agentTok) });
    expect(res.statusCode).toBe(403);
    expect(cap.allumees).toEqual([]);
    await server.close();
  });

  it('rallumer un lien deja sans automation compagnon : 409', async () => {
    const { server, cap } = app({ linkById: async () => ({ ...LIEN, automationId: null }) });
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/enable`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(cap.allumees).toEqual([]);
    await server.close();
  });

  it('rallumer un identifiant mal forme ou un lien d un autre espace : 404', async () => {
    const { server } = app();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/links/pas-un-uuid/enable', ...h(adminTok) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${WF_ID}/enable`, ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });
});

describe('Channels Me : publier', () => {
  it('publie, PUIS allume l automation du LIEN, PUIS trace : l ordre est ce qui compte', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(201);
    // Le lien wa.me est AJOUTE au texte du post par le serveur : c'est lui qui fait apparaitre le bouton
    // que WhatsApp dessine, le client ne le colle pas a la main.
    // 🔴 Egalite EXACTE du texte complet, composee avec les VRAIES fonctions (lienWaMe, textePreRempli) :
    // un simple `toContain` d'un prefixe d'URL ne prouve pas que le jeton fait bien partie du texte envoye,
    // et c'est pourtant lui, et lui seul, qui declenche le scenario quand l'abonne appuie sur le bouton.
    const urlAttendue = lienWaMe('+33 5 25 68 02 50', textePreRempli(LIEN.phrase, LIEN.token));
    expect(cap.publies[0]!.text).toBe(`Notre newsletter arrive\n\n${urlAttendue}`);
    // 🔴 Publier d'abord : une automation allumee avant une publication qui echoue laisserait un jeton
    // vivant sans post. Allumer ensuite : sinon le bouton du post est mort. Tracer en dernier.
    expect(cap.ordre).toEqual(['publie', 'allume', 'trace']);
    // L'id transmis est celui du LIEN (LINK_ID), pas celui de son automation (AUTO_ID) : c'est le store des
    // liens qui resout l'automation compagnon.
    expect(cap.allumees).toEqual([LINK_ID]);
    expect(cap.eteintes).toEqual([]);
    expect(cap.posts).toEqual([{ cmMessageId: 'cm-msg-1', linkId: LINK_ID }]);
    await server.close();
  });

  it('un post SANS lien ne touche a aucune automation', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Bonjour a tous' },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.publies[0]!.text).toBe('Bonjour a tous');
    expect(cap.allumees).toEqual([]);
    expect(cap.posts).toEqual([{ cmMessageId: 'cm-msg-1', linkId: null }]);
    await server.close();
  });

  it('🔴 scenario sans version publiee : 409 AVANT toute publication, rien ne part et rien ne s allume', async () => {
    const { server, cap } = app({ scenarioEtat: async () => 'vide' });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    // Un post publie circule POUR TOUJOURS : un bouton qui demarre un scenario vide ne se rattrape pas.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('publiee');
    expect(cap.publies).toEqual([]);
    expect(cap.allumees).toEqual([]);
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  it('🔴 publication refusee par le tiers : 422, et le lien reste ETEINT', async () => {
    const { server, cap } = app({ createMessage: async () => { throw new Error('422 text too long'); } });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(422);
    expect(cap.allumees).toEqual([]);
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  // Trois situations, distinguees par le statut porte par `ChannelsMeApiError` (constat de revue du
  // 2026-09-04) : le catch precedent ne regardait ni le type ni le statut, et repondait 422 avec « reessaie »
  // meme quand le message etait deja PARTI (statut 2xx recu, seule l'enveloppe attendue etait mal formee) ou
  // quand on ne savait tout simplement pas (statut 0, delai depasse). Un operateur qui suit ce conseil et
  // republie ferait recevoir le meme message deux fois a toute l'audience (`createMessage` n'a aucune cle
  // d'idempotence).
  it('🔴 vrai refus du fournisseur (ChannelsMeApiError avec un statut 4xx recu) : 422, invite a reessayer', async () => {
    const { server, cap } = app({ createMessage: async () => { throw new ChannelsMeApiError(422, 'texte trop long'); } });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('reessaie');
    expect(cap.allumees).toEqual([]);
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  it('🔴 delai depasse (statut 0) : 4xx qui ne dit JAMAIS de reessayer, rien ne s allume ni ne se trace', async () => {
    const { server, cap } = app({ createMessage: async () => { throw new ChannelsMeApiError(0, 'delai depasse'); } });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    // Jamais 5xx : Cloudflare remplacerait le corps de la reponse par sa propre page d'erreur.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    // On ne sait PAS si le message est parti : le message ne doit jamais inviter a reessayer a l'aveugle.
    expect(res.json<{ error: string }>().error).not.toContain('reessaie');
    expect(cap.allumees).toEqual([]);
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  it('🔴 le tiers a REPONDU 2xx avec un corps non enveloppe : le message est PARTI, jamais un echec', async () => {
    // Le vrai client HTTP, contre un vrai faux `fetch` qui rend 201 avec un corps qui n'a pas la forme
    // attendue (`{ data: ... }`) : c'est exactement le chemin qui, dans `ChannelsMeClient.appel`, leve
    // `ChannelsMeApiError` APRES avoir verifie `res.ok`, donc avec le statut 2xx REELLEMENT recu.
    const fauxFetch = (async () => new Response(JSON.stringify({ id: 'msg-2xx-sans-enveloppe' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const clientReel = new ChannelsMeClient({ fetch: fauxFetch });
    const { server, cap } = app({ createMessage: (cx, m) => clientReel.createMessage(cx, m) });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    // Le message est reellement PARTI (201 recu cote fournisseur) : jamais une erreur, meme si l'enveloppe
    // attendue n'a pas ete reconnue.
    expect(res.statusCode).toBe(201);
    expect(res.json<{ avertissements?: string[] }>().avertissements).toEqual(['reponse_inattendue']);
    expect(res.json<{ post: { cmMessageId: unknown } }>().post.cmMessageId).toBeNull();
    // L'automation s'allume QUAND MEME : `allumerAutomationLien` ne prend qu'un id de LIEN, jamais un id de
    // message, donc l'absence d'identifiant Channels Me ne l'empeche pas.
    expect(cap.allumees).toEqual([LINK_ID]);
    // La trace, elle, est IMPOSSIBLE (aucun `cmMessageId` a ecrire) : `createPost` n'est meme pas tente.
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  // 🔴 Le post est PARTI (createMessage a reussi) : une panne transitoire APRES ce point ne doit jamais
  // ressembler a un echec de publication, sinon un operateur qui relit « erreur » et reessaie republie le
  // meme message a toute l'audience (createMessage n'a aucune cle d'idempotence). Avant le correctif, cet
  // appel n'etait protege par aucun try/catch : la route rejetait, et le gestionnaire d'erreur global
  // rendait un 500 opaque pour une publication qui avait pourtant reussi.
  it('🔴 l allumage de l automation echoue apres une publication reussie : 201 quand meme, avertissement, et la trace est ecrite', async () => {
    const { server, cap } = app({ allumerAutomationLien: async () => { throw new Error('connexion base perdue'); } });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    // Le post a reellement ete publie : repondre autre chose qu'un succes ferait reessayer, donc republier.
    expect(res.statusCode).toBe(201);
    expect(res.json<{ avertissements?: string[] }>().avertissements).toEqual(['automation_non_allumee']);
    // La trace n'a AUCUNE raison d'echouer parce que l'allumage a echoue : les deux appels sont independants.
    expect(cap.posts).toEqual([{ cmMessageId: 'cm-msg-1', linkId: LINK_ID }]);
    await server.close();
  });

  it('🔴 le tracage du post echoue apres une publication reussie : 201 quand meme (le post est bel et bien parti)', async () => {
    const { server, cap } = app({ createPost: async () => { throw new Error('connexion base perdue'); } });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ avertissements?: string[] }>().avertissements).toEqual(['trace_manquante']);
    // L'allumage n'a AUCUNE raison d'echouer parce que le tracage a echoue.
    expect(cap.allumees).toEqual([LINK_ID]);
    await server.close();
  });

  it('publication reussie sans aucun incident : pas de champ avertissements du tout', async () => {
    const { server } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(201);
    expect('avertissements' in res.json<Record<string, unknown>>()).toBe(false);
    await server.close();
  });

  it('mediaUrl non https ou interne : 400, et rien n est publie', async () => {
    const { server, cap } = app();
    for (const mediaUrl of ['http://exemple.fr/a.jpg', 'https://169.254.169.254/a.jpg', 'https://localhost/a.jpg']) {
      const res = await server.inject({
        method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
        payload: { text: 'Bonjour', mediaUrl },
      });
      expect(res.statusCode, `${mediaUrl} aurait du etre refusee`).toBe(400);
    }
    expect(cap.publies).toEqual([]);
    await server.close();
  });

  it('la liste des publications joint le statut LU EN DIRECT chez le tiers', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/posts', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ posts: Array<{ message: unknown }> }>().posts[0]!.message).not.toBeNull();
    // Rien n'est miroite en base, donc rien a resynchroniser : un tiers muet rend un statut absent, pas une
    // erreur, et surtout pas une liste vide.
    const { server: s2 } = app({ getMessages: async () => { throw new Error('reseau'); } });
    const r2 = await s2.inject({ method: 'GET', url: '/tenants/t1/channels-me/posts', ...h(adminTok) });
    expect(r2.statusCode).toBe(200);
    expect(r2.json<{ distant: string }>().distant).toBe('injoignable');
    expect(r2.json<{ posts: Array<{ message: unknown }> }>().posts[0]!.message).toBeNull();
    await server.close();
    await s2.close();
  });

  it('la demande d activation part, et un agent n y a pas droit', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok),
      payload: { message: 'On voudrait une chaine pour la rentree' },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.demandes).toEqual([{ message: 'On voudrait une chaine pour la rentree' }]);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(agentTok), payload: {} })).statusCode).toBe(403);
    await server.close();
  });

  it('demande d activation non cablee : 503 explicite, pas une page d incident', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    await server.close();

    // Le meme montage, prive de la dependance optionnelle : c'est ce qui permet a un cablage de test de
    // monter le module sans notification.
    const { server: nu, cap } = app({ demanderActivation: undefined });
    const r = await nu.inject({ method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok), payload: {} });
    expect(r.statusCode).toBe(503);
    expect(cap.demandes).toEqual([]);
    await nu.close();
  });

  it('🔴 trop de demandes d activation : 429 au dela du plafond (3/min, en memoire, sans base ni reseau)', async () => {
    const { server } = app();
    const appel = () => server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok), payload: {},
    });
    expect((await appel()).statusCode).toBe(200);
    expect((await appel()).statusCode).toBe(200);
    expect((await appel()).statusCode).toBe(200);
    // La quatrieme demande de ce meme utilisateur, dans la meme fenetre, depasse le plafond.
    const quatrieme = await appel();
    expect(quatrieme.statusCode).toBe(429);
    expect(quatrieme.json<{ error: string }>().error).toContain('trop de demandes');
    await server.close();
  });
});

describe('Channels Me : le cablage', () => {
  it('🔴 l automation compagnon est creee ETEINTE, en `contains`, et POSSEDEE', () => {
    // Ce test lit la source parce qu'aucun type ne peut exprimer « cette automation nait eteinte ». Les
    // routes ne voient qu'une dependance : si le cablage la creait allumee, un lien jamais publie
    // declencherait des scenarios, et rien dans les tests de routes ne le verrait.
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const debut = src.indexOf('channelsMe: {');
    expect(debut).toBeGreaterThan(0);
    const brut = src.slice(debut, src.indexOf('\n    },', debut));
    // 🔴 SANS LES COMMENTAIRES : deux des chaines cherchees (`enabled: false`, `mode: 'contains'`) sont deja
    // citees, entre backticks, dans les commentaires qui EXPLIQUENT ce cablage. Chercher dans le bloc brut
    // ferait donc passer ce test meme si le CODE perdait ces lignes, tant que le commentaire les citant
    // resterait. Meme patron que `tests/campagne-cablage.test.ts`.
    const bloc = brut.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(bloc).toContain('enabled: false');
    expect(bloc).toContain("possedePar: 'channelsme_link'");
    expect(bloc).toContain("triggerKind: 'keyword'");
    expect(bloc).toContain("mode: 'contains'");
    // 🔴 Le cablage bascule par le LIEN (le store qui porte la garde `possede_par`), jamais par
    // `automationStore.update`/`remove`, qui excluent ces lignes.
    expect(bloc).toContain('channelsMeLinks.allumerAutomation');
    expect(bloc).toContain('channelsMeLinks.eteindreAutomation');
    expect(bloc).not.toMatch(/automationStore\.update\(/);
  });
});
