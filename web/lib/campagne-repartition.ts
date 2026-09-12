import type { ContactFilters } from './contact-filters';
import type { CanalEtage, EtageAssistant } from './campagne-chaine';
import { RANG_INITIAL } from './campagne-chaine';

/**
 * LA RÉPARTITION PRÉVUE D'UNE AUDIENCE SUR UNE CHAÎNE, en fonctions PURES.
 *
 * 🔴 CE N'EST PAS UN RÉSUMÉ, C'EST LA SEULE FOIS OÙ L'OPÉRATEUR VOIT COMBIEN DE MONDE CHAQUE ÉTAGE
 * COUVRE. L'audience est demandée APRÈS le contenu (décision d'ordre du 2026-09-12) : il a donc
 * configuré son repli sans savoir s'il concernait trois personnes ou trois cents. C'est cet écran qui
 * rachète cet ordre, et c'est pour ça qu'il porte des NOMBRES et pas des libellés.
 *
 * 🔴 ELLE NE PRÉDIT QUE CE QU'ELLE SAIT, ET DIT LE RESTE. Deux choses sont MESURÉES en base et se
 * comptent d'avance : la joignabilité WhatsApp mémorisée (migration 0133) et la présence d'une adresse
 * e-mail sur la fiche. Tout le reste est un pari : un échec RCS ne se prévoit pas, et le plafond
 * marketing 131049 de Meta est par utilisateur et vit chez Meta. Un chiffre inventé sur ces deux-là
 * serait pire qu'une case vide, parce qu'il serait cru.
 *
 * ⚠️ MODULE PUR (ni React, ni `@/`) : les seuls tests du front qui tournent hors navigateur sont ceux
 * de `lib/**` (`web/vitest.config.ts` les y borne). Une règle de comptage enfouie dans un `.tsx` ne
 * serait exerçable que par un e2e Playwright, alors qu'elle décide de ce qu'un opérateur croit avant
 * d'appuyer sur « Lancer ».
 */

/** Le canal, tel qu'il s'écrit dans une phrase. */
export const LIBELLE_CANAL: Record<CanalEtage, string> = {
  whatsapp: 'WhatsApp',
  rcs: 'RCS',
  email: 'e-mail',
};

/**
 * CE QUE LA BASE SAIT DIRE DE L'AUDIENCE CHOISIE. Trois comptes, trois requêtes bornées, jamais une
 * liste de contacts rapatriée dans le navigateur.
 *
 * 🔴 `null` VEUT DIRE « PAS MESURABLE », JAMAIS « ZÉRO ». La nuance décide de ce que l'écran affiche :
 * zéro est une prévision (« personne ne bascule »), `null` est un aveu (« je ne sais pas le prévoir »).
 * Les confondre annoncerait « 0 basculeront en RCS » sur une chaîne qui part en RCS au premier étage,
 * c'est-à-dire un chiffre faux et rassurant.
 */
export interface MesuresAudience {
  /** Contacts retenus par la sélection. */
  retenus: number;
  /**
   * Ceux qu'on SAIT injoignables sur WhatsApp (migration 0133, mesure périmée à 90 jours).
   *
   * ⚠️ `null` DÈS QUE LE PREMIER ÉTAGE NE PART PAS EN WHATSAPP : la seule joignabilité mémorisée par ce
   * produit est celle de WhatsApp, et l'appliquer à un premier étage RCS ferait basculer un chiffre
   * mesuré sur un autre canal.
   */
  connusInjoignables: number | null;
  /**
   * Ceux dont le champ d'adresse e-mail est VIDE.
   *
   * ⚠️ `null` quand la chaîne n'a pas d'étage e-mail, ou quand aucun champ d'adresse n'a été choisi :
   * `contacts` n'a PAS de colonne `email`, l'adresse vit dans le jsonb `fields` sous une clé que le
   * client nomme lui-même (vécu le 2026-08-25 : un espace l'appelait « mail », un autre « email »).
   * Sans ce choix, il n'y a rien à compter.
   */
  sansAdresse: number | null;
}

/** Une ligne du tableau de répartition. `nombre` à `null` = le chiffre n'est pas prévisible. */
export interface LigneRepartition {
  rang: number;
  canal: CanalEtage;
  nombre: number | null;
  /** La phrase telle qu'elle s'affiche, nombre compris. */
  texte: string;
}

/**
 * LA RÉPARTITION, LIGNE PAR LIGNE, DANS L'ORDRE DES RANGS.
 *
 * ⚠️ `formater` est injecté plutôt qu'importé : le nombre se met en forme selon la langue de l'écran
 * (`fmtNum`), et ce module n'a pas à connaître la locale. L'injecter garde la règle testable avec un
 * formateur trivial, donc sans dépendre de l'ICU de la machine qui exécute le test.
 */
export function repartitionPrevue(
  chaine: EtageAssistant[],
  m: MesuresAudience,
  formater: (n: number) => string,
): LigneRepartition[] {
  const tries = [...chaine].sort((a, b) => a.rang - b.rang);
  return tries.map((etage) => {
    const libelle = LIBELLE_CANAL[etage.canal];
    if (etage.canal === 'email') {
      // 🔴 LA LIGNE E-MAIL DIT CE QU'ON PERD, PAS CE QU'ON ATTEINT, et c'est la seule honnête. Combien de
      // contacts ARRIVERONT jusqu'à cet étage dépend des échecs des étages précédents, qui ne se prévoient
      // pas. Combien n'ont pas d'adresse, en revanche, se compte : ceux-là sortent de la chaîne avant.
      if (m.sansAdresse === null) {
        return {
          rang: etage.rang, canal: etage.canal, nombre: null,
          texte: "Choisissez le champ qui porte l'adresse e-mail pour savoir combien de fiches en ont une.",
        };
      }
      return {
        rang: etage.rang, canal: etage.canal, nombre: m.sansAdresse,
        texte: m.sansAdresse === 0
          ? 'Toutes les fiches retenues portent une adresse e-mail.'
          : `${formater(m.sansAdresse)} n'ont pas d'adresse e-mail et sortiront de la chaîne avant cet étage.`,
      };
    }
    if (m.connusInjoignables === null) {
      return {
        rang: etage.rang, canal: etage.canal, nombre: null,
        texte: etage.rang === RANG_INITIAL
          ? `Tous les contacts retenus partiront en ${libelle}.`
          : `Ceux qui échouent en ${LIBELLE_CANAL[tries[0]?.canal ?? 'whatsapp']} basculeront en ${libelle}. Ce nombre n'est pas prévisible : la joignabilité n'est mémorisée que sur WhatsApp.`,
      };
    }
    if (etage.rang === RANG_INITIAL) {
      // ⚠️ `Math.max(0, ...)` N'EST PAS DE LA COQUETTERIE : les deux comptes viennent de DEUX requêtes,
      // donc de deux instants. Un import ou une mesure de joignabilité arrivée entre les deux peut rendre
      // le second plus grand que le premier, et « -3 partiront en WhatsApp » serait lu comme un bug.
      const n = Math.max(0, m.retenus - m.connusInjoignables);
      return { rang: etage.rang, canal: etage.canal, nombre: n, texte: `${formater(n)} partiront en ${libelle}.` };
    }
    return {
      rang: etage.rang, canal: etage.canal, nombre: m.connusInjoignables,
      texte: `${formater(m.connusInjoignables)} basculeront en ${libelle}.`,
    };
  });
}

/**
 * LE CHAMP QUI PORTE L'ADRESSE E-MAIL, proposé par défaut parmi les champs perso de l'espace.
 *
 * 🔴 IL N'Y A AUCUNE CONVENTION DANS CE PRODUIT, ET C'EST UN FAIT MESURÉ. `contacts` n'a pas de colonne
 * `email` (vérifié : 0001 et les `alter table contacts` qui ont suivi) ; l'adresse vit dans le jsonb
 * `fields`, sous la clé que le client a créée dans « Champs perso ». Le dépôt porte déjà la trace d'un
 * espace qui l'appelait « mail » quand un autre l'appelait « email » (`src/workflow/wiring.ts`, cas du
 * 2026-08-25). Deviner la clé, c'est donc se tromper une fois sur deux, EN SILENCE.
 *
 * ⚠️ D'OÙ UNE SUGGESTION, PAS UN DÉFAUT IMPOSÉ : on propose la clé la plus plausible pour épargner un
 * clic, et l'écran laisse choisir. Rendre `null` quand rien ne ressemble à une adresse est le bon
 * comportement : l'opérateur voit alors qu'il doit trancher.
 */
export function champEmailSuggere(champs: Array<{ key: string; label: string }>): string | null {
  const ressemble = (s: string): boolean => /e-?mail|courriel/i.test(s);
  return champs.find((c) => ressemble(c.key))?.key
    ?? champs.find((c) => ressemble(c.label))?.key
    ?? null;
}

/**
 * CE QUE L'ÉTAPE AUDIENCE LAISSE CHOISIR.
 *
 * ⚠️ VOLONTAIREMENT PAUVRE, et c'est la discipline anti-tailor-made du dépôt : « tout le monde », « ceux
 * qui portent un de ces tags », et une case pour écarter ceux qu'on sait injoignables. Le mini-CRM porte
 * déjà des filtres riches ; les rapatrier ici ferait un second écran de filtres à tenir d'accord avec le
 * premier, pour une campagne qui se cible en pratique par tag.
 */
export interface AudienceChoix {
  mode: 'tous' | 'tags';
  tags: string[];
  /** Écarter ceux dont la dernière mesure dit « injoignable en WhatsApp » (migration 0133). */
  sansInjoignables: boolean;
}

/**
 * LES FILTRES SERVEUR QUE CE CHOIX DÉCRIT.
 *
 * 🔴 C'EST LE MÊME OBJET QUE CELUI DU MINI-CRM (`ContactFilters`), ET C'EST TOUT L'INTÉRÊT. Le compte de
 * l'écran et la résolution des destinataires à la création passent alors par le MÊME analyseur côté
 * serveur (`parseFilters`), donc l'écran ne peut pas annoncer une population et la campagne en emporter
 * une autre. Un second vocabulaire de ciblage aurait eu besoin d'un second analyseur, et c'est là que les
 * deux divergent.
 *
 * ⚠️ `mode: 'tags'` SANS AUCUN TAG NE REND PAS « TOUT LE MONDE » : l'objet rendu porte `tags: []`, que
 * `filtersActive` lit comme « aucun filtre posé ». C'est l'appelant qui doit refuser d'avancer, et
 * l'étape Audience le fait. Le dire ici serait inventer un filtre qui n'existe pas.
 */
export function filtresDeLAudience(a: AudienceChoix): ContactFilters {
  return {
    ...(a.mode === 'tags' ? { tags: a.tags, tagMode: 'or' as const } : {}),
    ...(a.sansInjoignables ? { joignabiliteWhatsApp: 'connu_injoignable' as const } : {}),
  };
}

/**
 * LE CHAMP D'ADRESSE RÉELLEMENT EN VIGUEUR : celui que l'opérateur a choisi, sinon la suggestion.
 *
 * 🔴 UN SEUL POINT DE PASSAGE, ET C'EST TOUTE LA RAISON D'ÊTRE DE CETTE FONCTION. Le sélecteur de
 * l'étape Contenu et le comptage du récapitulatif lisent la même valeur : si chacun appliquait la
 * suggestion de son côté, l'écran pourrait AFFICHER un champ pendant que le compte en utilise un autre,
 * et l'opérateur lirait « 12 sans adresse » sur une colonne qu'il n'a pas choisie. Pire encore, oublier
 * la suggestion d'un seul côté ferait afficher un champ et compter sur rien du tout.
 */
export function champEmailEffectif(
  choisi: string | undefined,
  champs: Array<{ key: string; label: string }>,
): string | null {
  if (choisi !== undefined && choisi !== '') return choisi;
  // ⚠️ Une chaîne VIDE est un choix EXPLICITE de ne rien mettre (l'option « Choisir... » du sélecteur) :
  // elle ne retombe PAS sur la suggestion, sinon on ne pourrait jamais la retirer.
  if (choisi === '') return null;
  return champEmailSuggere(champs);
}
