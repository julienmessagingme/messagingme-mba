/**
 * Ce qu'un outil qui NE VIENT PAS d'un serveur MCP porte dans les quatre colonnes de la migration 0152.
 *
 * 🔴 POURQUOI UNE FIXTURE NOMMÉE PLUTÔT QUE DES CHAMPS OPTIONNELS. Les quatre sont REQUIS dans
 * `OutilDefini`, et c'est ce qui les fait voyager : un câblage qui les oublierait ne compile pas. Mais la
 * contrepartie est que chaque fixture de test doit les écrire, et quatre `null` recopiés trente fois ne
 * disent rien. Ce nom-là dit l'hypothèse (« cet outil n'est pas importé »), au lieu de la cacher derrière
 * un `?:` qui aurait laissé un vrai câblage se perdre en silence.
 *
 * Même patron que `jamaisDesabonne` (`tests/consentement.ts`), posé le 2026-09-15 pour la même raison.
 *
 * ⚠️ IL VIT DANS `tests/`, JAMAIS DANS `src/` : une valeur par défaut importable par le câblage de
 * production redonnerait exactement ce que le type vient de retirer.
 */
export const SANS_MCP = {
  mcpAnnonce: null,
  mcpNonActivable: null,
  mcpIndisponibleLe: null,
  mcpVuLe: null,
} as const;
