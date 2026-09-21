import { REPONSE_MAISON, lireValeurChamp, type CibleMaison } from './outils-maison';

/**
 * EXÉCUTER UN GESTE DE L'AGENT DE META pour un contact (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 AUCUN GESTE N'EST RÉÉCRIT ICI : chaque dépendance est la fonction qui le fait déjà ailleurs (la pose d'un
 * tag des agents IA, l'écriture de champ du mini-CRM). Ce module ne fait que choisir laquelle, et traduire
 * l'issue en ce que l'agent de Meta lit.
 */
export interface DepsMaison {
  /** `creerPoserTagAgent` : pose, déclaration dans Contenus > Tags, `tag_added` si l'étiquette est nouvelle. */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;
  ecrireChamp(tenantId: string, waId: string, champ: string, valeur: string): Promise<void>;
  /**
   * Le champ existe-t-il encore dans le mini-CRM ? 🔴 Sans cette question, un outil dont le champ a été supprimé
   * écrivait quand même la valeur, sous une clé qu'aucun écran ne montre plus, pendant que l'onglet Outils
   * affichait « ce champ n'existe plus ». Même source que cette ligne rouge : la liste des champs de l'espace.
   */
  champExiste(tenantId: string, champ: string): Promise<boolean>;
}

export type IssueMaison = { ok: true; reponse: string } | { ok: false; erreur: string };

/** Ce que l'agent de Meta lit quand le champ visé a été supprimé du mini-CRM. */
export const CHAMP_DISPARU = "Ce champ n'existe plus sur la fiche du client : l'information n'a pas été enregistrée.";

export async function executerOutilMaison(
  deps: DepsMaison,
  input: { tenantId: string; waId: string; cible: CibleMaison; corps: unknown },
): Promise<IssueMaison> {
  const { tenantId, waId, cible } = input;
  switch (cible.handler) {
    case 'tag_fixe':
      await deps.poserTag(tenantId, waId, cible.tag);
      return { ok: true, reponse: REPONSE_MAISON.tag_fixe };
    case 'champ_fixe': {
      if (!(await deps.champExiste(tenantId, cible.champ))) return { ok: false, erreur: CHAMP_DISPARU };
      const lu = lireValeurChamp(cible, input.corps);
      if (!lu.ok) return { ok: false, erreur: lu.erreur };
      await deps.ecrireChamp(tenantId, waId, cible.champ, lu.valeur);
      return { ok: true, reponse: REPONSE_MAISON.champ_fixe };
    }
  }
}
