/**
 * Ce que le service de connexions et ses clients partagent, sans rien de Baileys : l'API et le worker l'importent sans
 * charger le transport (`tests/application-sans-baileys.test.ts`).
 */
export const PREFIXE = '/interne/application/comptes';

export type RaisonRefus = 'compte_inconnu' | 'non_relie' | 'statut';

export class ErreurApplication extends Error {
  constructor(readonly raison: RaisonRefus, message: string) {
    super(message);
    this.name = 'ErreurApplication';
  }
}
