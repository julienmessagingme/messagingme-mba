import { z } from 'zod';

/**
 * LE TARIF QUE META ANNONCE POUR UN DE NOS MESSAGES SORTANTS (objet `pricing` d'un accusé de réception).
 *
 * 🔴 C'EST LA SEULE SOURCE DE « META NE FACTURE PAS CE MESSAGE ». Un message parti dans les 72 h qui suivent un
 * clic sur une pub Click-to-WhatsApp (« free entry point ») est gratuit, modèles compris, et seul l'accusé le
 * dit. Recalculer la fenêtre nous-mêmes recopierait les conditions de Meta (réponse sous 24 h, clic depuis un
 * téléphone...), et notre chiffre deviendrait faux le jour où elles changent.
 *
 * ⚠️ `safeParse`, jamais `parse` : c'est un payload externe. Un `pricing` illisible rend `null`, et le message
 * reste compté comme payant, c'est-à-dire le comportement d'avant.
 */
export const TYPE_ENTREE_GRATUITE = 'free_entry_point';

const accuseAvecTarif = z.object({
  id: z.string().min(1),
  pricing: z.object({
    type: z.string().min(1),
    category: z.string().min(1).nullish(),
    billable: z.boolean().nullish(),
    pricing_model: z.string().min(1).nullish(),
  }),
});

export interface TarifMeta {
  /** L'identifiant Meta du message sortant (wamid). */
  messageId: string;
  /** `pricing.type`, tel quel : 'regular', 'free_customer_service', 'free_entry_point'... */
  type: string;
  categorie: string | null;
  facturable: boolean | null;
  modele: string | null;
}

export function extraireTarif(data: unknown): TarifMeta | null {
  const r = accuseAvecTarif.safeParse(data);
  if (!r.success) return null;
  const p = r.data.pricing;
  return {
    messageId: r.data.id,
    type: p.type,
    categorie: p.category ?? null,
    facturable: p.billable ?? null,
    modele: p.pricing_model ?? null,
  };
}

/**
 * Garde le tarif d'un message. `phoneNumberId` est le numéro Meta DESTINATAIRE de l'accusé : c'est le seul
 * rattachement à un espace que porte un payload Meta.
 */
export interface TarifsMetaSink {
  enregistrer(phoneNumberId: string, t: TarifMeta): Promise<void>;
}
