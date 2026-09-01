import { describe, it, expect } from 'vitest';
import { buildTranscript, deduceHandledBy, countExchanges, parseLlmOutput, type AnalysisMessage } from '../src/analysis/engine';

const valid = {
  sentiment: 'positif', intent: 'demande_devis', topic: 'devis 50 licences', resolved: false,
  entities: { quantite: 50 }, action_suggestion: 'creer_devis', confidence: 0.86, justification: 'Le client veut un devis.',
};

describe('engine — buildTranscript', () => {
  it('rend Client:/Agent: chronologique', () => {
    const t = buildTranscript([
      { direction: 'in', body: 'Bonjour', type: 'text' },
      { direction: 'out', body: 'Salut', type: 'text' },
    ]);
    expect(t).toBe('Client: Bonjour\nAgent: Salut');
  });
  it('remplace un corps vide par [type]', () => {
    expect(buildTranscript([{ direction: 'in', body: null, type: 'image' }])).toContain('Client: [image]');
  });
  it('tronque en gardant la FIN (épisode récent)', () => {
    const msgs: AnalysisMessage[] = Array.from({ length: 50 }, (_, i) => ({ direction: 'in', body: `msg-${i}-xxxxxxxxxx`, type: 'text' }));
    const t = buildTranscript(msgs, 100);
    expect(t.startsWith('[...début tronqué...]')).toBe(true);
    expect(t).toContain('msg-49'); // la fin est conservée
  });
});

describe('engine — deduceHandledBy', () => {
  it('humain si un sortant humain', () => {
    expect(deduceHandledBy({ hasHumanOutbound: true })).toBe('humain');
  });
  it('automatise sinon (y compris inbound jamais traité)', () => {
    expect(deduceHandledBy({ hasHumanOutbound: false })).toBe('automatise');
    expect(deduceHandledBy({ hasHumanOutbound: false })).toBe('automatise');
  });
});

describe('engine — countExchanges (tours du client)', () => {
  it('compte les entrants', () => {
    expect(countExchanges([
      { direction: 'in', body: 'a', type: 'text' },
      { direction: 'out', body: 'b', type: 'text' },
      { direction: 'in', body: 'c', type: 'text' },
    ])).toBe(2);
  });
});

describe('engine — parseLlmOutput', () => {
  it('parse un JSON valide', () => {
    expect(parseLlmOutput(JSON.stringify(valid))).toMatchObject({ sentiment: 'positif', intent: 'demande_devis' });
  });
  it('tolère un préambule + des balises ```json', () => {
    expect(parseLlmOutput('Voici :\n```json\n' + JSON.stringify(valid) + '\n```')).not.toBeNull();
  });
  it('entities absent -> défaut {}', () => {
    const { entities, ...rest } = valid;
    void entities;
    expect(parseLlmOutput(JSON.stringify(rest))?.entities).toEqual({});
  });
  it('JSON malformé -> null', () => {
    expect(parseLlmOutput('pas du json')).toBeNull();
    expect(parseLlmOutput('{ cassé')).toBeNull();
  });
  it('enum hors liste -> null', () => {
    expect(parseLlmOutput(JSON.stringify({ ...valid, sentiment: 'euphorique' }))).toBeNull();
  });
  it('🔴 summary ABSENT -> analyse valide quand même, et le champ reste indéfini', () => {
    // Le résumé (migration 0100) est arrivé après coup, comme `abusive` avant lui : un modèle qui l'omet
    // ne doit pas faire perdre TOUTE l'analyse, qui coûte un appel LLM. Et son absence doit rester
    // DISTINGUABLE d'un résumé vide, parce que la fiche de conversation ne dit pas la même chose des deux.
    const sortie = parseLlmOutput(JSON.stringify(valid));
    expect(sortie).not.toBeNull();
    expect(sortie?.summary).toBeUndefined();
  });
  it('summary présent -> conservé ; summary trop long -> analyse refusée', () => {
    expect(parseLlmOutput(JSON.stringify({ ...valid, summary: 'Le client veut 50 licences.' }))?.summary)
      .toBe('Le client veut 50 licences.');
    // Borne haute : un modèle qui recrache le transcript entier remplirait la colonne de bruit, et la
    // fiche deviendrait illisible. Mieux vaut refuser et rejouer que stocker ça.
    expect(parseLlmOutput(JSON.stringify({ ...valid, summary: 'x'.repeat(801) }))).toBeNull();
  });
  it('champ manquant -> null', () => {
    const { confidence, ...rest } = valid;
    void confidence;
    expect(parseLlmOutput(JSON.stringify(rest))).toBeNull();
  });
  it('confidence hors [0,1] -> null', () => {
    expect(parseLlmOutput(JSON.stringify({ ...valid, confidence: 1.5 }))).toBeNull();
  });
});
