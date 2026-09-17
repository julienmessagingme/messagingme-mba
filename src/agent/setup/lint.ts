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
  /**
   * Les `handler` des outils ACTIFS. Le compte seul ne suffisait pas : il ne peut pas dire QUEL outil
   * manque, et c'est précisément l'absence d'un outil PRÉCIS qui a rendu un agent muet en production.
   */
  handlersActifs: string[];
  /**
   * 🔴 LES OUTILS QU'UN RAFRAÎCHISSEMENT MCP A DÉBRANCHÉS, par leur nom. Le consentement TOMBE quand le
   * schéma d'un outil change ou quand il disparaît du serveur distant (`actif = false`, `active_par`
   * conservé) : c'est la bonne décision, mais elle se prenait EN SILENCE. L'agent perdait une capacité que
   * quelqu'un avait explicitement autorisée, et rien, nulle part, ne le disait à ce quelqu'un.
   *
   * 🔴 REQUIS, PAS OPTIONNEL, et ce dépôt a payé la différence plusieurs fois (`estDesabonne?`, `guard?`,
   * `journal?`) : un champ optionnel qu'un câblage oublie ne casse rien, ne compile pas moins bien, et
   * désarme simplement la capacité en silence. Un espace sans connecteur MCP passe un tableau VIDE, ce qui
   * DIT l'hypothèse au lieu de la cacher.
   */
  outilsMcpDebranches: string[];
}

/**
 * Ce qu'on AVERTIT sans bloquer. Séparé de `manquesAvantActivation` pour une raison mécanique : cette
 * dernière est aussi la garde dure de l'activation, donc tout ce qu'on y ajoute devient bloquant.
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
   * 🔴 UNE BASE REMPLIE QUE L'AGENT NE PEUT PAS LIRE, et c'est le défaut vécu le 2026-09-08. Les deux
   * contrôles voisins regardent chacun un côté (la base est-elle vide ? y a-t-il des outils ?) et laissaient
   * passer exactement la combinaison qui casse tout : des fiches d'un côté, aucun moyen d'y accéder de
   * l'autre. L'agent transfère alors TOUTES les questions de fond, et l'écran affiche une base bien remplie
   * qui donne l'impression que tout va bien. C'est le pire des deux mondes : le travail est fait ET inutile.
   *
   * ⚠️ Seulement quand il Y A des outils : sans aucun outil, le contrôle voisin le dit déjà, et plus
   * fondamentalement. Deux messages pour un même geste transforment une liste utile en bruit.
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
  /**
   * 🔴 IL NE BLOQUE PAS L'ACTIVATION, ET C'EST DÉLIBÉRÉ. Un serveur tiers qui change son schéma ne doit pas
   * pouvoir empêcher un client d'activer son agent : ce serait donner à un tiers un droit de veto sur notre
   * produit. Ce qu'on doit, c'est le DIRE, parce que personne ne peut deviner qu'un outil autorisé la
   * semaine dernière ne l'est plus. La liste reste NOMMÉE : « un outil » enverrait chercher lequel.
   *
   * ⚠️ ET CE N'EST PAS UN BLOCAGE DÉGUISÉ : `manquesAvantActivation` sert AUSSI de garde dure sur
   * `status = 'active'` (`src/http/agents.ts`), donc l'ajouter à cette liste bloquerait. Il est donc
   * rendu à part, et le front l'affiche dans le même bandeau.
   */
  return out;
}
