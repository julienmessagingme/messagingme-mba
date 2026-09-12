/**
 * « Ce contact est-il joignable sur ce canal ? », le point de passage UNIQUE.
 *
 * 🔴 IL LIT DEUX SOURCES, IL N'EN CRÉE PAS UNE TROISIÈME. Le RCS a déjà son cache
 * (`src/rcs/reachability.ts`, TTL 7 jours, indexé par agent) ; WhatsApp gagne deux colonnes sur
 * `contacts`. Écrire une seconde définition de « joignable » garantirait qu'elles divergent.
 *
 * ⚠️ L'ASYMÉTRIE DES DEUX PÉREMPTIONS EST VOULUE. Le RCS dépend du terminal et de l'opérateur, il
 * est volatil, d'où 7 jours. Un numéro qui GAGNE WhatsApp est rare mais réel, d'où 90 jours : assez
 * long pour servir à quelque chose, assez court pour ne pas exclure quelqu'un à vie.
 */
export type Verdict = 'oui' | 'non' | 'inconnu';

/** 90 jours. Au-delà, on retente : le coût d'un essai est un message raté, celui d'un faux
 *  définitif est un contact exclu pour toujours sans que personne ne puisse le voir. */
export const PEREMPTION_WHATSAPP_MS = 90 * 86_400_000;

/**
 * PURE, donc testable sans base ni horloge.
 *
 * 🔴 `null` rend `inconnu`, jamais `non`. Un contact jamais sollicité n'a pas été jugé.
 * ⚠️ Une valeur SANS date rend `inconnu` aussi : une mesure sans instant ne peut pas se périmer,
 * donc elle vaudrait pour toujours, ce qui est exactement ce que la péremption interdit.
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
