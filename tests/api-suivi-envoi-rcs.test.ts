import { describe, it, expect } from 'vitest';
import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';
import type { EnvoiApiBrut } from '../src/campaign/store.pg';

/**
 * `GET /v1/sends/{sendId}` d'un envoi de message RCS (lot 3).
 *
 * Le lot 2 reconnaît déjà une campagne RCS par son CANAL (elle porte `templateName: ''`, pas null) et rend
 * `{ rcsMessage: null }`. 🔴 Pour un envoi de l'API, le suivi NOMME désormais le message, relu derrière le
 * préfixe du nom de la campagne ; une campagne de la console reste à `null`.
 */
const RCS: EnvoiApiBrut = {
  id: '33333333-3333-4333-8333-333333333333',
  status: 'running',
  createdAt: '2026-09-24T10:00:00.000Z',
  name: '[API] relance-panier',
  channel: 'rcs',
  templateName: '',
  templateLanguage: '',
  workflowCode: null,
  startNodeId: null,
  graph: null,
  counts: { pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 },
  recipientsTotal: 1,
  recipients: [
    {
      contactId: '11111111-1111-4111-8111-000000000001', externalId: 'crm-7781', rang: 1, canalEtage: 'rcs', status: 'sent',
      messageId: 'sms-1', error: null, errorCode: null, sentAt: '2026-09-24T10:00:01.000Z', deliveryStatus: 'delivered', deliveryError: null,
    },
  ],
};

describe('GET /v1/sends/{sendId} : un envoi de message RCS', () => {
  it('🔴 la cible est le message RCS, l’ouverture et le canal sont RCS', () => {
    const s = formaterSuiviEnvoi(RCS);
    expect(s.target).toEqual({ rcsMessage: 'relance-panier' });
    expect(s.opening).toBe('rcs');
    expect(s.recipients.map((r) => r.channel)).toEqual(['rcs']);
  });

  it('une campagne RCS de la console (nom sans le préfixe de l’API) : `rcsMessage: null`, comme au lot 2', () => {
    expect(formaterSuiviEnvoi({ ...RCS, name: 'Soldes d’automne' }).target).toEqual({ rcsMessage: null });
  });

  it('le contrat garde sa forme : ni le nom ni le canal de la campagne ne fuient', () => {
    expect(Object.keys(formaterSuiviEnvoi(RCS)).sort()).toEqual(['counts', 'createdAt', 'opening', 'recipients', 'recipientsTotal', 'sendId', 'status', 'target']);
  });
});
