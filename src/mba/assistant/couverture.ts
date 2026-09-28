import type { CompletionMba, TacheMba } from '../completion';

/**
 * L'ordre du jour de l'assistant du Meta Business Agent, dérivé de `completion.ts`, jamais réécrit à côté : une
 * seconde liste divergerait, et `calculerCompletion` sait déjà qu'une compétence en relecture ou un site à zéro
 * page ne comptent pas. Le grain est l'élément, pas le mode : cette fonction dit quels éléments sont encore
 * vides. Pur : aucune IO, aucune horloge.
 */

/** Un point que l'assistant peut ouvrir. */
export interface PointMba {
  cle: TacheMba['cle'];
  /** La question, en français, écrite ici et pas par le modèle : c'est le serveur qui conduit l'entretien. */
  question: string;
  /**
   * Deux ou trois possibilités concrètes : des exemples que le mandat demande de traduire dans le métier du
   * client, pas un menu à réciter. Vide quand la réponse ne peut venir que du client (une adresse de site).
   */
  pistes: string[];
  /** Reprise verbatim de la complétude : elle dépend de ce qui a été mesuré, pas de l'état seul. */
  raison?: string;
}

/**
 * Les questions, par clé de tâche. Toutes les tâches n'en ont pas : `connecteurs` et `outils` se règlent dans
 * WhatsApp Manager ; sans question, une tâche reste visible dans l'écran de complétude, hors de l'ordre du jour.
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
    // L'assistant pose la question, le client fournit l'adresse : jamais d'URL devinée, d'où l'absence de pistes.
    question: 'Avez-vous un site que votre agent peut lire pour répondre ? Donnez-moi son adresse.',
    pistes: [],
  },
  fichiers: {
    // L'onglet Fichiers, et lui seul : le dépôt dans la conversation a été retiré (2026-09-28), une question qui
    // invite à déposer « ici » offrirait un geste qui n'existe plus.
    question: 'Avez-vous des documents à lui donner (tarifs, procédures, conditions) ? Vous pouvez les déposer dans l’onglet Fichiers.',
    pistes: [],
  },
  activation: {
    // Toujours la dernière, cf. `ordreDuJourMba`.
    question: 'Tout est en place. On met en service ?',
    pistes: [],
  },
};

/**
 * `activation` ferme toujours la marche : la mise en service est la dernière question du setup initial, et la
 * poser plus tôt proposerait d'allumer un agent qui n'a rien à dire.
 */
const RANG = (cle: TacheMba['cle']): number => (cle === 'activation' ? 1 : 0);

/**
 * Les points encore ouverts, dans l'ordre où l'assistant les posera. Une tâche `inconnue` n'est jamais une
 * question : c'est une lecture ratée chez Meta, et le client réglerait ce qui l'est peut-être déjà.
 */
export function ordreDuJourMba(completion: CompletionMba): PointMba[] {
  return completion.taches
    /**
     * Le filtre n'est pas `requise` : sites et fichiers sont facultatifs pour Meta, et l'assistant doit quand même
     * en poser la question. Ce qui filtre, c'est l'existence d'une question.
     */
    .filter((t) => t.etat === 'a_faire' && QUESTIONS[t.cle] !== undefined)
    .sort((a, b) => RANG(a.cle) - RANG(b.cle))
    .map((t) => {
      const q = QUESTIONS[t.cle]!;
      return { cle: t.cle, question: q.question, pistes: q.pistes, ...(t.raison ? { raison: t.raison } : {}) };
    });
}

/**
 * Le point du tour, ou `null` quand tout est couvert : `null` ne veut pas dire « tais-toi », c'est la bascule de
 * l'entretien vers l'écoute.
 */
export function prochainPointMba(completion: CompletionMba, dejaPoses: readonly string[]): PointMba | null {
  const ouverts = ordreDuJourMba(completion);
  // On ne repose pas un point déjà posé dans ce fil, sauf s'il reste le seul : un client qui n'a pas répondu
  // doit pouvoir se le voir redemander.
  const neufs = ouverts.filter((p) => !dejaPoses.includes(p.cle));
  return neufs[0] ?? ouverts[0] ?? null;
}

/**
 * Ce qui est déjà en place, en une phrase, pour l'ouverture du fil. Rédigée par le serveur, pas par le modèle,
 * qui inventerait la moitié d'un inventaire au moment où le client décide s'il peut lui faire confiance.
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
  // On ne liste que ce qui manque : une énumération complète se lit comme un reproche.
  const manque = ouverts.map((p) => nom(p.cle)).join(', ');
  return `${debut}Il reste ${manque}.`;
}
