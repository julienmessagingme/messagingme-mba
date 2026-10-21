// web/lib/registre-vitrine.ts

/**
 * LE REGISTRE DES PAGES DE CAS ET DE SOLUTIONS DE LA VITRINE (lots 6 et 6 bis, specs
 * `docs/superpowers/specs/2026-10-15-cas-d-usage-design.md` pour les adresses, `2026-10-16-cas-d-usage-par-profil-design.md`
 * pour le registre).
 *
 * 🔴 DÉCLARÉ ICI, UNE SEULE FOIS : les carrefours, le menu, le README du plugin, la liste de ses commandes, le plan du
 * site, `llms.txt` et les tests en dérivent. `tests/registre-vitrine.test.ts` le tient dans les deux sens : une entrée
 * en ligne a ses deux pages, une entrée hors ligne n'a ni page ni lien entrant, et une page de `site/cas-d-usage/`,
 * `site/solutions/` ou de leurs jumelles anglaises sans entrée rend le test rouge.
 *
 * ⚠️ `enLigne` passe à `true` dans le commit qui pose les deux pages, jamais avant.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par le build de la console, par les générateurs de `scripts/` et par la suite racine
 * (la même contrainte que `doc-api-pages.ts`).
 */

/** Les quatre profils de la spec 6 bis : les filtres de « Tous les cas d'usage », jamais des pages. */
export const PROFILS = ['saas', 'lovable', 'agence', 'produit'] as const;
export type Profil = (typeof PROFILS)[number];

export type NatureEntree = 'cas' | 'secteur' | 'metier';

/** Une adresse de la vitrine (chemin avec barre finale) et le libellé qui la nomme dans le menu et les carrefours. */
export interface PageVitrine {
  readonly adresse: string;
  readonly titre: string;
}

export interface EntreeVitrine {
  readonly cle: string;
  readonly nature: NatureEntree;
  readonly fr: PageVitrine;
  readonly en: PageVitrine;
  /** Vide pour une page Solutions : les profils ne filtrent que les cas. */
  readonly profils: readonly Profil[];
  readonly vague: 1 | 2;
  /** La recherche que la page vise ; une recherche à laquelle une page répond déjà enrichit cette page. */
  readonly recherche: string;
  /** La commande du plugin qui branche le cas (`demarrer` quand la mise en service le porte). */
  readonly commande?: string;
  /** `code` : le cas s'écrit dans l'application du client ; `console` : il se règle sans code. */
  readonly chemin: 'code' | 'console';
  /** Le slug anglais du guide de la doc (`/developers/api/guides/<guide>`). */
  readonly guide?: string;
  /** Le nom de base du film dans `site/films/`. */
  readonly film?: string;
  readonly enLigne: boolean;
  /** Un secteur en ligne dont la page est en préparation : une page d'attente, en noindex (2026-10-20). */
  readonly attente?: boolean;
}

export const ENTREES: readonly EntreeVitrine[] = [
  {
    cle: 'rendez-vous', nature: 'cas',
    fr: { adresse: '/cas-d-usage/prise-de-rendez-vous/', titre: 'Prise de rendez-vous' },
    en: { adresse: '/en/use-cases/appointment-booking/', titre: 'Appointment booking' },
    profils: ['saas', 'lovable', 'agence', 'produit'], vague: 1, recherche: 'prise de rendez-vous whatsapp',
    commande: 'demarrer', chemin: 'code', guide: 'appointment-booking', film: 'cas-rendez-vous', enLigne: true,
  },
  {
    cle: 'rappels', nature: 'cas',
    fr: { adresse: '/cas-d-usage/rappels-rendez-vous/', titre: 'Rappels de rendez-vous' },
    en: { adresse: '/en/use-cases/appointment-reminders/', titre: 'Appointment reminders' },
    profils: ['lovable', 'produit'], vague: 1, recherche: 'rappel rendez-vous whatsapp absences',
    commande: 'rappels', chemin: 'code', guide: 'appointment-reminders', film: 'cas-rappels', enLigne: true,
  },
  {
    cle: 'support', nature: 'cas',
    fr: { adresse: '/cas-d-usage/support-ia-relais-humain/', titre: 'Support IA et relais à l’équipe' },
    en: { adresse: '/en/use-cases/ai-support-human-handover/', titre: 'AI support and human handover' },
    profils: ['saas', 'lovable', 'agence', 'produit'], vague: 1, recherche: 'agent ia support client whatsapp',
    commande: 'demarrer', chemin: 'console', enLigne: false,
  },
  {
    cle: 'bulle-lovable', nature: 'cas',
    fr: { adresse: '/cas-d-usage/bulle-whatsapp-site-lovable/', titre: 'Bulle WhatsApp sur un site Lovable' },
    en: { adresse: '/en/use-cases/whatsapp-bubble-lovable-site/', titre: 'WhatsApp bubble on a Lovable site' },
    profils: ['lovable'], vague: 1, recherche: 'bulle whatsapp site lovable', chemin: 'console', film: 'cas-bulle', enLigne: true,
  },
  {
    cle: 'accueil', nature: 'cas',
    fr: { adresse: '/cas-d-usage/accueil-activation-saas/', titre: 'Accueil des utilisateurs d’un SaaS' },
    en: { adresse: '/en/use-cases/saas-onboarding-activation/', titre: 'SaaS onboarding and activation' },
    profils: ['saas', 'produit'], vague: 1, recherche: 'onboarding saas whatsapp',
    commande: 'accueil', chemin: 'code', guide: 'saas-onboarding-activation', film: 'cas-saas', enLigne: true,
  },
  {
    cle: 'relance-paiement', nature: 'cas',
    fr: { adresse: '/cas-d-usage/relance-paiement-echoue/', titre: 'Relance d’un paiement échoué' },
    en: { adresse: '/en/use-cases/failed-payment-recovery/', titre: 'Failed payment recovery' },
    profils: ['saas', 'produit'], vague: 1, recherche: 'relance paiement échoué whatsapp',
    commande: 'relance-paiement', chemin: 'code', guide: 'failed-payment-recovery', film: 'cas-saas', enLigne: true,
  },
  {
    cle: 'notifications', nature: 'cas',
    fr: { adresse: '/cas-d-usage/notifications-de-commande/', titre: 'Notifications de commande' },
    en: { adresse: '/en/use-cases/order-notifications/', titre: 'Order notifications' },
    profils: ['produit'], vague: 2, recherche: 'notification de commande whatsapp api',
    chemin: 'code', guide: 'order-notifications', film: 'cas-notifications', enLigne: true,
  },
  {
    // La maquette de Julien du 2026-10-20, avec le cas Keolis : le premier secteur en ligne.
    cle: 'transport-mobilites', nature: 'secteur',
    fr: { adresse: '/solutions/transport-et-mobilites/', titre: 'Transport et mobilités' },
    en: { adresse: '/en/solutions/transport-and-mobility/', titre: 'Transport and mobility' },
    profils: [], vague: 1, recherche: 'whatsapp information voyageurs transport', chemin: 'console', enLigne: true,
  },
  {
    // Les trois maquettes de Julien du 2026-10-21, avec les cas NEOMA, EDH et EDHEC : avant les pages d'attente au menu.
    cle: 'enseignement-superieur', nature: 'secteur',
    fr: { adresse: '/solutions/enseignement-superieur/', titre: 'Enseignement supérieur' },
    en: { adresse: '/en/solutions/higher-education/', titre: 'Higher education' },
    profils: [], vague: 1, recherche: 'whatsapp enseignement supérieur', chemin: 'console', enLigne: true,
  },
  {
    cle: 'assurance', nature: 'secteur',
    fr: { adresse: '/solutions/assurance/', titre: 'Assurance' },
    en: { adresse: '/en/solutions/insurance/', titre: 'Insurance' },
    profils: [], vague: 1, recherche: 'whatsapp assurance', chemin: 'console', enLigne: true, attente: true,
  },
  {
    cle: 'tourisme', nature: 'secteur',
    fr: { adresse: '/solutions/voyage-et-tourisme/', titre: 'Voyage et tourisme' },
    en: { adresse: '/en/solutions/travel-and-tourism/', titre: 'Travel and tourism' },
    profils: [], vague: 1, recherche: 'whatsapp voyage tourisme', chemin: 'console', enLigne: true, attente: true,
  },
  {
    cle: 'saas-app-builders', nature: 'metier',
    fr: { adresse: '/solutions/saas-et-app-builders/', titre: 'SaaS et app builders' },
    en: { adresse: '/en/solutions/saas-and-app-builders/', titre: 'SaaS and app builders' },
    profils: [], vague: 1, recherche: 'whatsapp api saas app builder', chemin: 'console', enLigne: true,
  },
  {
    cle: 'agences', nature: 'metier',
    fr: { adresse: '/solutions/agences/', titre: 'Agences' },
    en: { adresse: '/en/solutions/agencies/', titre: 'Agencies' },
    profils: [], vague: 1, recherche: 'agence whatsapp clients', commande: 'agence', chemin: 'console', enLigne: false,
  },
];

export const entreesEnLigne = (): EntreeVitrine[] => ENTREES.filter((e) => e.enLigne);
