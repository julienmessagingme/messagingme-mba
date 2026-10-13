/**
 * Les bornes d'une publicité Click-to-WhatsApp que la console annonce et que le serveur applique : le visuel, l'âge et
 * le bouton. L'écran refuse AVANT de téléverser, le serveur en dernier ressort, et lui seul protège. Celles de la
 * vidéo vivent à côté (`./pub-video`).
 */

/**
 * Types de fichier acceptés pour le visuel : une garde de sécurité, ce qui part d'ici va chez un tiers sous
 * l'identité du client. 🔴 Ni SVG (un document exécutable) ni GIF.
 */
export const TYPES_VISUEL_PUB = ['image/jpeg', 'image/png'] as const;

/**
 * Plafond de taille du visuel d'une publicité, en octets. Nom long exprès : le dépôt porte déjà plusieurs
 * `TAILLE_IMAGE_MAX` aux valeurs différentes. Bas devant ce que Meta accepte (30 Mo) : au-delà de quelques
 * mégaoctets, on n'achète qu'un téléversement lent sur une route HTTP que l'utilisateur attend.
 */
export const TAILLE_VISUEL_PUB_MAX = 5 * 1024 * 1024;

/**
 * Advantage+ audience est laissé à Meta (décision de Julien, 2026-09-28) : il n'accepte qu'un âge minimum entre 18 et
 * 25 ans et fixe l'âge maximum à 65.
 */
export const AGE_MIN_ADVANTAGE_BAS = 18;
export const AGE_MIN_ADVANTAGE_HAUT = 25;
export const AGE_MAX_ADVANTAGE = 65;

/**
 * 🔴 HYPOTHÈSE QUE L'ESSAI RÉEL TRANCHE, ÉCRITE ICI ET NULLE PART AILLEURS : les boutons qu'une créa
 * Click-to-WhatsApp accepte (`call_to_action.type`), dans l'ordre où l'écran les propose.
 *
 * Seul `WHATSAPP_MESSAGE` est documenté par Meta côté API pour cette destination. Les neuf autres viennent de ce
 * que le Gestionnaire de publicités propose pour une destination WhatsApp (relevé le 2026-09-28) : rien ne dit
 * que l'API les accepte sur `link_data` et `video_data`. La liste est FERMÉE (la route la tient en énumération
 * Zod, création et brouillon) ; si Meta refuse un type à la première création réelle, son message s'affiche
 * (422, `src/http/pubs.ts`) et c'est cette liste, seule, qui perd le type refusé.
 */
export const BOUTONS_PUB = [
  'WHATSAPP_MESSAGE', 'LEARN_MORE', 'GET_QUOTE', 'BOOK_NOW', 'CONTACT_US',
  'SHOP_NOW', 'ORDER_NOW', 'SIGN_UP', 'SUBSCRIBE', 'APPLY_NOW',
] as const;
export type BoutonPub = (typeof BOUTONS_PUB)[number];

/** Le bouton d'une publicité qui ne dit rien de plus : le seul que Meta documente pour Click-to-WhatsApp. */
export const BOUTON_PUB_DEFAUT: BoutonPub = 'WHATSAPP_MESSAGE';

/** Une valeur lue ailleurs (base, ancien brouillon) est-elle un bouton de la liste ? */
export function estBoutonPub(v: unknown): v is BoutonPub {
  return typeof v === 'string' && (BOUTONS_PUB as readonly string[]).includes(v);
}
