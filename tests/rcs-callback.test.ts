import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import {
  parseRcsDlr, parseRcsMo, estDlr, statutDepuisSmsmode, estDemandeArret, urlRappelRcs,
} from '../src/rcs/callback';
import type { RcsDlr, RcsMo } from '../src/rcs/callback';

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
  it('distingue un rapport de livraison (MT) d une reponse (MO)', () => {
    expect(estDlr(DLR_DELIVERED)).toBe(true);
    expect(estDlr(MO_SUGGESTION)).toBe(false);
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
    });
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

  it('reconnait un STOP en tete de message, et PAS un stop au milieu d une phrase', () => {
    for (const t of ['STOP', 'stop', ' Stop ', 'stop svp', 'désabonner', 'unsubscribe']) {
      expect(estDemandeArret(t)).toBe(true);
    }
    for (const t of ['je ne peux pas stopper la', 'non stop merci ?', null, '']) {
      expect(estDemandeArret(t)).toBe(false);
    }
  });

  it('construit une adresse de rappel qui passe par la reecriture du front', () => {
    expect(urlRappelRcs('https://mba.messagingme.app/', CODE))
      .toBe(`https://mba.messagingme.app/api/backend/rcs/callback/${CODE}`);
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
