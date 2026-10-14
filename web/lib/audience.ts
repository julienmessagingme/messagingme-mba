import { filtersActive, type BulkTarget, type ContactFilters } from './contact-filters';
import { cibleContacts, selectionTout, type SelectionContacts } from './selection-contacts';

/**
 * QUI REÇOIT UNE CAMPAGNE, en fonctions PURES et en UN SEUL exemplaire.
 *
 * La sélection commune au CRM et à la campagne vit dans `selection-contacts.ts`. Ce module garde les
 * décisions propres à la campagne : source de l'audience, prévision et forme de la création.
 *
 * ⚠️ MODULE PUR (ni React, ni `@/`) : les seuls tests du front qui tournent hors navigateur sont ceux de
 * `lib/**` (`web/vitest.config.ts` les y borne). Une règle qui décide de QUI reçoit un message n'a pas
 * sa place dans un `.tsx`, où seul un e2e Playwright pourrait l'atteindre.
 */

/**
 * D'OÙ VIENNENT LES DESTINATAIRES. `fichier` et `hubspot` retombent sur `crm` une fois l'import fait.
 *
 * 🔴 `webhook` N'EST PAS UNE QUATRIÈME FAÇON DE CONSTITUER UNE LISTE, C'EST L'ABSENCE DE LISTE. Les
 * trois autres désignent un ensemble FIGÉ au moment du lancement ; celui-ci laisse la campagne OUVERTE
 * et lui amène un contact à la fois, à mesure qu'il arrive par l'adresse choisie. Tout ce qui compte,
 * filtre ou coche des contacts n'a donc rien à faire dans ce mode, et une campagne qui naît vide y est
 * l'état NORMAL, pas un échec.
 */
export type SourceAudience = 'crm' | 'fichier' | 'hubspot' | 'webhook';

/** L'audience complète : d'où elle vient, ce qui la filtre, et ce qui a été coché dedans. */
export interface AudienceChoix {
  source: SourceAudience;
  /**
   * L'ADRESSE ENTRANTE QUI AMÈNERA LES DESTINATAIRES, quand la source est `webhook`. Vide = aucune.
   *
   * ⚠️ ELLE RESTE DANS L'ÉTAT QUAND ON QUITTE LA SOURCE, ET C'EST `entreeDeCreation` QUI TRANCHE : elle
   * ne lit cette adresse que si la source est bien `webhook`. La vider au changement de source serait la
   * perdre à chaque aller-retour ; la lire sans regarder la source ferait partir « au fil de l'eau » une
   * campagne dont l'opérateur a sous les yeux une liste de contacts cochés.
   */
  webhookId: string;
  /**
   * LES FILTRES DU MINI-CRM, LE MÊME OBJET QUE CELUI DE L'ÉCRAN CONTACTS.
   *
   * 🔴 C'EST TOUT L'INTÉRÊT : le compte affiché et la résolution des destinataires à la création passent
   * alors par le MÊME analyseur côté serveur (`parseFilters`), donc l'écran ne peut pas annoncer une
   * population et la campagne en emporter une autre. Un second vocabulaire de ciblage aurait eu besoin
   * d'un second analyseur, et c'est là que les deux divergent.
   */
  filtres: ContactFilters;
  selection: SelectionContacts;
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
  return { source: 'crm', filtres: {}, selection: selectionTout(), webhookId: '' };
}

/**
 * LA CAMPAGNE EST-ELLE ALIMENTÉE AU FIL DE L'EAU plutôt que par une liste ?
 *
 * 🔴 UN SEUL PRÉDICAT POUR TOUS LES LECTEURS, et ils sont nombreux : le bouton de lancement, la
 * prévision du récapitulatif, le comptage de l'étape Audience et la traduction en requête. Chacun
 * testant `source === 'webhook'` de son côté, il suffirait d'en oublier un pour qu'un écran compte des
 * contacts qui n'existent pas encore, ou pour qu'une campagne ouverte se fasse refuser « aucun contact
 * sélectionné ».
 */
export function auFilDeLEau(a: Pick<AudienceChoix, 'source'>): boolean {
  return a.source === 'webhook';
}

/**
 * L'AUDIENCE SE DÉCRIT-ELLE ENTIÈREMENT PAR SES FILTRES ?
 *
 * 🔴 SEULE CETTE FORME SE COMPTE À L'AVANCE. `countContacts` ne sait interroger que des filtres : une
 * liste d'identifiants choisis à la main, ou un filtre amputé de ses exclusions, ne se comptent pas de
 * ce côté-là. Les lecteurs de cette fonction (la prévision du récapitulatif) doivent alors dire « je ne
 * sais pas » plutôt que de rendre un chiffre voisin, qui serait cru parce qu'il est plausible.
 */
export function audienceEnFiltres(sel: SelectionContacts): boolean {
  return sel.toutFiltre && sel.exclus.size === 0;
}

/** Les deux formes que la création accepte pour désigner des destinataires. Le serveur refuse les deux. */
export type CibleDestinataires = { contactIds: string[] } | { contactTarget: BulkTarget };

/**
 * CE QUE LA CRÉATION EMPORTE : une intention, ou une liste.
 *
 * La sélection est traduite une fois en `BulkTarget` partagé avec le CRM. Ici, seule l'enveloppe
 * attendue par la création de campagne change ; le serveur refuse de recevoir les deux formes.
 */
export function cibleDeCreation(sel: SelectionContacts, filtres: ContactFilters): CibleDestinataires {
  const cible = cibleContacts(sel, filtres);
  return 'ids' in cible ? { contactIds: cible.ids } : { contactTarget: cible };
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
  // 🔴 AU FIL DE L'EAU, IL N'Y A NI FILTRE NI COCHE À DÉCRIRE, et la valeur RÉSIDUELLE de `selection`
  // dirait « tous les contacts », c'est-à-dire exactement le contraire : cette campagne n'envoie à
  // personne qui soit déjà là. Le mode se lit donc en premier, avant tout le reste.
  if (auFilDeLEau(a)) return 'au fil de l’eau, par une adresse entrante';
  if (!a.selection.toutFiltre) return 'contacts choisis un par un';
  // ⚠️ `filtersActive` PLUTÔT QU'UN COMPTE DE CLÉS : un objet `{ tags: [] }` porte une clé et ne filtre
  // rien. Le mini-CRM tranche déjà cette question, et s'en donner une seconde réponse ici la ferait
  // dériver de l'autre à la première clé ajoutée.
  const exclus = a.selection.exclus.size;
  const base = filtersActive(a.filtres) ? 'tous ceux qui correspondent aux filtres' : 'tous les contacts';
  return exclus === 0 ? base : `${base}, moins ${exclus} décoché(s)`;
}
