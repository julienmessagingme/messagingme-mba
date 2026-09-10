import type { BusinessInfo, Faq, Skill, Website, KnowledgeFile, AgentSettings } from './client';

/**
 * « Où en est la configuration de l'agent Meta », en une ligne et une liste.
 *
 * Repris de l'écran de Meta (« 4 of 5 tasks completed »), demandé par Julien le 2026-09-10, et pour une
 * raison précise : nos onglets ne disent PAS ce qui manque. Il faut les ouvrir un par un pour découvrir
 * qu'un réglage obligatoire est vide, ce qui est exactement ce qui venait de lui arriver avec les
 * compétences, restées vides pendant que l'agent répondait à tout le monde.
 *
 * 🔴 MAIS PLUS STRICT QUE CELUI DE META, SUR DEUX POINTS MESURÉS LE MÊME JOUR, et c'est tout l'intérêt
 * d'avoir le nôtre :
 *
 * 1. **Une compétence `pending_review` NE COMPTE PAS.** Meta relit les compétences avant de les activer.
 *    Entre l'écriture et l'activation, elle existe et n'agit pas. Une coche verte à ce moment-là dirait
 *    « c'est réglé » sur un agent qui répond encore sans elle.
 * 2. **Un site à `pages_crawled: 0` NE COMPTE PAS.** Sur notre propre numéro, l'écran de Meta affichait une
 *    coche verte sur `messagingme.fr` avec `crawl_status: "completed"` et ZÉRO page aspirée. Le crawl s'est
 *    « terminé » sans rien récolter. Une source de connaissance vide n'est pas une source de connaissance.
 *
 * 🔴 CE QU'ON NE SAIT PAS, ON LE DIT `inconnue`, ON NE LE COMPTE PAS. Le moyen de paiement ne se lit par
 * aucune route de l'API (Meta ne l'expose pas), et les connecteurs et outils ne sont pas encore pilotés
 * depuis Engage Me. Les compter comme faits serait une invention ; les compter comme à faire serait un
 * reproche injuste. Ils sortent du dénominateur et gardent leur ligne, avec la raison.
 *
 * PUR : aucune IO. C'est ici que se décide ce que « fait » veut dire, et ça se teste sans réseau.
 */

/** `inconnue` n'est pas un demi-état poli : c'est « nous ne pouvons pas le savoir », et ça se dit. */
export type EtatTache = 'faite' | 'a_faire' | 'inconnue';

export interface TacheMba {
  /** Clé stable, pour que l'écran lui associe son libellé et son onglet. */
  cle: 'business_info' | 'faq' | 'competences' | 'activation' | 'paiement' | 'fichiers' | 'sites' | 'connecteurs' | 'outils';
  /** Obligatoire chez Meta pour que l'agent réponde, ou facultative. */
  requise: boolean;
  etat: EtatTache;
  /**
   * Pourquoi ce n'est pas fait, ou pourquoi on ne peut pas le dire. Absent quand c'est fait.
   *
   * ⚠️ Écrit ici et non à l'écran : la raison DÉPEND de ce qu'on a mesuré (« quatre compétences, aucune
   * active » n'est pas « aucune compétence »), et un écran qui la reconstruirait à partir de l'état seul
   * la perdrait.
   */
  raison?: string;
}

export interface CompletionMba {
  taches: TacheMba[];
  /** Tâches OBLIGATOIRES faites, sur celles dont l'état est connaissable. C'est le « 3 sur 4 » de l'écran. */
  faites: number;
  total: number;
  /** Tâches obligatoires dont l'état est hors de notre portée. Affichées à part, jamais dans le ratio. */
  indeterminees: number;
}

/**
 * ⚠️ PAS DE TÂCHE « TESTER », alors que l'écran de Meta en a une. « Avoir testé » n'est pas un état de la
 * configuration : ça ne se lit sur aucune route de Meta, et notre propre historique d'essais (migration
 * 0119) répondrait à une autre question, « quelqu'un a-t-il cliqué », qui n'a pas sa place dans une liste
 * de réglages. L'onglet Tester existe et se suffit.
 */
export interface EntreeCompletion {
  settings: AgentSettings | null;
  businessInfo: BusinessInfo | null;
  faqs: Faq[] | null;
  skills: Skill[] | null;
  websites: Website[] | null;
  files: KnowledgeFile[] | null;
}

const rempli = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * ⚠️ `null` VEUT DIRE « PAS LU », PAS « VIDE », et la distinction porte tout le module. Chacune de ces
 * lectures est un aller-retour chez Meta qui peut échouer seul. Traiter un échec comme un tableau vide
 * afficherait « FAQ à faire » sur un agent qui en a trente, et enverrait le client en écrire une de plus.
 */
function etatListe(liste: unknown[] | null, vide: string): { etat: EtatTache; raison?: string } {
  if (liste === null) return { etat: 'inconnue', raison: 'Lecture impossible chez Meta pour l’instant.' };
  return liste.length > 0 ? { etat: 'faite' } : { etat: 'a_faire', raison: vide };
}

export function calculerCompletion(e: EntreeCompletion): CompletionMba {
  const taches: TacheMba[] = [];

  // --- Obligatoires ------------------------------------------------------------------------------
  taches.push({
    cle: 'business_info',
    requise: true,
    ...(e.businessInfo === null
      ? { etat: 'inconnue' as const, raison: 'Lecture impossible chez Meta pour l’instant.' }
      : rempli(e.businessInfo.business_description)
        ? { etat: 'faite' as const }
        : { etat: 'a_faire' as const, raison: 'L’agent ne sait pas décrire votre activité.' }),
  });

  taches.push({ cle: 'faq', requise: true, ...etatListe(e.faqs, 'Aucune question fréquente enregistrée.') });

  // 🔴 La seule tâche où « écrite » et « active » se séparent, et c'est celle qui a coûté le plus cher.
  if (e.skills === null) {
    taches.push({ cle: 'competences', requise: true, etat: 'inconnue', raison: 'Lecture impossible chez Meta pour l’instant.' });
  } else {
    const actives = e.skills.filter((s) => s.status === 'active').length;
    const enRelecture = e.skills.filter((s) => s.status === 'pending_review').length;
    const bloquees = e.skills.filter((s) => s.status === 'blocked').length;
    taches.push({
      cle: 'competences',
      requise: true,
      ...(actives > 0
        ? { etat: 'faite' as const }
        : e.skills.length === 0
          ? { etat: 'a_faire' as const, raison: 'Aucune compétence : l’agent répond avec les réglages par défaut de Meta.' }
          : {
            etat: 'a_faire' as const,
            raison: bloquees > 0 && enRelecture === 0
              ? `${bloquees} compétence(s) refusée(s) par Meta. Elles n’agissent pas.`
              : `${enRelecture} compétence(s) en relecture chez Meta. Elles n’agissent pas encore.`,
          }),
    });
  }

  taches.push({
    cle: 'activation',
    requise: true,
    ...(e.settings === null
      ? { etat: 'inconnue' as const, raison: 'Lecture impossible chez Meta pour l’instant.' }
      : e.settings.rollout?.enabled === true
        ? { etat: 'faite' as const }
        : { etat: 'a_faire' as const, raison: 'L’agent est éteint : personne ne répond automatiquement.' }),
  });

  /**
   * 🔴 HORS DE NOTRE PORTÉE, ET LA RAISON EST PRÉCISE, PAS « l'API ne l'expose pas ». Mesuré le 2026-09-10
   * sur le WABA réel :
   *  - `primary_funding_id` existe et répond **code 10** : « requires that the Business that owns this App
   *    is a Business Solution Provider for WhatsApp ». Ce n'est donc pas une absence, c'est une porte
   *    fermée derrière le statut BSP, qui est une décision d'entreprise et non un réglage ;
   *  - `/{business}/extendedcredits` répond **code 200**, « requires business_management permission ». Là,
   *    c'est une PORTÉE de jeton que nous ne demandons pas : celle-ci pourrait s'obtenir.
   *
   * ⚠️ Et le déduire de « l'agent est allumé » serait faux dans les deux sens : une audience restreinte
   * n'exige aucun paiement (mesuré dans la doc du 2026-09-10), et un paiement peut exister sans agent allumé.
   */
  taches.push({
    cle: 'paiement',
    requise: true,
    etat: 'inconnue',
    raison: 'Le moyen de paiement se lit derrière le statut BSP, que nous n’avons pas. À vérifier dans le Business Manager.',
  });

  // --- Facultatives ------------------------------------------------------------------------------
  taches.push({ cle: 'fichiers', requise: false, ...etatListe(e.files, 'Aucun fichier de connaissance.') });

  if (e.websites === null) {
    taches.push({ cle: 'sites', requise: false, etat: 'inconnue', raison: 'Lecture impossible chez Meta pour l’instant.' });
  } else {
    const aspires = e.websites.filter((w) => (w.pages_crawled ?? 0) > 0).length;
    taches.push({
      cle: 'sites',
      requise: false,
      ...(aspires > 0
        ? { etat: 'faite' as const }
        : e.websites.length === 0
          ? { etat: 'a_faire' as const, raison: 'Aucun site déclaré.' }
          : { etat: 'a_faire' as const, raison: `${e.websites.length} site(s) déclaré(s), mais AUCUNE page aspirée. L’agent n’en tire rien.` }),
    });
  }

  for (const cle of ['connecteurs', 'outils'] as const) {
    taches.push({
      cle,
      requise: false,
      etat: 'inconnue',
      raison: 'Pas encore piloté depuis Engage Me. Se règle dans WhatsApp Manager.',
    });
  }

  const requises = taches.filter((t) => t.requise);
  return {
    taches,
    faites: requises.filter((t) => t.etat === 'faite').length,
    total: requises.filter((t) => t.etat !== 'inconnue').length,
    indeterminees: requises.filter((t) => t.etat === 'inconnue').length,
  };
}
