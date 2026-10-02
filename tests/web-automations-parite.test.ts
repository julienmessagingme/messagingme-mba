import { describe, it, expect } from 'vitest';
import { AUTOMATION_TRIGGER_KINDS, OPERATEURS_CONVERSATION_ANALYSEE, OPERATEURS_DEVIENT } from '../src/automation/match';
import {
  TYPES_DECLENCHEUR, OPERATEURS_CONVERSATION_ANALYSEE as OPS_ANALYSEE_CONSOLE, OPERATEURS_DEVIENT as OPS_DEVIENT_CONSOLE,
} from '../web/lib/api/integrations';

/**
 * La console et le serveur proposent les mêmes déclencheurs et les mêmes opérateurs d'analyse. Un type ajouté d'un
 * seul côté, ou un opérateur que la route refuse, ferait échouer la création en 400, ou cacherait un déclencheur.
 */
describe('déclencheurs d’automation : parité console et serveur', () => {
  it('la console propose tous les types du serveur, sauf `webhook`, possédé par son propre écran', () => {
    expect([...TYPES_DECLENCHEUR].sort()).toEqual(AUTOMATION_TRIGGER_KINDS.filter((k) => k !== 'webhook').sort());
  });

  it('les opérateurs des deux déclencheurs d’analyse sont les mêmes des deux côtés', () => {
    expect([...OPS_DEVIENT_CONSOLE]).toEqual([...OPERATEURS_DEVIENT]);
    expect([...OPS_ANALYSEE_CONSOLE]).toEqual([...OPERATEURS_CONVERSATION_ANALYSEE]);
  });
});
