/**
 * LE PÉRIMÈTRE À COUVRIR AVANT DE PROPOSER QUOI QUE CE SOIT.
 *
 * 🔴 CE QUE ÇA RÉPARE. L'assistant proposait des réglages dès la première phrase, en comblant lui-même tout ce
 * que le client n'avait pas dit. Julien, le 2026-08-28, sur une proposition réelle : « là tu inventes ce que
 * le client voudrait quand il semble prêt à prendre rdv, alors qu'il faut en fait définir avec lui ce qu'il
 * faut faire (quel outil ? si pas de tool, quel scénario ?) ». Et sur une autre : « il n'a jamais été
 * question à la fin d'appeler le client [...] faut pas inventer ».
 *
 * La cause n'était pas le modèle, elle était dans nos propres mots : le mandat lui ordonnait « déduis-les de
 * ce qu'il raconte plutôt que de les lui demander », et le schéma exigeait une clause « quand ne pas
 * l'appeler » JAMAIS VIDE. On lui commandait d'inventer, il inventait.
 *
 * D'où cette liste. Elle sert deux fois, et c'est ce qui lui donne des dents : le modèle la reçoit comme
 * l'ordre du jour de l'entretien, et la route s'en sert pour RETENIR le diff tant qu'un point obligatoire
 * n'est pas couvert. Sans le second usage, ce ne serait qu'une consigne de plus, qu'un modèle pressé ignore.
 *
 * Chaque point correspond à un champ que l'assistant devra remplir ensuite : la couverture n'est pas un
 * questionnaire décoratif, c'est exactement ce qu'il faut savoir pour écrire la fiche sans rien inventer.
 */

export interface Dimension {
  code: string;
  /** Ce que l'assistant doit avoir obtenu. Part dans le prompt, telle quelle. */
  aObtenir: string;
}

/**
 * Les six points. Volontairement peu nombreux : un entretien de quarante questions est un formulaire avec
 * plus de friction, et c'est l'anti-patron que le mandat évitait déjà avant de tomber dans l'autre excès.
 */
export const DIMENSIONS: Dimension[] = [
  { code: 'mission', aObtenir: 'ce que l’agent est là pour faire, au-delà de répondre' },
  { code: 'perimetre', aObtenir: 'ce dont il ne parle pas, ce qu’il ne fait jamais' },
  { code: 'aboutissements', aObtenir: 'à quoi ressemble une conversation qui finit bien ; il peut y en avoir plusieurs' },
  {
    code: 'bascules',
    aObtenir: 'les moments où il doit faire autre chose que répondre, ET CE QU’IL DOIT FAIRE à ce moment-là '
      + '(appeler un outil, envoyer un bloc du scénario, passer la main, ou simplement continuer à répondre)',
  },
  { code: 'humain', aObtenir: 'quand un humain reprend la conversation ; « jamais » est une réponse valable' },
  { code: 'ton', aObtenir: 'comment il parle' },
];

const CODES = new Set(DIMENSIONS.map((d) => d.code));

/** Les codes valables, pour l'énumération fermée du schéma de proposition. */
export const CODES_DIMENSIONS = DIMENSIONS.map((d) => d.code) as [string, ...string[]];

/**
 * Ce qui reste à couvrir. Un code inconnu est IGNORÉ : il vient d'un modèle, donc d'une source non fiable, et
 * inventer un code ne doit pas permettre de déclarer couvert un point qui ne l'est pas.
 */
export function manquesDeCouverture(couverts: readonly string[]): string[] {
  const vus = new Set(couverts.filter((c) => CODES.has(c)));
  return DIMENSIONS.filter((d) => !vus.has(d.code)).map((d) => d.code);
}

/**
 * L'ordre du jour, tel qu'il part dans le prompt.
 *
 * Le modèle reçoit la liste ENTIÈRE à chaque tour, pas seulement ce qui manque : il doit pouvoir revenir sur
 * un point déjà abordé si la réponse suivante le contredit, et une liste tronquée le lui interdirait.
 */
export function ordreDuJour(): string {
  const large = Math.max(...DIMENSIONS.map((d) => d.code.length));
  return DIMENSIONS.map((d) => `  ${d.code.padEnd(large)} : ${d.aObtenir}`).join('\n');
}
