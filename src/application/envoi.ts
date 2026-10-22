import type { ClientApplication, RaisonClient, Resultat } from './client';
import type { ComptesApplication, Filiere } from './comptes';
import { idDuMessage, jidDuWaId } from './message';

/**
 * ENVOYER PAR LA FILIÈRE APPLICATION (plan 2026-10-22, tâche 5) : ce que la réponse commune (`src/inbox/repondre.ts`),
 * l'agent IA (`src/workflow/wiring.ts`) et le contrôle du fil (`src/inbox/fil.ts`) savent de cette filière. Une seule
 * dépendance, requise partout : sans elle, un chemin oublié refuserait en silence faute de numéro Meta.
 */
export interface EnvoiApplication {
  /** `application` dès qu'un compte non retiré existe, `api` avec un numéro de Meta, `null` sinon. */
  filiere(tenantId: string): Promise<Filiere | null>;
  /** Le compte de l'espace est-il relié, donc en état d'envoyer ? */
  relie(tenantId: string): Promise<boolean>;
  /** Un texte au contact ; l'identifiant rendu est celui de nos tables (`idDuMessage`). */
  envoyer(tenantId: string, waId: string, texte: string): Promise<Resultat<{ messageId: string }>>;
}

export function creerEnvoiApplication(d: {
  comptes: Pick<ComptesApplication, 'parEspace' | 'filiereDe'>;
  /** `null` : le service n'est pas configuré (`APPLICATION_SERVICE_URL` vide), la filière est fermée. */
  client: ClientApplication | null;
}): EnvoiApplication {
  return {
    filiere: (tenantId) => d.comptes.filiereDe(tenantId),
    relie: async (tenantId) => (await d.comptes.parEspace(tenantId))?.statut === 'relie',
    async envoyer(tenantId, waId, texte) {
      const jid = jidDuWaId(waId);
      if (!jid) return { ok: false, raison: 'refuse' };
      const compte = await d.comptes.parEspace(tenantId);
      if (compte?.statut !== 'relie') return { ok: false, raison: 'non_relie' };
      if (!d.client) return { ok: false, raison: 'service_injoignable' };
      const r = await d.client.envoyer(compte.id, jid, texte);
      return r.ok ? { ok: true, messageId: idDuMessage(compte.id, r.messageId) } : r;
    },
  };
}

/** Ce qu'un refus d'envoi de la filière application dit à qui a voulu envoyer (API publique, Claude, console). */
export function phraseApplicationIndisponible(raison: RaisonClient): string {
  if (raison === 'service_injoignable') {
    return 'le service de connexion de l’application WhatsApp Business ne répond pas : réessayez dans un instant';
  }
  if (raison === 'refuse') return 'WhatsApp a refusé l’envoi de ce message';
  return 'le numéro de l’application WhatsApp Business n’est pas relié : reliez-le de nouveau (start_whatsapp_connection)';
}

/** Sur l'application, seul le texte part au premier lot : un média, des boutons ou un lieu attendent un lot suivant. */
export const PHRASE_FORMAT_APPLICATION = 'sur un numéro de l’application WhatsApp Business, seul un texte peut partir pour l’instant';
