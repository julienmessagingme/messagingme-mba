import { z } from 'zod';
import type { RcsOutbound } from './types';

/**
 * Validation d'un message RCS reçu du client (assistant de campagne, bloc de scénario, bibliothèque).
 *
 * UNE SEULE définition dans le projet : elle vivait dans `http/campaigns.ts` et la bibliothèque en aurait
 * fait un second exemplaire. Deux schémas pour la même donnée finissent toujours par diverger, et c'est
 * exactement ce qui a coûté des bugs de production sur les composants Meta et les visuels de carousel.
 *
 * Union FERMÉE : un `kind` inconnu est refusé, il ne traverse jamais jusqu'au provider. Toujours en
 * `safeParse` chez l'appelant, jamais `parse`.
 */
export const rcsSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(25), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('openUrl'), text: z.string().min(1).max(25), url: z.string().url(), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('dial'), text: z.string().min(1).max(25), phoneNumber: z.string().min(1), postbackData: z.string().min(1) }),
]);

export const rcsCardSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  suggestions: z.array(rcsSuggestionSchema).max(4).optional(),
});

export const rcsOutboundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(3072), suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  z.object({ kind: z.literal('card'), card: rcsCardSchema }),
  z.object({ kind: z.literal('carousel'), cards: z.array(rcsCardSchema).min(2).max(10) }),
]);

/** Message relu de NOTRE base (jsonb déjà validé à l'écriture). Rendu `null` si la forme est inattendue,
 *  plutôt qu'un `as` qui laisserait passer n'importe quoi jusqu'au provider. */
export function parseStoredRcsOutbound(raw: unknown): RcsOutbound | null {
  const r = rcsOutboundSchema.safeParse(raw);
  return r.success ? r.data : null;
}
