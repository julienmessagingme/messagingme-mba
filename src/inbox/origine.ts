/**
 * D'OU vient un message sortant. Une seule definition, partagee par les chemins d'ecriture et par
 * l'agregat de l'ecran quantitatif (migration 0099).
 *
 * Pourquoi ce n'est pas derivable du reste de la ligne : un envoi de scenario et une reponse de l'agent IA
 * ecrivent tous les deux `type = 'text'` avec `sender_user_id = null`. Rien ne les separait avant cette
 * colonne. C'est le constat qui a motive la brique, et il vaut la peine d'etre garde ici : la tentation
 * naturelle, en relisant la table, est de croire que `type` suffit.
 */

export const ORIGINES = ['humain', 'scenario', 'ia', 'mba', 'campagne'] as const;
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
export const THEME_DE_ORIGINE: Record<string, 'ia' | 'scenario' | 'humain' | 'indeterminee'> = {
  ia: 'ia',
  mba: 'ia',
  scenario: 'scenario',
  humain: 'humain',
  campagne: 'scenario',
  indeterminee: 'indeterminee',
};
