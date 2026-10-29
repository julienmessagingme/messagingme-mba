import { ensureFieldByKey, type UserFieldStore } from '../crm/fields';
import type { UserFieldType } from '../crm/types';
import type { ChampsFiche } from '../campaign/build';

/**
 * LES CHAMPS QUE L'ACTION « LANCER UN SCÉNARIO (TRANSACTION) » ÉCRIT SUR LA FICHE (cadrage
 * `~/mm-hubspot/docs/2026-10-29-action-workflow-transaction-cadrage.md`, décisions 6 et 7, validées par Julien le
 * 2026-10-29). Ce que HubSpot sait et que la fiche ne sait pas : le prénom du contact, son conseiller (le propriétaire de
 * la transaction), le lien de réservation de ce conseiller. Les blocs libres du scénario les lisent (`{{hubspot_…}}`), et
 * le modèle d'ouverture par ses sources.
 *
 * 🔴 DES CLÉS FIXES, DÉCLARÉES AVANT LA PREMIÈRE ÉCRITURE : les sources d'un modèle se posent à sa création et ne
 * proposent que les champs déclarés, et un champ créé depuis la console tire sa clé de son libellé (« Prénom (HubSpot) »
 * donnerait `prenom_hubspot`). La déclaration a lieu à l'allumage des workflows HubSpot (`declarerChampsHubspot`). Une
 * clé qui existe déjà est reprise telle quelle : même clé, même sens.
 */
export const CHAMPS_FICHE_HUBSPOT = [
  { cle: 'hubspot_prenom', libelle: 'Prénom (HubSpot)', type: 'text', recu: 'prenom' },
  { cle: 'hubspot_conseiller', libelle: 'Conseiller (HubSpot)', type: 'text', recu: 'conseiller' },
  { cle: 'hubspot_lien_agenda', libelle: 'Lien d’agenda (HubSpot)', type: 'url', recu: 'lienAgenda' },
] as const satisfies ReadonlyArray<{ cle: string; libelle: string; type: UserFieldType; recu: string }>;

/** Ce que le connecteur transmet pour la fiche, chaque valeur facultative. */
export type ChampsRecus = Partial<Record<(typeof CHAMPS_FICHE_HUBSPOT)[number]['recu'], string>>;

/** Déclare les trois champs dans l'espace (idempotent). */
export async function declarerChampsHubspot(store: UserFieldStore, tenantId: string): Promise<void> {
  for (const c of CHAMPS_FICHE_HUBSPOT) await ensureFieldByKey(store, tenantId, c.cle, c.libelle, c.type);
}

/**
 * Les champs reçus, en écriture de fiche : une valeur posée, une absente RETIRÉE. Jamais la valeur laissée par une
 * transaction précédente (décision 6).
 */
export function champsDeFiche(recus: ChampsRecus): ChampsFiche {
  const poser: Record<string, string> = {};
  const retirer: string[] = [];
  for (const c of CHAMPS_FICHE_HUBSPOT) {
    const v = recus[c.recu];
    if (v !== undefined && v !== '') poser[c.cle] = v;
    else retirer.push(c.cle);
  }
  return { poser, retirer };
}
