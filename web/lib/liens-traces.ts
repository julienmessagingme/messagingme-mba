/**
 * Les clics sur les liens tracés des templates, TOUS ENVOIS CONFONDUS.
 *
 * Lecture volontairement distincte de celle par scénario : un lien ne sait pas qui l'a envoyé. Un template
 * utilisé uniquement en CAMPAGNE n'a aucun bloc de scénario où s'accrocher, et n'apparaîtrait donc nulle
 * part dans une lecture par bloc. Ici, il est compté comme les autres.
 */

export interface LienTraceAvecClics {
  code: string;
  templateName: string;
  templateLanguage: string;
  /** Index de la carte de carousel, ou null pour un bouton du template lui-même. */
  cardIndex: number | null;
  buttonIndex: number;
  destination: string;
  clics: number;
}

/**
 * Ce qui identifie un lien à l'écran : son template, et lequel de ses boutons.
 *
 * Le libellé du bouton n'est pas disponible ici (il vit chez Meta, pas dans notre table) : on nomme donc par
 * la POSITION, la seule chose dont on soit sûr. Mieux vaut « bouton 2 » qu'un libellé deviné.
 */
export function libelleLien(l: LienTraceAvecClics): string {
  const bouton = `bouton ${l.buttonIndex + 1}`;
  return l.cardIndex === null
    ? `${l.templateName} · ${bouton}`
    : `${l.templateName} · carte ${l.cardIndex + 1}, ${bouton}`;
}

/**
 * Largeur de la barre d'un lien, en pourcentage du plus cliqué.
 *
 * Une valeur NON NULLE garde 4 % : sinon « 1 clic » se dessine comme « aucun », et une barre invisible se lit
 * comme une mesure absente. Zéro reste à zéro, parce que zéro clic est une information, pas un détail
 * d'affichage.
 *
 * Rendue en LISTE et non en histogramme : les libellés de liens sont bien plus longs que des titres de blocs,
 * et l'histogramme les tronquerait à une quinzaine de caractères, rendant deux boutons d'un même template
 * indiscernables. Une liste les affiche en entier, et laisse la place à la destination.
 */
export function largeurBarre(clics: number, max: number): number {
  if (clics <= 0 || max <= 0) return 0;
  return Math.max(4, Math.round((clics / max) * 100));
}
