import { describe, it, expect } from 'vitest';
import { matchesTrigger, isInCooldown, keywordsOf, keywordModeOf, normalizeText, isCreatableTriggerKind } from '../src/automation/match';
import type { AutomationRow, AutomationEvent } from '../src/automation/match';

/**
 * Mise en correspondance déclencheur <-> événement (module PUR).
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. Une automation MAL CONFIGURÉE (aucun mot-clé, tag vide) ne doit JAMAIS déclencher. Le défaut inverse
 *     serait catastrophique : un scénario qui part sur TOUS les messages entrants du client.
 *  2. La comparaison ignore casse et accents : « RDV », « rdv » et « Rdv » sont le même mot-clé pour un client.
 *  3. `equals` compare le message ENTIER (c'est ce qui rend un jeton de test fiable), `contains` cherche dedans.
 *  4. L'anti-rebond est ce qui empêche la boucle scénario -> tag/mot-clé -> même scénario.
 */

const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Test', enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, ...over,
});
const msg = (body: string | null, isNewContact = false): AutomationEvent => ({ kind: 'message', waId: '33611', body, isNewContact });

describe('normalizeText', () => {
  it('minuscules, sans accents, espaces resserrés', () => {
    expect(normalizeText('  Éléphant   ROSE ')).toBe('elephant rose');
  });
});

describe('déclencheur mot-clé', () => {
  it('contains (défaut) : le mot-clé trouvé DANS le message déclenche', () => {
    const a = auto({ triggerConfig: { keywords: ['rdv'] } });
    expect(matchesTrigger(a, msg('Bonjour, je voudrais un RDV svp'))).toBe(true);
    expect(matchesTrigger(a, msg('Bonjour, une question'))).toBe(false);
  });

  it('insensible à la casse ET aux accents, dans les deux sens', () => {
    const a = auto({ triggerConfig: { keywords: ['RÉSILIER'] } });
    expect(matchesTrigger(a, msg('je veux resilier'))).toBe(true);
    const b = auto({ triggerConfig: { keywords: ['resilier'] } });
    expect(matchesTrigger(b, msg('Je veux RÉSILIER'))).toBe(true);
  });

  it('equals : compare le message ENTIER (base d’un jeton de test fiable)', () => {
    const a = auto({ triggerConfig: { keywords: ['tok_abc'], mode: 'equals' } });
    expect(matchesTrigger(a, msg('tok_abc'))).toBe(true);
    expect(matchesTrigger(a, msg('  TOK_ABC  '))).toBe(true); // normalisé (trim + casse)
    expect(matchesTrigger(a, msg('mon code est tok_abc'))).toBe(false); // pas le message entier
  });

  it('plusieurs mots-clés : un seul suffit', () => {
    const a = auto({ triggerConfig: { keywords: ['rdv', 'rendez-vous'] } });
    expect(matchesTrigger(a, msg('je veux un rendez-vous'))).toBe(true);
  });

  it('AUCUN mot-clé configuré -> ne déclenche JAMAIS (ne part pas sur tous les messages)', () => {
    expect(matchesTrigger(auto({ triggerConfig: {} }), msg('bonjour'))).toBe(false);
    expect(matchesTrigger(auto({ triggerConfig: { keywords: [] } }), msg('bonjour'))).toBe(false);
    expect(matchesTrigger(auto({ triggerConfig: { keywords: ['  ', ''] } }), msg('bonjour'))).toBe(false);
  });

  it('message vide ou sans texte (média seul) -> ne déclenche pas', () => {
    const a = auto({ triggerConfig: { keywords: ['rdv'] } });
    expect(matchesTrigger(a, msg(null))).toBe(false);
    expect(matchesTrigger(a, msg('   '))).toBe(false);
  });

  it('config malformée (keywords non tableau, mode inconnu) -> jamais de throw, repli sûr', () => {
    expect(keywordsOf({ keywords: 'rdv' })).toEqual([]);
    expect(keywordModeOf({ mode: 'nawak' })).toBe('contains');
    expect(matchesTrigger(auto({ triggerConfig: { keywords: 'rdv' } }), msg('rdv'))).toBe(false);
  });
});

describe('déclencheur nouveau contact', () => {
  it('ne déclenche QUE sur le 1er message d’un contact inconnu', () => {
    const a = auto({ triggerKind: 'new_contact', triggerConfig: {} });
    expect(matchesTrigger(a, msg('bonjour', true))).toBe(true);
    expect(matchesTrigger(a, msg('bonjour', false))).toBe(false);
  });
});

describe('déclencheur tag ajouté (moteur prêt, pas encore émis)', () => {
  const a = auto({ triggerKind: 'tag_added', triggerConfig: { tag: 'VIP' } });
  it('compare le tag normalisé', () => {
    expect(matchesTrigger(a, { kind: 'tag_added', waId: '33611', tag: 'vip' })).toBe(true);
    expect(matchesTrigger(a, { kind: 'tag_added', waId: '33611', tag: 'autre' })).toBe(false);
  });
  it('tag non configuré -> ne déclenche jamais (sinon il partirait sur TOUS les tags)', () => {
    expect(matchesTrigger(auto({ triggerKind: 'tag_added', triggerConfig: {} }), { kind: 'tag_added', waId: '33611', tag: 'vip' })).toBe(false);
  });
  it('n’est PAS proposé à la création tant que rien ne l’émet (honnêteté produit)', () => {
    expect(isCreatableTriggerKind('keyword')).toBe(true);
    expect(isCreatableTriggerKind('new_contact')).toBe(true);
    expect(isCreatableTriggerKind('tag_added')).toBe(false);
  });
});

describe('les types d’événement ne se croisent pas', () => {
  it('un événement tag ne déclenche pas un mot-clé, et inversement', () => {
    expect(matchesTrigger(auto(), { kind: 'tag_added', waId: '33611', tag: 'rdv' })).toBe(false);
    expect(matchesTrigger(auto({ triggerKind: 'tag_added', triggerConfig: { tag: 'vip' } }), msg('vip'))).toBe(false);
  });
});

describe('anti-rebond', () => {
  const T = new Date('2026-08-03T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(T - ms);
  const H = 3600_000;

  it('jamais déclenché -> pas de blocage', () => {
    expect(isInCooldown(null, null, 3600, T)).toBe(false);
  });
  it('déclenché récemment -> bloqué ; assez ancien -> autorisé', () => {
    expect(isInCooldown(ago(10 * 60_000), null, 3600, T)).toBe(true);
    expect(isInCooldown(ago(2 * H), null, 3600, T)).toBe(false);
  });
  it('le réglage de l’automation PRIME sur le défaut du serveur, dans les deux sens', () => {
    expect(isInCooldown(ago(30 * 60_000), 7200, 60, T)).toBe(true); // automation plus stricte que le défaut
    expect(isInCooldown(ago(30 * 60_000), 60, 7200, T)).toBe(false); // automation plus permissive
  });
  it('0 désactive explicitement le garde-fou (choix assumé)', () => {
    expect(isInCooldown(ago(1000), 0, 3600, T)).toBe(false);
  });
});
