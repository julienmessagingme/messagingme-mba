import { request } from './http';
import { patchAgent, type SortieAgent } from './api-agent';
import { ajouterOutil, listOutils, patchOutil } from './api-agent-tools';

/**
 * La conversation de construction : elle propose, le client corrige.
 *
 * 🔴 ELLE N'ÉCRIT RIEN. La route rend une proposition et le diff qu'elle produirait ; c'est l'écran qui
 * applique, par les mêmes routes que le formulaire, avec leur verrou de version. Le jour où l'onglet
 * « Create » a disparu de l'interface d'OpenAI, des GPTs sont devenus non modifiables du jour au lendemain :
 * ici la conversation n'est jamais le seul chemin d'édition, et elle n'a aucun pouvoir que le formulaire
 * n'ait déjà.
 */

export interface TourConstruction {
  role: 'user' | 'assistant';
  content: string;
}

/** Ce que l'assistant propose d'écrire. Les clés de sécurité en sont ABSENTES, par construction. */
export interface PropositionConstruction {
  fiche: {
    nom?: string;
    objectif?: string;
    ton?: string;
    personnalite?: string;
    reglesTransfert?: string;
    sorties?: SortieAgent[];
  };
  outils: Array<{ handler: string; description: string; nePasUtiliser: string }>;
}

/** Une ligne du diff, telle que l'écran la montre. */
export interface Changement {
  champ: string;
  label: string;
  avant: string;
  apres: string;
}

export interface ReponseConstruction {
  message: string;
  proposition: PropositionConstruction;
  changements: Changement[];
  usage: { tokensIn: number; tokensOut: number };
}

export async function parlerAuConstructeur(
  tenantId: string, agentId: string, messages: TourConstruction[],
): Promise<ReponseConstruction> {
  return request<ReponseConstruction>(`/tenants/${tenantId}/agents/${agentId}/setup`, {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
}

/**
 * Applique une proposition, par les MÊMES routes que le formulaire.
 *
 * 🔴 La fiche d'abord, et avec son verrou de version. Si elle a bougé sous les pieds du client (l'autre
 * surface d'édition, un autre onglet), le `PATCH` refuse en 409 et RIEN d'autre n'est tenté : appliquer les
 * outils d'une proposition dont la fiche a été refusée laisserait l'agent à moitié réglé, sans que personne
 * sache lequel des deux gestes a compté.
 */
export async function appliquerProposition(
  tenantId: string, agentId: string, proposition: PropositionConstruction, ficheVersion: number,
): Promise<void> {
  const ficheEcrite = Object.keys(proposition.fiche).length > 0;
  if (ficheEcrite) {
    await patchAgent(tenantId, agentId, { contenu: proposition.fiche, ficheVersionAttendue: ficheVersion });
  }
  if (proposition.outils.length === 0) return;
  try {
    // Les outils posés sont relus MAINTENANT : la proposition a pu être calculée il y a plusieurs minutes, et
    // ajouter un outil qui existe déjà rendrait 409 sur un nom pris.
    const { outils: poses } = await listOutils(tenantId, agentId);
    for (const propose of proposition.outils) {
      const deja = poses.find((o) => String(o.binding.handler ?? '') === propose.handler);
      // Ajouté INACTIF, comme toujours : l'activation reste un geste humain, et l'assistant ne l'a pas.
      const cible = deja ?? await ajouterOutil(tenantId, agentId, propose.handler);
      await patchOutil(tenantId, agentId, cible.id, {
        description: propose.description,
        nePasUtiliser: propose.nePasUtiliser,
      });
    }
  } catch (err) {
    // 🔴 Ces écritures ne sont PAS dans une transaction : la fiche part par une route, les outils par une
    // autre. Un échec ici laisse donc la fiche déjà écrite, et le dire est la seule honnêteté possible.
    // Sans ce message, le client réessaierait « Garder » et se ferait refuser en 409 sur un numéro de
    // version périmé, c'est-à-dire une erreur qui ne parle pas du tout de ce qui s'est passé.
    const cause = err instanceof Error ? err.message : 'erreur inconnue';
    // Apostrophes typographiques, comme partout ailleurs dans l'interface : ce message est lu par le client.
    throw new Error(ficheEcrite
      ? `La fiche est enregistrée, mais un outil n’a pas pu l’être : ${cause}. Vérifiez l’onglet Outils.`
      : `Un outil n’a pas pu être enregistré : ${cause}`);
  }
}

/** Un manque qui empêche l'activation, tel que la route `PATCH` le rend en 422. */
export interface ManqueFiche {
  onglet: 'identite' | 'objectif' | 'connaissance' | 'outils';
  message: string;
}

/** Lit la liste des manques d'une erreur 422 d'activation. Défensif : le corps vient du réseau. */
export function manquesDe(corps: unknown): ManqueFiche[] {
  const liste = (corps as { manques?: unknown } | null)?.manques;
  if (!Array.isArray(liste)) return [];
  return liste.flatMap((brut) => {
    const m = brut as { onglet?: unknown; message?: unknown };
    return typeof m?.message === 'string' && typeof m.onglet === 'string'
      ? [{ onglet: m.onglet as ManqueFiche['onglet'], message: m.message }]
      : [];
  });
}
