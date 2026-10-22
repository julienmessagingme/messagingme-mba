import type { Emission } from '../emails-produit/emission';
import type { ClientApplication } from './client';
import type { CompteApplication } from './comptes';

/**
 * LA MISE EN SOMMEIL (plan 2026-10-22, tâche 7) : un compte relié qui n'a reçu ni envoyé aucun message depuis
 * `APPLICATION_SOMMEIL_JOURS` jours voit sa session fermée par le service de connexions, sans la retirer du téléphone.
 * C'est ce qui borne la mémoire d'un service qui tient toutes les sessions. Un nouveau lien la réveille (`relierApplication`).
 * Le développeur est prévenu par courriel, une fois par jour au plus.
 */
export interface DepsSommeil {
  comptes: { endormables(jours: number): Promise<CompteApplication[]> };
  /** `null` : le service n'est pas configuré, rien ne tient de session. */
  client: ClientApplication | null;
  emettre(e: Emission): Promise<unknown>;
}

/** Rend le nombre de comptes endormis. Un refus du service laisse le compte relié : le balayage suivant réessaie. */
export async function endormirLesComptes(d: DepsSommeil, jours: number, maintenant: Date): Promise<number> {
  if (!d.client) return 0;
  let n = 0;
  for (const c of await d.comptes.endormables(jours)) {
    if (!(await d.client.sommeil(c.id)).ok) continue;
    n += 1;
    await d.emettre({
      cle: 'application_en_sommeil', tenantId: c.tenantId, occasion: `sommeil:${c.id}:${maintenant.toISOString().slice(0, 10)}`,
      a: 'admins', valeurs: { numero: `+${c.numero}`, jours: String(jours) },
    });
  }
  return n;
}
