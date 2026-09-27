/**
 * D'où vient un message sortant. Une seule définition, partagée par les chemins d'écriture et par l'agrégat
 * de l'écran quantitatif. Elle ne se déduit pas du reste de la ligne : un envoi de scénario et une réponse de
 * l'agent IA écrivent tous deux `type = 'text'` sans `sender_user_id`.
 */

export const ORIGINES = ['humain', 'scenario', 'ia', 'mba', 'campagne', 'mcp', 'api'] as const;
export type OrigineMessage = (typeof ORIGINES)[number];

/**
 * Le moment où la colonne a commencé à être remplie. Il borne la dérivation ci-dessous : un chemin d'écriture
 * qui oublierait de poser son origine ressort en « indeterminee » au lieu d'être compté comme du scripté.
 */
export const BASCULE_ORIGINE = '2026-09-01T00:00:00Z';

/**
 * L'origine effective d'un message sortant, en SQL (`m` = alias de `conversation_messages`) : la colonne quand
 * elle est remplie, sinon ce que la ligne dit d'elle-même (expéditeur humain, message de l'agent de Meta),
 * sinon `scenario` pour le seul historique d'avant la bascule (aucun tour d'agent n'existait alors).
 * Fragment partagé : l'agrégat et le détail doivent classer un message de la même façon.
 */
export const ORIGINE_EFFECTIVE_SQL = `coalesce(
  m.origin,
  case
    when m.sender_user_id is not null then 'humain'
    when m.type = 'mba' then 'mba'
    when m.created_at < timestamptz '${BASCULE_ORIGINE}' then 'scenario'
    else 'indeterminee'
  end
)`;

/**
 * Le détail sous le thème « IA » : laquelle des trois. À côté de `THEME_DE_ORIGINE` pour qu'une nouvelle IA
 * s'ajoute aux deux tables à la fois (un test tient l'invariant). `agent` et non `ia` : la valeur `ia`
 * désigne notre agent, pas la famille.
 */
export const DETAIL_IA: Record<string, 'agent' | 'mba' | 'mcp' | undefined> = {
  ia: 'agent',
  mba: 'mba',
  mcp: 'mcp',
};

/** Les trois thèmes de l'écran, et ce que chaque origine y verse. `mba` est une IA (l'agent de Meta). */
export const THEME_DE_ORIGINE: Record<string, 'ia' | 'scenario' | 'humain' | 'indeterminee'> = {
  ia: 'ia',
  mba: 'ia',
  // Un agent tiers branché par MCP : une IA côté client. La valeur reste distincte en base pour pouvoir la
  // séparer un jour sans réécrire l'historique.
  mcp: 'ia',
  scenario: 'scenario',
  humain: 'humain',
  campagne: 'scenario',
  /**
   * L'API publique du client : un envoi automatisé, ni humain ni modèle (le ranger dans « IA » afficherait un
   * coût d'IA inexistant), donc comme `campagne`. Surtout pas `indeterminee`, qui est un signal de panne.
   */
  api: 'scenario',
  indeterminee: 'indeterminee',
};

/**
 * Les origines qui répondent, dont se dérivent les badges « Répondu par » (`web/lib/qui-a-repondu.ts`).
 *
 * Un message de l'API ne répond que s'il suit un entrant du même fil : sans fenêtre en RCS, l'API peut écrire
 * la première et ouvre alors l'échange comme une campagne. Il suit un entrant si et seulement si le premier
 * entrant du fil est antérieur au dernier message de l'API. Les autres origines passent telles quelles.
 */
export function originesQuiRepondent(
  origines: readonly string[],
  dernierApi: Date | null,
  premierEntrant: Date | null,
): string[] {
  // Une valeur absente (`null`, ou une colonne qu'une lecture n'aurait pas rendue) veut dire « pas d'entrant »
  // ou « pas de message de l'API » : l'API ne répond pas.
  const apiRepond = dernierApi instanceof Date && premierEntrant instanceof Date && premierEntrant.getTime() < dernierApi.getTime();
  return origines.filter((o) => o !== 'api' || apiRepond);
}
