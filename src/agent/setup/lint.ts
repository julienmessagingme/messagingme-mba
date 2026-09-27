import type { FicheAgentContenu } from '../fiche';

/**
 * Le blocage dur avant activation, sur des champs vides, jamais sur une qualité sémantique : un détecteur
 * qui refuserait un objectif « mal écrit » serait un mur arbitraire. Chaque manque bloqué rend l'agent
 * incapable de tenir sa promesse (sans règle d'arrêt, `terminer` n'est même pas exposé ; sans fiche de
 * connaissance, tout sort par « Aucune source »).
 *
 * Il bloque l'activation, pas l'écriture : un brouillon se remplit dans n'importe quel ordre, par petites
 * touches de la conversation de construction.
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
  /** Nombre d'outils actifs. Un outil posé mais inactif ne compte pas : le modèle ne le voit pas. */
  outilsActifs: number;
  /** Les `handler` des outils actifs : le compte seul ne dit pas quel outil manque. */
  handlersActifs: string[];
  /**
   * Les outils qu'un rafraîchissement MCP a débranchés, par leur nom (le consentement tombe quand le schéma
   * change ou que l'outil disparaît). Requis : un espace sans connecteur MCP passe un tableau vide, plutôt
   * qu'un champ optionnel qu'un câblage oublierait en silence.
   */
  outilsMcpDebranches: string[];
}

/**
 * Ce qu'on avertit sans bloquer. À part de `manquesAvantActivation`, qui est aussi la garde dure de
 * l'activation (`src/http/agents.ts`) : tout ce qu'on y ajoute devient bloquant. Un serveur tiers qui change
 * son schéma ne doit pas avoir de veto sur l'activation, mais on le dit, en nommant les outils.
 */
export function avertissements(etat: EtatPourLint): ManqueFiche[] {
  const debranches = etat.outilsMcpDebranches;
  if (debranches.length === 0) return [];
  return [{
    onglet: 'outils',
    message: debranches.length === 1
      ? `L’outil « ${debranches[0]} » a été désactivé par un rafraîchissement du serveur MCP (son schéma a changé, `
        + 'ou il a disparu) : il faut le réautoriser pour que l’agent puisse s’en servir de nouveau.'
      : `${debranches.length} outils ont été désactivés par un rafraîchissement du serveur MCP `
        + `(${debranches.join(', ')}) : il faut les réautoriser pour que l’agent puisse s’en servir de nouveau.`,
  }];
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
  /**
   * Une base remplie que l'agent ne peut pas lire : les deux contrôles voisins laissaient passer des fiches
   * sans outil de recherche, et l'agent transférerait toutes les questions de fond. Seulement s'il y a des
   * outils : sinon le contrôle voisin le dit déjà.
   */
  if (etat.fichesConnaissance > 0 && etat.outilsActifs > 0 && !etat.handlersActifs.includes('chercher_connaissance')) {
    out.push({
      onglet: 'outils',
      message: 'La base de connaissance est remplie mais l’outil « Chercher dans la base de connaissance » '
        + 'n’est pas actif : l’agent ne peut pas la lire, et transférera toutes les questions de fond.',
    });
  }
  if (etat.outilsActifs === 0) {
    out.push({ onglet: 'outils', message: 'Aucun outil actif : l’agent peut parler mais ne peut rien faire, pas même terminer.' });
  }
  return out;
}
