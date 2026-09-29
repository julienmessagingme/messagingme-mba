import { describe, it, expect } from 'vitest';
import { CAUSE_AMORCAGE, TYPES_EVENEMENT } from '../src/inbox/evenements';
import { CAUSE_AMORCAGE as CAUSE_AMORCAGE_ECRAN, TYPES_EVENEMENT as TYPES_ECRAN } from '../web/lib/inbox-detail';

/**
 * Le panneau Détail de l'Inbox lit le journal des événements (migration 0192) avec SA copie des types et de la
 * cause d'amorçage : la console ne peut pas importer `src/`. Un type ajouté d'un seul côté serait écarté en
 * silence par la validation de l'écran (`lireDetail`), et la frise perdrait des lignes sans rien dire.
 */
describe('panneau Détail : l’écran et le serveur parlent des mêmes événements', () => {
  it('les mêmes types, dans le même ordre', () => {
    expect([...TYPES_ECRAN]).toEqual([...TYPES_EVENEMENT]);
  });

  it('la même cause d’amorçage : c’est elle qui fait dire « tenue par l’équipe » à une ligne amorcée', () => {
    expect(CAUSE_AMORCAGE_ECRAN).toBe(CAUSE_AMORCAGE);
  });
});
