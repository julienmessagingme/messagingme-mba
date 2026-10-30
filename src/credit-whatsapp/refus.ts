/**
 * LE REFUS D'UN ENVOI SUR LA LIGNE DE CRÉDIT, levé par la fabrique d'envoi AVANT tout appel à Meta (garde du Crédit
 * WhatsApp, `src/credit-whatsapp/garde.ts`).
 *
 * 🔴 Une classe à part, et pas un troisième motif de `NumeroBloqueError` : toutes les traductions de celle-ci sont
 * binaires (délié, sinon suspendu), un motif de plus y deviendrait « numéro suspendu » ou une pause jamais écrite.
 * Chaque chemin qui attrape `NumeroBloqueError` attrape aussi celle-ci (inventaire `tests/credit-whatsapp-inventaire.test.ts`).
 *
 * - `solde` (402) : le Crédit WhatsApp ne couvre pas ce message ; `manqueMicroEur` dit combien il manque.
 * - `ligne_inactive` (409) : le numéro est sur la ligne mais n'y est plus payé (option arrêtée), ou rien ne permet de
 *   chiffrer le message (aucune grille de Meta en vigueur) ; recharger n'y changerait rien.
 *
 * Le message ne porte aucun identifiant : il s'inscrit sur le destinataire d'une campagne ou dans un journal.
 */
export type MotifRefusCredit = 'solde' | 'ligne_inactive';

/** Le code de l'API publique, de Claude et de la console, une fois pour tous les chemins. */
export const CODE_REFUS_CREDIT: Record<MotifRefusCredit, string> = {
  solde: 'whatsapp_credit_exhausted',
  ligne_inactive: 'whatsapp_credit_line_inactive',
};

export const MESSAGE_REFUS_CREDIT: Record<MotifRefusCredit, string> = {
  solde: 'Crédit WhatsApp épuisé : ce message n’est pas parti. Un administrateur peut recharger le crédit depuis Paramètres > Offre.',
  ligne_inactive: 'Le Crédit WhatsApp n’est pas actif sur ce numéro : ce message n’est pas parti.',
};

export class CreditWhatsappRefus extends Error {
  readonly statusCode: 402 | 409;

  /**
   * `manqueMicroEur` : ce qui manque pour ce message ; `prixMicroEur` : son prix, commission comprise (la pause d'une
   * campagne ne s'écrit que si le solde est encore sous ce prix, `pauserCampagneCredit`).
   */
  constructor(readonly motif: MotifRefusCredit, readonly manqueMicroEur: number | null = null, readonly prixMicroEur: number | null = null) {
    super(MESSAGE_REFUS_CREDIT[motif]);
    this.name = 'CreditWhatsappRefus';
    this.statusCode = motif === 'solde' ? 402 : 409;
  }

  get code(): string {
    return CODE_REFUS_CREDIT[this.motif];
  }
}
