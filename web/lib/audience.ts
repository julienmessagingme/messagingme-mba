import { filtersActive, type BulkTarget, type ContactFilters } from './contact-filters';

/**
 * QUI REÇOIT UNE CAMPAGNE, en fonctions PURES et en UN SEUL exemplaire.
 *
 * 🔴 POURQUOI CE FICHIER EXISTE (2026-09-13). Deux écrans désignent aujourd'hui les destinataires d'une
 * campagne : `CampaignCreateForm`, en service, et l'étape Audience de l'assistant. Chacun portait sa
 * propre traduction « ce que j'ai coché » -> « ce que la requête emporte », et l'assistant n'en portait
 * qu'une moitié (les filtres, jamais une liste). Deux traductions d'une même notion, c'est une
 * divergence programmée : le jour où l'une gagne un cas, l'autre envoie à une population différente
 * sans que rien ne le dise. Elles n'en font plus qu'une, ici, exerçable en quelques millisecondes.
 *
 * ⚠️ MODULE PUR (ni React, ni `@/`) : les seuls tests du front qui tournent hors navigateur sont ceux de
 * `lib/**` (`web/vitest.config.ts` les y borne). Une règle qui décide de QUI reçoit un message n'a pas
 * sa place dans un `.tsx`, où seul un e2e Playwright pourrait l'atteindre.
 */

/** D'où viennent les destinataires. `fichier` et `hubspot` retombent sur `crm` une fois l'import fait. */
export type SourceAudience = 'crm' | 'fichier' | 'hubspot';

/**
 * CE QUI EST COCHÉ, EN DEUX MODES QUI NE SE MÉLANGENT PAS.
 *
 * 🔴 `toutFiltre` RETIENT UNE INTENTION, PAS UNE LISTE, et c'est ce qui retire le piège des grosses
 * sélections. « Tout sélectionner » rapatriait jusqu'à 100 000 identifiants dans le navigateur puis les
 * renvoyait tous dans la requête, plafonnée à 1 Mo : la création échouait vers 25 000 contacts, donc
 * bien AVANT la limite que l'écran annonçait, et sans rien dire.
 *
 * ⚠️ `selected` NE VAUT QUE HORS `toutFiltre`, et `exclus` QUE DEDANS. Les lire tous les deux en même
 * temps donnerait deux réponses à la question « qui est retenu ? ».
 */
export interface SelectionDestinataires {
  toutFiltre: boolean;
  /** Les lignes cochées, quand on désigne une liste. Bornée : on ne coche que ce qui est affiché. */
  selected: Set<string>;
  /** Les lignes décochées, quand on vise « tout ce qui correspond ». */
  exclus: Set<string>;
}

/** L'audience complète : d'où elle vient, ce qui la filtre, et ce qui a été coché dedans. */
export interface AudienceChoix {
  source: SourceAudience;
  /**
   * LES FILTRES DU MINI-CRM, LE MÊME OBJET QUE CELUI DE L'ÉCRAN CONTACTS.
   *
   * 🔴 C'EST TOUT L'INTÉRÊT : le compte affiché et la résolution des destinataires à la création passent
   * alors par le MÊME analyseur côté serveur (`parseFilters`), donc l'écran ne peut pas annoncer une
   * population et la campagne en emporter une autre. Un second vocabulaire de ciblage aurait eu besoin
   * d'un second analyseur, et c'est là que les deux divergent.
   */
  filtres: ContactFilters;
  selection: SelectionDestinataires;
}

/** « Tout ce qui correspond aux filtres », sans exclusion. */
export function selectionTout(): SelectionDestinataires {
  return { toutFiltre: true, selected: new Set(), exclus: new Set() };
}

/** Aucune ligne cochée, en mode liste. */
export function selectionVide(): SelectionDestinataires {
  return { toutFiltre: false, selected: new Set(), exclus: new Set() };
}

/**
 * L'AUDIENCE D'UNE CAMPAGNE QUI DÉMARRE : tout l'espace, par INTENTION.
 *
 * 🔴 `toutFiltre` PLUTÔT QUE LES 500 LIGNES AFFICHÉES, et la nuance décide de qui reçoit. La liste est
 * plafonnée à 500 : un défaut en mode liste viserait 500 personnes sur un espace qui en compte 5 000,
 * en affichant « 500 » comme si c'était tout le monde. Le défaut le plus large du produit doit rester
 * celui qui se VOIT, d'où le bandeau que l'écran affiche dans ce mode.
 */
export function audienceInitiale(): AudienceChoix {
  return { source: 'crm', filtres: {}, selection: selectionTout() };
}

/** Une ligne affichée est-elle retenue ? En mode « tout », tout l'est sauf ce qui a été exclu. */
export function estRetenu(sel: SelectionDestinataires, id: string): boolean {
  return sel.toutFiltre ? !sel.exclus.has(id) : sel.selected.has(id);
}

/**
 * COMBIEN DE DESTINATAIRES, RÉELLEMENT.
 *
 * ⚠️ En mode « tout ce qui correspond », c'est le total SERVEUR moins les exclusions : le navigateur ne
 * connaît pas la liste, il en connaît le cardinal. Lire `selected.size` dans ce mode rendrait zéro, et
 * l'écran annoncerait « prêt à lancer à 0 destinataire » sur une campagne qui vise tout l'espace.
 */
export function nbRetenus(sel: SelectionDestinataires, total: number | null): number {
  return sel.toutFiltre ? Math.max(0, (total ?? 0) - sel.exclus.size) : sel.selected.size;
}

/**
 * L'AUDIENCE SE DÉCRIT-ELLE ENTIÈREMENT PAR SES FILTRES ?
 *
 * 🔴 SEULE CETTE FORME SE COMPTE À L'AVANCE. `countContacts` ne sait interroger que des filtres : une
 * liste d'identifiants choisis à la main, ou un filtre amputé de ses exclusions, ne se comptent pas de
 * ce côté-là. Les lecteurs de cette fonction (la prévision du récapitulatif) doivent alors dire « je ne
 * sais pas » plutôt que de rendre un chiffre voisin, qui serait cru parce qu'il est plausible.
 */
export function audienceEnFiltres(sel: SelectionDestinataires): boolean {
  return sel.toutFiltre && sel.exclus.size === 0;
}

/** Les deux formes que la création accepte pour désigner des destinataires. Le serveur refuse les deux. */
export type CibleDestinataires = { contactIds: string[] } | { contactTarget: BulkTarget };

/**
 * CE QUE LA CRÉATION EMPORTE : une intention, ou une liste.
 *
 * 🔴 UNE SEULE TRADUCTION POUR LES DEUX ÉCRANS. C'est la dernière décision avant des messages réels, et
 * elle tenait en un ternaire recopié : l'assistant n'en avait gardé que la branche « filtres », donc
 * cocher des lignes n'y changeait rien du tout. Le serveur, lui, refuse de recevoir les deux.
 */
export function cibleDeCreation(sel: SelectionDestinataires, filtres: ContactFilters): CibleDestinataires {
  if (!sel.toutFiltre) return { contactIds: [...sel.selected] };
  return { contactTarget: { filters: filtres, excludeIds: [...sel.exclus] } };
}

/**
 * LES FILTRES QUI DÉSIGNENT EXACTEMENT LES CONTACTS QU'ON VIENT D'IMPORTER.
 *
 * ⚠️ LEUR(S) TAG(S) COMME SEUL FILTRE, TOUT LE RESTE VIDÉ : un filtre résiduel d'avant l'import ferait
 * viser une partie des importés sans que rien ne le montre. `tagMode: 'or'` dès qu'il y en a plusieurs
 * (au moins un suffit), sinon un contact taggé « lot-A » sortirait d'un import à deux tags.
 */
export function filtresDesImportes(tags: string[]): ContactFilters {
  return tags.length > 1 ? { tags, tagMode: 'or' } : { tags };
}

/**
 * COMMENT L'AUDIENCE SE DIT EN UNE PARENTHÈSE, sur le récapitulatif.
 *
 * ⚠️ ELLE DIT LE MODE, PAS LE DÉTAIL DES FILTRES. Réciter six critères dans une parenthèse la rendrait
 * illisible, et l'opérateur a un lien pour retourner les voir. Ce qui doit se distinguer d'un coup
 * d'œil, c'est « tout l'espace » de « une sélection », parce que les deux n'engagent pas le même argent.
 */
export function libelleAudience(a: AudienceChoix): string {
  if (!a.selection.toutFiltre) return 'contacts choisis un par un';
  // ⚠️ `filtersActive` PLUTÔT QU'UN COMPTE DE CLÉS : un objet `{ tags: [] }` porte une clé et ne filtre
  // rien. Le mini-CRM tranche déjà cette question, et s'en donner une seconde réponse ici la ferait
  // dériver de l'autre à la première clé ajoutée.
  const exclus = a.selection.exclus.size;
  const base = filtersActive(a.filtres) ? 'tous ceux qui correspondent aux filtres' : 'tous les contacts';
  return exclus === 0 ? base : `${base}, moins ${exclus} décoché(s)`;
}
