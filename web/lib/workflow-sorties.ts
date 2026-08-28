/**
 * La SORTIE LIBRE d'un bloc (« Toute autre réponse »), et la règle qui la nomme.
 *
 * 🔴 CE QU'ELLE RÉPARE, ET C'EST MESURÉ. Dans le graphe enregistré, la sortie libre est une arête SANS
 * `sourceHandle` : c'est le contrat du moteur (`nextNodeSansHandle`), et il ne bouge pas. Mais React Flow, lui,
 * a besoin d'un identifiant pour savoir DE QUEL POINT partir. Sans identifiant, il ancre la flèche sur la
 * PREMIÈRE poignée de sortie du bloc. Sur un bloc à réponses rapides, la flèche de « Toute autre réponse »
 * était donc dessinée sur la ligne de la PREMIÈRE réponse, où une autre flèche part déjà : d'où les « deux
 * flèches qui partent d'une même réponse » signalées par Julien le 2026-08-28, et l'impression que la sortie
 * libre ne se reliait pas alors qu'elle se reliait ailleurs.
 *
 * La règle : le CANEVAS nomme cette poignée `libre`, le GRAPHE ENREGISTRÉ continue de ne rien porter. La
 * traduction se fait aux deux bords, ici, et nulle part ailleurs. Le format en base, le moteur, l'écran
 * d'Analytics et les scénarios déjà enregistrés ne changent pas d'un octet.
 */

/** Le nom de la poignée de sortie libre, CÔTÉ CANEVAS uniquement. Jamais enregistré. */
export const SORTIE_LIBRE = 'libre';

/** Graphe enregistré -> canevas : une arête sans poignée part de la sortie libre. */
export function poigneeCanevas(sourceHandle?: string | null): string {
  return sourceHandle && sourceHandle !== '' ? sourceHandle : SORTIE_LIBRE;
}

/** Canevas -> graphe enregistré : la sortie libre redevient une arête sans poignée. */
export function poigneeGraphe(sourceHandle?: string | null): string | undefined {
  if (!sourceHandle || sourceHandle === '' || sourceHandle === SORTIE_LIBRE) return undefined;
  return sourceHandle;
}

/**
 * UNE arête par sortie, appliquée au CHARGEMENT et pas seulement à la connexion.
 *
 * 🔴 POURQUOI AU CHARGEMENT AUSSI. Le moteur prend la PREMIÈRE arête qui part d'une sortie
 * (`nextNodeByHandle`, `nextNodeSansHandle`) : une seconde arête sur la même sortie est inatteignable par
 * construction. La dessiner ferait promettre au canevas une branche que le parcours n'empruntera jamais, et
 * c'est le pire cas d'un éditeur visuel : montrer autre chose que ce qui va se passer. On garde donc la
 * première, celle que le moteur suit.
 *
 * La garde de connexion (`onConnect`) empêche d'en créer une seconde depuis le 2026-07-13 ; celle-ci couvre
 * les graphes plus anciens et tout ce qui pourrait écrire dans la table sans passer par l'éditeur.
 */
export function uneAreteParSortie<E extends { source: string; sourceHandle?: string | null }>(edges: E[]): E[] {
  const vues = new Set<string>();
  return edges.filter((e) => {
    const cle = `${e.source}|${poigneeCanevas(e.sourceHandle)}`;
    if (vues.has(cle)) return false;
    vues.add(cle);
    return true;
  });
}
