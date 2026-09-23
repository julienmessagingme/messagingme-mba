/**
 * D'OU vient un message sortant. Une seule definition, partagee par les chemins d'ecriture et par
 * l'agregat de l'ecran quantitatif (migration 0099).
 *
 * Pourquoi ce n'est pas derivable du reste de la ligne : un envoi de scenario et une reponse de l'agent IA
 * ecrivent tous les deux `type = 'text'` avec `sender_user_id = null`. Rien ne les separait avant cette
 * colonne. C'est le constat qui a motive la brique, et il vaut la peine d'etre garde ici : la tentation
 * naturelle, en relisant la table, est de croire que `type` suffit.
 */

export const ORIGINES = ['humain', 'scenario', 'ia', 'mba', 'campagne', 'mcp', 'api'] as const;
export type OrigineMessage = (typeof ORIGINES)[number];

/**
 * Le moment ou la colonne a commence a etre remplie. Avant, personne ne l'ecrivait.
 *
 * 🔴 Il sert de BORNE a la derivation ci-dessous, et c'est tout son interet. Sans borne, un chemin
 * d'ecriture ajoute demain sans poser son origine serait compte comme du scripte, en silence et pour
 * toujours. Avec elle, il ressort en « indeterminee » a l'ecran, donc il se voit.
 */
export const BASCULE_ORIGINE = '2026-09-01T00:00:00Z';

/**
 * L'origine EFFECTIVE d'un message sortant, en SQL. `m` est l'alias de `conversation_messages`.
 *
 * Trois couches, dans cet ordre :
 *   1. la colonne, quand elle est remplie (tout ce qui est ecrit depuis la migration 0099) ;
 *   2. ce que la ligne dit d'elle-meme et qui ne peut pas mentir (un expediteur humain, un message de
 *      l'agent de Meta) ;
 *   3. pour le seul historique d'AVANT la bascule, le scenario.
 *
 * La couche 3 n'est pas une supposition confortable, elle a ete MESUREE le 2026-09-01 sur la base de
 * production : `agent_sessions` etait vide, aucun tour d'agent n'avait jamais tourne, donc aucun message
 * d'agent ne pouvait exister dans l'historique. Tout sortant hors template et sans expediteur humain y
 * vient d'un scenario. Cette phrase est la justification de la ligne `else 'scenario'` : si elle cesse
 * d'etre vraie un jour, c'est que quelqu'un a rejoue de vieilles donnees, pas que la regle a derive.
 *
 * Fragment PARTAGE et non recopie : l'agregat et le detail doivent classer un message de la meme facon,
 * sinon un total et sa ventilation ne tombent plus juste (regle « Modules partages » du CLAUDE.md).
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

/** Les trois themes demandes a l'ecran, et ce que chaque origine y verse. `mba` est une IA (l'agent de
 *  Meta), il rejoint donc l'IA ; `campagne` n'apparait pas ici parce qu'une campagne part en template et
 *  qu'un template n'est pas un message de service. */
/**
 * LE DÉTAIL SOUS LE THÈME « IA » : laquelle des trois (demande de Julien, 2026-09-15).
 *
 * 🔴 IL VIT ICI, À CÔTÉ DE `THEME_DE_ORIGINE`, ET PAS DANS L'AGRÉGAT. Les deux tables répondent à la même
 * question sur la même valeur, et les séparer de fichier ferait diverger le jour où une quatrième IA
 * apparaît : on ajouterait la ligne dans l'une et pas dans l'autre, et le détail cesserait de retomber sur
 * son total sans qu'aucune erreur ne le dise. `tests/origine-messages.test.ts` tient l'invariant.
 *
 * ⚠️ `agent` ET NON `ia`, délibérément : la valeur en base s'appelle `ia`, mais elle désigne NOTRE agent, pas
 * la famille. Garder le même mot aux deux niveaux donnerait `ia.ia`, illisible à l'écran comme au code.
 */
export const DETAIL_IA: Record<string, 'agent' | 'mba' | 'mcp' | undefined> = {
  ia: 'agent',
  mba: 'mba',
  mcp: 'mcp',
};

export const THEME_DE_ORIGINE: Record<string, 'ia' | 'scenario' | 'humain' | 'indeterminee'> = {
  ia: 'ia',
  mba: 'ia',
  // Un agent tiers branché par MCP : côté client, c'est une IA qui répond. La valeur reste DISTINCTE en
  // base (comme `mba` l'est de `ia`) pour pouvoir la séparer un jour sans réécrire l'historique, mais elle
  // rejoint le thème « IA » à l'écran, parce que Julien en a demandé trois et pas six.
  mcp: 'ia',
  scenario: 'scenario',
  humain: 'humain',
  campagne: 'scenario',
  /**
   * L'API publique du client (migration 0166) : un envoi par `POST /v1/messages`.
   *
   * 🔴 `scenario` ET SURTOUT PAS `ia`, ET LE CHOIX SE JUSTIFIE PAR CE QUI EST VRAI, pas par ce qui reste.
   * Le theme repond a « qui a ecrit ce message ? » et il n'a que trois reponses. Ce n'est pas un humain
   * (personne n'a tape la phrase dans la console), et il n'y a AUCUN modele au bout : le ranger dans « IA »
   * afficherait un cout d'IA la ou il n'y en a pas. C'est un envoi AUTOMATISE, non redige sur le moment,
   * donc exactement ce que `campagne` fait deja ici pour la meme raison.
   *
   * ⚠️ ET SURTOUT PAS `indeterminee`, qui veut dire « un chemin d'ecriture a oublie de poser son origine ».
   * Ce theme-la est un SIGNAL DE PANNE : y verser une valeur parfaitement connue le rendrait muet.
   */
  api: 'scenario',
  indeterminee: 'indeterminee',
};
