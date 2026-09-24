import { describe, it, expect } from 'vitest';
import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';
import type { EnvoiApiBrut } from '../src/campaign/store.pg';

/**
 * LE CONTRAT DE `GET /v1/sends/{sendId}` (spec 2026-09-24, § 3).
 *
 * 🔴 L'API renvoyait l'objet de la console (`chaine`, `paramMapping`, `archivedAt`) : un changement de la
 * console changeait l'API, sans contrat ni exemple. Ce fichier fixe le contrat.
 */
/** Des identifiants de fiche au FORMAT d'un vrai, comme ceux que l'API rend. */
const C1 = '11111111-1111-4111-8111-000000000001';
const C2 = '11111111-1111-4111-8111-000000000002';
const C3 = '11111111-1111-4111-8111-000000000003';

const TEMPLATE: EnvoiApiBrut = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'running',
  createdAt: '2026-09-24T10:00:00.000Z',
  channel: 'whatsapp',
  // 🔴 SANS le préfixe de l'API, délibérément : le cas « une campagne RCS de la console » ÉTALE cette fixture
  // en changeant son canal, et attend `{ rcsMessage: null }`. Un nom préfixé en ferait un envoi RCS de l'API.
  name: 'Confirmation de commande',
  templateName: 'confirmation',
  templateLanguage: 'fr',
  workflowCode: null,
  startNodeId: null,
  graph: null,
  counts: { pending: 0, sending: 0, sent: 1, failed: 2, skipped: 0 },
  recipientsTotal: 3,
  recipients: [
    { contactId: C1, externalId: 'crm-7781', rang: 1, canalEtage: 'whatsapp', status: 'sent', messageId: 'wamid.A', error: null, errorCode: null, sentAt: '2026-09-24T10:00:05.000Z', deliveryStatus: 'delivered', deliveryError: null },
    { contactId: C2, externalId: null, rang: 1, canalEtage: 'whatsapp', status: 'sent', messageId: 'wamid.B', error: null, errorCode: 131026, sentAt: '2026-09-24T10:00:06.000Z', deliveryStatus: 'failed', deliveryError: 'Message undeliverable' },
    { contactId: C3, externalId: null, rang: 1, canalEtage: 'whatsapp', status: 'failed', messageId: null, error: 'template inconnu', errorCode: 132001, sentAt: null, deliveryStatus: null, deliveryError: null },
  ],
};

describe('formaterSuiviEnvoi', () => {
  it('🔴 le contrat, et rien que lui : aucune clé de la console ne fuit', () => {
    const s = formaterSuiviEnvoi(TEMPLATE);
    expect(Object.keys(s).sort()).toEqual(['counts', 'createdAt', 'opening', 'recipients', 'recipientsTotal', 'sendId', 'status', 'target']);
    expect(Object.keys(s.recipients[0]!).sort()).toEqual(['channel', 'contactId', 'delivery', 'error', 'externalId', 'messageId', 'sentAt', 'status']);
  });

  it('un envoi de template : cible, ouverture, destinataires, et les deux sortes d’échec', () => {
    expect(formaterSuiviEnvoi(TEMPLATE)).toEqual({
      sendId: '11111111-1111-4111-8111-111111111111',
      status: 'running',
      target: { template: { name: 'confirmation', language: 'fr' } },
      opening: 'whatsapp_template',
      createdAt: '2026-09-24T10:00:00.000Z',
      counts: { pending: 0, sending: 0, sent: 1, failed: 2, skipped: 0 },
      recipientsTotal: 3,
      recipients: [
        { contactId: C1, externalId: 'crm-7781', channel: 'whatsapp', status: 'sent', messageId: 'wamid.A', delivery: 'delivered', error: null, sentAt: '2026-09-24T10:00:05.000Z' },
        // Échec de LIVRAISON signalé plus tard : `status` reste `sent` en base, l'API dit `failed`.
        { contactId: C2, externalId: null, channel: 'whatsapp', status: 'failed', messageId: 'wamid.B', delivery: 'failed', error: { message: 'Message undeliverable', metaCode: 131026 }, sentAt: '2026-09-24T10:00:06.000Z' },
        // Refus à l'ENVOI.
        { contactId: C3, externalId: null, channel: 'whatsapp', status: 'failed', messageId: null, delivery: null, error: { message: 'template inconnu', metaCode: 132001 }, sentAt: null },
      ],
    });
  });

  it('un envoi de scénario qui ouvre en RCS : cible par code, canal rcs, jamais l’identifiant synthétique `wf-`', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE,
      templateName: null, templateLanguage: null, workflowCode: 'scn_demo_01', startNodeId: null,
      graph: { nodes: [{ id: 'r', type: 'rcs_message', position: { x: 0, y: 0 }, data: { text: 'Bonjour' } }], edges: [] },
      recipients: [{ ...TEMPLATE.recipients[0]!, messageId: 'wf-5f1c', deliveryStatus: null }],
    });
    expect(s.target).toEqual({ scenario: 'scn_demo_01' });
    expect(s.opening).toBe('rcs');
    expect(s.recipients[0]).toMatchObject({ channel: 'rcs', messageId: null, delivery: null });
  });

  it('un envoi de bloc : la cible est le CODE du bloc, l’ouverture se juge depuis lui', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE,
      templateName: null, templateLanguage: null, workflowCode: 'scn_demo_02', startNodeId: 'q',
      graph: { nodes: [{ id: 'q', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Bonjour', code: 'nod_demo_q' } }], edges: [] },
    });
    expect(s.target).toEqual({ node: 'nod_demo_q' });
    expect(s.opening).toBe('whatsapp_session');
  });

  it('un scénario supprimé depuis : cible et ouverture inconnues, jamais inventées', () => {
    const s = formaterSuiviEnvoi({ ...TEMPLATE, templateName: null, templateLanguage: null, workflowCode: null, startNodeId: null, graph: null });
    expect(s.target).toEqual({ scenario: null });
    expect(s.opening).toBeNull();
    expect(s.recipients.every((r) => r.channel === 'whatsapp')).toBe(true);
  });

  it('🔴 une campagne RCS de la console (`template_name` vide, pas null) : cible RCS, ouverture et canal RCS, jamais un template au nom vide', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE, channel: 'rcs', templateName: '', templateLanguage: '',
      recipients: [{ ...TEMPLATE.recipients[0]!, messageId: 'sms-1' }],
    });
    expect(s.target).toEqual({ rcsMessage: null });
    expect(s.opening).toBe('rcs');
    expect(s.recipients[0]).toMatchObject({ channel: 'rcs', messageId: 'sms-1' });
  });

  it('🔴 une chaîne de repli : au-delà du rang 1, le canal est celui de l’ÉTAGE du destinataire, e-mail compris', () => {
    const s = formaterSuiviEnvoi({
      ...TEMPLATE,
      recipients: [
        { ...TEMPLATE.recipients[0]!, rang: 2, canalEtage: 'rcs', messageId: 'sms-2' },
        { ...TEMPLATE.recipients[1]!, rang: 3, canalEtage: 'email' },
        { ...TEMPLATE.recipients[2]!, rang: 1, canalEtage: 'rcs' },
      ],
    });
    expect(s.recipients.map((r) => r.channel)).toEqual(['rcs', 'email', 'whatsapp']);
  });

  it('une liste tronquée se voit : recipientsTotal est le nombre de la campagne, pas celui des lignes rendues', () => {
    const s = formaterSuiviEnvoi({ ...TEMPLATE, recipientsTotal: 1200 });
    expect(s.recipients).toHaveLength(3);
    expect(s.recipientsTotal).toBe(1200);
  });

  it('un nom de template VIDE sur une campagne WhatsApp n’est pas une cible template', () => {
    const s = formaterSuiviEnvoi({ ...TEMPLATE, templateName: '', templateLanguage: '' });
    expect(s.target).toEqual({ scenario: null });
    expect(s.opening).toBeNull();
  });
});
