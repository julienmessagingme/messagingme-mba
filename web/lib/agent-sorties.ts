/**
 * La règle du CODE d'une règle d'arrêt, côté client.
 *
 * 🔴 Le code devient un handle d'arête `sortie:<code>` dans le builder : il est donc contraint au même
 * alphabet que les noms d'outils, et le serveur refuse tout le reste en 400. Plutôt que de laisser le client
 * découvrir la règle par un message d'erreur, on la lui applique en direct, sous ses yeux.
 *
 * ⚠️ MIROIR de `CODE_SORTIE_RE` et `MAX_SORTIES` (`src/agent/fiche.ts`), qui font AUTORITÉ. Recopié plutôt
 * qu'importé pour ne pas tirer du code serveur dans le bundle client, comme `MAX_DESTINATAIRES_EMAIL` ;
 * `tests/web-agent-code-sortie-parity.test.ts` casse dès que les deux divergent.
 *
 * Posé dans `web/lib/` et non dans le composant : c'est de la logique PURE, et un test de parité ne peut pas
 * importer un composant (il tirerait les alias `@/` et le JSX avec lui).
 */

export const MAX_SORTIES = 12;

/**
 * Ramène une saisie libre vers ce qu'un handle d'arête accepte. Rend une chaîne VIDE quand il ne reste rien
 * d'exploitable : l'appelant désactive alors son bouton, plutôt que d'ajouter une sortie nommée « _ ».
 *
 * ⚠️ Un code DÉJÀ valide doit ressortir inchangé. Sinon rouvrir une fiche déplacerait ses codes, et les
 * arêtes déjà tirées dans le builder désigneraient des sorties qui n'existent plus.
 */
export function normaliserCodeSortie(brut: string): string {
  return brut
    // Décomposition puis retrait des marques diacritiques : un accent ne passe pas dans un handle, mais la
    // lettre qui le porte, si.
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    // Le `slice` peut laisser un souligné en fin de chaîne : on le retire APRÈS, sinon un code tronqué
    // sortirait avec une terminaison que personne n'a écrite.
    .replace(/_+$/g, '');
}
