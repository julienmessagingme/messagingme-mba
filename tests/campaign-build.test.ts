import { describe, it, expect } from 'vitest';
import { buildRecipients } from '../src/campaign/build';
import type { BuildContact } from '../src/campaign/build';
import type { TemplateParam } from '../src/crm/template';

const mapping: TemplateParam[] = [{ position: 1, source: { type: 'attribute', key: 'name' } }];

const contacts: BuildContact[] = [
  { id: 'c1', phone_e164: '+33611111111', profile_name: 'Julie', optInStatus: 'opted_in' },
  { id: 'c2', phone_e164: '+33622222222', profile_name: 'Marc', optInStatus: 'unknown' },
  { id: 'c3', phone_e164: '+33611111111', profile_name: 'Doublon', optInStatus: 'opted_in' },
  { id: 'c4', phone_e164: null, profile_name: 'SansTel', optInStatus: 'opted_in' },
];

describe('buildRecipients', () => {
  it('marketing : opt-in filtré, dédup par numéro, params résolus', () => {
    const { recipients } = buildRecipients('marketing', mapping, contacts);
    expect(recipients.map((x) => x.contactId)).toEqual(['c1']); // c2 non opt-in, c3 doublon, c4 sans tel
    expect(recipients[0]?.resolvedParams).toEqual(['Julie']);
  });

  it('utility : inclut les contacts sans opt-in explicite', () => {
    const { recipients } = buildRecipients('utility', mapping, contacts);
    expect(recipients.map((x) => x.contactId)).toEqual(['c1', 'c2']); // c3 doublon, c4 sans tel
  });

  it('cible un contact SANS numéro par son BSUID (destinataire = bsuid)', () => {
    const withBsuid: BuildContact[] = [
      { id: 'b1', phone_e164: null, bsuid: 'BS_123', profile_name: 'Anon', optInStatus: 'opted_in' },
    ];
    const { recipients } = buildRecipients('marketing', mapping, withBsuid);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ contactId: 'b1', toE164: 'BS_123' });
  });

  it('numéro prioritaire sur le BSUID ; dédup par identité', () => {
    const mixed: BuildContact[] = [
      { id: 'p1', phone_e164: '+33699999999', bsuid: 'BS_A', profile_name: 'A', optInStatus: 'opted_in' },
      { id: 'b2', phone_e164: null, bsuid: 'BS_B', profile_name: 'B', optInStatus: 'opted_in' },
      { id: 'b3', phone_e164: null, bsuid: 'BS_B', profile_name: 'Doublon BSUID', optInStatus: 'opted_in' },
    ];
    const { recipients } = buildRecipients('marketing', mapping, mixed);
    expect(recipients.map((x) => x.toE164)).toEqual(['+33699999999', 'BS_B']); // p1 par numéro, b3 = doublon de b2
  });

  it('variable manquante (prénom absent) -> destinataire SAUTÉ + recensé dans skipped (jamais un envoi vide)', () => {
    const prenom: TemplateParam[] = [{ position: 1, source: { type: 'field', key: 'prenom' } }];
    const list: BuildContact[] = [
      { id: 'ok', phone_e164: '+33611111111', fields: { prenom: 'Marie' }, optInStatus: 'opted_in' },
      { id: 'ko', phone_e164: '+33622222222', fields: {}, optInStatus: 'opted_in' },
    ];
    const { recipients, skipped } = buildRecipients('marketing', prenom, list);
    expect(recipients.map((x) => x.contactId)).toEqual(['ok']);
    expect(recipients[0]?.resolvedParams).toEqual(['Marie']);
    expect(skipped).toEqual([{ contactId: 'ko', toE164: '+33622222222', reason: 'missing_variable', missing: [1] }]);
  });
});

/**
 * Un contact écarté faute d'opt-in doit être RAPPORTÉ, pas jeté en silence.
 *
 * Vécu : une campagne marketing montée sur une liste HubSpot rendait 0 destinataire et l'écran accusait la
 * variable de template, seul motif qu'il connaissait. Le motif existait déjà sur la voie API
 * (`buildApiRecipients`), il manquait sur la voie écran, celle que l'opérateur utilise.
 */
describe('buildRecipients : motif de l’écart pour opt-in', () => {
  it('marketing : le contact sans opt-in part dans `skipped` avec le motif, pas dans le vide', () => {
    const { recipients, skipped } = buildRecipients('marketing', mapping, contacts);
    expect(recipients.map((x) => x.contactId)).toEqual(['c1']);
    expect(skipped).toEqual([{ contactId: 'c2', toE164: '+33622222222', reason: 'not_opted_in' }]);
  });

  it('un opt-OUT est écarté avec le même motif, y compris en utility', () => {
    const optOut: BuildContact[] = [{ id: 'x', phone_e164: '+33699999999', profile_name: 'Non', optInStatus: 'opted_out' }];
    const { recipients, skipped } = buildRecipients('utility', mapping, optOut);
    expect(recipients).toEqual([]);
    expect(skipped[0]).toMatchObject({ contactId: 'x', reason: 'not_opted_in' });
  });

  it('utility : un contact `unknown` PASSE (non-régression, la fenêtre de service le couvre)', () => {
    const { recipients, skipped } = buildRecipients('utility', mapping, contacts);
    expect(recipients.map((x) => x.contactId)).toEqual(['c1', 'c2']);
    expect(skipped).toEqual([]);
  });

  it('les deux motifs coexistent sans se mélanger', () => {
    const melange: BuildContact[] = [
      { id: 'sansOptIn', phone_e164: '+33611111111', profile_name: 'Marc', optInStatus: 'unknown' },
      { id: 'sansValeur', phone_e164: '+33622222222', profile_name: null, optInStatus: 'opted_in' },
    ];
    const { skipped } = buildRecipients('marketing', mapping, melange);
    expect(skipped.map((s) => s.reason).sort()).toEqual(['missing_variable', 'not_opted_in']);
    // Seul `missing_variable` porte les positions concernées.
    expect(skipped.find((s) => s.reason === 'not_opted_in')?.missing).toBeUndefined();
    expect(skipped.find((s) => s.reason === 'missing_variable')?.missing).toEqual([1]);
  });
});
