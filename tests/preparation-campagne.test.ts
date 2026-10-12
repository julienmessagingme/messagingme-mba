import { describe, expect, it } from 'vitest';
import { preparerCampagne, type PreparationCampagneDeps } from '../src/http/preparation-campagne';
import { campagnesInertes } from './routes-inertes';

const corps = {
  phoneNumberId: 'pn1',
  name: 'Annonce',
  category: 'marketing',
  templateName: 'annonce',
  templateLanguage: 'fr',
  paramMapping: [],
};

function lecteurs(options: {
  tous?: (tenant: string, limite: number) => Promise<string[]>;
  cible?: PreparationCampagneDeps['contacts']['contactIdsForTarget'];
  plafond?: number;
} = {}): PreparationCampagneDeps {
  return {
    repo: { phoneNumberBelongsToTenant: async () => true },
    contacts: { contactIdsForTarget: options.cible ?? (async () => { throw new Error('cible inattendue'); }) },
    identifiantsDeTousLesContacts: options.tous ?? (async () => { throw new Error('lecture de tous inattendue'); }),
    plafondDestinataires: options.plafond ?? 2,
    rcs: { belongsToTenant: async () => true },
    emailTemplateBelongsToTenant: async () => true,
    webhookUsableByTenant: async () => true,
    getWorkflowGraph: async () => null,
    offres: campagnesInertes.offres,
  };
}

describe('préparation de campagne', () => {
  it('fige les identifiants lus dans la limite plafond + 1', async () => {
    const lectures: Array<{ tenant: string; limite: number }> = [];
    const resultat = await preparerCampagne(corps, 't1', lecteurs({
      tous: async (tenant, limite) => {
        lectures.push({ tenant, limite });
        return ['c1', 'c2'];
      },
    }));

    expect(lectures).toEqual([{ tenant: 't1', limite: 3 }]);
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.input.contactIds).toEqual(['c1', 'c2']);
  });

  it('refuse une liste explicitement vide sans élargir à tous les contacts', async () => {
    const resultat = await preparerCampagne({ ...corps, contactIds: [] }, 't1', lecteurs());
    expect(resultat).toEqual({ ok: false, status: 422, body: { error: 'Aucun contact ne correspond à cette sélection.' } });
  });

  it('prépare une campagne au fil de l’eau sans résoudre d’audience initiale', async () => {
    const resultat = await preparerCampagne({ ...corps, webhookId: 'wh1' }, 't1', lecteurs());
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      expect(resultat.input.webhookId).toBe('wh1');
      expect(resultat.input.contactIds).toBeUndefined();
    }
  });
});
