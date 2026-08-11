import { describe, it, expect } from 'vitest';
// Module PUR du front, importé par chemin relatif (même patron que web-campaign-eligibility / web-range).
import { campaignSendLabel } from '../web/lib/format';

const tpl = { templateName: 'promo_ete', templateLanguage: 'fr', workflowName: null };
const scenario = { templateName: null, templateLanguage: null, workflowName: 'Relance promo' };
const orphan = { templateName: null, templateLanguage: null, workflowName: null };

describe('campaignSendLabel', () => {
  it('template + langue', () => {
    expect(campaignSendLabel(tpl, 'fr')).toBe('Template « promo_ete » (fr)');
    expect(campaignSendLabel(tpl, 'en')).toBe('Template “promo_ete” (fr)');
  });

  it('template sans langue -> aucune parenthèse vide', () => {
    expect(campaignSendLabel({ ...tpl, templateLanguage: null }, 'fr')).toBe('Template « promo_ete »');
    expect(campaignSendLabel({ ...tpl, templateLanguage: '' }, 'fr')).toBe('Template « promo_ete »');
  });

  it('campagne scénario -> nom du scénario, jamais le mot template', () => {
    expect(campaignSendLabel(scenario, 'fr')).toBe('Scénario « Relance promo »');
    expect(campaignSendLabel(scenario, 'en')).toBe('Scenario “Relance promo”');
  });

  it('ni template ni scénario (scénario supprimé) -> repli explicite', () => {
    expect(campaignSendLabel(orphan, 'fr')).toBe('Scénario supprimé');
    expect(campaignSendLabel(orphan, 'en')).toBe('Deleted scenario');
  });

  it('NON-RÉGRESSION du bug : jamais « template () », jamais vide, dans tous les cas', () => {
    const cases = [tpl, scenario, orphan,
      { templateName: '', templateLanguage: '', workflowName: '' },      // ancien codage du cas scénario
      { templateName: '  ', templateLanguage: ' ', workflowName: null }, // blancs seuls
      { ...tpl, templateLanguage: null },
    ];
    for (const c of cases) {
      for (const locale of ['fr', 'en'] as const) {
        const out = campaignSendLabel(c, locale);
        expect(out.trim()).not.toBe('');
        expect(out).not.toMatch(/\(\s*\)/); // le symptôme exact rapporté par l'utilisateur
      }
    }
  });
});
