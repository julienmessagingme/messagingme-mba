/**
 * Poser une étiquette sur UN contact : le geste unique des portes unitaires (plan
 * `docs/superpowers/plans/2026-10-04-poser-une-etiquette.md`). Cinq portes y passent : l'agent IA et l'agent de Meta,
 * le bloc de scénario, le widget, l'outil MCP `tag_conversation` et la fiche contact de la console. Chacune
 * recopiait la règle avec ses écarts : l'outil MCP ne coupait pas à 64 caractères et ne déclarait rien, la fiche ne
 * déclarait rien non plus.
 *
 * Le geste, le même partout :
 *  1. NETTOYER : espaces autour retirés, 64 caractères, vides et doublons écartés. Sans ça, « vip » et « vip  »
 *     seraient deux étiquettes, et celle posée sur le contact ne serait ni celle du référentiel ni celle annoncée aux
 *     automations ;
 *  2. POSER sur le contact ;
 *  3. DÉCLARER dans le référentiel de l'espace (Contenu > Bibliothèque > Étiquettes), au mieux : un référentiel
 *     incomplet est un désagrément, une pose qui lève est un tour d'agent mort ou une fiche qui ne s'enregistre plus ;
 *  4. PUBLIER « tag ajouté » pour les automations, sur les seules étiquettes réellement nouvelles (reposer une
 *     étiquette présente n'est pas un événement : un agent qui la repose à chaque tour relancerait l'automation, donc
 *     un message au contact, à chaque fois).
 *
 * 🔴 LA PUBLICATION SE DEMANDE, ELLE N'EST JAMAIS UN DÉFAUT (`OptionsDePose.publier`, requise). Elle démarre des
 * scénarios, donc des messages facturés, et seul le chemin APPELANT sait s'il est unitaire (règle du dépôt) : l'agent
 * publie, le scénario selon la politique de son lancement (par l'exécuteur, jamais en campagne), la fiche publie,
 * le widget non (le chemin de réception décide une fois qui prend la conversation), l'outil MCP non (un agent qui
 * boucle sur 500 fils déclencherait 500 automations). Les chemins de MASSE (import, API publique, action en masse)
 * n'entrent pas ici : ils n'en prennent que le nettoyage, `nettoyerEtiquettes`.
 */

/** La longueur d'une étiquette, la même sur le contact, dans le référentiel et dans un bloc de scénario. */
export const LONGUEUR_MAX_ETIQUETTE = 64;

/** Une étiquette nettoyée : sans espaces autour, 64 caractères au plus. `''` = rien à poser. */
export function normaliserEtiquette(etiquette: string): string {
  return etiquette.trim().slice(0, LONGUEUR_MAX_ETIQUETTE);
}

/** Chaque étiquette normalisée, les vides et les doublons écartés, dans l'ordre de leur première apparition. */
function propres(etiquettes: readonly string[]): string[] {
  return [...new Set(etiquettes.map(normaliserEtiquette).filter((e) => e !== ''))];
}

/**
 * Une liste d'étiquettes nettoyée, puis bornée à `max`. La borne est celle de la PORTE (10 pour l'outil MCP, 50 pour
 * la fiche et les chemins de masse), et elle tombe APRÈS le dédoublonnage : dix fois la même étiquette ne remplissent
 * pas la liste. Le type des éléments est l'affaire de l'appelant (convertir ou écarter ce qui n'est pas une chaîne).
 */
export function nettoyerEtiquettes(etiquettes: readonly string[], max: number): string[] {
  return propres(etiquettes).slice(0, max);
}

export interface DepsPoseEtiquette {
  /** Ajoute les étiquettes au contact du `wa_id` et rend celles qui étaient réellement nouvelles. */
  ajouterAuContact(tenantId: string, waId: string, etiquettes: string[]): Promise<{ added: string[] }>;
  /** Le `wa_id` d'une fiche, que la console désigne par son identifiant. `null` : aucune identité joignable. */
  waIdDeLaFiche(tenantId: string, contactId: string): Promise<string | null>;
  /** Déclare une étiquette dans le référentiel de l'espace. Idempotent (clé `tenant_id, name`). */
  declarer(tenantId: string, etiquette: string): Promise<void>;
  /** Publie « tag ajouté » sur la file d'automations. */
  emettre(tenantId: string, waId: string, etiquette: string): Promise<void>;
}

/** Ce que l'APPELANT décide, sans valeur par défaut : voir l'en-tête. */
export interface OptionsDePose {
  publier: boolean;
}

export interface PoseEtiquette {
  /**
   * Le geste complet sur le contact d'un `wa_id` : nettoyer, poser, déclarer, et publier les nouvelles si l'appelant
   * le demande. Rend les étiquettes réellement nouvelles. Une liste vide après nettoyage ne fait RIEN. La pose et la
   * publication lèvent (l'appelant décide de ce qu'il en fait), la déclaration jamais.
   */
  poser(tenantId: string, waId: string, etiquettes: readonly string[], options: OptionsDePose): Promise<{ nouvelles: string[] }>;
  /**
   * La suite d'une pose faite AILLEURS : la fiche contact pose ses étiquettes dans la transaction d'`applyEdits`, avec
   * les champs et le consentement, et cette transaction ne bouge pas. Après l'écriture réussie : déclarer ce qui a
   * été posé, puis publier ce qui était nouveau si l'appelant le demande. Le `wa_id` n'est lu que s'il y a quelque
   * chose à publier ; une fiche sans identité joignable n'a rien à déclencher.
   */
  apresPose(
    tenantId: string,
    contactId: string,
    pose: { posees: readonly string[]; nouvelles: readonly string[] },
    options: OptionsDePose,
  ): Promise<void>;
  /**
   * La publication DIFFÉRÉE du bloc de scénario : l'exécuteur pose par `poser` sans publier, puis demande cette
   * publication après tous les effets du parcours, et seulement si le lancement est unitaire (`apply`,
   * `src/workflow/executor.ts`). L'appel EST la demande.
   */
  publierEnDiffere(tenantId: string, waId: string, etiquettes: readonly string[]): Promise<void>;
}

export function creerPoseEtiquette(deps: DepsPoseEtiquette): PoseEtiquette {
  // Chacune au mieux, et séparément : une déclaration en échec n'empêche ni les suivantes, ni la publication.
  const declarer = async (tenantId: string, etiquettes: readonly string[]): Promise<void> => {
    for (const e of etiquettes) {
      try { await deps.declarer(tenantId, e); } catch { /* best-effort */ }
    }
  };
  // L'une après l'autre : un incident de file arrête les suivantes et remonte à l'appelant, qui le journalise ou
  // l'avale selon son chemin.
  const publier = async (tenantId: string, waId: string, etiquettes: readonly string[]): Promise<void> => {
    for (const e of etiquettes) await deps.emettre(tenantId, waId, e);
  };

  return {
    async poser(tenantId, waId, etiquettes, options) {
      const aPoser = propres(etiquettes);
      if (aPoser.length === 0) return { nouvelles: [] };
      const { added } = await deps.ajouterAuContact(tenantId, waId, aPoser);
      await declarer(tenantId, aPoser);
      if (options.publier) await publier(tenantId, waId, added);
      return { nouvelles: added };
    },

    async apresPose(tenantId, contactId, pose, options) {
      await declarer(tenantId, propres(pose.posees));
      if (!options.publier) return;
      const nouvelles = propres(pose.nouvelles);
      if (nouvelles.length === 0) return;
      const waId = await deps.waIdDeLaFiche(tenantId, contactId);
      if (!waId) return;
      await publier(tenantId, waId, nouvelles);
    },

    async publierEnDiffere(tenantId, waId, etiquettes) {
      await publier(tenantId, waId, propres(etiquettes));
    },
  };
}
