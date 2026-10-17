import { describe, it, expect } from 'vitest';
import { nAQueDesAccuses, parseWebhook } from '../src/webhooks/parse';
import { destinataireDuStatut, extractDelivery, instantDuStatut } from '../src/webhooks/delivery';
import { extraireTarif } from '../src/webhooks/tarif-meta';
import { corpsAccuse, numeroAccuses, palierTenu, waIdDe, wamidDe } from '../scripts/banc-accuses';

/**
 * 🔴 LES ACCUSÉS DU BANC SONT CEUX QUE LE CODE LIT (point P1 de l'audit du 2026-10-17). Le banc du 14 octobre envoyait
 * des accusés pour des messages inexistants : il a mesuré du vide sans que rien ne le signale. Ce test passe chaque
 * accusé fabriqué par les VRAIES fonctions de la réception et du traitement : s'il cesse d'être reconnu, le banc
 * cesse d'être croyable, et c'est ici qu'on le voit, pas dans ses chiffres.
 */
describe('banc des accusés : ce qu’il envoie est un vrai accusé', () => {
  const corps = (statut: 'sent' | 'delivered' | 'read') => JSON.parse(corpsAccuse(7, 42, statut, 1_760_000_000)) as unknown;

  it('🔴 un lot d’accusés seuls, rangé sur `webhook-status`', () => {
    for (const s of ['sent', 'delivered', 'read'] as const) expect(nAQueDesAccuses(corps(s))).toBe(true);
  });

  it('🔴 le traitement y lit le message semé, son statut, son destinataire et son instant', () => {
    const [ev] = parseWebhook(corps('delivered'));
    expect(ev?.source).toBe('statuses');
    expect(ev?.phoneNumberId).toBe(numeroAccuses(7));
    expect(extractDelivery(ev?.data)).toEqual({ messageId: wamidDe(7, 42), status: 'delivered', error: null, errorCode: null });
    expect(destinataireDuStatut(ev?.data)).toBe(waIdDe(7, 42));
    expect(instantDuStatut(ev?.data)).toBe(new Date(1_760_000_000_000).toISOString());
  });

  it('🔴 `sent` et `delivered` portent le tarif de Meta, `read` non', () => {
    const tarif = (s: 'sent' | 'delivered' | 'read') => extraireTarif(parseWebhook(corps(s))[0]?.data);
    expect(tarif('sent')).toMatchObject({ messageId: wamidDe(7, 42), categorie: 'marketing', facturable: true });
    expect(tarif('delivered')).not.toBeNull();
    expect(tarif('read')).toBeNull();
  });

  it('le verdict d’un palier : sous l’objectif, rien en souffrance, aucun refus de la réception', () => {
    const r = { termines: 100, restants: 0, reprises: 0, p50: 2, p95: 30, max: 50 };
    expect(palierTenu(r, r, 120, 0)).toBe(true);
    expect(palierTenu({ ...r, p95: 121 }, r, 120, 0)).toBe(false);
    expect(palierTenu({ ...r, restants: 3 }, r, 120, 0)).toBe(false);
    expect(palierTenu(r, r, 120, 1)).toBe(false);
    expect(palierTenu({ ...r, termines: 0 }, r, 120, 0)).toBe(false);
  });

  it('🔴 une file qui déborde lentement ne passe pas : le dernier quart du palier est jugé à part', () => {
    // Le p95 du palier entier reste sous l'objectif, celui du dernier quart le dépasse : la file ne suit pas.
    const palier = { termines: 3000, restants: 0, reprises: 0, p50: 20, p95: 80, max: 140 };
    const dernierQuart = { termines: 750, restants: 0, reprises: 0, p50: 110, p95: 135, max: 140 };
    expect(palierTenu(palier, dernierQuart, 120, 0)).toBe(false);
  });
});
