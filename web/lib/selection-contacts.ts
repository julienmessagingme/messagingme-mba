import type { BulkTarget, ContactFilters } from './contact-filters';

/**
 * Une sélection explicite de lignes, ou tous les contacts correspondant aux filtres moins les exclusions.
 * `toutFiltre` exprime une intention serveur : la page affichée peut être plafonnée à 500 lignes. Dans ce
 * mode, seul `exclus` décide des cases décochées ; dans l'autre, seul `selected` décide des cases cochées.
 */
export interface SelectionContacts {
  toutFiltre: boolean;
  selected: Set<string>;
  exclus: Set<string>;
}

export function selectionTout(): SelectionContacts {
  return { toutFiltre: true, selected: new Set(), exclus: new Set() };
}

export function selectionVide(): SelectionContacts {
  return { toutFiltre: false, selected: new Set(), exclus: new Set() };
}

export function estRetenu(selection: SelectionContacts, id: string): boolean {
  return selection.toutFiltre ? !selection.exclus.has(id) : selection.selected.has(id);
}

export function nbRetenus(selection: SelectionContacts, total: number | null): number {
  return selection.toutFiltre ? Math.max(0, (total ?? 0) - selection.exclus.size) : selection.selected.size;
}

/** Bascule la seule case active dans le mode courant, sans muter l'état précédent. */
export function basculerContact(selection: SelectionContacts, id: string): SelectionContacts {
  const ids = new Set(selection.toutFiltre ? selection.exclus : selection.selected);
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  return selection.toutFiltre ? { ...selection, exclus: ids } : { ...selection, selected: ids };
}

/** L'en-tête du CRM coche les lignes chargées, ou vide la sélection si elles le sont déjà. */
export function basculerLignesAffichees(selection: SelectionContacts, ids: string[]): SelectionContacts {
  if (selection.toutFiltre) return selectionVide();
  const toutesCochees = ids.length > 0 && ids.every((id) => estRetenu(selection, id));
  return { ...selection, selected: toutesCochees ? new Set() : new Set(ids) };
}

/** Contrat commun des actions CRM et de la création de campagne. */
export function cibleContacts(selection: SelectionContacts, filtres: ContactFilters): BulkTarget {
  return selection.toutFiltre
    ? { filters: filtres, excludeIds: [...selection.exclus] }
    : { ids: [...selection.selected] };
}
