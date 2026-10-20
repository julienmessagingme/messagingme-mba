import type { SortieAgent } from './agent-store';
import { transfereALEquipe } from './enchainement';
import { lireCibleOutilAgent } from './outils-maison';

/**
 * CHOISIR SON CAMP (demande de Julien du 2026-10-20) : un agent passe la conversation à l'équipe SOIT en qualifiant le
 * contact d'abord, SOIT directement, jamais les deux. Avec les deux, le modèle prendrait le chemin le plus court
 * (« Passer la main ») et l'équipe recevrait un contact dont elle ne sait rien.
 *
 *  - camp « qualification » : l'outil « Qualifier et transférer », ou un outil enchaîné qui finit par le transfert ;
 *  - camp « direct » : « Passer la main à un humain », ou une règle d'arrêt cochée « passe à un humain ».
 *
 * 🔴 UNE SEULE CLASSIFICATION, ici : l'activation d'un outil et son `PATCH` (`PgToolCatalog`) comme l'écriture des
 * règles d'arrêt (`PgAgentStore.patch`) la lisent. Une copie en SQL ou dans un autre module divergerait au premier outil
 * ajouté. Un refus dit TOUJOURS ce qu'il faut désactiver d'abord (décision de Julien) : le client ne doit pas chercher.
 *
 * ⚠️ Lecture puis écriture, sans verrou commun : deux administrateurs qui activent chacun un camp à la même seconde
 * passeraient tous les deux. Le défaut n'est qu'une incohérence de réglage (le modèle voit les deux chemins), que le
 * prochain geste refuse de prolonger ; il ne justifie pas un verrou sur l'agent à chaque activation.
 */
export type Camp = 'qualification' | 'direct';

/** Le camp d'un outil, lu sur son `binding` (handler et cible), ou `null` quand il n'en a pas. */
export function campDeLOutil(binding: unknown): Camp | null {
  const handler = binding && typeof binding === 'object' ? String((binding as { handler?: unknown }).handler ?? '') : '';
  if (handler === 'escalader') return 'direct';
  if (handler === 'qualifier_transferer') return 'qualification';
  if (handler !== 'enchainer') return null;
  const cible = lireCibleOutilAgent(binding);
  return cible?.handler === 'enchainer' && transfereALEquipe(cible.etapes) ? 'qualification' : null;
}

/** Un outil actif de l'agent, tel que la règle le lit : son titre (celui que l'écran montre) et son `binding`. */
export interface OutilPourCamp {
  titre: string;
  binding: unknown;
}

const QUALIFIE = 'qualifie le contact avant de le passer à l’équipe';
const DIRECT = 'passe la main sans qualifier';

/**
 * Le refus d'un outil qui entre dans le camp `camp` (activé, ou dont la cible change), face aux AUTRES outils actifs de
 * l'agent et à ses règles d'arrêt, ou `null`. L'outil lui-même ne doit pas figurer dans `actifs`.
 */
export function refusDeCampPourUnOutil(
  camp: Camp | null, actifs: readonly OutilPourCamp[], sorties: readonly SortieAgent[],
): string | null {
  if (camp === null) return null;
  if (camp === 'direct') {
    const q = actifs.find((o) => campDeLOutil(o.binding) === 'qualification');
    return q ? `Choisissez un camp : cet outil ${DIRECT}, et « ${q.titre} » ${QUALIFIE}. Désactivez d’abord « ${q.titre} ».` : null;
  }
  const d = actifs.find((o) => campDeLOutil(o.binding) === 'direct');
  if (d) return `Choisissez un camp : cet outil ${QUALIFIE}, et « ${d.titre} » ${DIRECT}. Désactivez d’abord « ${d.titre} ».`;
  const regle = sorties.find((s) => s.humain === true);
  return regle
    ? `Choisissez un camp : cet outil ${QUALIFIE}, et la règle d’arrêt « ${regle.label} » ${DIRECT}. Décochez d’abord « passe à un humain » sur cette règle (onglet Objectif et transferts).`
    : null;
}

/** Le refus de règles d'arrêt dont l'une passe à un humain, face aux outils actifs de l'agent, ou `null`. */
export function refusDeCampPourLesSorties(sorties: readonly SortieAgent[], actifs: readonly OutilPourCamp[]): string | null {
  const regle = sorties.find((s) => s.humain === true);
  if (!regle) return null;
  const q = actifs.find((o) => campDeLOutil(o.binding) === 'qualification');
  return q
    ? `Choisissez un camp : la règle d’arrêt « ${regle.label} » ${DIRECT}, et l’outil « ${q.titre} » ${QUALIFIE}. Désactivez d’abord « ${q.titre} » (onglet Outils), ou laissez cette case décochée.`
    : null;
}

/** Les outils maison ACTIFS d'un consommateur, tels que la règle les lit : une requête partagée par les deux stores
 *  (catalogue et fiche), pour qu'ils lisent les mêmes. `$1` = tenant, `$2` = consommateur (`agent:<id>`). Servie par
 *  l'index `atc_nom_par_consommateur_uidx` (plan relu le 2026-10-20). */
export const OUTILS_ACTIFS_POUR_CAMP = `select t.id, t.title, t.binding
   from agent_tool_consommateurs c
   join agent_tools t on t.tenant_id = c.tenant_id and t.id = c.tool_id
  where c.tenant_id = $1 and c.consommateur = $2 and c.actif and t.origin = 'mba'`;

/** Une ligne de `OUTILS_ACTIFS_POUR_CAMP`. */
export interface LigneOutilPourCamp {
  id: string;
  title: string;
  binding: unknown;
}
