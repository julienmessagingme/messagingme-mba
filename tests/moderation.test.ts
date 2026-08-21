import { describe, it, expect } from 'vitest';
import { llmOutputSchema } from '../src/analysis/schema';
import { buildPrompt } from '../src/analysis/engine';

/** Sortie LLM minimale valide, à laquelle chaque test ajoute ce qu'il veut éprouver. */
const base = {
  sentiment: 'negatif', intent: 'reclamation', topic: 'retard', resolved: false,
  entities: {}, action_suggestion: 'escalader', confidence: 0.8, justification: 'client mécontent',
};

describe('constat d’injure dans l’analyse', () => {
  it('le champ est lu quand le modèle le renvoie', () => {
    const r = llmOutputSchema.safeParse({ ...base, abusive: true });
    expect(r.success && r.data.abusive).toBe(true);
  });

  it('🔴 un modèle qui OMET le champ ne casse pas toute l’analyse', () => {
    // Le champ est arrivé après coup. Une analyse perdue coûte plus cher qu'un signalement manqué : l'absence
    // vaut donc « rien à signaler », et surtout pas un rejet de la sortie entière.
    const r = llmOutputSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.success && r.data.abusive).toBe(false);
  });

  it('une valeur non booléenne est refusée, pas coercée', () => {
    expect(llmOutputSchema.safeParse({ ...base, abusive: 'oui' }).success).toBe(false);
    expect(llmOutputSchema.safeParse({ ...base, abusive: 1 }).success).toBe(false);
  });

  it('🔴 la consigne reste ÉTROITE : le mécontentement n’est pas une injure', () => {
    // Si le critère s'élargit, la liste se remplit de réclamations ordinaires et plus personne ne la lit.
    // Ce test fige l'intention, pas la formulation exacte.
    const { system } = buildPrompt('client: bonjour');
    expect(system).toContain('abusive');
    expect(system).toMatch(/UNIQUEMENT/);
    expect(system).toMatch(/mécontentement/);
  });
});
