import { describe, it, expect } from 'vitest';
import { handleWebhookJob } from '../src/webhooks/handler';
import { destinataireDuStatut, instantDuStatut, type AccuseDuStatut } from '../src/webhooks/delivery';
import { processInbound, type InboundMessage } from '../src/webhooks/inbound';
import { aucunTarif, aucunEchecLibre, aucuneArriveePub, aucunRoutagePub } from './webhook-fixtures';

/**
 * LES POINTS D'ACCROCHE DES SIGNAUX sur les webhooks Meta (spec 2026-09-24, § 8). Ce test ne dit rien du coût
 * (c'est le puits qui décide de ne rien lire, `tests/signaux-emetteur.test.ts`) : il dit que CHAQUE accusé et
 * CHAQUE entrant arrive au puits, et qu'un puits en panne ne fait rien échouer.
 */
const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const statuts = (...s: Array<Record<string, unknown>>) => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: s } }] }],
});
const entrant = (type: string, extra: Record<string, unknown>) => ({
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'PN1' },
    contacts: [{ wa_id: '33612345678' }],
    messages: [{ id: 'wamid.in1', from: '33612345678', type, timestamp: '1790000000', ...extra }],
  } }] }],
});
const store = { insertEvent: async () => true };
const delivery = { updateDeliveryByMessageId: async () => 1 };

describe('les accusés Meta passent au puits des signaux', () => {
  it('🔴 chaque accusé, avec son numéro, son destinataire, son motif et son instant', async () => {
    const vus: Array<{ pn: string; a: AccuseDuStatut }> = [];
    await handleWebhookJob(statuts(
      { id: 'wamid.1', status: 'delivered', recipient_id: '33612345678', timestamp: '1790000000' },
      { id: 'wamid.2', status: 'failed', recipient_id: '33612345678', errors: [{ code: 131026, title: 'Message undeliverable' }] },
    ), { store, delivery, tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre, signauxAccuse: async (pn, a) => { vus.push({ pn, a }); } });
    expect(vus).toEqual([
      { pn: 'PN1', a: { messageId: 'wamid.1', status: 'delivered', waId: '33612345678', motif: null, codeMeta: null, le: new Date(1790000000 * 1000).toISOString() } },
      { pn: 'PN1', a: { messageId: 'wamid.2', status: 'failed', waId: '33612345678', motif: '131026 Message undeliverable', codeMeta: 131026, le: null } },
    ]);
  });

  it('🔴 un puits en panne ne fait pas échouer la livraison, qui est la donnée métier', async () => {
    const maj: string[] = [];
    await expect(handleWebhookJob(statuts({ id: 'wamid.3', status: 'read', recipient_id: '336' }), {
      store,
      delivery: { updateDeliveryByMessageId: async (id) => { maj.push(id); return 1; } },
      tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre,
      signauxAccuse: async () => { throw new Error('file indisponible'); },
    })).resolves.toBeUndefined();
    expect(maj).toEqual(['wamid.3']);
  });

  it('un accusé sans numéro Meta (aucun rattachement à un espace) ne va pas au puits', async () => {
    const vus: string[] = [];
    await handleWebhookJob({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.4', status: 'read' }] } }] }] }, {
      store, delivery, tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre, signauxAccuse: async (_pn, a) => { vus.push(a.messageId); },
    });
    expect(vus).toEqual([]);
  });

  it('les deux lecteurs du statut ne lèvent jamais', () => {
    expect(destinataireDuStatut({ recipient_id: '336' })).toBe('336');
    expect(destinataireDuStatut({ recipient_id: '' })).toBeNull();
    expect(destinataireDuStatut(null)).toBeNull();
    expect(instantDuStatut({ timestamp: '1790000000' })).toBe(new Date(1790000000 * 1000).toISOString());
    expect(instantDuStatut({ timestamp: 'demain' })).toBeNull();
    expect(instantDuStatut('x')).toBeNull();
  });
});

describe('les entrants Meta passent au puits des signaux', () => {
  const inbox = { phoneNumberTenant: async () => T, recordInbound: async () => {} };

  it('🔴 la réponse passe au puits APRÈS son enregistrement, avec son espace', async () => {
    const ordre: string[] = [];
    await processInbound(
      entrant('text', { text: { body: 'bonjour' } }),
      { phoneNumberTenant: async () => T, recordInbound: async () => { ordre.push('enregistre'); } },
      { signalReponse: async (t, m: InboundMessage) => { ordre.push(`signal:${t}:${m.messageId}`); } },
    );
    expect(ordre).toEqual(['enregistre', `signal:${T}:wamid.in1`]);
  });

  it('🔴 un puits en panne ne fait pas échouer la réception', async () => {
    let enregistres = 0;
    await expect(processInbound(
      entrant('text', { text: { body: 'bonjour' } }),
      { phoneNumberTenant: async () => T, recordInbound: async () => { enregistres += 1; } },
      { signalReponse: async () => { throw new Error('file indisponible'); } },
    )).resolves.toBeUndefined();
    expect(enregistres).toBe(1);
  });

  it('🔴 l’ÉCHO de l’agent de Meta (`message_echoes`) n’arrive PAS au puits : ce n’est pas une réponse du contact', async () => {
    // Forme RÉELLE, reprise de `tests/webhooks-change.test.ts` (STANDBY_ECHO) : l'écho vit sous
    // `standby.message_echoes`, que seul `processHandovers` lit. `extractInbound` ne lit que `messages`.
    const vus: string[] = [];
    await processInbound({ entry: [{ changes: [{ field: 'standby', value: {
      metadata: { phone_number_id: 'PN1' },
      standby: { message_echoes: [{ id: 'wamid.echo', message: { to: '33612345678', type: 'text', text: { body: 'Réponse de l’agent' } }, timestamp: '1790000000' }] },
    } }] }] }, inbox, { signalReponse: async (_t, m) => { vus.push(m.messageId); } });
    expect(vus).toEqual([]);
  });

  it('un message du CLIENT en `standby` (l’agent de Meta tient le fil) arrive au puits : il a bien répondu', async () => {
    // Forme RÉELLE (STANDBY_ENTRANT, essais de Julien du 2026-09-16) : le texte du client, avec son `from`.
    const vus: string[] = [];
    await processInbound({ entry: [{ changes: [{ field: 'standby', value: {
      metadata: { phone_number_id: 'PN1' },
      standby: {
        contacts: [{ wa_id: '33612345678' }],
        messages: [{ id: 'wamid.sb', from: '33612345678', type: 'text', text: { body: 'je veux un conseiller' }, timestamp: '1790000000' }],
      },
    } }] }] }, inbox, { signalReponse: async (_t, m) => { vus.push(`${m.field}:${m.messageId}`); } });
    expect(vus).toEqual(['standby:wamid.sb']);
  });

  it('le handler transmet le puits à la réception', async () => {
    const vus: string[] = [];
    await handleWebhookJob(entrant('button', { button: { text: 'Oui', payload: 'Oui' } }), {
      store,
      inbox: { phoneNumberTenant: async () => T, recordInbound: async () => {} },
      arriveesPub: aucuneArriveePub,
      routagePub: aucunRoutagePub,
      signalReponse: async (_t, m) => { vus.push(`${m.type}:${m.body}`); },
    });
    expect(vus).toEqual(['button:Oui']);
  });
});
