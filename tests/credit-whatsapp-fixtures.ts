import type { GardeCreditWhatsapp } from '../src/credit-whatsapp/garde';

/**
 * Aucun numéro sur la ligne de crédit : la garde du Crédit WhatsApp ne provisionne rien et laisse tout partir. Les tests
 * qui construisent la fabrique d'envoi sans parler du Crédit WhatsApp prennent CETTE garde, et le DISENT (comme
 * `jamaisDelie` ou `modelesIllimites`).
 */
export const sansLigneDeCredit: GardeCreditWhatsapp = {
  avant: async () => ({ provisionId: null }),
  apres: async () => undefined,
  surEchec: async () => undefined,
  bloque: async () => false,
};
