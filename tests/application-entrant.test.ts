import { describe, it, expect } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { OPTIONS_SOCKET, completerNumero, versMessageApplication, type MessageApplication } from '../src/application/transport/session';
import { lireJobEntrant, traiterEntrantApplication, versInboundMessage, type DepsEntrantApplication } from '../src/application/entrant';
import type { JobEntrant } from '../src/application/sessions';
import type { InboundMessage } from '../src/webhooks/inbound';
import { aucuneCorrectionDuDetenteur } from './webhook-fixtures';

/**
 * RECEVOIR, FILIÈRE APPLICATION (plan 2026-10-22, tâche 4). Le service de connexions verse chaque message dans la file
 * `application-entrant` ; le worker l'enregistre par l'ingestion commune (`processInbound` : fiche, STOP, écriture,
 * détenteur), puis la remise commune décide si l'agent IA répond.
 */

const brut = (cle: Record<string, unknown>, message: Record<string, unknown> = { conversation: 'Bonjour' }): WAMessage =>
  ({ key: { id: 'WA1', fromMe: false, ...cle }, message, pushName: 'Alice', messageTimestamp: 1_760_000_000 }) as unknown as WAMessage;

describe('le message de Baileys, côté service de connexions', () => {
  it('🔴 un groupe et un statut sont écartés : seules les conversations individuelles entrent', () => {
    expect(versMessageApplication(brut({ remoteJid: '120363000000000000@g.us', participant: '33612345678@s.whatsapp.net' }))).toBeNull();
    expect(versMessageApplication(brut({ remoteJid: 'status@broadcast', participant: '33612345678@s.whatsapp.net' }))).toBeNull();
  });

  it('un contact par son numéro garde ses chiffres', () => {
    const m = versMessageApplication(brut({ remoteJid: '33612345678@s.whatsapp.net' }));
    expect(m).toMatchObject({ id: 'WA1', jid: '33612345678@s.whatsapp.net', numero: '33612345678', deMoi: false, type: 'text', texte: 'Bonjour', nom: 'Alice' });
  });

  it('un contact masqué donne son numéro quand WhatsApp le joint au message reçu', () => {
    const m = versMessageApplication(brut({ remoteJid: '123456789012345@lid', senderPn: '33612345678@s.whatsapp.net' }));
    expect(m).toMatchObject({ jid: '123456789012345@lid', numero: '33612345678' });
  });

  it('🔴 un message tapé sur le téléphone vers un contact masqué ne prend PAS le numéro joint : c’est le nôtre', () => {
    const m = versMessageApplication(brut({ remoteJid: '123456789012345@lid', fromMe: true, senderPn: '447700900000@s.whatsapp.net' }));
    expect(m).toMatchObject({ deMoi: true, numero: null });
  });

  it('🔴 nos propres envois ne reviennent pas comme des messages : sinon chaque réponse de l’agent vaudrait une prise de main', () => {
    expect(OPTIONS_SOCKET.emitOwnEvents).toBe(false);
  });
});

describe('le numéro d’un contact masqué, appris et retrouvé', () => {
  const memoire = () => {
    const m = new Map<string, string>();
    return { m, retenir: async (lid: string, n: string) => { m.set(lid, n); }, numeroDe: async (lid: string) => m.get(lid) ?? null };
  };
  const msg = (p: Partial<MessageApplication>): MessageApplication => ({
    id: 'WA1', jid: '123456789012345@lid', deMoi: false, nom: null, horodatage: new Date(0), type: 'text', texte: 'x', numero: null, ...p,
  });

  it('🔴 la réponse tapée sur le téléphone retrouve le numéro appris du message reçu : même conversation', async () => {
    const c = memoire();
    await completerNumero(msg({ numero: '33612345678' }), c);
    expect(await completerNumero(msg({ deMoi: true }), c)).toMatchObject({ numero: '33612345678' });
  });

  it('sans rien d’appris, le message garde l’identifiant masqué', async () => {
    expect(await completerNumero(msg({ deMoi: true }), memoire())).toMatchObject({ numero: null });
  });

  it('un contact par son numéro ne touche pas aux correspondances', async () => {
    const c = memoire();
    await completerNumero(msg({ jid: '33612345678@s.whatsapp.net', numero: '33612345678' }), c);
    expect(c.m.size).toBe(0);
  });
});

const COMPTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID = `app:${COMPTE}:WA1`;
const job = (p: Partial<JobEntrant['message']> = {}): JobEntrant => ({
  tenantId: 'bbbbbbbb-0000-4000-8000-000000000002',
  compteId: COMPTE,
  message: {
    id: 'WA1', jid: '33612345678@s.whatsapp.net', deMoi: false, nom: 'Alice', horodatage: '2026-10-22T10:00:00.000Z',
    type: 'text', texte: 'Bonjour', numero: '33612345678', ...p,
  },
});

describe('le job de la file, côté worker', () => {
  it('🔴 un job mal formé est refusé, pas deviné', () => {
    expect(lireJobEntrant(job())).toEqual(job());
    expect(lireJobEntrant({ tenantId: 't1' })).toBeNull();
    expect(lireJobEntrant({ ...job(), message: { ...job().message, type: 'reaction' } })).toBeNull();
  });

  it('devient un message entrant comme ceux de Meta, à l’identifiant préfixé par le compte', () => {
    // Préfixé par le compte : l'identifiant est unique pour toute la base, et deux de nos comptes qui s'écrivent
    // recevraient le même identifiant WhatsApp.
    expect(versInboundMessage(job())).toEqual({
      phoneNumberId: '', waId: '33612345678', messageId: ID, type: 'text', body: 'Bonjour',
      buttonPayload: null, profileName: 'Alice', field: 'messages', envoyeLe: new Date('2026-10-22T10:00:00.000Z'),
    });
  });

  it('un contact masqué sans numéro garde son identifiant masqué comme wa_id', () => {
    expect(versInboundMessage(job({ jid: '123456789012345@lid', numero: null }))?.waId).toBe('123456789012345@lid');
  });

  it('un média entre comme un message de son type, sans téléchargement', () => {
    expect(versInboundMessage(job({ type: 'audio', texte: null }))).toMatchObject({ type: 'audio', body: '[audio]' });
    expect(versInboundMessage(job({ type: 'image', texte: 'La facture' }))).toMatchObject({ type: 'image', body: 'La facture' });
  });

  it('🔴 un groupe arrivé quand même est ignoré', () => {
    expect(versInboundMessage(job({ jid: '120363000000000000@g.us', numero: null }))).toBeNull();
  });
});

function banc() {
  const traces: string[] = [];
  const enregistres = new Set<string>();
  const deps: DepsEntrantApplication = {
    dejaRecu: async (_t, id) => enregistres.has(id),
    inbox: {
      async recordInbound(_t, m: InboundMessage) {
        traces.push(`in:${m.waId}:${m.messageId}`);
        enregistres.add(m.messageId);
        return { rouverte: false };
      },
      async recordOutboundByWaId(_t, waId, msg) {
        traces.push(`out:${waId}:${msg.messageId}:${msg.origine}`);
        if (msg.messageId) enregistres.add(msg.messageId);
      },
    },
    entrants: {
      upsertContact: async (_t, m) => { traces.push(`contact:${m.waId}`); return 'created'; },
      optOut: async (_t, waId, id) => { traces.push(`stop:${waId}:${id}`); return 'c1'; },
      detenteur: aucuneCorrectionDuDetenteur,
    },
    remise: { remettre: async (_t, waId, contenu, e) => { traces.push(`remise:${waId}:${contenu}:${e.messageDeclencheur}:${e.redelivre}`); } },
    priseDeMain: async (_t, waId) => { traces.push(`main:${waId}`); },
  };
  return { traces, deps };
}

describe('traiter un message reçu', () => {
  it('enregistre, crée la fiche, et passe la main à la remise qui décide si l’agent répond', async () => {
    const { traces, deps } = banc();
    await traiterEntrantApplication(job(), deps);
    expect(traces).toEqual(['contact:33612345678', `in:33612345678:${ID}`, `remise:33612345678:Bonjour:${ID}:false`]);
  });

  it('🔴 cas 1 : le même message redonné deux fois n’est enregistré et remis qu’une fois', async () => {
    const { traces, deps } = banc();
    await traiterEntrantApplication(job(), deps);
    await traiterEntrantApplication(job(), deps);
    expect(traces.filter((t) => t.startsWith('in:'))).toHaveLength(1);
    expect(traces.filter((t) => t.startsWith('remise:'))).toHaveLength(1);
  });

  it('🔴 un STOP désabonne le contact, avant la remise', async () => {
    const { traces, deps } = banc();
    await traiterEntrantApplication(job({ texte: 'STOP' }), deps);
    expect(traces.indexOf(`stop:33612345678:${ID}`)).toBeGreaterThan(-1);
    expect(traces.indexOf(`stop:33612345678:${ID}`)).toBeLessThan(traces.findIndex((t) => t.startsWith('remise:')));
  });

  it('🔴 un message tapé sur le téléphone est une réponse humaine qui prend le fil, et l’agent n’est pas sollicité', async () => {
    const { traces, deps } = banc();
    await traiterEntrantApplication(job({ deMoi: true, texte: 'Je m’en occupe' }), deps);
    expect(traces).toEqual([`out:33612345678:${ID}:humain`, 'main:33612345678']);
  });

  it('un message tapé sur le téléphone redonné ne reprend pas le fil une seconde fois', async () => {
    const { traces, deps } = banc();
    await traiterEntrantApplication(job({ deMoi: true }), deps);
    await traiterEntrantApplication(job({ deMoi: true }), deps);
    expect(traces.filter((t) => t.startsWith('main:'))).toHaveLength(1);
  });
});
