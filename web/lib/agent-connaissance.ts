/**
 * La fraîcheur d'une source de connaissance.
 *
 * 🔴 POURQUOI C'EST UNE FEATURE ET PAS UNE COQUETTERIE. Le constat récurrent du marché est que la cause
 * dominante des mauvaises réponses d'un agent n'est pas le modèle, c'est le CONTENU PÉRIMÉ : le site a changé,
 * la fiche non. Un agent qui répond avec assurance un tarif de l'an dernier fait plus de dégâts qu'un agent
 * qui transfère. D'où la seule parade que le produit peut offrir sans relire le site tout seul : montrer la
 * date de lecture, et le dire quand elle devient vieille.
 *
 * Pur et sans dépendance, dans `lib/` : les tests de la racine ne savent pas résoudre les alias `@/` des
 * composants, donc une règle qu'on veut tester ne vit jamais dans un `.tsx`.
 */

/** Au-delà, une source est signalée comme à relire. Un trimestre : assez long pour ne pas harceler un client
 *  dont le site ne bouge pas, assez court pour attraper une saison tarifaire. */
export const JOURS_AVANT_ALERTE = 90;

/**
 * Bornes des champs, REJOUÉES depuis le serveur (`src/agent/scrape.ts` et `src/http/agent-knowledge.ts`).
 *
 * Les deux builds ne partagent aucun module : `tests/web-agent-connaissance.test.ts` casse dès qu'une valeur
 * s'écarte de celle du serveur. Sans elles, un corps trop long partirait et reviendrait en 400, c'est-à-dire
 * une erreur technique pour une saisie que le champ savait déjà mauvaise.
 */
export const MAX_TITRE_FICHE = 200;
export const MAX_CORPS_FICHE = 4000;

const JOUR_MS = 86_400_000;

/** Jours entiers écoulés depuis la lecture. `null` si la fiche n'a pas de date (écrite à la main) ou si la
 *  date est illisible : on ne fabrique pas une alerte à partir de rien. */
export function joursDepuis(iso: string | null, maintenant: number): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // Une date dans le futur (horloge décalée) rend 0, jamais un nombre négatif qui s'afficherait tel quel.
  return Math.max(0, Math.floor((maintenant - t) / JOUR_MS));
}

/** La source est-elle assez vieille pour mériter un avertissement ? */
export function sourcePerimee(iso: string | null, maintenant: number): boolean {
  const jours = joursDepuis(iso, maintenant);
  return jours !== null && jours >= JOURS_AVANT_ALERTE;
}
