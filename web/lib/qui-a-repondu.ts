/**
 * QUI A REPONDU DANS UNE CONVERSATION : scripte, humain, Meta Business Agent, agent IA.
 *
 * 🔴 UN FAIT DERIVE, PAS UNE OPINION, ET C'EST POURQUOI CE SONT DES BADGES ET PAS DES CASES A COCHER.
 * Julien, le 2026-09-17 : « peut-etre mettre une checkbox ». Une case a cocher PROMET qu'on peut la
 * changer ; or ces quatre etats se lisent dans `conversation_messages.origin`, ecrit au moment de l'envoi
 * (migration 0099). Un utilisateur qui decocherait ferait mentir les compteurs de la synthese sans
 * qu'aucun ecran ne puisse le signaler. Le badge garde le geste voulu (cliquer pour voir la partie de
 * conversation concernee) sans l'illusion qu'on peut reecrire ce qui s'est passe.
 *
 * 🔴 ET SURTOUT PAS `conversation_analysis.handled_by`, QUI NE SAIT PAS REPONDRE A CETTE QUESTION.
 * `deduceHandledBy` (`src/analysis/engine.ts`) ne rend que `humain` ou `automatise` : la valeur `mba` est
 * declaree dans l'enumeration et n'est JAMAIS produite. Mesure en production le 2026-09-17 : sur 14
 * analyses, 8 `automatise` et 6 `humain`, zero `mba`. Une conversation menee par l'agent de Meta y est donc
 * indiscernable d'un scenario, ce qui est exactement la distinction demandee.
 *
 * Module PUR : aucun appel, aucun etat.
 */

/** Les quatre repondeurs possibles, dans l'ordre ou l'ecran les montre. */
export const REPONDEURS = ['scripte', 'humain', 'mba', 'agent'] as const;
export type Repondeur = (typeof REPONDEURS)[number];

/**
 * De l'origine d'un message sortant au repondeur affiche.
 *
 * ⚠️ `mcp` EST UN AGENT IA, et le compter a part serait une cinquieme case que personne n'a demandee : c'est
 * un agent qui appelle un outil, pas un autre repondeur. Le depot fait deja ce rapprochement ailleurs
 * (`serviceIaDetail` somme `agent + mba + mcp` pour retrouver le theme « ia »).
 *
 * 🔴 `campagne` N'EST PAS UN REPONDEUR, ET SON ABSENCE EST DELIBEREE. Un envoi de campagne est le message
 * qui OUVRE l'echange, pas une reponse a ce que le client a dit. Le compter en « scripte » ferait porter un
 * badge « on vous a repondu » a toute conversation nee d'une campagne, y compris celles ou personne n'a
 * jamais repondu.
 */
const DE_L_ORIGINE: Record<string, Repondeur | undefined> = {
  scenario: 'scripte',
  humain: 'humain',
  mba: 'mba',
  ia: 'agent',
  mcp: 'agent',
};

/**
 * Les repondeurs d'une conversation, dans l'ordre d'affichage, sans doublon.
 *
 * ⚠️ UNE CONVERSATION HYBRIDE EN PORTE PLUSIEURS, et c'est le cas que Julien a nomme : « si la conversation
 * est hybride (parfois repondue par un agent humain puis par le MBA) ». Rendre un seul repondeur
 * obligerait a en choisir un, donc a cacher l'autre.
 *
 * ⚠️ UNE LISTE VIDE VEUT DIRE « PERSONNE N'A REPONDU », ET C'EST UNE INFORMATION. Une conversation ou seule
 * une campagne est partie, ou dont tous les sortants sont anterieurs a la migration 0099, n'a aucun badge.
 * L'ecran doit le dire plutot que d'inventer un repondeur par defaut.
 */
export function repondeursDe(origines: readonly (string | null | undefined)[]): Repondeur[] {
  const vus = new Set<Repondeur>();
  for (const o of origines) {
    const r = typeof o === 'string' ? DE_L_ORIGINE[o] : undefined;
    if (r) vus.add(r);
  }
  return REPONDEURS.filter((r) => vus.has(r));
}

/** Le libelle d'un repondeur. Le nom de l'agent n'y est PAS : cf. le cadrage, il attend un second agent. */
export function libelleRepondeur(r: Repondeur, t: (fr: string, en?: string) => string): string {
  switch (r) {
    case 'scripte': return t('Scripté', 'Scripted');
    case 'humain': return t('Humain', 'Human');
    case 'mba': return t('Meta Business Agent', 'Meta Business Agent');
    case 'agent': return t('Agent IA', 'AI agent');
  }
}
