import type { FicheAgentContenu } from '../fiche';

/**
 * Le blocage dur avant activation.
 *
 * 🔴 SUR DES CHAMPS VIDES, JAMAIS SUR UNE QUALITÉ SÉMANTIQUE. C'est la règle du cadrage, et elle est plus
 * fine qu'elle en a l'air : aucun produit du marché ne bloque sur du flou, et un détecteur sémantique qui
 * refuserait un objectif « mal écrit » serait un mur arbitraire que le client ne saurait pas franchir. Ce
 * qu'on bloque, ce sont des manques VÉRIFIABLES, dont chacun rend l'agent incapable de tenir sa promesse :
 *
 *  - sans objectif, le modèle n'a pas de colonne vertébrale et répond à côté ;
 *  - sans règle d'arrêt, `terminer` n'est même pas exposé (`outilsExposes`), donc l'agent ne peut sortir que
 *    par les sorties automatiques du bloc ;
 *  - sans fiche de connaissance, la recherche ne rend rien et TOUTES les questions sortent par
 *    « Aucune source » : l'agent transfère tout, ce qui n'est jamais ce que le client croit avoir réglé ;
 *  - sans outil actif, il ne peut rien faire du tout, pas même terminer ;
 *  - sans règle de transfert, personne n'a écrit quand l'agent doit s'effacer.
 *
 * ⚠️ Ce lint bloque l'ACTIVATION, pas l'écriture. Un agent en brouillon se remplit dans n'importe quel
 * ordre ; c'est le geste qui le rend proposable dans un scénario qui exige que tout soit là. Bloquer
 * l'écriture ferait un formulaire qu'on ne peut pas remplir champ par champ, donc inutilisable avec la
 * conversation de construction, qui procède par petites touches.
 */

/** Un manque, dit au client dans ses mots, avec l'endroit où le combler. */
export interface ManqueFiche {
  /** Onglet de l'écran de réglage où ça se corrige. Le front en fait un lien. */
  onglet: 'identite' | 'objectif' | 'connaissance' | 'outils';
  message: string;
}

export interface EtatPourLint {
  fiche: FicheAgentContenu;
  /** Nombre de fiches de connaissance de cet agent. */
  fichesConnaissance: number;
  /** Nombre d'outils ACTIFS. Un outil posé mais inactif ne compte pas : le modèle ne le voit pas. */
  outilsActifs: number;
}

export function manquesAvantActivation(etat: EtatPourLint): ManqueFiche[] {
  const out: ManqueFiche[] = [];
  if (etat.fiche.objectif.trim() === '') {
    out.push({ onglet: 'objectif', message: 'L’objectif de l’agent est vide : c’est le champ qui pèse le plus sur ce qu’il répondra.' });
  }
  if (etat.fiche.reglesTransfert.trim() === '') {
    out.push({ onglet: 'objectif', message: 'Personne n’a écrit quand l’agent doit passer la main à un humain.' });
  }
  if (etat.fiche.sorties.length === 0) {
    out.push({ onglet: 'objectif', message: 'Aucune règle d’arrêt : l’agent n’a aucune façon de finir et de rendre la main au scénario.' });
  }
  if (etat.fichesConnaissance === 0) {
    out.push({ onglet: 'connaissance', message: 'La base de connaissance est vide : l’agent transférerait toutes les questions de fond.' });
  }
  if (etat.outilsActifs === 0) {
    out.push({ onglet: 'outils', message: 'Aucun outil actif : l’agent peut parler mais ne peut rien faire, pas même terminer.' });
  }
  return out;
}
