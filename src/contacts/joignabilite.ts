/**
 * « Ce contact est-il joignable sur ce canal ? », le point de passage unique. Il lit deux sources sans en créer une
 * troisième : le cache RCS (`src/rcs/reachability.ts`, 7 jours, par agent) et deux colonnes WhatsApp de `contacts`.
 * Péremptions asymétriques, voulues : le RCS dépend du terminal et de l'opérateur (7 jours) ; un numéro qui gagne
 * WhatsApp est rare mais réel (90 jours, pour ne pas exclure quelqu'un à vie).
 */
export type Verdict = 'oui' | 'non' | 'inconnu';

/** 90 jours. Au-delà, on retente : un essai coûte un message raté, un faux définitif exclut un contact en silence. */
export const PEREMPTION_WHATSAPP_MS = 90 * 86_400_000;

/**
 * Pur. `null` rend `inconnu`, jamais `non` : un contact jamais sollicité n'a pas été jugé. Une valeur sans date rend
 * `inconnu` aussi : sans instant, elle ne se périmerait jamais.
 */
export function verdictWhatsApp(
  valeur: boolean | null,
  mesureLe: Date | null,
  maintenant: Date,
): Verdict {
  if (valeur === null || mesureLe === null) return 'inconnu';
  if (maintenant.getTime() - mesureLe.getTime() > PEREMPTION_WHATSAPP_MS) return 'inconnu';
  return valeur ? 'oui' : 'non';
}
