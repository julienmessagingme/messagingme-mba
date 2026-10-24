import type { Emission } from '../emails-produit/emission';
import type { CompteApplication } from './comptes';

/**
 * LE COURRIEL D'UNE COUPURE (plan 2026-10-22, tâche 7) : WhatsApp a coupé le numéro, ou l'appareil a été retiré depuis le
 * téléphone. Le service de connexions le voit à la fermeture de la session (`DepsSessions.prevenir`). L'occasion porte la
 * dernière liaison du compte : une coupure ne prévient qu'une fois, et la suivante, après un nouveau lien, à nouveau.
 */
export function avisDeCoupure(emettre: (e: Emission) => Promise<unknown>): (compte: CompteApplication, quoi: 'banni' | 'deconnecte') => Promise<void> {
  return async (compte, quoi) => {
    await emettre({
      cle: quoi === 'banni' ? 'application_numero_coupe' : 'application_appareil_retire',
      tenantId: compte.tenantId,
      occasion: `${quoi}:${compte.id}:${compte.relieLe?.toISOString() ?? ''}`,
      a: 'admins',
      valeurs: { numero: `+${compte.numero}` },
    });
  };
}

/**
 * LE COURRIEL D'UN GEL (plan 2026-10-23, tâche 2) : WhatsApp a refusé un premier message du numéro, ses premiers messages
 * sont suspendus 72 heures (`traiterPremierMessage`, `src/application/premier-message.ts`). L'occasion porte la fin du
 * gel : un gel ne prévient qu'une fois, le suivant à nouveau.
 */
export function avisDeGel(emettre: (e: Emission) => Promise<unknown>): (compte: CompteApplication, jusqua: Date) => Promise<void> {
  return async (compte, jusqua) => {
    await emettre({
      cle: 'application_premiers_geles',
      tenantId: compte.tenantId,
      occasion: `gel:${compte.id}:${jusqua.toISOString()}`,
      a: 'admins',
      valeurs: { numero: `+${compte.numero}` },
    });
  };
}
