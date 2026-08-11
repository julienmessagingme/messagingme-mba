import { describe, it, expect } from 'vitest';
import { rowToSummary, type CampaignSummaryRow } from '../src/campaign/store.pg';

const base: CampaignSummaryRow = {
  id: 'c1', name: 'Promo', category: 'marketing', status: 'completed', phone_number_id: 'pn1',
  template_name: 'promo_ete', template_language: 'fr', workflow_name: null,
  created_at: new Date('2026-08-10T09:05:00.000Z'), scheduled_at: null, archived_at: null,
  total: '3', pending: '1', sending: '0', sent: '1', failed: '1', skipped: '0',
};

describe('rowToSummary', () => {
  it('campagne template -> nom et langue tels quels', () => {
    expect(rowToSummary(base)).toMatchObject({ templateName: 'promo_ete', templateLanguage: 'fr', workflowName: null });
  });

  it('campagne SCÉNARIO -> null (PAS de coercition en chaîne vide) + nom du scénario', () => {
    const out = rowToSummary({ ...base, template_name: null, template_language: null, workflow_name: 'Relance promo' });
    expect(out.templateName).toBeNull();
    expect(out.templateLanguage).toBeNull();
    expect(out.workflowName).toBe('Relance promo');
  });

  it('scénario supprimé (workflow_id passé à null) -> workflowName null', () => {
    expect(rowToSummary({ ...base, template_name: null, template_language: null, workflow_name: null }).workflowName).toBeNull();
  });

  it('colonne workflow_name absente (ancienne requête) -> null, pas undefined', () => {
    const { workflow_name: _drop, ...without } = base;
    expect(rowToSummary(without).workflowName).toBeNull();
  });

  it('compteurs convertis en nombres, dates en ISO', () => {
    expect(rowToSummary(base).counts).toEqual({ total: 3, pending: 1, sending: 0, sent: 1, failed: 1, skipped: 0 });
    expect(rowToSummary(base).createdAt).toBe('2026-08-10T09:05:00.000Z');
  });
});
