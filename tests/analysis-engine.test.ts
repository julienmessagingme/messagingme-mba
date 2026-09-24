import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildTranscript, buildPrompt, deduceHandledBy, countExchanges, parseLlmOutput, type AnalysisMessage } from '../src/analysis/engine';
import { NOTE_MIN, NOTE_MAX } from '../src/analysis/schema';

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
  it('🔴 les intentions de commerce en ligne sont ACCEPTÉES (spec du 2026-09-24, § 7)', () => {
    // Refusées par le schéma, elles feraient perdre l'analyse ENTIÈRE : `safeParse` échoue sur l'objet, le
    // job rappelle le modèle une fois puis marque la conversation en échec, et « veut acheter » n'arrive
    // jamais sur aucun écran.
    for (const intent of ['achat', 'suivi_commande', 'retour']) {
      expect(parseLlmOutput(JSON.stringify({ ...valid, intent }))?.intent, intent).toBe(intent);
    }
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

/**
 * Les deux notes du lot F (migration 0121). Ce bloc garde une seule idée, déclinée : une note ne vaut
 * JAMAIS une analyse. Le modèle peut l'omettre, la rendre en texte, la rendre décimale ou hors échelle ;
 * dans tous les cas l'analyse doit survivre, et c'est la MESURE qui manque, pas le reste.
 */
describe('engine — satisfaction et urgence (lot F)', () => {
  it('🔴 absentes -> analyse valide, et les deux champs restent INDÉFINIS (jamais 0)', () => {
    // C'est le cœur du lot : `undefined` veut dire « pas de mesure », `0` veut dire « client très
    // mécontent ». Les confondre rangerait tout l'historique dans le coin qui alarme.
    const sortie = parseLlmOutput(JSON.stringify(valid));
    expect(sortie).not.toBeNull();
    expect(sortie?.satisfaction).toBeUndefined();
    expect(sortie?.urgence).toBeUndefined();
  });

  it('présentes et valides -> conservées, 0 compris', () => {
    const sortie = parseLlmOutput(JSON.stringify({ ...valid, satisfaction: 0, urgence: 10 }));
    expect(sortie?.satisfaction).toBe(0);
    expect(sortie?.urgence).toBe(10);
  });

  it('décimale ou numérique en texte -> arrondie, parce que le modèle a bien rendu une mesure', () => {
    expect(parseLlmOutput(JSON.stringify({ ...valid, satisfaction: 8.5 }))?.satisfaction).toBe(9);
    expect(parseLlmOutput(JSON.stringify({ ...valid, urgence: '7' }))?.urgence).toBe(7);
  });

  it('🔴 note ABERRANTE -> la note est perdue, PAS l’analyse', () => {
    // Sans le `.catch(undefined)` du schéma, `safeParse` échouerait sur l'objet entier : on perdrait le
    // sentiment, l'intention, le résumé et le reste pour une note hors échelle. Une analyse coûte un
    // appel LLM ; une mesure manquée ne coûte qu'un point de moins sur le nuage.
    for (const aberrante of [12, -1, 'huit', null]) {
      const sortie = parseLlmOutput(JSON.stringify({ ...valid, satisfaction: aberrante, urgence: aberrante }));
      expect(sortie, `satisfaction=${JSON.stringify(aberrante)}`).not.toBeNull();
      expect(sortie?.sentiment).toBe('positif');
      expect(sortie?.satisfaction).toBeUndefined();
      expect(sortie?.urgence).toBeUndefined();
    }
  });

  it('🔴 le CHECK de la migration 0121 porte les MÊMES bornes que le schéma', async () => {
    // TROISIÈME copie de l'échelle, et la seule que rien ne tenait. Le front est déjà arrimé à ce schéma
    // (`web/lib/nuage.test.ts` lit le fichier serveur) ; la contrainte EN BASE ne l'était que par un
    // commentaire. Élargir l'échelle sans la migration qui va avec ne casserait pas la note, ça ferait
    // échouer l'INSERT de l'analyse ENTIÈRE : la transaction est annulée, `analysis_status` n'avance pas,
    // le balayage re-réclame la conversation et repaie le modèle à chaque passage. Une boucle payante et
    // silencieuse, pour une constante changée dans un seul des trois fichiers.
    const sql = await readFile(new URL('../db/migrations/0121_analyse_urgence_satisfaction.sql', import.meta.url), 'utf8');
    const bornes = [...sql.matchAll(/check \((?:satisfaction|urgence) between (-?\d+) and (-?\d+)\)/g)];
    // Sans cette ligne, une migration renommée ou reformatée rendrait zéro correspondance et le test
    // passerait en ne vérifiant rien : c'est la panne qu'une sonde attrape le moins bien, la sienne.
    expect(bornes.length, 'les deux CHECK n’ont pas été lus dans la migration : ce test ne garde plus rien').toBe(2);
    for (const [, min, max] of bornes) {
      expect(Number(min)).toBe(NOTE_MIN);
      expect(Number(max)).toBe(NOTE_MAX);
    }
  });

  it('le PROMPT demande les deux notes avec leurs bornes', () => {
    // Une échelle sans ses extrémités se lit dans les deux sens : « 0 » voudrait dire « aucune urgence »
    // pour un modèle et « urgence maximale » pour un autre, et le nuage entier basculerait sans un mot.
    const { system } = buildPrompt('Client: bonjour');
    expect(system).toContain('satisfaction');
    expect(system).toContain('urgence');
    expect(system).toMatch(/0 = client très mécontent/);
    expect(system).toMatch(/10 = le client attend une réponse immédiate/);
  });
});
