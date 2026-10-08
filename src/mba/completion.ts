import type { BusinessInfo, Faq, Skill, Website, KnowledgeFile, AgentSettings } from './client';

/**
 * « Où en est la configuration de l'agent Meta », en une ligne et une liste : nos onglets ne disent pas ce qui
 * manque. Plus strict que l'écran de Meta sur deux points : une compétence `pending_review` ne compte pas (elle
 * existe sans agir), et un site à `pages_crawled: 0` non plus (« terminé » sans rien récolter).
 *
 * Ce qu'on ne sait pas se dit `inconnue` et ne se compte pas (connecteurs et outils non pilotés d'ici, lecture
 * ratée chez Meta) : hors du dénominateur et du compte d'étapes, mais leur ligne reste, avec sa raison, dans la
 * liste grise des signalements (`EnteteAgent`, prop `signalements`, obligatoires seulement).
 * Pur : aucune IO. C'est ici que se décide ce que « fait » veut dire.
 */

/** `inconnue` n'est pas un demi-état poli : c'est « nous ne pouvons pas le savoir », et ça se dit. */
export type EtatTache = 'faite' | 'a_faire' | 'inconnue';

export interface TacheMba {
  /** Clé stable, pour que l'écran lui associe son libellé et son onglet. */
  cle: 'business_info' | 'faq' | 'competences' | 'activation' | 'fichiers' | 'sites' | 'connecteurs' | 'outils';
  /** Obligatoire chez Meta pour que l'agent réponde, ou facultative. */
  requise: boolean;
  etat: EtatTache;
  /**
   * Pourquoi ce n'est pas fait, ou pourquoi on ne peut pas le dire ; absent quand c'est fait. Écrit ici et non à
   * l'écran : la raison dépend de ce qu'on a mesuré (« quatre compétences, aucune active »).
   */
  raison?: string;
}

export interface CompletionMba {
  taches: TacheMba[];
  /** Tâches obligatoires faites, sur celles dont l'état est connaissable : le « 3 sur 4 » de l'écran. */
  faites: number;
  total: number;
  /**
   * Tâches obligatoires dont l'état est hors de notre portée, jamais dans le ratio. Aucun affichage ne lit ce
   * compteur : la liste grise filtre `taches`, pour qu'une ligne porte sa raison.
   */
  indeterminees: number;
}

/**
 * Pas de tâche « tester », contrairement à l'écran de Meta : « avoir testé » n'est pas un état de la
 * configuration et ne se lit sur aucune route de Meta. L'onglet Tester se suffit.
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
 * `null` veut dire « pas lu », pas « vide » : chaque lecture chez Meta peut échouer seule, et traiter un échec
 * comme vide afficherait « FAQ à faire » sur un agent qui en a trente.
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

  // La seule tâche où « écrite » et « active » se séparent.
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
          ? { etat: 'a_faire' as const, raison: 'Aucune consigne : l’agent répond avec les réglages par défaut de Meta.' }
          : {
            etat: 'a_faire' as const,
            raison: bloquees > 0 && enRelecture === 0
              ? `${bloquees} consigne(s) refusée(s) par Meta. Elles n’agissent pas.`
              : `${enRelecture} consigne(s) en relecture chez Meta. Elles n’agissent pas encore.`,
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
   * Le moyen de paiement n'est pas une tâche : jamais lisible (toujours `inconnue`), il posait une ligne grise
   * permanente. Côté Meta : `primary_funding_id` répond code 10 (réservé aux Business Solution Providers), et
   * `/{business}/extendedcredits` code 200 (portée `business_management`, que nous ne demandons pas mais qui
   * s'obtiendrait ; le jour venu, il redevient une vraie tâche). Il ne se déduit pas de « l'agent est allumé » :
   * une audience restreinte n'exige aucun paiement, et un paiement peut exister sans agent allumé.
   */

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
      raison: 'Pas encore piloté depuis Messaging Me. Se règle dans WhatsApp Manager.',
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
