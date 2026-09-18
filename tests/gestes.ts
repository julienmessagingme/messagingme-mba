/**
 * Ce qu'un outil qui NE FAIT AUCUN GESTE porte dans la colonne de la migration 0158.
 *
 * 🔴 POURQUOI UNE FIXTURE NOMMÉE PLUTÔT QU'UN CHAMP OPTIONNEL. `gestes` est REQUIS dans `OutilDefini`, et
 * c'est ce qui le fait voyager : un câblage qui l'oublierait ne compile pas. Un `?:` aurait laissé une
 * lecture les perdre en silence, et le symptôme aurait été un tag qui ne se pose jamais, c'est-à-dire un
 * trou dans le mini-CRM que personne ne relie à un outil.
 *
 * Ce nom-là dit l'hypothèse (« ce moment ne fait rien d'autre que sa réponse principale ») au lieu de la
 * cacher derrière un tableau vide recopié. Même patron que `SANS_MCP` et que `jamaisDesabonne`.
 *
 * ⚠️ IL VIT DANS `tests/`, JAMAIS DANS `src/` : une valeur par défaut importable par le câblage de
 * production redonnerait exactement ce que le type vient de retirer.
 */
import type { Geste } from '../src/agent/gestes';

/**
 * ⚠️ UNE FONCTION, PAS UNE CONSTANTE, contrairement à `SANS_MCP` qui ne porte que des `null`. Ici la valeur
 * est un TABLEAU : une constante partagée donnerait la MÊME référence à toutes les fixtures du dépôt, et le
 * jour où un test y pousse un geste, il le pousserait chez tous les autres. Le coût est un `()`.
 */
export const AUCUN_GESTE = (): { gestes: Geste[] } => ({ gestes: [] });

/**
 * Un exécuteur de gestes qui ne fait RIEN, pour les harnais qui n'en éprouvent aucun.
 *
 * ⚠️ IL DIT L'HYPOTHÈSE (« ce test ne regarde pas les gestes ») au lieu de la cacher derrière un
 * `async () => {}` recopié dix fois. Un test qui éprouve VRAIMENT un geste passe le sien et capture, il ne
 * prend pas celui-ci.
 */
export const GESTE_MUET = async (): Promise<void> => {};
