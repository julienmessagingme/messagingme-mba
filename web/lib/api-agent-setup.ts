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
  /** Les MOTS de connecteurs DÉJÀ déclarés. L'assistant n'en crée jamais : voir l'application ci-dessous. */
  connecteurs?: Array<{ nom: string; description: string; nePasUtiliser: string }>;
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
  /** Les points du périmètre encore à couvrir. Non vide = l'assistant est ENCORE EN ENTRETIEN, et le serveur
   *  a volontairement retenu le diff : on discute avant d'afficher ce qu'il a compris. */
  couverture?: { manquants: string[]; total: number };
  usage: { tokensIn: number; tokensOut: number };
}

/**
 * Ce que le client GARDE, ligne par ligne : la clé technique du changement, et le texte retenu.
 *
 * 🔴 POURQUOI CE N'EST PAS UN SIMPLE FILTRE. Julien, 2026-08-28 : « il n'y a qu'un seul bouton Garder ou
 * Jeter à la fin, alors que potentiellement le mec ne veut en changer qu'une et le reste lui convient ».
 * Jeter une ligne ne veut PAS dire ne rien envoyer pour ce champ : les deux textes d'un outil partent dans le
 * même `PATCH`, et omettre celui qu'on a jeté le laisserait prendre la valeur proposée. Une ligne jetée
 * réécrit donc la valeur ACTUELLE (`avant`), ce qui la rend sans effet.
 */
export type LignesGardees = ReadonlyMap<string, string>;

/**
 * Réduit une proposition aux seules lignes gardées, avec le texte éventuellement corrigé par le client.
 *
 * ⚠️ `fiche.sorties` se garde ou se jette, mais ne se modifie pas ici : cette ligne est un TEXTE composé de
 * plusieurs règles d'arrêt (`code : libellé`), et le relire pour reconstruire la liste ferait dépendre un
 * enregistrement d'un format que le client peut casser en tapant. Les régler une par une est le travail de
 * l'onglet Objectif, qui a les bons champs.
 */
export function restreindreProposition(
  proposition: PropositionConstruction,
  changements: Changement[],
  gardees: LignesGardees,
): PropositionConstruction {
  const avantDe = new Map(changements.map((c) => [c.champ, c.avant]));
  // Le texte à envoyer pour une ligne : celui que le client a gardé (corrigé ou non), sinon la valeur
  // ACTUELLE quand il l'a jetée, sinon la proposition (le champ n'était pas une ligne de diff, donc il est
  // déjà identique à l'existant et l'écrire ne change rien).
  const retenu = (champ: string, propose: string): string => {
    if (gardees.has(champ)) return gardees.get(champ) as string;
    return avantDe.get(champ) ?? propose;
  };

  const fiche: PropositionConstruction['fiche'] = {};
  for (const [cle, valeur] of Object.entries(proposition.fiche)) {
    if (valeur === undefined) continue;
    const champ = `fiche.${cle}`;
    if (avantDe.has(champ) && !gardees.has(champ)) continue;
    if (cle === 'sorties') { fiche.sorties = valeur as SortieAgent[]; continue; }
    (fiche as Record<string, unknown>)[cle] = gardees.get(champ) ?? valeur;
  }

  // Un outil dont TOUTES les lignes ont été jetées n'est pas écrit du tout : le réécrire avec ses valeurs
  // actuelles CRÉERAIT quand même l'outil (aux mots vides) alors que le client vient de refuser l'ajout.
  const garde = <T>(liste: T[], cles: (x: T) => string[]): T[] => liste.filter((x) => {
    const lignes = cles(x).filter((c) => avantDe.has(c));
    return lignes.length === 0 || lignes.some((c) => gardees.has(c));
  });

  return {
    fiche,
    outils: garde(proposition.outils, (o) => [`outil.${o.handler}.description`, `outil.${o.handler}.nePasUtiliser`])
      .map((o) => ({
        handler: o.handler,
        description: retenu(`outil.${o.handler}.description`, o.description),
        nePasUtiliser: retenu(`outil.${o.handler}.nePasUtiliser`, o.nePasUtiliser),
      })),
    connecteurs: garde(proposition.connecteurs ?? [], (c) => [`connecteur.${c.nom}.description`, `connecteur.${c.nom}.nePasUtiliser`])
      .map((c) => ({
        nom: c.nom,
        description: retenu(`connecteur.${c.nom}.description`, c.description),
        nePasUtiliser: retenu(`connecteur.${c.nom}.nePasUtiliser`, c.nePasUtiliser),
      })),
  };
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
  const connecteurs = proposition.connecteurs ?? [];
  if (proposition.outils.length === 0 && connecteurs.length === 0) return;
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
    // 🔴 LES CONNECTEURS SE PATCHENT, ILS NE SE CRÉENT PAS. Un nom inconnu est IGNORÉ, jamais créé : déclarer
    // un connecteur, c'est écrire une adresse réseau et un secret, et cela reste un geste d'administrateur.
    // Le serveur a déjà filtré les noms inconnus ; cette seconde ceinture tient si la proposition vieillit
    // entre son calcul et le clic « Garder » (l'administrateur peut avoir retiré le connecteur entre-temps).
    for (const propose of connecteurs) {
      const cible = poses.find((o) => o.name === propose.nom && o.origin !== 'mba');
      if (!cible) continue;
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
