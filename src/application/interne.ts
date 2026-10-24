/**
 * Ce que le service de connexions et ses clients partagent, sans rien de Baileys : l'API et le worker l'importent sans
 * charger le transport (`tests/application-sans-baileys.test.ts`).
 */
export const PREFIXE = '/interne/application/comptes';

/**
 * `refuse_whatsapp` : WhatsApp a refusé le message lui-même (l'erreur 463 des appareils liés qui écrivent à de nouveaux
 * contacts, plan 2026-10-23, tâche 2). Le numéro n'est pas coupé ; c'est ce qui gèle ses premiers messages.
 */
export type RaisonRefus = 'compte_inconnu' | 'non_relie' | 'statut' | 'refuse_whatsapp';

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
