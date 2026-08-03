import { describe, it, expect } from 'vitest';
import { parseAutomationEventJob, AUTOMATION_EVENT_QUEUE } from '../src/automation/event-job';

/**
 * Payload de la file `automation-event` (E.2) : le pont entre l'API (qui pose un tag) et le worker (seul à
 * savoir démarrer un scénario).
 *
 * Ce que ces tests protègent : un payload douteux (ancienne version du code, écriture manuelle, corruption)
 * ne doit JAMAIS faire boucler la file jusqu'à la DLQ, ni déclencher un scénario sur des données partielles.
 * Un envoi part chez un vrai client : dans le doute, on ne fait rien.
 */

describe('parseAutomationEventJob', () => {
  it('accepte un tag posé', () => {
    expect(parseAutomationEventJob({ tenantId: 't1', event: { kind: 'tag_added', waId: '33611', tag: 'vip' } }))
      .toEqual({ tenantId: 't1', event: { kind: 'tag_added', waId: '33611', tag: 'vip' } });
  });

  it('accepte une analyse de conversation', () => {
    expect(parseAutomationEventJob({ tenantId: 't1', event: { kind: 'analysis', waId: '33611', sentiment: 'negatif', resolved: false } }))
      .toEqual({ tenantId: 't1', event: { kind: 'analysis', waId: '33611', sentiment: 'negatif', resolved: false } });
  });

  it('`resolved` absent ou non booléen -> false (on ne suppose pas qu’une demande est réglée)', () => {
    const j = parseAutomationEventJob({ tenantId: 't1', event: { kind: 'analysis', waId: '33611', sentiment: 'neutre' } });
    expect(j?.event).toMatchObject({ resolved: false });
  });

  it('refuse tout payload inexploitable, sans jamais lever', () => {
    const bad: unknown[] = [
      null, undefined, 'texte', 42, [],
      {},                                                              // ni tenant ni événement
      { tenantId: '', event: { kind: 'tag_added', waId: '1', tag: 'a' } },
      { tenantId: 't1' },                                              // pas d'événement
      { tenantId: 't1', event: {} },                                   // pas de kind
      { tenantId: 't1', event: { kind: 'tag_added', waId: '', tag: 'a' } },
      { tenantId: 't1', event: { kind: 'tag_added', waId: '33611' } },  // tag manquant
      { tenantId: 't1', event: { kind: 'tag_added', waId: '33611', tag: '' } },
      { tenantId: 't1', event: { kind: 'analysis' } },                  // waId manquant
      { tenantId: 't1', event: { kind: 'nawak', waId: '33611' } },
    ];
    for (const raw of bad) expect(parseAutomationEventJob(raw), JSON.stringify(raw)).toBeNull();
  });

  it('REFUSE un événement `message` : il n’a de sens que dans le webhook', () => {
    // Le contexte d'un message (nouveau contact ? message déjà consommé par un jeton de test ?) n'existe que
    // le temps du job webhook. L'accepter ici ouvrirait un second chemin au comportement subtilement différent.
    expect(parseAutomationEventJob({ tenantId: 't1', event: { kind: 'message', waId: '33611', body: 'rdv', isNewContact: false } })).toBeNull();
  });

  it('le nom de file est stable (API et worker doivent parler de la même)', () => {
    expect(AUTOMATION_EVENT_QUEUE).toBe('automation-event');
  });
});
