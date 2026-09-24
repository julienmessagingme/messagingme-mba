import { describe, it, expect } from 'vitest';
import { processStatuses } from '../src/webhooks/delivery';
import type { DeliveryStore, DeliveryStatus, EchecsLibresSink } from '../src/webhooks/delivery';
import { handleWebhookJob } from '../src/webhooks/handler';
import type { WebhookEvent } from '../src/webhooks/parse';
import { aucunTarif } from './webhook-fixtures';

/**
 * L'ÉCHEC D'UN MESSAGE LIBRE N'ÉTAIT ÉCRIT NULLE PART (défaut 4 de la spec 2026-09-24).
 *
 * Seul `wamid.campagne` est un destinataire de campagne : tout autre identifiant n'en touche aucun.
 */
class Livraison implements DeliveryStore {
  async updateDeliveryByMessageId(messageId: string, _s: DeliveryStatus): Promise<number> {
    return messageId === 'wamid.campagne' ? 1 : 0;
  }
}

function puits() {
  const notes: Array<{ messageId: string; code: number | null; motif: string | null; tenantId?: string }> = [];
  const sink: EchecsLibresSink = { noter: async (e) => { notes.push(e); return null; } };
  return { notes, sink };
}

const statut = (id: string, status: string, erreur?: { code: number; title: string }): WebhookEvent => ({
  source: 'statuses',
  dedupKey: `status:${id}:${status}`,
  data: { id, status, ...(erreur ? { errors: [erreur] } : {}) },
});

const INJOIGNABLE = { code: 131026, title: 'Message undeliverable' };

describe('processStatuses : l’échec d’un message LIBRE', () => {
  it('🔴 un échec qui ne touche aucun destinataire de campagne est NOTÉ, avec son code et son motif', async () => {
    const { notes, sink } = puits();
    await processStatuses([statut('wamid.libre', 'failed', INJOIGNABLE)], new Livraison(), { tarifs: aucunTarif, echecsLibres: sink });
    expect(notes).toEqual([{ messageId: 'wamid.libre', code: 131026, motif: '131026 Message undeliverable' }]);
  });

  it('🔴 l’échec d’un destinataire de campagne n’en écrit PAS de second', async () => {
    const { notes, sink } = puits();
    await processStatuses(
      [statut('wamid.campagne', 'failed', INJOIGNABLE), statut('wamid.libre', 'failed', INJOIGNABLE)],
      new Livraison(), { tarifs: aucunTarif, echecsLibres: sink },
    );
    // L'ancre positive est le second : le mécanisme a bien tourné sur ce lot.
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.libre']);
  });

  it('un statut ordinaire ne coûte rien : sent, delivered et read ne notent jamais', async () => {
    const { notes, sink } = puits();
    await processStatuses(
      [statut('wamid.a', 'sent'), statut('wamid.a', 'delivered'), statut('wamid.a', 'read'), statut('wamid.b', 'failed', INJOIGNABLE)],
      new Livraison(), { tarifs: aucunTarif, echecsLibres: sink },
    );
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.b']);
  });

  it('🔴 un journal en panne ne fait pas échouer le job (pg-boss le rejouerait en entier)', async () => {
    const enPanne: EchecsLibresSink = { noter: async () => { throw new Error('base indisponible'); } };
    await expect(processStatuses([statut('wamid.libre', 'failed', INJOIGNABLE)], new Livraison(), { tarifs: aucunTarif, echecsLibres: enPanne }))
      .resolves.toBeUndefined();
  });

  it('🔴 le traitement d’un webhook transmet le puits jusqu’aux statuts', async () => {
    const { notes, sink } = puits();
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pn1' },
        statuses: [{ id: 'wamid.h1', status: 'failed', errors: [INJOIGNABLE] }],
      } }] }],
    }, { store: { insertEvent: async () => true }, delivery: new Livraison(), tarifsMeta: aucunTarif, echecsLibres: sink });
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.h1']);
  });
});
