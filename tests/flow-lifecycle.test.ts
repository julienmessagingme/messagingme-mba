import { describe, expect, it } from 'vitest';
import {
  creerFormulaire,
  FormulaireDistantNonConfirme,
  mettreAJourFormulaire,
} from '../src/flow/lifecycle';
import type { CycleFormulaireDeps, FormulaireLocal } from '../src/flow/lifecycle';
import type { CreateFlowInput } from '../src/meta/flows';

const metaInput: CreateFlowInput = {
  name: 'Contact',
  ref: 'ref-1',
  screens: [{ elements: [{ kind: 'field', label: 'Ville', type: 'text', required: true, key: 'ville' }] }],
};

const localSansId: Omit<FormulaireLocal, 'id'> = {
  tenantId: 'tenant-1',
  name: 'Contact',
  ref: 'ref-1',
  screens: metaInput.screens,
  mapping: { ville: 'ville' },
  champsAAssurer: [{ key: 'ville', label: 'Ville', type: 'text' }],
};

function deps(over: {
  createLocal?: () => Promise<void>;
  updateLocal?: () => Promise<boolean>;
  deleteMeta?: () => Promise<void>;
} = {}) {
  const appels = { createMeta: 0, updateMeta: 0, deleteMeta: 0, createLocal: 0, updateLocal: 0 };
  const d: CycleFormulaireDeps = {
    meta: {
      create: async () => { appels.createMeta += 1; return { id: 'flow-1', status: 'DRAFT' }; },
      updateDraft: async () => { appels.updateMeta += 1; },
      delete: async () => { appels.deleteMeta += 1; await over.deleteMeta?.(); },
    },
    local: {
      create: async () => { appels.createLocal += 1; await over.createLocal?.(); },
      update: async () => { appels.updateLocal += 1; return over.updateLocal ? over.updateLocal() : true; },
    },
  };
  return { d, appels };
}

describe('cycle de vie des formulaires WhatsApp', () => {
  it('réessaie seulement la confirmation locale après une création acceptée par Meta', async () => {
    let premier = true;
    const { d, appels } = deps({
      createLocal: async () => {
        if (premier) {
          premier = false;
          throw new Error('base indisponible');
        }
      },
    });

    await expect(creerFormulaire(d, 'waba-1', localSansId, metaInput)).resolves.toEqual({ id: 'flow-1', status: 'DRAFT' });
    expect(appels).toMatchObject({ createMeta: 1, createLocal: 2, deleteMeta: 0 });
  });

  it('supprime le brouillon Meta si la confirmation locale échoue deux fois', async () => {
    const { d, appels } = deps({ createLocal: async () => { throw new Error('base indisponible'); } });

    await expect(creerFormulaire(d, 'waba-1', localSansId, metaInput)).rejects.toThrow('base indisponible');
    expect(appels).toMatchObject({ createMeta: 1, createLocal: 2, deleteMeta: 1 });
  });

  it('rend un état explicite si le brouillon Meta ne peut pas être compensé', async () => {
    const { d } = deps({
      createLocal: async () => { throw new Error('base indisponible'); },
      deleteMeta: async () => { throw new Error('suppression refusée'); },
    });

    const erreur = await creerFormulaire(d, 'waba-1', localSansId, metaInput).catch((err: unknown) => err);
    expect(erreur).toBeInstanceOf(FormulaireDistantNonConfirme);
    expect(erreur).toMatchObject({ statusCode: 409, flowId: 'flow-1', operation: 'creation' });
    expect((erreur as Error).message).toContain('Rafraîchir');
  });

  it('une mise à jour acceptée ne rejoue jamais Meta quand la base reprend', async () => {
    let premier = true;
    const { d, appels } = deps({
      updateLocal: async () => {
        if (premier) {
          premier = false;
          throw new Error('base indisponible');
        }
        return true;
      },
    });

    await mettreAJourFormulaire(d, { ...localSansId, id: 'flow-1' }, metaInput);
    expect(appels).toMatchObject({ updateMeta: 1, updateLocal: 2 });
  });
});
