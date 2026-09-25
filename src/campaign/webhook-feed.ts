import { buildRecipients, type BuildContact } from './build';
import type { Campaign } from './types';
import { messageDe } from '../lib/erreur';

/**
 * Campagne AU FIL DE L'EAU : un contact vient d'arriver par un webhook entrant, on l'ajoute aux campagnes
 * vivantes qui se nourrissent de ce webhook et on les fait partir.
 *
 * Trois principes commandent ce fichier.
 *
 *  1. **Aucun chemin d'envoi nouveau.** On INSCRIT un destinataire de plus et on enfile un `campaign-run` :
 *     c'est `runCampaign` qui envoie, avec sa cadence, son quality gate, son claim atomique et ses
 *     statistiques. Un arrivant est envoyé exactement comme un destinataire choisi à la main.
 *  2. **Les mêmes règles d'éligibilité que partout.** `buildRecipients` est appelé tel quel, sur UN contact :
 *     opt-in marketing, identité requise, résolution des variables du template. Rien n'est réécrit ici, donc
 *     rien ne peut diverger de la voie ordinaire.
 *  3. **Un écart s'INSCRIT, il ne disparaît pas.** Un arrivant sans consentement (campagne marketing) ou dont
 *     une variable manque est enregistré `skipped` avec son motif. Sinon l'opérateur voit une campagne à zéro
 *     destinataire, alors que des gens sont bel et bien arrivés : c'est la panne muette classique.
 *
 * Fonction PURE au sens du dépôt (dépendances injectées) : testable sans base, sans file et sans horloge.
 */

/** Motif LISIBLE d'un écart, tel qu'il sera lu dans le détail de la campagne. */
export function motifEcart(reason: 'missing_variable' | 'not_opted_in' | 'no_phone_number'): string {
  if (reason === 'not_opted_in') return "Écarté : pas de consentement pour du marketing.";
  if (reason === 'no_phone_number') return 'Écarté : aucun numéro de téléphone (le RCS en exige un).';
  return "Écarté : une variable du template n'a pas de valeur sur la fiche.";
}

export interface WebhookFeedDeps {
  /** Campagnes VIVANTES nourries par ce webhook (statut `running` uniquement). */
  listRunning(tenantId: string, webhookId: string): Promise<Campaign[]>;
  /** Le contact qui vient d'arriver, prêt pour `buildRecipients`. null = inconnu ou bloqué -> rien à faire. */
  contact(tenantId: string, waId: string): Promise<BuildContact | null>;
  /** Inscrit l'arrivant. false = il était DÉJÀ destinataire de cette campagne (il ne reçoit pas deux fois). */
  insertRecipient(
    campaignId: string,
    r: { contactId: string; toE164: string; resolvedParams: string[]; statut: 'pending' | 'skipped'; motif?: string },
  ): Promise<boolean>;
  /** Enfile le run de la campagne. ⚠️ NON dédupliqué : un arrivant = un job, même run déjà en vol. */
  enqueueRun(campaign: Campaign): Promise<void>;
  now?: () => Date;
}

export interface FeedReport {
  /** Arrivants inscrits ET envoyables (un run a été enfilé pour eux). */
  inscrits: number;
  /** Arrivants inscrits mais ÉCARTÉS (consentement, variable manquante). Aucun envoi. */
  ecartes: number;
  /** Arrivants déjà destinataires d'une de ces campagnes : ignorés en silence, c'est le comportement voulu. */
  deja: number;
}

export async function alimenterCampagnesWebhook(
  tenantId: string,
  webhookId: string,
  waId: string,
  deps: WebhookFeedDeps,
): Promise<FeedReport> {
  const report: FeedReport = { inscrits: 0, ecartes: 0, deja: 0 };
  const campagnes = await deps.listRunning(tenantId, webhookId);
  if (campagnes.length === 0) return report;

  // Le contact n'est relu QU'UNE fois, même si plusieurs campagnes se nourrissent du même webhook.
  const contact = await deps.contact(tenantId, waId);
  if (!contact) return report;

  const maintenant = (deps.now ?? (() => new Date()))();
  for (const c of campagnes) {
    try {
      const { recipients, skipped } = buildRecipients(
        c.category,
        c.paramMapping,
        [contact],
        { now: maintenant },
        c.channel ?? 'whatsapp',
      );
      const envoyable = recipients[0];
      if (envoyable) {
        const pose = await deps.insertRecipient(c.id, { ...envoyable, statut: 'pending' });
        if (!pose) { report.deja += 1; continue; } // déjà destinataire -> surtout pas un second run
        report.inscrits += 1;
        // Enfilé APRÈS l'inscription : dans l'ordre inverse, un run pourrait tourner avant que le
        // destinataire existe, et l'arrivant attendrait le suivant pour partir.
        await deps.enqueueRun(c);
        continue;
      }
      const ecarte = skipped[0];
      if (!ecarte) continue; // ni envoyable ni écarté : contact sans identité, il n'y a rien à inscrire
      const pose = await deps.insertRecipient(c.id, {
        contactId: ecarte.contactId,
        toE164: ecarte.toE164,
        resolvedParams: [],
        statut: 'skipped',
        motif: motifEcart(ecarte.reason),
      });
      if (pose) report.ecartes += 1; else report.deja += 1;
    } catch (err) {
      // Une campagne en échec n'empêche pas les autres d'être servies : le lead arrive UNE fois, et le perdre
      // pour toutes les campagnes parce que l'une d'elles a un souci serait une régression bien pire.
      // eslint-disable-next-line no-console
      console.error(`webhook-feed: campagne ${c.id} non alimentée`, messageDe(err));
    }
  }
  return report;
}
