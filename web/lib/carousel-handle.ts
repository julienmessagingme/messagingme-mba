/**
 * Identifiant d'un bouton de carte de carousel : c'est À LA FOIS le nom de la sortie du bloc dans le builder
 * et le `payload` que l'envoi transmet à Meta. Les deux DOIVENT produire la même chaîne, sinon un tap sur une
 * carte ne retrouve pas la branche qu'on a reliée.
 *
 * `buttonIndex` est la position dans TOUS les boutons de la carte (un bouton lien compte, même s'il n'est pas
 * reliable), pas parmi les seules réponses rapides.
 *
 * ⚠️ Dupliqué dans `src/meta/template-components.ts` (les deux builds ne partagent aucun module) et verrouillé
 * par `tests/web-carousel-handle-parity.test.ts`.
 */
export function carouselButtonHandle(cardIndex: number, buttonIndex: number): string {
  return `card:${cardIndex}:btn:${buttonIndex}`;
}
