import { describe, it, expect } from 'vitest';
import { sendingLimitLabel, tierLabel, mmLiteBadge, accountReviewBadge, businessVerificationBadge, campaignSendLabel } from './format';

/** Anti-tiret : règle projet, aucun libellé produit ne doit contenir de tiret cadratin/demi-cadratin. */
const NO_EM_DASH = /[—–]/;

describe('sendingLimitLabel (cap 24 h toujours affiché, repli honnête)', () => {
  it('palier connu -> cap en clair', () => {
    expect(sendingLimitLabel('TIER_1K', 'fr')).toBe('1 000 clients / 24 h');
    expect(sendingLimitLabel('TIER_100K', 'en')).toBe('100,000 customers / 24 h');
    expect(sendingLimitLabel('TIER_UNLIMITED', 'fr')).toBe('Illimité');
  });
  it('null / vide -> repli honnête (jamais un faux chiffre)', () => {
    expect(sendingLimitLabel(null, 'fr')).toBe('Pas encore évalué par Meta');
    expect(sendingLimitLabel(undefined, 'en')).toBe('Not yet evaluated by Meta');
    expect(sendingLimitLabel('', 'fr')).toBe('Pas encore évalué par Meta');
  });
  it('palier inconnu -> brut (jamais planter)', () => {
    expect(sendingLimitLabel('TIER_FOO', 'fr')).toBe('TIER_FOO');
  });
});

describe('tierLabel (paliers clients / 24 h, fr + en)', () => {
  it('mappe les paliers Meta en français', () => {
    expect(tierLabel('TIER_250', 'fr')).toBe('250 clients / 24 h');
    expect(tierLabel('tier_10k', 'fr')).toBe('10 000 clients / 24 h');
    expect(tierLabel('TIER_100K', 'fr')).toBe('100 000 clients / 24 h');
    expect(tierLabel('TIER_UNLIMITED', 'fr')).toBe('Illimité');
  });
  it('mappe les paliers Meta en anglais', () => {
    expect(tierLabel('TIER_1K', 'en')).toBe('1,000 customers / 24 h');
    expect(tierLabel('UNLIMITED', 'en')).toBe('Unlimited');
  });
  it('valeur inconnue -> brut (jamais un faux chiffre)', () => {
    expect(tierLabel('TIER_999', 'fr')).toBe('TIER_999');
  });
});

describe('mmLiteBadge', () => {
  it('ONBOARDED -> approuvé, tone ok', () => {
    expect(mmLiteBadge('ONBOARDED', 'fr')).toEqual({ label: 'Approuvé', tone: 'ok' });
    expect(mmLiteBadge('onboarded', 'en')).toEqual({ label: 'Approved', tone: 'ok' });
  });
  it('null -> non communiqué, tone unknown (jamais un faux "Non")', () => {
    expect(mmLiteBadge(null, 'fr')).toEqual({ label: 'Non communiqué', tone: 'unknown' });
    expect(mmLiteBadge(undefined, 'en')).toEqual({ label: 'Not reported', tone: 'unknown' });
  });
  it('autre statut connu -> warn', () => {
    expect(mmLiteBadge('IN_REVIEW', 'fr')).toEqual({ label: 'En revue', tone: 'warn' });
    expect(mmLiteBadge('NOT_ONBOARDED', 'en')).toEqual({ label: 'Not enabled', tone: 'warn' });
  });
});

describe('accountReviewBadge', () => {
  it('APPROVED -> ok ; PENDING/REJECTED -> warn ; null -> unknown', () => {
    expect(accountReviewBadge('APPROVED', 'fr').tone).toBe('ok');
    expect(accountReviewBadge('PENDING', 'fr').tone).toBe('warn');
    expect(accountReviewBadge('REJECTED', 'en').tone).toBe('warn');
    expect(accountReviewBadge(null, 'fr').tone).toBe('unknown');
  });
});

describe('businessVerificationBadge', () => {
  it('VERIFIED -> ok ; not_verified/pending -> warn ; null -> unknown', () => {
    expect(businessVerificationBadge('verified', 'fr').tone).toBe('ok');
    expect(businessVerificationBadge('not_verified', 'fr').tone).toBe('warn');
    expect(businessVerificationBadge('pending', 'en').tone).toBe('warn');
    expect(businessVerificationBadge(null, 'en').tone).toBe('unknown');
  });
});

describe('anti-tiret cadratin sur tous les libellés produits', () => {
  it('aucun libellé ne contient — ou –', () => {
    const samples = [
      sendingLimitLabel(null, 'fr'), sendingLimitLabel(null, 'en'),
      sendingLimitLabel('TIER_1K', 'fr'), sendingLimitLabel('TIER_UNLIMITED', 'fr'),
      mmLiteBadge('ONBOARDED', 'fr').label, mmLiteBadge(null, 'fr').label, mmLiteBadge('IN_REVIEW', 'fr').label,
      accountReviewBadge('PENDING', 'fr').label, businessVerificationBadge('not_verified', 'fr').label,
      campaignSendLabel({ templateName: 'promo', templateLanguage: 'fr', workflowName: null }, 'fr'),
      campaignSendLabel({ templateName: null, templateLanguage: null, workflowName: 'Relance' }, 'fr'),
      campaignSendLabel({ templateName: null, templateLanguage: null, workflowName: null }, 'fr'),
    ];
    for (const s of samples) expect(NO_EM_DASH.test(s), `libellé « ${s} » contient un tiret interdit`).toBe(false);
  });
});

describe('campaignSendLabel (ce que la campagne envoie)', () => {
  const tpl = { templateName: 'promo_ete', templateLanguage: 'fr', workflowName: null };
  const scenario = { templateName: null, templateLanguage: null, workflowName: 'Relance promo' };

  it('template, scénario, scénario supprimé', () => {
    expect(campaignSendLabel(tpl, 'fr')).toBe('Template « promo_ete » (fr)');
    expect(campaignSendLabel({ ...tpl, templateLanguage: null }, 'fr')).toBe('Template « promo_ete »');
    expect(campaignSendLabel(scenario, 'fr')).toBe('Scénario « Relance promo »');
    expect(campaignSendLabel(scenario, 'en')).toBe('Scenario “Relance promo”');
    expect(campaignSendLabel({ templateName: null, templateLanguage: null, workflowName: null }, 'fr')).toBe('Scénario supprimé');
  });

  it('NON-RÉGRESSION : jamais « template () », jamais vide (le symptôme rapporté)', () => {
    const cases = [tpl, scenario, { templateName: '', templateLanguage: '', workflowName: '' }, { templateName: ' ', templateLanguage: ' ', workflowName: null }];
    for (const c of cases) for (const l of ['fr', 'en'] as const) {
      const out = campaignSendLabel(c, l);
      expect(out.trim()).not.toBe('');
      expect(out).not.toMatch(/\(\s*\)/);
    }
  });
});
