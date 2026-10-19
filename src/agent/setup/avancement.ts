import { inventaireDe, type ContexteConstruction } from './conversation';
import { agendaEffectif, manquesDeCouverture, prochainPoint } from './couverture';
import type { EntretienComplet } from './entretien-store';

export interface AvancementEntretien {
  manquants: string[];
  total: number;
  pointOuvert: string | null;
}

/** L'avancement affiché par la console, calculé sur l'ordre du jour effectif de cet agent. */
export function avancementEntretien(
  etat: EntretienComplet,
  contexte: ContexteConstruction | null,
): AvancementEntretien {
  const inventaire = contexte ? inventaireDe(contexte) : undefined;
  const manquants = manquesDeCouverture(etat, inventaire);
  return {
    manquants,
    total: agendaEffectif(etat, inventaire).length,
    pointOuvert: prochainPoint(etat, inventaire)?.code ?? null,
  };
}
