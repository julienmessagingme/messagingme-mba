import { describe, expect, it } from 'vitest';
import { preparerConfigurationWebhook } from '../src/webhook-entrant/configuration';
import type { WebhookRow } from '../src/webhook-entrant/modele';

const PAYLOAD = {
  client: { telephone: '+33612345678', nom: 'Marie' },
  lignes: [{ prix: 42 }],
};

const EXISTANT: WebhookRow = {
  id: 'wh1',
  name: 'Formulaire',
  enabled: true,
  code: 'ab12cd34ef56gh78jk90mn12pq',
  hasSecret: false,
  mapping: [{ chemin: 'client.telephone', cible: 'sys:phone' }],
  createContact: true,
  optIn: true,
  workflowId: 'wf1',
  startNodeId: 'n1',
  cooldownSeconds: 120,
  lastPayload: PAYLOAD,
  lastReceivedAt: '2026-10-30T08:00:00.000Z',
  contactsCreated: 3,
  createdAt: '2026-10-29T08:00:00.000Z',
};

describe('configuration d’un webhook entrant', () => {
  it('prépare une création complète avec les défauts du domaine', () => {
    expect(preparerConfigurationWebhook({ saisie: { name: ' Commandes ' }, actuel: null })).toEqual({
      ok: true,
      input: {
        name: 'Commandes', enabled: true, mapping: [], createContact: true, optIn: true,
        workflowId: null, startNodeId: null, cooldownSeconds: null,
      },
    });
  });

  it('fusionne un PATCH avec l’état courant sans remettre les autres champs à leur défaut', () => {
    expect(preparerConfigurationWebhook({ saisie: { name: ' Nouveau nom ' }, actuel: EXISTANT })).toEqual({
      ok: true,
      input: {
        name: 'Nouveau nom', enabled: true,
        mapping: [{ chemin: 'client.telephone', cible: 'sys:phone' }],
        createContact: true, optIn: true, workflowId: 'wf1', startNodeId: 'n1', cooldownSeconds: 120,
      },
    });
  });

  it('refuse un mapping qui désigne un ensemble dans le dernier payload', () => {
    const issue = preparerConfigurationWebhook({
      saisie: { mapping: [{ chemin: 'client', cible: 'field:client' }] },
      actuel: EXISTANT,
    });
    expect(issue).toEqual(expect.objectContaining({ ok: false }));
    if (!issue.ok) expect(issue.error).toMatch(/pointez un élément précis/);
  });

  it('accepte un chemin absent de l’échantillon et refuse un bloc sans scénario', () => {
    expect(preparerConfigurationWebhook({
      saisie: { mapping: [{ chemin: 'client.email', cible: 'field:email' }] },
      actuel: EXISTANT,
    })).toEqual(expect.objectContaining({ ok: true }));

    expect(preparerConfigurationWebhook({ saisie: { name: 'x', startNodeId: 'n1' }, actuel: null }))
      .toEqual({ ok: false, error: 'startNodeId n’a de sens qu’avec un scénario' });
  });
});
