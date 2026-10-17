import { WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL } from '../crm/fields';
import { estCleReservee } from '../crm/champs-fiche';
import type { UserFieldDef } from '../crm/types';
import {
  deriveScreens,
  DuplicateFieldKeyError,
  fieldsOfScreens,
  flowFieldToUserFieldType,
  VisibleIfError,
} from '../meta/flow-json';
import type { FlowField, FlowScreenDef, FlowScreenInput } from '../meta/flow-json';

/** Forme déjà lue par la route : les cibles restent alignées sur l'ordre global des champs. */
export interface FormulaireALire {
  screens: FlowScreenInput[];
  saveTos: Array<string | undefined>;
}

/**
 * Résultat complet de la préparation. Aucun effet n'a encore eu lieu : les champs à assurer ne seront créés
 * qu'avec la ligne locale, après l'acceptation du formulaire par Meta.
 */
export interface FormulairePrepare {
  screens: FlowScreenDef[];
  mapping: Record<string, string>;
  fields: FlowField[];
  champsAAssurer: UserFieldDef[];
}

export interface LectureChampsFormulaire {
  list(tenantId: string): Promise<UserFieldDef[]>;
}

export type ResultatPreparation = { error: string } | { formulaire: FormulairePrepare };

/**
 * Valide et prépare un formulaire sans aucune écriture. Cette séparation garantit qu'un 400 ou un refus de Meta
 * ne laisse jamais de définition CRM créée à moitié. Les seules lectures servent à valider les cibles explicites
 * des consentements.
 */
export async function preparerFormulaire(
  champs: LectureChampsFormulaire,
  tenantId: string,
  brut: FormulaireALire,
): Promise<ResultatPreparation> {
  let screens: FlowScreenDef[];
  try {
    screens = deriveScreens(brut.screens);
  } catch (err) {
    if (err instanceof DuplicateFieldKeyError || err instanceof VisibleIfError) return { error: err.message };
    throw err;
  }

  const fields = fieldsOfScreens(screens);
  const mapping: Record<string, string> = {};
  const champsAAssurer: UserFieldDef[] = [];
  let defs: UserFieldDef[] | null = null;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    const saveTo = brut.saveTos[i];
    const cible = saveTo ?? field.key;

    // `nom` et `wa_id` restent permis pour compatibilité avec les formulaires déjà créés.
    if (estCleReservee(cible) && cible !== 'nom' && cible !== 'wa_id') {
      return { error: `« ${field.label} » : « ${cible} » est un champ réservé de la fiche, renommez la question` };
    }

    if (field.type === 'optin') {
      if (saveTo) {
        defs ??= await champs.list(tenantId);
        const target = defs.find((d) => d.key === saveTo);
        if (!target || target.type !== 'boolean') {
          return { error: `le consentement « ${field.label} » doit être enregistré dans un champ Oui/Non existant` };
        }
        mapping[field.key] = saveTo;
      } else {
        mapping[field.key] = WHATSAPP_OPTIN_FIELD_KEY;
        champsAAssurer.push({
          key: WHATSAPP_OPTIN_FIELD_KEY,
          label: WHATSAPP_OPTIN_FIELD_LABEL,
          type: 'boolean',
        });
      }
    } else if (saveTo) {
      mapping[field.key] = saveTo;
    } else {
      mapping[field.key] = field.key;
      champsAAssurer.push({
        key: field.key,
        label: field.label,
        type: flowFieldToUserFieldType(field.type),
      });
    }
  }

  const optinTargets = fields.filter((f) => f.type === 'optin').map((f) => mapping[f.key]!);
  if (new Set(optinTargets).size !== optinTargets.length) {
    return { error: 'deux consentements enregistrent dans le même champ : donnez une cible distincte à chacun' };
  }

  return { formulaire: { screens, mapping, fields, champsAAssurer } };
}
