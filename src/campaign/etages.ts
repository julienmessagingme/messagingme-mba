/**
 * LA CHAÎNE D'ÉTAGES D'UNE CAMPAGNE : le canal n'est plus un attribut de la campagne, c'est une SUITE
 * de tentatives, chacune sur son canal, qu'on parcourt tant que la précédente n'a pas abouti.
 *
 * 🔴 CE MODULE NE CHANGE RIEN AUJOURD'HUI, ET C'EST SON INTÉRÊT. Une chaîne à UN seul étage a, par
 * construction, un `rangSuivant` toujours nul : aucune bascule n'est possible, donc le comportement est
 * EXACTEMENT celui d'avant. La migration 0134 reprend tout le parc existant au rang 1, ce qui permet de
 * déployer la chaîne avant que le moteur de bascule existe, et de la vérifier sur du vrai trafic.
 *
 * ⚠️ Les fonctions sont PURES et ne supposent rien de l'ordre du tableau. Le contraire aurait été le
 * piège : la lecture SQL peut rendre les lignes dans n'importe quel ordre, et une chaîne construite par
 * un appelant n'est triée par personne.
 */

/**
 * Les canaux qu'un étage sait porter.
 *
 * ⚠️ `email` est déjà ici alors qu'aucun étage e-mail ne peut encore être créé : c'est le CHECK de la
 * table qui fait foi (`campaign_etages.canal`), et il porte les trois. Une liste plus étroite ici
 * refuserait de relire une ligne que la base accepte d'écrire, ce qui est la pire des deux fautes.
 */
export type CanalEtage = 'whatsapp' | 'rcs' | 'email';

/**
 * Le rang du PREMIER étage, celui de toute campagne d'aujourd'hui.
 *
 * 🔴 CONSTANTE PARTAGÉE, PAS UN `1` RECOPIÉ. Elle est écrite par la reprise de 0134, par le défaut de
 * `campaign_recipients.etage_courant`, et par le journal des tentatives du moteur. Le jour où le moteur
 * de bascule fera avancer un destinataire, c'est la liste des lecteurs de cette constante qu'il faudra
 * relire, et un `1` en dur n'apparaît dans aucune liste.
 */
export const RANG_INITIAL = 1;

/**
 * Le rang le plus haut qu'une chaîne puisse porter.
 *
 * ⚠️ IL EST AUSSI ÉCRIT DANS LE CHECK DE LA MIGRATION 0134 (`rang between 1 and 3`), et les deux doivent
 * rester d'accord : élargir ici sans élargir la contrainte ferait échouer l'écriture en base, pas la
 * validation en code, donc l'erreur sortirait au plus mauvais moment.
 */
export const RANG_MAX = 3;

/** Un étage : un rang, un canal, et le contenu que ce canal sait envoyer. */
export interface Etage {
  rang: number;
  canal: CanalEtage;
  /** Étage WhatsApp : le template à envoyer. */
  templateName?: string;
  /** Étage WhatsApp : la langue du template. */
  templateLanguage?: string;
  /** Étage RCS : le message, tel que validé à la création (jsonb en base). */
  rcsMessage?: unknown;
  /** Étage e-mail : le modèle (`email_templates.id`). */
  emailTemplateId?: string;
  /** Étage à SCÉNARIO : démarre ce parcours au lieu d'envoyer un contenu propre. */
  workflowId?: string;
}

/**
 * L'étage d'un rang donné, ou `null` s'il n'y en a pas.
 *
 * `null` veut dire « il n'y a rien à ce rang », ce que l'appelant lit comme « la chaîne s'arrête ici ».
 */
export function etageAuRang(chaine: Etage[], rang: number): Etage | null {
  return chaine.find((e) => e.rang === rang) ?? null;
}

/**
 * Le rang qui suit `rangCourant` dans la chaîne, ou `null` si `rangCourant` est le dernier.
 *
 * 🔴 C'EST LE PLUS PETIT RANG STRICTEMENT SUPÉRIEUR, PAS `rangCourant + 1`. Une chaîne dont un étage a
 * été retiré au milieu (rangs 1 et 3) doit continuer jusqu'à 3, pas s'arrêter sur un 2 qui n'existe
 * pas : `rangCourant + 1` rendrait un rang vide, que l'appelant traiterait comme un étage introuvable,
 * donc comme une fin de chaîne. Le repli le plus utile serait précisément celui qu'on perdrait.
 *
 * 🔴 ET CE N'EST PAS NON PLUS « L'ÉLÉMENT SUIVANT DU TABLEAU ». Cette écriture-là suppose la chaîne
 * triée, ce que rien ne garantit ; sur une chaîne arrivée dans le désordre elle peut rendre un rang
 * DÉJÀ franchi, c'est-à-dire faire tourner un destinataire en rond sur le même étage.
 *
 * ⚠️ `rangCourant` n'a pas besoin d'exister dans la chaîne : on répond « qu'y a-t-il après », pas « où
 * suis-je ». C'est ce qui rend la réponse juste même si l'étage courant vient d'être supprimé.
 */
export function rangSuivant(chaine: Etage[], rangCourant: number): number | null {
  let suivant: number | null = null;
  for (const e of chaine) {
    if (e.rang > rangCourant && (suivant === null || e.rang < suivant)) suivant = e.rang;
  }
  return suivant;
}
