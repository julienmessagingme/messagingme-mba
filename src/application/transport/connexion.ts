// Recopié de wagroups, commit 526d3cc, `src/transport/connectionState.ts` (règle de Julien : un moteur partagé entre
// deux produits se recopie avec la référence de son commit, on n'en extrait un paquet commun qu'au troisième).
// Changé : la mise en forme du dépôt ; sa machine d'états n'est pas recopiée, le gestionnaire des sessions décide
// (`../sessions.ts`, avec `causeDeFermeture` de `./session.ts`).

const DELAI_BASE_MS = 1000;
const DELAI_MAX_MS = 300_000;

export function delaiBackoff(tentative: number): number {
  // Garde de domaine locale a la fonction : un NaN ou un negatif ne doit jamais produire un delai nul ou
  // sub-seconde, sinon le backoff redevient une boucle chaude. Math.max(0, NaN) vaut NaN en JavaScript (pas 0),
  // donc le cas NaN est ecarte explicitement avant le clamp.
  const tentativeSure = Number.isFinite(tentative) ? Math.max(0, Math.floor(tentative)) : 0;
  return Math.min(DELAI_BASE_MS * 2 ** tentativeSure, DELAI_MAX_MS);
}

/**
 * Code HTTP porte par une erreur de deconnexion Baileys, lu par la FORME de l'objet et non par `instanceof Boom`.
 *
 * 🔴 Ce nombre est la SEULE chose qui distingue un compte banni (403) d'une coupure reseau ordinaire : s'il revient
 * undefined, la deconnexion passe pour banale et le compte banni serait relie en boucle, ce qui rendrait le
 * bannissement definitif. `instanceof Boom` lierait ce constat a l'identite d'un constructeur, donc a la resolution
 * npm (une seconde copie de @hapi/boom et l'instanceof devient faux EN SILENCE). La forme ne depend d'aucune copie.
 */
export function codeDeconnexion(err: unknown): number | undefined {
  const code = (err as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

