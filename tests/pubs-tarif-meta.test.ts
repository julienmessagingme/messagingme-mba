import { describe, it, expect } from 'vitest';
import { extraireTarif, TYPE_ENTREE_GRATUITE, type TarifMeta } from '../src/webhooks/tarif-meta';
import { processStatuses } from '../src/webhooks/delivery';
import type { DeliveryStore, DeliveryStatus } from '../src/webhooks/delivery';
import type { WebhookEvent } from '../src/webhooks/parse';
import { handleWebhookJob } from '../src/webhooks/handler';
import { aucunEchecLibre, aucunSignalAccuse } from './webhook-fixtures';

const accuse = (id: string, status: string, pricing?: unknown): unknown =>
  ({ id, status, ...(pricing === undefined ? {} : { pricing }) });

describe('extraireTarif', () => {
  it('lit le tarif de la fenêtre gratuite qui suit un clic sur une pub', () => {
    expect(extraireTarif(accuse('wamid.A', 'sent', { billable: false, pricing_model: 'PMP', type: 'free_entry_point', category: 'referral_conversion' })))
      .toEqual({ messageId: 'wamid.A', type: TYPE_ENTREE_GRATUITE, categorie: 'referral_conversion', facturable: false, modele: 'PMP' });
  });

  it('lit un tarif ordinaire', () => {
    expect(extraireTarif(accuse('wamid.B', 'delivered', { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' }))?.type)
      .toBe('regular');
  });

  it('garde tel quel un type que le code ne connaît pas', () => {
    expect(extraireTarif(accuse('wamid.C', 'sent', { type: 'nouveau_type_meta' })))
      .toEqual({ messageId: 'wamid.C', type: 'nouveau_type_meta', categorie: null, facturable: null, modele: null });
  });

  it('sans pricing, sans type ou illisible : null, et le message reste compté comme payant', () => {
    expect(extraireTarif(accuse('wamid.D', 'read'))).toBeNull();
    expect(extraireTarif(accuse('wamid.E', 'sent', { billable: true }))).toBeNull();
    expect(extraireTarif(accuse('wamid.F', 'sent', { type: 'regular', billable: 'oui' }))).toBeNull();
    expect(extraireTarif(accuse('', 'sent', { type: 'regular' }))).toBeNull();
    expect(extraireTarif(null)).toBeNull();
  });
});

class FakeDelivery implements DeliveryStore {
  readonly calls: string[] = [];
  async updateDeliveryByMessageId(messageId: string, status: DeliveryStatus): Promise<number> {
    this.calls.push(`${messageId}:${status}`);
    return 1;
  }
}

const statut = (id: string, status: string, pricing?: unknown, phoneNumberId: string | null = 'pn1'): WebhookEvent => ({
  source: 'statuses',
  dedupKey: `status:${id}:${status}`,
  data: accuse(id, status, pricing),
  ...(phoneNumberId ? { phoneNumberId } : {}),
});

describe('processStatuses : le tarif de Meta', () => {
  const gratuit = { type: 'free_entry_point', category: 'referral_conversion', billable: false };

  it('enregistre le tarif, rattaché au numéro destinataire de l’accusé', async () => {
    const vus: Array<{ pn: string; t: TarifMeta }> = [];
    await processStatuses([statut('wamid.1', 'sent', gratuit)], new FakeDelivery(), {
      echecsLibres: aucunEchecLibre,
      tarifs: { enregistrer: async (pn, t) => { vus.push({ pn, t }); } },
    });
    expect(vus).toEqual([{ pn: 'pn1', t: { messageId: 'wamid.1', type: 'free_entry_point', categorie: 'referral_conversion', facturable: false, modele: null } }]);
  });

  it('sans numéro destinataire, rien n’est enregistré (aucun espace à qui rattacher la ligne)', async () => {
    let n = 0;
    await processStatuses([statut('wamid.2', 'sent', gratuit, null)], new FakeDelivery(), {
      echecsLibres: aucunEchecLibre,
      tarifs: { enregistrer: async () => { n += 1; } },
    });
    expect(n).toBe(0);
  });

  it('🔴 un échec d’écriture du tarif ne bloque ni la livraison ni le job', async () => {
    const delivery = new FakeDelivery();
    await expect(processStatuses([statut('wamid.3', 'delivered', gratuit)], delivery, {
      echecsLibres: aucunEchecLibre,
      tarifs: { enregistrer: async () => { throw new Error('base indisponible'); } },
    })).resolves.toBeUndefined();
    expect(delivery.calls).toEqual(['wamid.3:delivered']);
  });

  it('le tarif est lu même sur un statut que la livraison ignore', async () => {
    const vus: string[] = [];
    await processStatuses([statut('wamid.4', 'warning', { type: 'regular' })], new FakeDelivery(), {
      echecsLibres: aucunEchecLibre,
      tarifs: { enregistrer: async (_pn, t) => { vus.push(t.messageId); } },
    });
    expect(vus).toEqual(['wamid.4']);
  });
});

describe('handleWebhookJob : le tarif des accusés', () => {
  it('passe le tarif au puits, avec le numéro destinataire du change', async () => {
    const vus: string[] = [];
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pn9' },
        statuses: [{ id: 'wamid.h1', status: 'sent', pricing: { type: 'free_entry_point', category: 'referral_conversion', billable: false } }],
      } }] }],
    }, {
      store: { insertEvent: async () => true },
      delivery: new FakeDelivery(),
      echecsLibres: aucunEchecLibre,
      signauxAccuse: aucunSignalAccuse,
      tarifsMeta: { enregistrer: async (pn, t) => { vus.push(`${pn}:${t.messageId}:${t.type}`); } },
    });
    expect(vus).toEqual(['pn9:wamid.h1:free_entry_point']);
  });
});
