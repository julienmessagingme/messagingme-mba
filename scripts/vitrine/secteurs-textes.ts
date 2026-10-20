// scripts/vitrine/secteurs-textes.ts
// Les textes des pages de secteur (rubrique Solutions), en français et en anglais : la seule chose écrite à la main de
// ces pages, que `scripts/vitrine/cas.ts` assemble (npm run vitrine:cas). La première, Transport et mobilités, reprend la
// maquette de Julien du 2026-10-20 (`maquette-landing-mobilite`), avec le cas Keolis.
// ⚠️ Un client n'est cité (nom, chiffres, captures) qu'avec son accord écrit (spec des cas d'usage) : Keolis et SNCF le
// sont sur la maquette de Julien.

import type { Langue } from './cas-textes';

export interface TexteSecteur {
  readonly titre: string;
  readonly description: string;
  /** La ligne sous le titre dans le menu Solutions. */
  readonly menu: string;
  readonly icone: string;
  readonly surtitre: string;
  /** Le H1, en deux temps : la seconde phrase est accentuée. */
  readonly h1: readonly [string, string];
  readonly chapeau: string;
  readonly sous: string;
  readonly appel: string;
  /** Les clients cités, en logos (leur accord écrit est requis, voir plus haut). */
  readonly references: { readonly titre: string; readonly logos: ReadonlyArray<{ readonly src: string; readonly alt: string; readonly largeur: number; readonly hauteur: number }> };
  readonly captures: ReadonlyArray<{ readonly src: string; readonly alt: string }>;
  readonly enjeux: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly liste: ReadonlyArray<{ readonly num: string; readonly titre: readonly [string, string]; readonly texte: string }>;
    readonly encart: { readonly titre: readonly [string, string]; readonly texte: string };
  };
  readonly terrain: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly film: { readonly nom: string; readonly aria: string; readonly duree: string; readonly publie: string; readonly note?: string };
    readonly chiffres: ReadonlyArray<{ readonly valeur: string; readonly texte: string }>;
    readonly source: string;
  };
  readonly usages: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly liste: ReadonlyArray<{ readonly titre: string; readonly texte: string; readonly mots: string }>;
    readonly parcours: string;
  };
  readonly partenaire: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly liste: ReadonlyArray<{ readonly titre: string; readonly texte: string }>;
    readonly pilotage: string;
  };
  /** L'appel final : il mène au formulaire de la page Contact. */
  readonly projet: { readonly titre: string; readonly texte: string; readonly bouton: string };
}

export const TEXTES_SECTEURS: Readonly<Record<string, Record<Langue, TexteSecteur>>> = {
  'transport-mobilites': {
    fr: {
      titre: 'WhatsApp pour le transport et la mobilité · Messaging Me',
      description: 'Chaînes WhatsApp, assistance avec IA, horaires et itinéraires : informez vos voyageurs et accompagnez chaque trajet. Le cas Keolis.',
      menu: 'L’information voyageurs sur WhatsApp',
      icone: 'i-signal',
      surtitre: 'Mobilité · WhatsApp et IA conversationnelle',
      h1: ['Informez vos voyageurs.', 'Accompagnez chaque trajet.'],
      chapeau: 'Des chaînes WhatsApp à l’assistance avec IA, connectez vos voyageurs aux informations et aux réponses dont ils ont besoin.',
      sous: 'Conseil stratégique, technologie et accompagnement&nbsp;: une expérience adaptée à votre réseau, connectée à vos outils.',
      appel: 'Parlons de votre projet mobilité',
      references: { titre: 'Nos références mobilité', logos: [{ src: '/img/logo-keolis.svg', alt: 'Keolis', largeur: 116, hauteur: 18 }, { src: '/img/logo-sncf.svg', alt: 'SNCF', largeur: 57, hauteur: 30 }] },
      captures: [
        { src: '/img/transport-ligne-deviee.webp?v=2', alt: 'La chaîne WhatsApp d’un réseau de bus annonce une ligne déviée' },
        { src: '/img/transport-auxrm-bot.webp?v=2', alt: 'Un voyageur demande les tarifs au compte WhatsApp du réseau, qui lui répond' },
      ],
      enjeux: {
        surtitre: 'Vos enjeux aujourd’hui',
        titre: ['Vos voyageurs sont dispersés.', 'Votre information doit les retrouver.'],
        liste: [
          { num: '01 / Visibilité', titre: ['Sur X, une audience plus', 'difficile à toucher.'], texte: 'Une visibilité plus incertaine et un travail de modération qui mobilise vos équipes.' },
          { num: '02 / Adoption', titre: ['Une application à télécharger.', 'Puis à faire vivre.'], texte: 'Développement, maintenance, mises à jour&nbsp;: un investissement continu avant de devenir un réflexe.' },
          { num: '03 / Dispersion', titre: ['Des canaux multiples.', 'Une audience fragmentée.'], texte: 'Vous multipliez les publications. Vos voyageurs cherchent encore où trouver la bonne information.' },
        ],
        encart: { titre: ['Le conversationnel.', 'Un réflexe universel.'], texte: 'Rejoignez vos voyageurs dans une messagerie qu’ils utilisent déjà. Une chaîne pour informer, une conversation pour répondre. Sans nouvelle application à faire télécharger.' },
      },
      terrain: {
        surtitre: 'Le conversationnel sur le terrain',
        titre: ['Avec Keolis, l’information voyageurs', 'prend le chemin de WhatsApp.'],
        film: { nom: 'cas-transport', aria: 'Film : le cas Keolis, l’information voyageurs sur WhatsApp avec Messaging Me', duree: 'PT38S', publie: '2026-10-20T19:00:00+02:00' },
        chiffres: [
          { valeur: 'Plus de 3&nbsp;500 abonnés', texte: 'sur les réseaux pilotes, en organique, en 3&nbsp;mois' },
          { valeur: 'Moins de 48&nbsp;h', texte: 'pour certifier deux réseaux' },
          { valeur: '+100 FAQ · +20 lignes', texte: 'intégrées au bot hybride. Pilotes présentés&nbsp;: Auxerre et Dole' },
        ],
        source: 'Objectif annoncé pour le service client&nbsp;: 30&nbsp;% de flux en moins. Source&nbsp;: présentation du cas Keolis, Messaging Me.',
      },
      usages: {
        surtitre: 'Les usages de votre réseau',
        titre: ['Une information collective.', 'Une réponse à chaque voyageur.'],
        liste: [
          { titre: 'Informer', texte: 'Trafic, perturbations, travaux et nouveautés&nbsp;: une chaîne WhatsApp pour diffuser les informations utiles.', mots: 'Publications locales · Annonces planifiées · Accès à la conversation' },
          { titre: 'Répondre', texte: 'Une IA qui s’appuie sur vos contenus pour traiter les demandes récurrentes et orienter les autres vers vos équipes.', mots: 'FAQ · Tarifs · Accessibilité · Relais humain' },
          { titre: 'Accompagner', texte: 'Le voyageur accède aux horaires, arrêts et itinéraires issus de vos sources connectées.', mots: 'Horaires · Itinéraires · Informations de votre réseau' },
        ],
        parcours: 'Chaîne WhatsApp → Conversation individuelle → IA ou relais humain',
      },
      partenaire: {
        surtitre: 'Votre partenaire conversationnel',
        titre: ['Votre réseau, vos outils.', 'Notre expertise pour les relier.'],
        liste: [
          { titre: 'Conseil stratégique et conception', texte: 'Prioriser les usages, dessiner les parcours et définir la place des chaînes, de l’IA et de vos équipes.' },
          { titre: 'Technologie et intégrations', texte: 'Déployer WhatsApp et connecter vos contenus, vos sources d’information voyageurs et votre CRM.' },
          { titre: 'Accompagnement et données conversationnelles', texte: 'Analyser les demandes, repérer les incompréhensions et faire évoluer les scénarios avec vos équipes.' },
        ],
        pilotage: 'Ce que nous pilotons ensemble&nbsp;: satisfaction voyageurs, résolution des demandes, motifs de contact et coûts de traitement.',
      },
      projet: {
        titre: 'Quel parcours voyageur voulez-vous simplifier&nbsp;?',
        texte: 'Lancer une chaîne WhatsApp, faire évoluer votre service client ou faciliter l’accès aux horaires et itinéraires&nbsp;: échangeons sur votre réseau et les usages à prioriser.',
        bouton: 'Parlons de votre projet mobilité',
      },
    },
    en: {
      titre: 'WhatsApp for transport and mobility · Messaging Me',
      description: 'WhatsApp Channels, AI assistance, timetables and routes: inform your passengers and support every journey. The Keolis case.',
      menu: 'Passenger information on WhatsApp',
      icone: 'i-signal',
      surtitre: 'Mobility · WhatsApp and conversational AI',
      h1: ['Inform your passengers.', 'Support every journey.'],
      chapeau: 'From WhatsApp Channels to AI assistance, connect your passengers to the information and answers they need.',
      sous: 'Strategy, technology and support: an experience built for your network, connected to your tools.',
      appel: 'Let’s talk about your mobility project',
      references: { titre: 'Our mobility references', logos: [{ src: '/img/logo-keolis.svg', alt: 'Keolis', largeur: 116, hauteur: 18 }, { src: '/img/logo-sncf.svg', alt: 'SNCF', largeur: 57, hauteur: 30 }] },
      captures: [
        { src: '/img/transport-ligne-deviee.webp?v=2', alt: 'A bus network’s WhatsApp Channel announces a diverted line' },
        { src: '/img/transport-auxrm-bot.webp?v=2', alt: 'A passenger asks the network’s WhatsApp account about fares, and gets an answer' },
      ],
      enjeux: {
        surtitre: 'Your challenges today',
        titre: ['Your passengers are scattered.', 'Your information has to find them.'],
        liste: [
          { num: '01 / Visibility', titre: ['On X, an audience', 'harder to reach.'], texte: 'More uncertain visibility, and moderation work that ties up your teams.' },
          { num: '02 / Adoption', titre: ['An app to download.', 'Then to keep alive.'], texte: 'Development, maintenance, updates: a continuous investment before it becomes a habit.' },
          { num: '03 / Scattering', titre: ['Many channels.', 'A fragmented audience.'], texte: 'You publish more and more. Your passengers are still looking for where to find the right information.' },
        ],
        encart: { titre: ['Conversational.', 'A universal habit.'], texte: 'Reach your passengers in a messaging app they already use. A channel to inform, a conversation to answer. No new app to download.' },
      },
      terrain: {
        surtitre: 'Conversational in the field',
        titre: ['With Keolis, passenger information', 'takes the WhatsApp route.'],
        film: { nom: 'cas-transport', aria: 'Film: the Keolis case, passenger information on WhatsApp with Messaging Me', duree: 'PT38S', publie: '2026-10-20T19:00:00+02:00' },
        chiffres: [
          { valeur: 'Over 3,500 followers', texte: 'on the pilot networks, organically, in 3 months' },
          { valeur: 'Under 48 h', texte: 'to verify two networks' },
          { valeur: '100+ FAQs · 20+ lines', texte: 'built into the hybrid bot. Pilots shown: Auxerre and Dole' },
        ],
        source: 'Stated goal for customer service: 30% less traffic. Source: Keolis case presentation, Messaging Me.',
      },
      usages: {
        surtitre: 'Your network’s use cases',
        titre: ['Collective information.', 'An answer for every passenger.'],
        liste: [
          { titre: 'Inform', texte: 'Traffic, disruptions, works and news: a WhatsApp Channel to share what matters.', mots: 'Local posts · Scheduled announcements · Access to the conversation' },
          { titre: 'Answer', texte: 'An AI that relies on your content to handle recurring requests and route the others to your teams.', mots: 'FAQ · Fares · Accessibility · Human handover' },
          { titre: 'Support', texte: 'Passengers reach the timetables, stops and routes from your connected sources.', mots: 'Timetables · Routes · Your network’s information' },
        ],
        parcours: 'WhatsApp Channel → One-to-one conversation → AI or human handover',
      },
      partenaire: {
        surtitre: 'Your conversational partner',
        titre: ['Your network, your tools.', 'Our expertise to connect them.'],
        liste: [
          { titre: 'Strategy and design', texte: 'Prioritize use cases, design the journeys and set the role of channels, AI and your teams.' },
          { titre: 'Technology and integrations', texte: 'Deploy WhatsApp and connect your content, your passenger information sources and your CRM.' },
          { titre: 'Support and conversational data', texte: 'Analyze requests, spot misunderstandings and evolve the scenarios with your teams.' },
        ],
        pilotage: 'What we steer together: passenger satisfaction, request resolution, contact reasons and handling costs.',
      },
      projet: {
        titre: 'Which passenger journey do you want to simplify?',
        texte: 'Launch a WhatsApp Channel, evolve your customer service or open access to timetables and routes: let’s talk about your network and the use cases to prioritize.',
        bouton: 'Let’s talk about your mobility project',
      },
    },
  },
};

/**
 * Les pages d'attente des secteurs en ligne au registre avec `attente` (Julien, 2026-10-20) : le menu les montre, la page
 * dit qu'elle arrive et mène au formulaire de contact. En noindex, hors du plan du site et de llms.txt.
 */
export interface TexteAttente {
  readonly titre: string; readonly description: string; readonly menu: string; readonly icone: string;
  readonly h1: string; readonly chapeau: string; readonly appel: string; readonly voir: string;
}

export const TEXTES_ATTENTE: Readonly<Record<string, Record<Langue, TexteAttente>>> = {
  assurance: {
    fr: {
      titre: 'WhatsApp pour l’assurance · Messaging Me',
      description: 'WhatsApp pour l’assurance : nos cas d’usage arrivent bientôt sur cette page. En attendant, parlons de votre projet avec nos équipes.',
      menu: 'Bientôt en ligne', icone: 'i-file-text', h1: 'Page en préparation.',
      chapeau: 'Nos cas d’usage WhatsApp pour l’assurance arrivent ici. En attendant, parlons du vôtre&nbsp;: une démo sur votre cas, avec vos assurés et vos canaux.',
      appel: 'Parlons de votre projet', voir: 'Voir le cas Transport',
    },
    en: {
      titre: 'WhatsApp for insurance · Messaging Me',
      description: 'WhatsApp for insurance: our use cases are coming to this page soon. Meanwhile, let’s talk about your project with our team.',
      menu: 'Coming soon', icone: 'i-file-text', h1: 'Coming soon.',
      chapeau: 'Our WhatsApp use cases for insurance are coming here. Meanwhile, let’s talk about yours: a demo on your case, with your policyholders and your channels.',
      appel: 'Let’s talk about your project', voir: 'See the Transport case',
    },
  },
  tourisme: {
    fr: {
      titre: 'WhatsApp pour le voyage et le tourisme · Messaging Me',
      description: 'WhatsApp pour le voyage et le tourisme : nos cas d’usage arrivent bientôt sur cette page. En attendant, parlons de votre projet.',
      menu: 'Bientôt en ligne', icone: 'i-key', h1: 'Page en préparation.',
      chapeau: 'Nos cas d’usage WhatsApp pour le voyage et le tourisme arrivent ici. En attendant, parlons du vôtre&nbsp;: une démo sur votre cas, avec vos voyageurs et vos canaux.',
      appel: 'Parlons de votre projet', voir: 'Voir le cas Transport',
    },
    en: {
      titre: 'WhatsApp for travel and tourism · Messaging Me',
      description: 'WhatsApp for travel and tourism: our use cases are coming to this page soon. Meanwhile, let’s talk about your project with our team.',
      menu: 'Coming soon', icone: 'i-key', h1: 'Coming soon.',
      chapeau: 'Our WhatsApp use cases for travel and tourism are coming here. Meanwhile, let’s talk about yours: a demo on your case, with your travellers and your channels.',
      appel: 'Let’s talk about your project', voir: 'See the Transport case',
    },
  },
};
