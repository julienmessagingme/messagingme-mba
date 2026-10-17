import { journaliser } from '../lib/journal';
import type { UserFieldDef } from '../crm/types';
import type { MetaFlowClient, CreateFlowInput } from '../meta/flows';
import type { FlowScreenDef } from '../meta/flow-json';

export interface FormulaireLocal {
  tenantId: string;
  id: string;
  name: string;
  screens: FlowScreenDef[];
  ref: string;
  mapping: Record<string, string>;
  cta?: string;
  champsAAssurer: UserFieldDef[];
}

/** Adapter local : la ligne du formulaire et ses champs CRM sont une seule écriture atomique. */
export interface PersistanceFormulaire {
  create(input: FormulaireLocal): Promise<void>;
  update(input: FormulaireLocal): Promise<boolean>;
}

type ClientCycleFormulaire = Pick<MetaFlowClient, 'create' | 'updateDraft' | 'delete'>;

export interface CycleFormulaireDeps {
  meta: ClientCycleFormulaire;
  local: PersistanceFormulaire;
}

/**
 * État exceptionnel mais actionnable : Meta a accepté l'effet, puis la confirmation locale a échoué. Le 409 garde
 * le détail visible à travers les proxies et décourage une nouvelle création aveugle.
 */
export class FormulaireDistantNonConfirme extends Error {
  readonly statusCode = 409;

  constructor(
    public readonly flowId: string,
    public readonly operation: 'creation' | 'mise_a_jour',
    cause: unknown,
  ) {
    super(operation === 'creation'
      ? `Le formulaire ${flowId} a été créé chez Meta mais n’a pas pu être enregistré ici. N’en créez pas un autre : utilisez « Rafraîchir ».`
      : `Le formulaire ${flowId} a été mis à jour chez Meta mais la copie locale n’a pas pu être confirmée. Réessayez exactement la même modification.`);
    this.name = 'FormulaireDistantNonConfirme';
    this.cause = cause;
  }
}

/** Une seule reprise locale, toujours avec le même identifiant Meta et sans rejouer l'effet distant. */
async function confirmerLocalement<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

/**
 * Crée chez Meta, puis confirme localement sans jamais créer deux fois chez Meta. Si les deux écritures locales
 * échouent, le brouillon distant est supprimé ; si cette compensation échoue aussi, l'identifiant est rendu dans une
 * erreur explicite afin que l'opérateur réconcilie au lieu de recommencer.
 */
export async function creerFormulaire(
  deps: CycleFormulaireDeps,
  wabaId: string,
  local: Omit<FormulaireLocal, 'id'>,
  metaInput: CreateFlowInput,
): Promise<{ id: string; status: string }> {
  const cree = await deps.meta.create(wabaId, metaInput);
  try {
    await confirmerLocalement(() => deps.local.create({ ...local, id: cree.id }));
    return cree;
  } catch (erreurLocale) {
    try {
      await deps.meta.delete(cree.id);
    } catch (erreurSuppression) {
      journaliser('error', 'formulaire_meta_non_confirme', {
        tenantId: local.tenantId,
        flowId: cree.id,
        operation: 'creation',
        erreurLocale,
        erreurSuppression,
      });
      throw new FormulaireDistantNonConfirme(cree.id, 'creation', erreurLocale);
    }
    throw erreurLocale;
  }
}

/**
 * Met à jour le brouillon distant, puis sa copie locale. Rejouer la confirmation locale est sûr ; en cas d'échec
 * durable, la même modification peut être renvoyée puisque l'identifiant Meta ne change pas.
 */
export async function mettreAJourFormulaire(
  deps: CycleFormulaireDeps,
  local: FormulaireLocal,
  metaInput: CreateFlowInput,
): Promise<void> {
  await deps.meta.updateDraft(local.id, metaInput);
  try {
    await confirmerLocalement(async () => {
      if (!(await deps.local.update(local))) {
        throw new Error(`formulaire local introuvable ou non modifiable : ${local.id}`);
      }
    });
  } catch (erreurLocale) {
    journaliser('error', 'formulaire_meta_non_confirme', {
      tenantId: local.tenantId,
      flowId: local.id,
      operation: 'mise_a_jour',
      erreurLocale,
    });
    throw new FormulaireDistantNonConfirme(local.id, 'mise_a_jour', erreurLocale);
  }
}
