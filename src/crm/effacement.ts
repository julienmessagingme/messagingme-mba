import type { ListeDeLAgent, LigneDeLaListe } from '../mba/liste';
import type { TravauxEnVol } from '../lib/en-vol';
import { messageDe } from '../lib/erreur';

/**
 * 🔴 L'EFFACEMENT DE FICHES, partagé par la purge du mini-CRM (`POST /tenants/:tenantId/contacts/purge`) et
 * `DELETE /v1/contacts/{contactId}` (lot 13, domaine 5) : la limite du jour de l'offre d'abord, tout ou rien, AVANT
 * la moindre écriture ; puis la purge (une transaction qui efface le contenu et anonymise les compteurs, irréversible).
 * Le retrait chez l'agent de Meta est rendu à l'appelant, qui le lance APRÈS avoir répondu : un appel par contact avant
 * la réponse pouvait dépasser le délai de Cloudflare, et un appel à Meta ne doit jamais retenir la transaction ouverte.
 * Les identifiants arrivent déjà résolus DANS l'espace (`contactIdsForTarget`). L'audit reste à la route (il signe la
 * personne ou la clé de la requête).
 */
export interface DepsEffacement {
  contacts: {
    purgeMany(tenantId: string, ids: readonly string[]): Promise<{
      purges: number; conversations: number; messages: number; analyses: number; listeAgent: LigneDeLaListe[];
    }>;
  };
  suppressionsDuJour: { consommer(tenantId: string, n: number): Promise<{ ok: true } | { ok: false; max: number }> };
  listeDeLAgent: Pick<ListeDeLAgent, 'oublierChezMeta'>;
  enVol: Pick<TravauxEnVol, 'suivre'>;
}

export interface BilanEffacement { purges: number; conversations: number; messages: number; analyses: number }

export type IssueEffacement =
  | { ok: false; max: number }
  | { ok: true; bilan: BilanEffacement; retirerChezMeta: () => void };

export async function effacerContacts(deps: DepsEffacement, tenantId: string, ids: readonly string[]): Promise<IssueEffacement> {
  const quota = await deps.suppressionsDuJour.consommer(tenantId, ids.length);
  if (!quota.ok) return { ok: false, max: quota.max };
  const { listeAgent, ...bilan } = await deps.contacts.purgeMany(tenantId, ids);
  return {
    ok: true,
    bilan,
    retirerChezMeta: () => {
      // La fonction `async` enveloppe aussi une levée synchrone : aucune promesse rejetée ne reste sans gestionnaire.
      void deps.enVol.suivre((async () => {
        try {
          await deps.listeDeLAgent.oublierChezMeta(tenantId, listeAgent);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`purge : retrait chez Meta des contacts purgés en échec (${tenantId}) :`, messageDe(err));
        }
      })());
    },
  };
}
