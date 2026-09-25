import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import {
  parseRcsDlr, parseRcsMo, estDlr, statutDepuisSmsmode, urlRappelRcs, apercuMo,
} from '../src/rcs/callback';
import type { RcsDlr, RcsMo } from '../src/rcs/callback';
import { adressesPubliques } from '../src/lib/adresses-publiques';
import Fastify from 'fastify';
import { registerRcsCallback } from '../src/http/rcs-callback';
import { RateLimiter } from '../src/auth/rate-limit';
import { config } from '../src/config';

const CODE = 'rcs-0123456789abcdef0123456789abcdef';

/**
 * Corps REELS de smsmode, recopies de leur spec (`dev.smsmode.com/rcs/openapi/rest-rcs.yml`, exemples
 * `RequestBody*StatusReceivedCallback` et `RequestBody*MoMessageReceivedCallback`). C'est le point : ces
 * fixtures ne sont pas ce qu'on imagine de leur format, ce sont leurs propres exemples.
 */
const DLR_DELIVERED = {
  messageId: 'e5ab32e9-caf1-464b-92ac-382a0899445f',
  acceptedAt: '2025-04-01T16:00:00',
  sentDate: '2025-04-01T16:00:00',
  channel: { channelId: 'ch-1', name: 'marketing_channel', type: 'RCS', flow: 'MARKETING' },
  type: 'RCS',
  direction: 'MT',
  recipient: { to: '33600000000' },
  from: 'RcsAgent',
  body: { type: 'TEXT', text: 'Bienvenue' },
  price: { amount: 0.05, currency: 'EUR' },
  status: {
    deliveryDate: '2025-04-01T16:00:10',
    value: 'DELIVERED',
    lookup: { mccMnc: '20820', country: 'France', network: 'BOUYGUES' },
  },
  refClient: 'reference',
};

const MO_SUGGESTION = {
  messageId: '82f71ab3-2e74-4da7-a9d8-bba0e23337a5',
  originMessageId: 'efbc1edd-4de7-4629-8f9d-8cb57123436b',
  sentDate: '2025-03-01T12:00:00',
  channel: { channelId: 'ch-1', name: 'marketing_channel', type: 'RCS', flow: 'MARKETING' },
  type: 'RCS',
  direction: 'MO',
  recipient: { to: 'RcsAgent' },
  from: '33600000000',
  body: { type: 'SUGGESTION', text: 'Oui, je veux découvrir 📅', postbackData: 'btn:0' },
};

describe('Lecture des rappels smsmode', () => {
  /**
   * 🔴 LE bug du 2026-08-24, en production. La premiere version discriminait sur `direction === 'MT'`. Un vrai
   * rappel a ete rejete : il tombait alors dans le lecteur de messages ENTRANTS, qui exige un expediteur
   * NUMERIQUE, n'en trouvait pas (l'expediteur d'un sortant est le nom de l'agent) et finissait
   * << non exploitable >>. Le parcours du contact restait bloque, sans que rien ne le dise.
   *
   * Le discriminant est desormais la PRESENCE d'un statut : un rapport en porte toujours un, un message
   * entrant jamais.
   */
  it('distingue un rapport de livraison d une reponse, MEME sans champ `direction`', () => {
    expect(estDlr(DLR_DELIVERED)).toBe(true);
    expect(estDlr(MO_SUGGESTION)).toBe(false);

    const { direction: _sansDirection, ...sansDirection } = DLR_DELIVERED;
    expect(estDlr(sansDirection)).toBe(true);
    expect(parseRcsDlr(sansDirection)?.status).toBe('delivered');

    const { direction: _idem, ...moSansDirection } = MO_SUGGESTION;
    expect(estDlr(moSansDirection)).toBe(false);
    expect(parseRcsMo(moSansDirection)?.postbackData).toBe('btn:0');
  });

  // Le corps REEL d'un envoi de production (relu chez eux le 2026-08-24) : une CARTE, avec ses boutons dans
  // la carte et le statut READ. C'est ce corps-la que la premiere version rejetait.
  it('lit le rapport d une CARTE telle qu elle part vraiment', () => {
    const reel = {
      messageId: '8bf92565-9f67-4cae-8a92-3bb25b064e38',
      channel: { channelId: 'ch-1', name: 'CANAL RCS (test)', type: 'RCS', flow: 'MARKETING' },
      type: 'RCS',
      recipient: { to: '33633921577' },
      from: 'Messaging Me (TEST)',
      body: {
        type: 'CARD',
        content: {
          description: 'Bonjour dumas',
          media: { fileUrl: 'https://mba.messagingme.app/m/abc.png', height: 'TALL' },
          suggestions: [{ type: 'REPLY', text: 'Recois un whastapp', postbackData: 'btn:0' }],
        },
        orientation: 'VERTICAL',
      },
      status: { deliveryDate: '2026-08-24T22:36:10', value: 'READ', lookup: { network: 'Orange' } },
      refClient: 'd8b021f7-cbca-41bd-98a6-121c3ea146ec:64b9ca84-44ca-442f-a33c-688ffbf0e7b5',
    };
    expect(estDlr(reel)).toBe(true);
    const d = parseRcsDlr(reel);
    expect(d).toMatchObject({ status: 'read', to: '33633921577', channelId: 'ch-1', echecDefinitif: false });
  });

  it('lit un rapport DELIVERED', () => {
    expect(parseRcsDlr(DLR_DELIVERED)).toEqual({
      messageId: 'e5ab32e9-caf1-464b-92ac-382a0899445f',
      channelId: 'ch-1',
      to: '33600000000',
      status: 'delivered',
      echecDefinitif: false,
      detail: null,
      refClient: 'reference',
    });
  });

  it('lit READ, qui n est PAS dans leur enumeration documentee mais existe en vrai', () => {
    const d = parseRcsDlr({ ...DLR_DELIVERED, status: { value: 'READ' } });
    expect(d?.status).toBe('read');
    expect(d?.echecDefinitif).toBe(false);
  });

  it('marque UNDELIVERABLE et UNDELIVERED comme echec DEFINITIF, avec leur motif', () => {
    for (const v of ['UNDELIVERABLE', 'UNDELIVERED']) {
      const d = parseRcsDlr({ ...DLR_DELIVERED, status: { value: v, detail: 'INVALID_PHONE_NUMBER' } });
      expect(d?.status).toBe('failed');
      expect(d?.echecDefinitif).toBe(true);
      expect(d?.detail).toBe('INVALID_PHONE_NUMBER');
    }
  });

  // 🔴 Le coeur du sujet : un statut inconnu ne doit JAMAIS passer pour un echec. Sinon un contact
  // parfaitement joignable bascule en repli WhatsApp et recoit deux fois le meme message.
  it('IGNORE un statut inconnu au lieu de le prendre pour un echec', () => {
    const d = parseRcsDlr({ ...DLR_DELIVERED, status: { value: 'QUELQUE_CHOSE_DE_NOUVEAU' } });
    expect(d?.status).toBeNull();
    expect(d?.echecDefinitif).toBe(false);
    expect(statutDepuisSmsmode('SCHEDULED')).toBe('sent');
    expect(statutDepuisSmsmode('ENROUTE')).toBe('sent');
  });

  it('lit un bouton tape, avec sa charge utile', () => {
    expect(parseRcsMo(MO_SUGGESTION)).toEqual({
      messageId: '82f71ab3-2e74-4da7-a9d8-bba0e23337a5',
      channelId: 'ch-1',
      from: '33600000000',
      originMessageId: 'efbc1edd-4de7-4629-8f9d-8cb57123436b',
      kind: 'suggestion',
      text: 'Oui, je veux découvrir 📅',
      postbackData: 'btn:0',
      latitude: null,
      longitude: null,
      fileUrl: null,
      filename: null,
    });
  });

  /**
   * 🔴 Une position et un fichier arrivent SANS texte et SANS charge utile. C'est la raison pour laquelle un
   * bouton « Demander la position » ne peut pas ouvrir une branche de scenario, et la raison pour laquelle il
   * faut garder ces valeurs : sans elles, la reponse ne serait qu'une bulle vide dans l'inbox, et ce que
   * l'operateur a demande au contact serait perdu.
   */
  it('garde les coordonnees d une position partagee, et en fait un apercu lisible', () => {
    const mo = parseRcsMo({
      ...MO_SUGGESTION,
      body: { type: 'LOCATION', latitude: 48.8566, longitude: 2.3522 },
    });
    expect(mo).toMatchObject({ kind: 'location', latitude: 48.8566, longitude: 2.3522, text: null, postbackData: null });
    expect(apercuMo(mo!)).toBe('📍 48.8566, 2.3522');
  });

  it('garde l adresse d un fichier recu', () => {
    const mo = parseRcsMo({
      ...MO_SUGGESTION,
      body: { type: 'FILE', fileUrl: 'https://x.test/video.mp4', filename: 'video.mp4', contentType: 'video/mp4' },
    });
    expect(mo).toMatchObject({ kind: 'file', fileUrl: 'https://x.test/video.mp4', filename: 'video.mp4' });
    expect(apercuMo(mo!)).toBe('video.mp4 https://x.test/video.mp4');
  });

  it('rend un apercu meme quand la position arrive sans coordonnees', () => {
    const mo = parseRcsMo({ ...MO_SUGGESTION, body: { type: 'LOCATION' } });
    expect(apercuMo(mo!)).toBe('📍 position partagée');
  });

  /**
   * 🔴 LE bug qui a bloque le scenario de Julien, deux fois, le 2026-08-24. Leur DOCUMENTATION montre un
   * entrant avec `from` = le contact et `recipient.to` = l'agent. Leur PRODUCTION fait l'INVERSE : elle garde
   * l'orientation du sortant, `from` = l'agent, `recipient.to` = le contact.
   *
   * On ne se fie donc plus a la position du champ mais a sa FORME. Ce corps est le vrai, recopie de la base
   * apres le clic.
   */
  it('lit un clic dont le contact est dans `recipient.to` et l agent dans `from` (corps REEL)', () => {
    const reel = {
      body: { text: 'Recois un whastapp', type: 'SUGGESTION', postbackData: 'btn:0' },
      from: 'Messaging Me (TEST)',
      type: 'RCS',
      channel: { flow: 'MARKETING', name: 'CANAL RCS (test)', type: 'RCS', channelId: 'ch-1' },
      sentDate: '2026-08-24T22:48:52',
      direction: 'MO',
      messageId: '01fb719b-a961-4709-ac09-de8c80e22e77',
      recipient: { to: '33633921577' },
      refClient: 'b246bebd-50f8-4d1a-bae1-6b2178ebc4e2:64b9ca84-44ca-442f-a33c-688ffbf0e7b5',
      originMessageId: 'dbe01225-5843-43ad-b239-e1276de6322a',
    };
    expect(estDlr(reel)).toBe(false);
    expect(parseRcsMo(reel)).toMatchObject({
      from: '33633921577',
      kind: 'suggestion',
      postbackData: 'btn:0',
      text: 'Recois un whastapp',
    });
  });

  it('lit AUSSI l orientation de leur documentation (contact dans `from`)', () => {
    expect(parseRcsMo(MO_SUGGESTION)?.from).toBe('33600000000');
  });

  it('refuse un corps ou AUCUN des deux champs n est un numero', () => {
    expect(parseRcsMo({ ...MO_SUGGESTION, from: 'Agent', recipient: { to: 'RcsAgent' } })).toBeNull();
  });

  it('lit un message ecrit, sans charge utile de bouton', () => {
    const mo = parseRcsMo({ ...MO_SUGGESTION, body: { type: 'TEXT', text: 'Hello World 🌍' } });
    expect(mo?.kind).toBe('text');
    expect(mo?.text).toBe('Hello World 🌍');
    expect(mo?.postbackData).toBeNull();
  });

  it('normalise le numero, quelle que soit la forme recue', () => {
    expect(parseRcsMo({ ...MO_SUGGESTION, from: '+33 6 00 00 00 00' })?.from).toBe('33600000000');
    expect(parseRcsDlr({ ...DLR_DELIVERED, recipient: { to: '+33600000000' } })?.to).toBe('33600000000');
  });

  it('ne leve JAMAIS sur un corps aberrant', () => {
    for (const brut of [null, undefined, 42, 'texte', {}, { messageId: '' }, { messageId: 'x' }]) {
      expect(() => parseRcsDlr(brut)).not.toThrow();
      expect(() => parseRcsMo(brut)).not.toThrow();
    }
    expect(parseRcsMo({ messageId: 'x', body: { type: 'TEXT' } })).toBeNull(); // sans expediteur : rien a rattacher
  });

  /**
   * 🔴 L'ADRESSE DE RAPPEL EST UNE ADRESSE DE L'API, ET ELLE SE CONSTRUIT SUR `avecPrefixe` (2026-09-21).
   *
   * Elle se construisait sur `APP_URL` + `/api/backend` : juste tant que le front relayait vers l'API. Depuis
   * la bascule Vercel, `APP_URL` vaut `engageme.messagingme.app`, et Vercel NE relaie PAS (`BACKEND_URL` n'y
   * est pas posé, il répond `404 DNS_HOSTNAME_RESOLVED_PRIVATE`, mesuré le 2026-09-21). smsmode appelait donc
   * une adresse morte : plus aucun rapport de livraison ni aucune réponse RCS n'arrivait depuis le 26 août.
   */
  it('sans PUBLIC_API_URL : l adresse d AVANT, au caractere pres (rewrite du front)', () => {
    expect(urlRappelRcs(adressesPubliques('https://mba.messagingme.app/', '').avecPrefixe, CODE))
      .toBe(`https://mba.messagingme.app/api/backend/rcs/callback/${CODE}`);
  });

  it('🔴 avec PUBLIC_API_URL : l adresse de l API, jamais celle du front', () => {
    const adresses = adressesPubliques('https://engageme.messagingme.app', 'https://api.messagingme.app');
    expect(urlRappelRcs(adresses.avecPrefixe, CODE)).toBe(`https://api.messagingme.app/rcs/callback/${CODE}`);
  });
});

function appWith(opts: { agentId?: string } = {}) {
  const dlrs: Array<{ tenant: string; dlr: RcsDlr }> = [];
  const mos: Array<{ tenant: string; mo: RcsMo }> = [];
  const app = buildServer({
    queue: new FakeQueue(),
    rcsCallback: {
      parCode: async (code) => (code === CODE ? { tenantId: 't1', agentId: opts.agentId ?? 'ch-1' } : null),
      onDlr: async (tenant, dlr) => { dlrs.push({ tenant, dlr }); },
      onMo: async (tenant, mo) => { mos.push({ tenant, mo }); },
    },
  });
  return { app, dlrs, mos };
}

const post = (url: string, payload: Record<string, unknown>) =>
  ({ method: 'POST' as const, url, headers: { 'content-type': 'application/json' }, payload });

describe('Route publique des rappels RCS', () => {
  it('route un rapport de livraison vers le workspace du CODE', async () => {
    const { app, dlrs, mos } = appWith();
    const r = await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED));
    expect(r.statusCode).toBe(200);
    expect(dlrs).toHaveLength(1);
    expect(dlrs[0]!.tenant).toBe('t1');
    expect(dlrs[0]!.dlr.status).toBe('delivered');
    expect(mos).toHaveLength(0);
  });

  it('route une reponse entrante', async () => {
    const { app, dlrs, mos } = appWith();
    const r = await app.inject(post(`/rcs/callback/${CODE}`, MO_SUGGESTION));
    expect(r.statusCode).toBe(200);
    expect(mos).toHaveLength(1);
    expect(mos[0]!.mo.postbackData).toBe('btn:0');
    expect(dlrs).toHaveLength(0);
  });

  it('REFUSE un code inconnu, et une forme de code qui n en est pas une, sans toucher la base', async () => {
    const { app } = appWith();
    for (const url of ['/rcs/callback/rcs-deadbeefdeadbeefdeadbeefdeadbeef', '/rcs/callback/nimporte-quoi', '/rcs/callback/rcs-XYZ']) {
      const r = await app.inject(post(url, DLR_DELIVERED));
      expect(r.statusCode).toBe(404);
    }
  });

  // 🔴 Deuxieme garde d'isolation : smsmode NE SIGNE PAS. Un corps forge portant le canal d'un autre client
  // ne doit rien ecrire chez celui du code, meme si le code fuitait.
  it('REFUSE un corps dont le canal n est pas celui du workspace', async () => {
    const { app, dlrs } = appWith({ agentId: 'ch-du-workspace' });
    const r = await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED));
    expect(r.statusCode).toBe(403);
    expect(dlrs).toHaveLength(0);
  });

  /**
   * 🔴 LE CORPS FORGÉ : il suffisait d'OMETTRE l'objet `channel` pour que la garde ci-dessus ne se déclenche
   * pas, et le corps était traité (une bulle dans le fil, un opt-out RCS, un parcours qui avance). Relevé par
   * l'audit d'étanchéité du 2026-08-25. Le champ est désormais EXIGÉ ; la décision a été prise sur les vrais
   * rappels (les 11 reçus le 2026-09-21, dont 3 messages entrants, le portaient tous), pas sur une intuition.
   */
  it('🔴 REFUSE un rapport de livraison SANS channelId, et ne l’écrit nulle part', async () => {
    const { app, dlrs, mos } = appWith();
    const { channel: _retire, ...sansCanal } = DLR_DELIVERED as Record<string, unknown>;
    const r = await app.inject(post(`/rcs/callback/${CODE}`, sansCanal));
    expect(r.statusCode).toBe(403);
    expect(dlrs).toHaveLength(0);
    expect(mos).toHaveLength(0);
  });

  it('🔴 REFUSE une réponse entrante SANS channelId, le cas qui écrivait dans le fil', async () => {
    const { app, mos } = appWith();
    const { channel: _retire, ...sansCanal } = MO_SUGGESTION as Record<string, unknown>;
    const r = await app.inject(post(`/rcs/callback/${CODE}`, sansCanal));
    expect(r.statusCode).toBe(403);
    expect(mos).toHaveLength(0);
  });

  it('REFUSE aussi un objet `channel` présent mais vide', async () => {
    const { app, mos } = appWith();
    const r = await app.inject(post(`/rcs/callback/${CODE}`, { ...MO_SUGGESTION, channel: {} }));
    expect(r.statusCode).toBe(403);
    expect(mos).toHaveLength(0);
  });

  it('ACQUITTE un corps illisible au lieu de le faire rejouer six fois', async () => {
    const { app, dlrs, mos } = appWith();
    const r = await app.inject(post(`/rcs/callback/${CODE}`, { direction: 'MT', pas: 'un rappel' }));
    expect(r.statusCode).toBe(200);
    expect(dlrs).toHaveLength(0);
    expect(mos).toHaveLength(0);
  });

  // Une panne interne doit RESSORTIR en 5xx : smsmode rejoue alors (30 s, 2 min, 10 min, 1 h, 5 h, 24 h).
  // Acquitter un evenement qu'on n'a pas su traiter, c'est une cascade de repli qui ne part jamais.
  it('laisse remonter une panne interne pour que smsmode rejoue', async () => {
    const app = buildServer({
      queue: new FakeQueue(),
      rcsCallback: {
        parCode: async () => ({ tenantId: 't1', agentId: 'ch-1' }),
        onDlr: async () => { throw new Error('base injoignable'); },
        onMo: async () => {},
      },
    });
    const r = await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED));
    expect(r.statusCode).toBe(500);
  });
});

/**
 * 🔴 LE PLAFOND DE REQUÊTES PAR CODE. Cette route est la seule écriture non signée du produit : son code d'URL
 * est sa seule authentification, et une adresse qui fuite (journal, capture, ticket) ne doit pas devenir un
 * robinet ouvert. Le plafond se prend sur le code, APRÈS la lecture (seuls les codes existants entrent dans sa
 * table, cf. le test des codes inventés ci-dessous), et un refus est un 429, que smsmode REJOUE
 * (30 s, 2 min, 10 min, 1 h, 5 h, 24 h) : un vrai accusé retardé n'est pas perdu.
 */
describe('Rappels RCS : le plafond par code', () => {
  const AUTRE_CODE = 'rcs-ffffffffffffffffffffffffffffffff';
  function monterAvec(max: number, maxCles = 0, budgetInconnus = 1000) {
    let lectures = 0;
    const dlrs: RcsDlr[] = [];
    const app = Fastify();
    registerRcsCallback(app, {
      parCode: async (code) => {
        lectures += 1;
        if (code === CODE) return { tenantId: 't1', agentId: 'ch-1' };
        // Un second code EXISTANT, d'un autre espace (même agent smsmode, pour que le corps partagé passe la
        // garde du canal) : sans lui, le test « PAR CODE » ne pouvait rien distinguer.
        return code === AUTRE_CODE ? { tenantId: 't2', agentId: 'ch-1' } : null;
      },
      onDlr: async (_t, dlr) => { dlrs.push(dlr); },
      onMo: async () => {},
    }, new RateLimiter(max, 60_000, () => 1_000, maxCles), new RateLimiter(budgetInconnus, 60_000, () => 1_000));
    return { app, dlrs, lectures: () => lectures };
  }

  it('🔴 un refus sur un code déjà résolu ne coûte plus de lecture en base', async () => {
    const { app, lectures } = monterAvec(2);
    const codes: number[] = [];
    for (let i = 0; i < 10; i += 1) codes.push((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode);
    expect(codes).toEqual([200, 200, 429, 429, 429, 429, 429, 429, 429, 429]);
    // Les deux premiers appels lisent le code (le premier le résout) ; les huit refus se prennent avant la base.
    expect(lectures()).toBe(2);
  });

  it('🔴 au-delà du plafond : 429, et plus RIEN n’est écrit', async () => {
    const { app, dlrs } = monterAvec(2);
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode);
    expect(codes).toEqual([200, 200, 429, 429, 429]);
    expect(dlrs, 'un code qui fuite ne doit pas devenir un robinet d’écritures').toHaveLength(2);
  });

  /**
   * 🔴 LE DÉFAUT QUE LA REVUE A TROUVÉ DANS LA PREMIÈRE VERSION DE CE PLAFOND. Pris AVANT la base, il comptait
   * n'importe quel code bien formé : des codes inventés en masse remplissaient sa table bornée, et le VRAI code,
   * dont l'entrée expire à chaque fenêtre, était refusé. Même une table sans borne n'y échapperait pas en
   * mémoire. Ici, une table de DEUX places et cinquante codes inventés : le vrai doit toujours passer.
   */
  it('🔴 des codes inventés en masse n’évincent pas le vrai code', async () => {
    const { app, dlrs } = monterAvec(100, 2);
    const statuts = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const invente = `rcs-${i.toString(16).padStart(32, 'a')}`;
      statuts.add((await app.inject(post(`/rcs/callback/${invente}`, DLR_DELIVERED))).statusCode);
    }
    // Le vrai code d'abord : c'est LUI dont le refus est le symptôme du défaut. Asserté dans la boucle, le
    // 404 des codes inventés échouait avant, sur le troisième, et la mutation ne montrait pas ce qu'elle cassait.
    expect((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode, 'le vrai code du client').toBe(200);
    expect([...statuts], 'un code inventé est inconnu, rien de plus').toEqual([404]);
    expect(dlrs).toHaveLength(1);
  });

  /**
   * 🔴 LE SECOND CODE EXISTE, ET C'EST TOUT LE CAS (relecture finale du 2026-09-21). La version d'avant vérifiait
   * qu'un autre code rendait 404 : depuis que le plafond se prend APRÈS la lecture, un code inconnu est refusé
   * avant lui, et le test passait aussi avec une clé de limiteur CONSTANTE. Un code qui déborde ne doit pas
   * couper le canal d'un autre espace.
   */
  it('🔴 le plafond est PAR CODE : un code qui déborde ne coupe pas un autre code existant', async () => {
    const { app, dlrs } = monterAvec(1);
    expect((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode).toBe(200);
    expect((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode).toBe(429);
    expect((await app.inject(post(`/rcs/callback/${AUTRE_CODE}`, DLR_DELIVERED))).statusCode, 'le code d’un autre espace').toBe(200);
    expect(dlrs).toHaveLength(2);
  });

  it('🔴 le plafond de production laisse passer TROIS accusés par message au débit RCS maximal', () => {
    // Deux constantes de deux endroits, et c'est leur ÉCART qui porte l'invariant : un plafond de rappels
    // sous le débit réel des accusés ferait rejouer par smsmode tout le trafic d'une campagne.
    expect(config.RCS_CALLBACK_PAR_MINUTE).toBeGreaterThanOrEqual(3 * config.RCS_RATE_PER_MINUTE_MAX);
    // Et au débit le plus haut que la configuration accepte (600), pas seulement à celui d'aujourd'hui.
    expect(config.RCS_CALLBACK_PAR_MINUTE).toBeGreaterThanOrEqual(3 * 600);
  });

  /**
   * 🔴 LA SECONDE MOITIÉ DU CALCUL, DANS UN AUTRE FICHIER (relecture du 2026-09-21). Le débit RCS borne UN run ;
   * le plafond de rappels ne tient que si un seul run tourne à la fois par espace, donc par code d'agent. C'est
   * `campaign-run` en `groupConcurrency: 1`, groupé par `tenantId`. Relâcher l'un sans l'autre laisserait deux
   * campagnes additionner leurs accusés sur le même code, et smsmode rejouerait le surplus.
   */
  it('🔴 un seul run de campagne à la fois par espace, sans quoi le plafond se calcule faux', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/\{ concurrency: config\.CAMPAIGN_RUN_CONCURRENCY, groupConcurrency: 1 \}/);
  });

  /**
   * ⚠️ ET CHAQUE ENFILEMENT PORTE SON ESPACE COMME GROUPE (relecture du 2026-09-21). `groupConcurrency` ne sert à
   * rien sur un job sans `groupId`. Les enfilements ne vivent pas qu'au worker : le lancement par l'opérateur et
   * `src/campaign/enqueue.ts` en font aussi. On les DÉRIVE de `src/`, au lieu d'en recopier la liste.
   */
  it('🔴 tout enfilement de `campaign-run`, où qu’il soit, porte un groupId', () => {
    const fichiers = ['src/worker.ts', 'src/http/campaigns.ts', 'src/campaign/enqueue.ts'];
    const enfilements = fichiers.flatMap((f) =>
      readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n')
        .filter((l) => l.includes("enqueue('campaign-run'")).map((l) => ({ f, l: l.trim() })));
    // Le compte n'est pas écrit : un enfilement ajouté ailleurs doit être ajouté à la liste des fichiers.
    expect(enfilements.length).toBeGreaterThan(0);
    for (const { f, l } of enfilements) expect(l, f).toMatch(/groupId: \w+/);
  });

  it('⚠️ et aucun autre fichier de src/ n’enfile `campaign-run` sans être lu par le test ci-dessus', () => {
    const racine = new URL('../src/', import.meta.url);
    const connus = new Set(['worker.ts', 'http/campaigns.ts', 'campaign/enqueue.ts']);
    const parcourir = (dossier: URL, prefixe: string): string[] =>
      readdirSync(dossier, { withFileTypes: true }).flatMap((e) => e.isDirectory()
        ? parcourir(new URL(`${e.name}/`, dossier), `${prefixe}${e.name}/`)
        : e.name.endsWith('.ts') ? [`${prefixe}${e.name}`] : []);
    const inconnus = parcourir(racine, '').filter((f) => !connus.has(f)
      && readFileSync(new URL(f, racine), 'utf8').includes("enqueue('campaign-run'"));
    expect(inconnus, 'un nouvel enfilement doit porter un groupId et entrer dans la liste').toEqual([]);
  });
});

/**
 * 🔴 LE FREIN DES CODES JAMAIS VUS, AVANT LA BASE (décision de Julien du 2026-09-21). Le plafond par code se prend
 * APRÈS la lecture (sinon des codes inventés évinceraient le vrai) : un robot qui tire des codes bien formés
 * coûtait donc une lecture en base par essai. Un budget COMMUN borne ces lectures, sans rien retirer à un code
 * déjà résolu.
 */
describe('Rappels RCS : le frein des codes jamais vus', () => {
  function monter(budget: number, existe: (code: string) => boolean = (c) => c === CODE) {
    let lectures = 0;
    const app = Fastify();
    registerRcsCallback(app, {
      parCode: async (code) => { lectures += 1; return existe(code) ? { tenantId: 't1', agentId: 'ch-1' } : null; },
      onDlr: async () => {}, onMo: async () => {},
    }, new RateLimiter(10_000, 60_000), new RateLimiter(budget, 60_000));
    return { app, lectures: () => lectures };
  }
  const invente = (i: number): string => `rcs-${i.toString(16).padStart(32, 'b')}`;

  it('🔴 des codes inventés en masse ne coûtent que le budget en lectures, et le refus ne dit rien du budget', async () => {
    const { app, lectures } = monter(5);
    const refus: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i += 1) {
      const r = await app.inject(post(`/rcs/callback/${invente(i)}`, DLR_DELIVERED));
      if (r.statusCode === 429) refus.push(r.headers);
    }
    expect(lectures(), 'la base ne voit que le budget').toBe(5);
    expect(refus).toHaveLength(25);
    expect(Number(refus[0]!['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Object.keys(refus[0]!).filter((k) => k.startsWith('x-ratelimit')), 'l’état d’un budget commun').toEqual([]);
  });

  it('🔴 un code déjà résolu traverse une attaque qui a épuisé le budget', async () => {
    const { app } = monter(3);
    expect((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode).toBe(200);
    for (let i = 0; i < 20; i += 1) await app.inject(post(`/rcs/callback/${invente(i)}`, DLR_DELIVERED));
    expect((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode, 'le vrai canal du client').toBe(200);
  });

  it('🔴 un code qui ne se résout plus perd son laissez-passer', async () => {
    let actif = true;
    const { app, lectures } = monter(2, (c) => c === CODE && actif);
    expect((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode).toBe(200);
    actif = false;
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await app.inject(post(`/rcs/callback/${CODE}`, DLR_DELIVERED))).statusCode);
    // Le premier refus le trouve encore « connu », les suivants le renvoient au budget, qui finit par l'arrêter.
    expect(codes).toContain(429);
    expect(lectures()).toBeLessThanOrEqual(4);
  });

  it('à 0, le frein est désactivé : chaque code inventé va en base, comme avant', async () => {
    const { app, lectures } = monter(0);
    for (let i = 0; i < 10; i += 1) expect((await app.inject(post(`/rcs/callback/${invente(i)}`, DLR_DELIVERED))).statusCode).toBe(404);
    expect(lectures()).toBe(10);
  });
});
