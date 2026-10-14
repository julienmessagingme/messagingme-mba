import { DEFAULT_TIMEZONE } from '../settings/store.pg';
import { journaliser } from '../lib/journal';
import type { EmetteurEmails } from '../emails-produit/emission';

/**
 * L'ALERTE DE CRÉDIT ÉPUISÉ (lot 5, spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 7) :
 * un e-mail aux admins de l'espace, une fois par jour au plus, avec le lien de recharge. Les agents IA se taisent à
 * sec, et le client ne le verrait qu'en ouvrant l'Inbox.
 *
 * Depuis le lot 7, elle passe par les e-mails du produit (`src/emails-produit/`) : son texte se modifie dans `/ops`
 * (modèle `credit_epuise`), elle part aux admins DÉJÀ connectés, dans leur langue, et elle compte dans les chiffres.
 *
 * 🔴 LE « UNE PAR JOUR » SE TIENT EN BASE, PAS EN MÉMOIRE : l'occasion est le jour, et le journal des envois (migration
 * 0234) n'en réserve qu'une par admin, quel que soit le nombre de copies de l'API et des workers qui voient passer un
 * message d'un espace à sec. Le jour est celui du fuseau de l'espace, celui que le client lit. Et une réservation est un
 * envoi DÛ : un Resend en panne ne perd plus l'alerte (avant le lot 7, la journée était marquée avant l'envoi).
 *
 * Appelée par le démarreur du répondeur (`./demarrer.ts`, solde lu avant de démarrer) et par le tour d'un agent qui
 * sort faute de crédit (`src/agent/run-turn.ts`). Ne lève JAMAIS : une alerte qui tombe ne doit pas faire tomber le
 * passage à l'équipe qu'elle accompagne.
 */

export interface DepsAlerteCredit {
  /** Le fuseau IANA de l'espace (`tenant_settings.timezone`, défaut du serveur). */
  fuseau(tenantId: string): Promise<string>;
  emettre: EmetteurEmails['emettre'];
  /** La page Crédit IA de la console, où l'admin recharge. */
  pageCredit: string;
  now?: () => Date;
}

export interface AlerteCredit {
  alerter(tenantId: string): Promise<void>;
}

/** Le jour civil `AAAA-MM-JJ` dans ce fuseau ; un fuseau illisible retombe sur celui du serveur. */
export function jourDans(fuseau: string, maintenant: Date): string {
  try {
    return maintenant.toLocaleDateString('en-CA', { timeZone: fuseau });
  } catch {
    return maintenant.toLocaleDateString('en-CA', { timeZone: DEFAULT_TIMEZONE });
  }
}

export function creerAlerteCreditEpuise(deps: DepsAlerteCredit): AlerteCredit {
  return {
    async alerter(tenantId) {
      try {
        const jour = jourDans(await deps.fuseau(tenantId), deps.now ? deps.now() : new Date());
        const issue = await deps.emettre({
          cle: 'credit_epuise', tenantId, occasion: `jour:${jour}`, valeurs: { lien_credit: deps.pageCredit }, a: 'admins',
        });
        if (issue.reserves > 0) journaliser('info', 'alerte_credit_emise', { tenantId, jour, admins: issue.reserves });
      } catch (err) {
        journaliser('error', 'alerte_credit_impossible', { err, tenantId });
      }
    },
  };
}
