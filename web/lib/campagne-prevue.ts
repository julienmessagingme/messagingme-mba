/**
 * Le bouton d'un brouillon que l'assistant a préparé pour une date (`prepare_campaign`, champ `prevueLe`). 🔴 Une date
 * future fait PROGRAMMER à cette date, jamais envoyer tout de suite : la personne a vu « demain 10 h » dans son
 * assistant. Une date passée redevient un lancement ordinaire, et l'écran la montre comme passée.
 */
export type LancementBrouillon =
  | { action: 'lancer'; prevuePassee: string | null }
  | { action: 'programmer'; quand: string };

export function lancementDuBrouillon(prevueLe: string | null | undefined, maintenant: number): LancementBrouillon {
  const t = typeof prevueLe === 'string' ? Date.parse(prevueLe) : Number.NaN;
  if (Number.isNaN(t)) return { action: 'lancer', prevuePassee: null };
  return t > maintenant ? { action: 'programmer', quand: prevueLe as string } : { action: 'lancer', prevuePassee: prevueLe as string };
}
