import { describe, it, expect } from 'vitest';
import { completerArguments } from '../src/agent/completer-arguments';
import type { ParamOutil } from '../src/agent/llm/tool-schema';

/**
 * 🔴 LA GARDE D'IDENTITÉ D'UN OUTIL, partagée par l'exécuteur d'un agent IA et le relais de l'agent de Meta (2026-10-02) :
 * les valeurs posées par le runtime ÉCRASENT celles du modèle, jamais l'inverse.
 */
describe('compléter les arguments d’un outil', () => {
  const contact = { nom: 'Julien', tags: [], champs: { email: 'julien@exemple.fr' } };

  it('🔴 la fiche, le champ et la constante écrivent APRÈS le modèle : il ne peut pas les remplacer', () => {
    const params: ParamOutil[] = [
      { name: 'question', type: 'string', source: 'modele' },
      { name: 'email', type: 'string', source: 'champ', cle: 'email' },
      { name: 'numero', type: 'string', source: 'contact', contactPath: 'wa_id' },
      { name: 'langue', type: 'string', source: 'fixe', value: 'fr' },
    ];
    const args = completerArguments(params, { question: 'q', email: 'pirate@x', numero: '0000', langue: 'en' }, { waId: '33612345678', contact });
    expect(args).toEqual({ question: 'q', email: 'julien@exemple.fr', numero: '33612345678', langue: 'fr' });
  });

  it('un contact inconnu, ou un champ absent, rend `null` : l’appel part quand même, le serveur décide', () => {
    const params: ParamOutil[] = [
      { name: 'nom', type: 'string', source: 'contact' },
      { name: 'ref', type: 'string', source: 'champ', cle: 'absent' },
    ];
    expect(completerArguments(params, {}, { waId: '336', contact: null })).toEqual({ nom: null, ref: null });
  });
});
