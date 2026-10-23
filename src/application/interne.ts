/**
 * Ce que le service de connexions et ses clients partagent, sans rien de Baileys : l'API et le worker l'importent sans
 * charger le transport (`tests/application-sans-baileys.test.ts`).
 */
export const PREFIXE = '/interne/application/comptes';

export type RaisonRefus = 'compte_inconnu' | 'non_relie' | 'statut';

/**
 * Ce que dit la vérification d'un numéro avant un premier message : présent sur WhatsApp ou non, et l'adresse à laquelle
 * l'envoi qui suit partira (l'identifiant masqué, ou le numéro faute de mieux, qui peut rester « En attente » sur le
 * mobile). `adresse` est `null` pour un absent.
 */
export interface Verification {
  present: boolean;
  adresse: 'lid' | 'numero' | null;
}

export class ErreurApplication extends Error {
  constructor(readonly raison: RaisonRefus, message: string) {
    super(message);
    this.name = 'ErreurApplication';
  }
}
