import { describe, it, expect } from 'vitest';
import { matchesTrigger, isInCooldown, keywordsOf, keywordModeOf, normalizeText, isAutomationTriggerKind } from '../src/automation/match';
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
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, possedePar: null, ...over,
});
const msg = (body: string | null, isNewContact = false): AutomationEvent => ({ kind: 'message', waId: '33611', body, isNewContact, channel: 'whatsapp' });

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

describe('déclencheur tag ajouté (émis depuis E.2, chemins unitaires seulement)', () => {
  const a = auto({ triggerKind: 'tag_added', triggerConfig: { tag: 'VIP' } });
  it('compare le tag normalisé', () => {
    expect(matchesTrigger(a, { kind: 'tag_added', waId: '33611', tag: 'vip' })).toBe(true);
    expect(matchesTrigger(a, { kind: 'tag_added', waId: '33611', tag: 'autre' })).toBe(false);
  });
  it('tag non configuré -> ne déclenche jamais (sinon il partirait sur TOUS les tags)', () => {
    expect(matchesTrigger(auto({ triggerKind: 'tag_added', triggerConfig: {} }), { kind: 'tag_added', waId: '33611', tag: 'vip' })).toBe(false);
  });
  it('est proposé à la création depuis E.2 (la file `automation-event` l’émet)', () => {
    for (const k of ['keyword', 'new_contact', 'tag_added', 'conversation_analyzed']) {
      expect(isAutomationTriggerKind(k), k).toBe(true);
    }
    expect(isAutomationTriggerKind('nawak')).toBe(false);
  });
});

describe('déclencheur « conversation analysée » (E.2)', () => {
  const ev = (sentiment: string, resolved: boolean): AutomationEvent => ({ kind: 'analysis', waId: '33611', sentiment, resolved });
  const anal = (cfg: Record<string, unknown>) => auto({ triggerKind: 'conversation_analyzed', triggerConfig: cfg });

  it('filtre par ressenti (catégoriel, pas de score numérique)', () => {
    const a = anal({ sentiment: 'negatif' });
    expect(matchesTrigger(a, ev('negatif', true))).toBe(true);
    expect(matchesTrigger(a, ev('positif', true))).toBe(false);
  });

  it('filtre « non résolue » seul', () => {
    const a = anal({ unresolvedOnly: true });
    expect(matchesTrigger(a, ev('positif', false))).toBe(true);
    expect(matchesTrigger(a, ev('negatif', true))).toBe(false); // résolue -> on ne relance pas
  });

  it('les deux filtres sont CUMULATIFS', () => {
    const a = anal({ sentiment: 'negatif', unresolvedOnly: true });
    expect(matchesTrigger(a, ev('negatif', false))).toBe(true);
    expect(matchesTrigger(a, ev('negatif', true))).toBe(false);
    expect(matchesTrigger(a, ev('neutre', false))).toBe(false);
  });

  it('aucun filtre -> déclenche à CHAQUE analyse (choix explicite, pas un oubli)', () => {
    expect(matchesTrigger(anal({}), ev('positif', true))).toBe(true);
  });

  it('ne réagit pas aux autres types d’événement', () => {
    expect(matchesTrigger(anal({ sentiment: 'negatif' }), msg('negatif'))).toBe(false);
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

/**
 * Déclencheur « étape de deal HubSpot ».
 *
 * Le point qui compte et qui ne se voit pas à la lecture : la correspondance se fait sur l'IDENTIFIANT
 * d'étape, jamais sur son libellé. Un client qui renomme « Devis envoyé » en « Proposition envoyée » dans
 * HubSpot ne doit RIEN casser. Un déclencheur sur libellé aurait cessé de fonctionner en silence.
 */
describe('matchesTrigger : étape de deal HubSpot', () => {
  const dealAuto = (cfg: Record<string, unknown>): AutomationRow =>
    auto({ triggerKind: 'hubspot_deal_stage', triggerConfig: cfg });
  const ev = (stageId: string, pipelineId = 'p1'): AutomationEvent =>
    ({ kind: 'hubspot_deal_stage', waId: '33600', pipelineId, stageId });

  it('même étape -> déclenche', () => {
    expect(matchesTrigger(dealAuto({ pipelineId: 'p1', stageId: 's-devis' }), ev('s-devis'))).toBe(true);
  });

  it('autre étape du même pipeline -> ne déclenche pas', () => {
    expect(matchesTrigger(dealAuto({ pipelineId: 'p1', stageId: 's-devis' }), ev('s-gagne'))).toBe(false);
  });

  it('même étape mais AUTRE pipeline -> ne déclenche pas', () => {
    expect(matchesTrigger(dealAuto({ pipelineId: 'p1', stageId: 's-devis' }), ev('s-devis', 'p2'))).toBe(false);
  });

  it('pipeline non renseigné dans l’AUTOMATION -> l’étape suffit (elle est déjà unique chez HubSpot)', () => {
    expect(matchesTrigger(dealAuto({ stageId: 's-devis' }), ev('s-devis', 'peu-importe'))).toBe(true);
  });

  it('pipeline absent de l’ÉVÉNEMENT -> déclenche quand même (le webhook HubSpot ne le porte pas)', () => {
    // Sans ça, une automation réglée sur un pipeline précis ne partirait JAMAIS en production : le payload
    // de HubSpot n'a pas le pipeline, et le connecteur publie donc une chaîne vide.
    expect(matchesTrigger(dealAuto({ pipelineId: 'p1', stageId: 's-devis' }), ev('s-devis', ''))).toBe(true);
  });

  it('étape NON configurée -> ne déclenche JAMAIS (automation inerte, pas automation folle)', () => {
    expect(matchesTrigger(dealAuto({ pipelineId: 'p1' }), ev('s-devis'))).toBe(false);
    expect(matchesTrigger(dealAuto({ pipelineId: 'p1', stageId: '   ' }), ev('s-devis'))).toBe(false);
  });

  it('le LIBELLÉ n’entre pas dans la décision : un renommage côté HubSpot ne casse rien', () => {
    const a = dealAuto({ pipelineId: 'p1', stageId: 's-devis', stageLabel: 'Devis envoyé' });
    // L'événement ne transporte aucun libellé, et l'automation garde le sien, périmé : ça marche quand même.
    expect(matchesTrigger(a, ev('s-devis'))).toBe(true);
  });

  it('un autre type d’événement ne l’active pas, et il n’attrape pas les autres déclencheurs', () => {
    expect(matchesTrigger(dealAuto({ stageId: 's-devis' }), { kind: 'tag_added', waId: '33600', tag: 's-devis' })).toBe(false);
    expect(matchesTrigger(auto({ triggerKind: 'tag_added', triggerConfig: { tag: 'vip' } }), ev('s-devis'))).toBe(false);
  });

  it('le type est créable depuis l’API/l’écran', () => {
    expect(isAutomationTriggerKind('hubspot_deal_stage')).toBe(true);
  });
});

/**
 * 🔴 Déclencheur « le contact arrive d'une publicité ». La doctrine de la config VIDE est volontairement
 * l'INVERSE de celle de « tag ajouté » : ici vide veut dire « n'importe quelle pub », parce que « tout lead
 * venu d'une pub part dans le scénario d'accueil » est le montage le plus courant. La portée reste bornée aux
 * messages issus d'une pub : elle ne peut pas déborder sur le trafic ordinaire.
 */
describe('déclencheur publicité (ctwa_ad)', () => {
  const pub = (adId?: string): AutomationEvent => ({
    kind: 'message', waId: '33611', body: 'Bonjour', isNewContact: true, channel: 'whatsapp',
    ...(adId ? { adId } : {}),
  });
  const autoPub = (cfg: Record<string, unknown> = {}): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'Pub', enabled: true, triggerKind: 'ctwa_ad', triggerConfig: cfg,
    workflowId: 'wf1', startNodeId: null, conditionGroup: null, cooldownSeconds: null, maxFiresPerHour: null,
    possedePar: null,
  });

  it('config VIDE : n importe quelle pub déclenche', () => {
    expect(matchesTrigger(autoPub(), pub('120212345678901234'))).toBe(true);
  });

  it('un message ORDINAIRE ne déclenche jamais, même avec une config vide', () => {
    expect(matchesTrigger(autoPub(), pub())).toBe(false);
  });

  it('une pub PRÉCISE ne déclenche que sur elle', () => {
    expect(matchesTrigger(autoPub({ adId: '120212345678901234' }), pub('120212345678901234'))).toBe(true);
    expect(matchesTrigger(autoPub({ adId: '120299999999999999' }), pub('120212345678901234'))).toBe(false);
  });

  /**
   * 🔴 LA CAMPAGNE, NIVEAU DU LIEN DEPUIS LE LOT 3 (décision de Julien du 2026-09-22). Une pub se COPIE dans
   * le Gestionnaire de Meta en deux clics, et chaque copie porte un identifiant neuf : router sur
   * l'identifiant de PUB ferait perdre le scénario au premier duplicata, sans aucun signe. La campagne, elle,
   * survit aux copies faites à l'intérieur d'elle-même.
   */
  describe('par CAMPAGNE (lot 3)', () => {
    const pubDeCampagne = (adId: string, campagneId?: string): AutomationEvent => ({
      kind: 'message', waId: '33611', body: 'Bonjour', isNewContact: true, channel: 'whatsapp', adId,
      ...(campagneId ? { campagneId } : {}),
    });

    it('une campagne PRÉCISE déclenche sur n’importe quelle pub DE CETTE CAMPAGNE', () => {
      expect(matchesTrigger(autoPub({ campaignId: 'camp-1' }), pubDeCampagne('ad-originale', 'camp-1'))).toBe(true);
      // La copie : identifiant de pub DIFFÉRENT, même campagne. C'est tout l'intérêt du niveau choisi.
      expect(matchesTrigger(autoPub({ campaignId: 'camp-1' }), pubDeCampagne('ad-copiee', 'camp-1'))).toBe(true);
    });

    it('une autre campagne ne déclenche pas', () => {
      expect(matchesTrigger(autoPub({ campaignId: 'camp-1' }), pubDeCampagne('ad-1', 'camp-2'))).toBe(false);
    });

    it('🔴 une campagne demandée mais INCONNUE du message ne déclenche pas, et ne retombe PAS sur la pub', () => {
      // Le repli serait tentant et il serait faux : il ferait déclencher une automation de campagne sur un
      // lead dont on n'a justement pas su dire la campagne.
      expect(matchesTrigger(autoPub({ campaignId: 'camp-1' }), pubDeCampagne('ad-1'))).toBe(false);
      expect(matchesTrigger(autoPub({ campaignId: 'camp-1', adId: 'ad-1' }), pubDeCampagne('ad-1'))).toBe(false);
    });

    it('la campagne PASSE AVANT la pub quand les deux sont réglées', () => {
      expect(matchesTrigger(autoPub({ campaignId: 'camp-1', adId: 'ad-AUTRE' }), pubDeCampagne('ad-1', 'camp-1'))).toBe(true);
    });

    it('une campagne sur le MESSAGE ne change rien à une automation qui n’en demande pas', () => {
      expect(matchesTrigger(autoPub(), pubDeCampagne('ad-1', 'camp-1'))).toBe(true);
      expect(matchesTrigger(autoPub({ adId: 'ad-1' }), pubDeCampagne('ad-1', 'camp-1'))).toBe(true);
    });
  });
});
