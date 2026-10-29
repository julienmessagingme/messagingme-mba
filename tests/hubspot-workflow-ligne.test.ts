import { describe, it, expect } from 'vitest';
import { PREFIXE_LIGNE_HUBSPOT, lancementDeCampagne } from '../src/hubspot-workflow/ligne';
import { PREFIXE_LIGNE_HUBSPOT as REEXPORTE } from '../src/hubspot-workflow/envoi';

describe('le type de lancement d’une campagne, lu sur son nom (cadrage du 2026-10-29, décision 3)', () => {
  it('la ligne d’un workflow HubSpot démarre en `workflow_hubspot`', () => {
    expect(lancementDeCampagne(`${PREFIXE_LIGNE_HUBSPOT}5213415625`)).toBe('workflow_hubspot');
  });

  it('toute autre campagne, ou sans nom, reste en `campagne_scenario`', () => {
    for (const nom of ['Relance devis', '[API] relance', 'HubSpot workflow 12', 'hubspot · workflow 12', '', null]) {
      expect(lancementDeCampagne(nom), String(nom)).toBe('campagne_scenario');
    }
  });

  it('un seul préfixe : l’adaptateur d’envoi réexporte celui du moteur', () => {
    expect(REEXPORTE).toBe(PREFIXE_LIGNE_HUBSPOT);
  });
});
