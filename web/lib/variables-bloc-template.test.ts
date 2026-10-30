import { describe, expect, it } from 'vitest';
import { variablesDuBloc } from './variables-bloc-template';

describe('variablesDuBloc', () => {
  it('relie chaque {{n}} du corps à son indice', () => {
    expect(variablesDuBloc('Bonjour {{1}}, rdv le {{2}}', [
      { position: 2, source: 'date' },
      { position: 1, source: 'prenom' },
    ])).toEqual([{ position: 1, source: 'prenom' }, { position: 2, source: 'date' }]);
  });

  it('une variable sans indice sort à null, pour être signalée', () => {
    expect(variablesDuBloc('Bonjour {{1}}, votre proposition est prête', [])).toEqual([{ position: 1, source: null }]);
  });

  it('un corps sans variable ne rend rien, quels que soient les indices', () => {
    expect(variablesDuBloc('Bonjour', [{ position: 1, source: 'prenom' }])).toEqual([]);
    expect(variablesDuBloc(undefined, [])).toEqual([]);
  });
});
