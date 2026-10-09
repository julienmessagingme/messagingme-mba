import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WebhookEvent } from './parse';
import { donneesStatutModele, idEvenement, TYPE_STATUT_MODELE } from '../evenements/types';
import { journaliser } from '../lib/journal';

/**
 * LE STATUT D'UN MODÈLE TRANCHÉ PAR META (lot 13, domaine 3, livraison C, spec § 5) : le champ
 * `message_template_status_update`, au niveau du COMPTE WhatsApp (il ne nomme aucun numéro), devient l'événement
 * sortant `template.status_changed` de l'espace qui porte ce compte.
 *
 * 🔴 L'identifiant de l'événement dérive de la clé du changement (`tpl:<modèle>:<statut>:<instant>`) : un changement
 * redélivré par Meta, ou un job rejoué, garde le même identifiant, et la ligne d'envoi unique par (adresse, événement)
 * ne le renvoie pas. Un modèle qui repasse par le même statut plus tard a un autre instant, donc un autre identifiant.
 * ⚠️ L'application Meta doit être abonnée au champ (tableau de bord Meta) ; sans abonnement, rien n'arrive ici.
 */

/** Le changement tel que Meta l'envoie, plus le compte et l'instant posés par le découpage (`parse.ts`). */
const statutRecuSchema = z.object({
  waba_id: z.string().min(1).max(64),
  le: z.number().int().nonnegative().optional(),
  event: z.string().min(1).max(64),
  message_template_id: z.union([z.number(), z.string().min(1).max(64)]).transform(String),
  message_template_name: z.string().min(1).max(512),
  message_template_language: z.string().min(1).max(20),
  reason: z.string().max(500).nullable().optional(),
});

export interface StatutsModelesDeps {
  /** L'espace qui porte ce compte WhatsApp (`waba.id`, clé primaire), ou `null` : aucun espace, rien ne part. */
  espaceDuCompte(wabaId: string): Promise<string | null>;
  /** La distribution d'un événement d'espace (`distribuerEvenementEspace`), aux adresses qui ont coché son type. */
  distribuer(tenantId: string, ev: { id: string; type: typeof TYPE_STATUT_MODELE; le: string; data: Record<string, unknown> }): Promise<void>;
}

export async function processStatutsModeles(events: readonly WebhookEvent[], deps: StatutsModelesDeps): Promise<void> {
  for (const ev of events) {
    if (ev.source !== 'template_status') continue;
    const lu = statutRecuSchema.safeParse(ev.data);
    if (!lu.success) {
      const i = lu.error.issues[0];
      journaliser('warn', 'statut_modele_illisible', { cle: ev.dedupKey, champ: i ? i.path.join('.') : null });
      continue;
    }
    const tenantId = await deps.espaceDuCompte(lu.data.waba_id);
    if (tenantId === null) continue;
    const id = idEvenement(createHash('sha256').update(ev.dedupKey).digest('hex').slice(0, 32));
    // L'instant de Meta (`entry.time`, en secondes) ; à défaut, celui du traitement.
    const le = new Date(lu.data.le !== undefined ? lu.data.le * 1000 : Date.now()).toISOString();
    await deps.distribuer(tenantId, { id, type: TYPE_STATUT_MODELE, le, data: donneesStatutModele(lu.data) });
  }
}
