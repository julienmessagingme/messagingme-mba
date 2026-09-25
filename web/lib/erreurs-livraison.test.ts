import { describe, it, expect } from 'vitest';
import { csvErreursLivraison, libelleOrigine } from './erreurs-livraison';
import type { ErreurLivraison } from './api/contacts';

/** `useT` en français, puis en anglais. */
const fr = (f: string): string => f;
const en = (f: string, e?: string): string => e ?? f;

const RCS_API: ErreurLivraison = {
  recipientId: 'e1', campaignId: null, campaignName: null, telephone: '+33612345678', contactId: 'c1', contactNom: null,
  code: null, message: 'UNDELIVERED', origine: 'message', origineMessage: 'api', canal: 'rcs', at: '2026-09-24T10:00:00.000Z',
};

describe('le journal des erreurs de livraison : l’origine, la même à l’écran et dans l’export', () => {
  it('🔴 un message libre non délivré dit son CANAL et sa PROVENANCE dans l’export, pas « message »', () => {
    const { entetes, lignes } = csvErreursLivraison([RCS_API], fr);
    expect(entetes).toEqual(['Date (ISO)', 'Campagne', 'Numéro', 'Code', 'Message', 'Origine']);
    expect(lignes).toEqual([['2026-09-24T10:00:00.000Z', '', '+33612345678', '', 'UNDELIVERED', 'RCS non délivré (envoi par l’API)']]);
  });

  it('WhatsApp depuis un bloc de scénario, puis une provenance inconnue ou absente : le canal seul', () => {
    expect(libelleOrigine({ origine: 'message', canal: 'whatsapp', origineMessage: 'scenario' }, fr)).toBe('message non délivré (bloc de scénario)');
    expect(libelleOrigine({ origine: 'message', canal: 'rcs', origineMessage: 'inconnue' }, fr)).toBe('RCS non délivré');
    expect(libelleOrigine({ origine: 'message', canal: 'whatsapp', origineMessage: null }, fr)).toBe('message non délivré');
  });

  it('les trois autres origines : les mots de l’écran, en anglais aussi', () => {
    expect(libelleOrigine({ origine: 'envoi' }, fr)).toBe('jamais parti');
    expect(libelleOrigine({ origine: 'livraison' }, fr)).toBe('parti, non délivré');
    expect(libelleOrigine({ origine: 'scenario' }, fr)).toBe('scénario bloqué sur une réponse');
    expect(libelleOrigine({ origine: 'livraison' }, en)).toBe('sent, not delivered');
    expect(csvErreursLivraison([RCS_API], en).lignes[0]![5]).toBe('RCS not delivered (API send)');
  });
});
