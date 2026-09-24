import type { CompletionMba, TacheMba } from '../completion';

/**
 * L'ORDRE DU JOUR DE L'ASSISTANT DU META BUSINESS AGENT.
 *
 * 🔴 IL EST DÉRIVÉ DE `completion.ts`, JAMAIS RÉÉCRIT À CÔTÉ. Une seconde liste de « ce qu'il faut régler »
 * divergerait de la première au premier ajout, et c'est l'écran qui aurait raison pendant que l'assistant
 * aurait tort. `calculerCompletion` sait déjà des choses qu'une liste écrite à la main ne saurait pas : une
 * compétence en relecture chez Meta ne compte pas, un site aspiré à zéro page non plus.
 *
 * 🔴 ET LE GRAIN EST L'ÉLÉMENT, PAS LE MODE (décision de Julien du 2026-09-14) : « soit il n'y a aucun
 * réglage du tout et forcément ça démarre à zéro, soit le user revient sur un élément déjà setuppé, et là ça
 * redémarre ». Cette fonction ne décide donc pas d'un mode : elle dit quels éléments sont encore vides.
 *
 * PUR : aucune IO, aucune horloge. C'est ce qui permet d'éprouver « une tâche inconnue n'est pas une
 * question » sans toucher à Meta.
 */

/** Un point que l'assistant peut ouvrir. */
export interface PointMba {
  cle: TacheMba['cle'];
  /** La question, en français, écrite ICI et pas par le modèle : c'est le serveur qui conduit l'entretien. */
  question: string;
  /**
   * Deux ou trois possibilités concrètes.
   *
   * ⚠️ CE SONT DES EXEMPLES, PAS UN MENU À RÉCITER : le mandat demande au modèle de les TRADUIRE dans le
   * métier du client. Réciter « vos horaires » à un garagiste qui vient de parler de révisions lui montre
   * qu'on ne l'écoute pas. Vide quand la réponse ne peut venir que du client (une adresse de site).
   */
  pistes: string[];
  /** Reprise VERBATIM de la complétude : elle dépend de ce qui a été mesuré, pas de l'état seul. */
  raison?: string;
}

/**
 * Les questions, par clé de tâche.
 *
 * ⚠️ TOUTES LES TÂCHES N'EN ONT PAS, et c'est voulu : `connecteurs` et `outils` se règlent au formulaire,
 * dans WhatsApp Manager. Une tâche sans question n'entre pas dans l'ordre du jour, elle reste visible dans
 * l'écran de complétude. (Le moyen de paiement était le troisième cas jusqu'au 2026-09-24 : il n'est plus
 * une tâche du tout, cf. `src/mba/completion.ts`.)
 */
const QUESTIONS: Partial<Record<TacheMba['cle'], { question: string; pistes: string[] }>> = {
  business_info: {
    question: 'Que fait votre entreprise, en quelques phrases ? C’est ce que l’agent dira quand on lui demandera qui vous êtes.',
    pistes: ['ce que vous vendez ou proposez', 'vos horaires et votre adresse', 'vos délais habituels'],
  },
  faq: {
    question: 'Quelles sont les questions que vos clients vous posent le plus souvent ?',
    pistes: ['vos horaires', 'vos tarifs', 'comment vous joindre'],
  },
  competences: {
    question: 'Que voulez-vous que votre agent sache FAIRE, au-delà de répondre ?',
    pistes: ['prendre un rendez-vous', 'donner l’état d’une commande', 'orienter vers la bonne personne'],
  },
  sites: {
    // 🔴 L'ASSISTANT POSE LA QUESTION, LE CLIENT FOURNIT L'ADRESSE (décision de Julien) : « c'est à l'user
    // de dire quels sites il veut rajouter, mais l'assistant doit lui poser la question à un moment ». Il
    // ne devine JAMAIS une URL, d'où l'absence de pistes.
    question: 'Avez-vous un site que votre agent peut lire pour répondre ? Donnez-moi son adresse.',
    pistes: [],
  },
  fichiers: {
    question: 'Avez-vous des documents à lui donner (tarifs, procédures, conditions) ? Vous pouvez les déposer ici, ou dans l’onglet Fichiers.',
    pistes: [],
  },
  activation: {
    // 🔴 TOUJOURS LA DERNIÈRE, cf. `ordreDuJourMba`.
    question: 'Tout est en place. On met en service ?',
    pistes: [],
  },
};

/**
 * 🔴 `activation` FERME TOUJOURS LA MARCHE, et ce n'est pas cosmétique : la décision de Julien est que la
 * mise en service soit la DERNIÈRE question du setup initial (« si on estime que toutes les questions ont
 * été posées et ont été répondues, ça doit être la dernière question »). La poser plus tôt reviendrait à
 * proposer d'allumer un agent qui n'a rien à dire.
 */
const RANG = (cle: TacheMba['cle']): number => (cle === 'activation' ? 1 : 0);

/**
 * LES POINTS ENCORE OUVERTS, dans l'ordre où l'assistant les posera.
 *
 * ⚠️ UNE TÂCHE `inconnue` N'EST JAMAIS UNE QUESTION. C'est « nous ne pouvons pas le savoir » (une lecture
 * qui a échoué chez Meta), pas « ce n'est pas fait » : en faire une question ferait demander au client de
 * régler quelque chose qui l'est peut-être déjà.
 */
export function ordreDuJourMba(completion: CompletionMba): PointMba[] {
  return completion.taches
    /**
     * 🔴 `requise` N'EST PAS LE FILTRE, ET L'Y METTRE ÉTAIT UN DÉFAUT (relevé par le test qui suit). Les
     * sites et les fichiers sont FACULTATIFS pour Meta : exiger `requise` les aurait exclus de l'ordre du
     * jour, donc l'assistant n'aurait JAMAIS posé la question des sites, alors que c'est une demande
     * explicite de Julien (« l'assistant doit lui poser la question à un moment ! »).
     *
     * ⚠️ Ce qui filtre, c'est « y a-t-il une question à poser ? » : une tâche qui se règle ailleurs que
     * chez nous (les connecteurs, les outils) n'en a pas, et n'entre donc pas.
     */
    .filter((t) => t.etat === 'a_faire' && QUESTIONS[t.cle] !== undefined)
    .sort((a, b) => RANG(a.cle) - RANG(b.cle))
    .map((t) => {
      const q = QUESTIONS[t.cle]!;
      return { cle: t.cle, question: q.question, pistes: q.pistes, ...(t.raison ? { raison: t.raison } : {}) };
    });
}

/**
 * LE POINT DU TOUR, ou `null` quand tout est couvert.
 *
 * ⚠️ `null` NE VEUT PAS DIRE « TAIS-TOI » : c'est là que l'assistant bascule de l'entretien vers l'écoute
 * (le mode évolution), et cette bascule est le sujet même de ce chantier.
 */
export function prochainPointMba(completion: CompletionMba, dejaPoses: readonly string[]): PointMba | null {
  const ouverts = ordreDuJourMba(completion);
  // On ne repose pas un point déjà posé dans ce fil, SAUF s'il reste le seul : un client qui n'a pas répondu
  // doit pouvoir se le voir redemander, sinon l'entretien s'arrête sans avoir couvert ce qu'il annonce.
  const neufs = ouverts.filter((p) => !dejaPoses.includes(p.cle));
  return neufs[0] ?? ouverts[0] ?? null;
}

/**
 * CE QUI EST DÉJÀ EN PLACE, en une phrase, pour l'ouverture du fil.
 *
 * 🔴 C'EST LE SERVEUR QUI LA RÉDIGE, PAS LE MODÈLE (décision de Julien : « il dit ce qui manque et
 * propose »). Un modèle à qui l'on demanderait de résumer un inventaire en inventerait la moitié, et c'est
 * précisément le moment où le client décide s'il peut faire confiance à l'assistant.
 */
export function accueilMba(completion: CompletionMba): string {
  const faites = completion.taches.filter((t) => t.requise && t.etat === 'faite');
  const ouverts = ordreDuJourMba(completion);
  const nom = (c: TacheMba['cle']): string => ({
    business_info: 'votre description', faq: 'vos questions fréquentes', competences: 'vos compétences',
    sites: 'vos sites', fichiers: 'vos documents', activation: 'la mise en service',
    connecteurs: 'vos connecteurs', outils: 'vos outils',
  }[c]);

  if (ouverts.length === 0) {
    return 'Tout est en place. Dites-moi ce que vous voulez changer, et je m’en occupe.';
  }
  const debut = faites.length > 0
    ? `${faites.map((t) => nom(t.cle)).join(', ')} : c’est en place. `
    : '';
  // ⚠️ On ne liste que ce qui MANQUE, pas tout : une énumération complète se lit comme un reproche.
  const manque = ouverts.map((p) => nom(p.cle)).join(', ');
  return `${debut}Il reste ${manque}.`;
}
