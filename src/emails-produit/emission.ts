import { z } from 'zod';
import { journaliser } from '../lib/journal';
import type { CleEmail } from './catalogue';
import { CLE_FUSEAU } from './rendu';

/**
 * L'ÉMISSION D'UN E-MAIL DU PRODUIT (lot 7) : une occasion (« crédit épuisé, cet espace, ce jour ») devient une ligne
 * du journal par destinataire, puis un job de la file `emails-produit` par ligne créée.
 *
 * 🔴 LE DÉDOUBLONNAGE EST LA RÉSERVATION, EN BASE : la contrainte unique du journal (migration 0234) arrête la même
 * occasion pour la même personne, quel que soit le nombre de copies de l'API et des workers qui émettent ; aucune file
 * du dépôt ne dédoublonne. Une occasion déjà réservée ne repart pas.
 *
 * 🔴 UNE RÉSERVATION FAITE EST UN ENVOI DÛ : si la mise en file échoue, la ligne reste `a_envoyer` et le balayage du
 * worker la reprend. C'est ce qui corrige l'alerte de crédit d'avant le lot 7, qui marquait sa journée AVANT d'envoyer et
 * perdait donc l'e-mail sur un échec de Resend.
 */

export const FILE_EMAILS_PRODUIT = 'emails-produit';

/** Le job de la file : un envoi, dans son espace, pour UNE tentative (voir `PgEmailsProduitStore.prendre`). */
export const jobEmailSchema = z.object({
  envoiId: z.uuid(),
  tenantId: z.uuid(),
  tentative: z.number().int().min(0),
});
export type JobEmail = z.infer<typeof jobEmailSchema>;

export interface Emission {
  cle: CleEmail;
  tenantId: string;
  /** Ce qui rend cet envoi unique pour une personne : un jour, un abonnement et un avis, une recharge... */
  occasion: string;
  /** Les valeurs des variables du modèle (les dates en ISO). Le nom de l'espace est relu à l'envoi. */
  valeurs: Record<string, string>;
  /** Les administrateurs déjà connectés de l'espace, ou des personnes nommées. */
  a: 'admins' | { identites: string[] };
}

export interface DepsEmetteurEmails {
  adminsConnectes(tenantId: string): Promise<string[]>;
  reserver(e: { tenantId: string; cle: string; occasion: string; identites: string[]; valeurs: Record<string, string> }): Promise<string[]>;
  /** Le fuseau de l'espace : il écrit les dates du modèle, et il est figé avec les valeurs. */
  fuseau(tenantId: string): Promise<string>;
  enfiler(job: JobEmail): Promise<void>;
}

/**
 * `reserves` : les lignes créées par CET appel (zéro = occasion déjà prise, ou personne à prévenir) ;
 * `destinataires` : les personnes visées.
 */
export interface IssueEmission {
  destinataires: number;
  reserves: number;
}

export interface EmetteurEmails {
  emettre(e: Emission): Promise<IssueEmission>;
}

export function creerEmetteurEmails(d: DepsEmetteurEmails): EmetteurEmails {
  return {
    async emettre(e) {
      const identites = e.a === 'admins' ? await d.adminsConnectes(e.tenantId) : [...new Set(e.a.identites)];
      if (identites.length === 0) {
        journaliser('warn', 'email_produit_sans_destinataire', { tenantId: e.tenantId, cle: e.cle });
        return { destinataires: 0, reserves: 0 };
      }
      const valeurs = { ...e.valeurs, [CLE_FUSEAU]: await d.fuseau(e.tenantId) };
      const ids = await d.reserver({ tenantId: e.tenantId, cle: e.cle, occasion: e.occasion, identites, valeurs });
      for (const envoiId of ids) {
        try {
          await d.enfiler({ envoiId, tenantId: e.tenantId, tentative: 0 });
        } catch (err) {
          // La ligne reste `a_envoyer` : le balayage la reprendra. Rien n'est perdu, rien ne remonte.
          journaliser('warn', 'email_produit_mise_en_file_echouee', { err, tenantId: e.tenantId, cle: e.cle });
        }
      }
      return { destinataires: identites.length, reserves: ids.length };
    },
  };
}
