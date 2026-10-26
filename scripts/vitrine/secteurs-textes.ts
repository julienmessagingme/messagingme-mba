// scripts/vitrine/secteurs-textes.ts
// Les textes des pages de secteur (rubrique Solutions), en français et en anglais : la seule chose écrite à la main de
// ces pages, que `scripts/vitrine/cas.ts` assemble (npm run vitrine:cas). La première, Transport et mobilités, reprend la
// maquette de Julien du 2026-10-20 (`maquette-landing-mobilite`), avec le cas Keolis. La deuxième, Enseignement
// supérieur, reprend ses trois maquettes du 2026-10-21 (`landing-education-*`), avec les cas NEOMA, EDH et EDHEC, et la
// troisième, Assurance, les trois du même jour (`landing-assurance-*`), avec les cas Gan Prévoyance, Groupama et Mieux Assuré,
// et la quatrième, Voyage et tourisme, les trois du 2026-10-22 (`landing-tourisme-*`), avec le cas Odalys.
// ⚠️ Un client n'est cité (nom, chiffres, captures) qu'avec son accord écrit (spec des cas d'usage) : Keolis et SNCF le
// sont sur la maquette de Julien, NEOMA, EDH, EDHEC, Gan Prévoyance, Groupama, Mieux Assuré, Odalys et Thalazur sur les siennes.

import type { Langue } from './cas-textes';

/** Le logo d'un client, sur fond blanc ; sa hauteur affichée vit dans `site.css` (`.sec-logo img[src$=...]`). */
export interface LogoClient { readonly src: string; readonly alt: string; readonly largeur: number; readonly hauteur: number }

/** Un autre cas du secteur, en carte sous le film (pages Enseignement supérieur et Assurance). */
export interface AutreCas {
  readonly logo: LogoClient;
  readonly titre: string;
  readonly texte: string;
  readonly chiffres?: ReadonlyArray<{ readonly valeur: string; readonly texte: string }>;
  /** Ce que le cas cherche à obtenir, quand il n'a pas de chiffre publié. */
  readonly resultat?: string;
  /** Des objectifs annoncés, et non des résultats : ils portent leur titre (« Objectifs de campagne »). */
  readonly objectifs?: { readonly titre: string; readonly liste: ReadonlyArray<{ readonly valeur: string; readonly texte: string }> };
  readonly visuel?: { readonly src: string; readonly alt: string; readonly largeur: number; readonly hauteur: number };
}

/** Un usage du secteur ; l'échange est un exemple de conversation, l'entreprise à gauche, son contact à droite. */
export interface UsageSecteur {
  readonly titre: string;
  readonly accroche?: string;
  readonly texte: string;
  readonly mots?: string;
  readonly echange?: ReadonlyArray<{ readonly qui: string; readonly texte: string; readonly contact?: boolean }>;
}

// Les logos des écoles, tirés des maquettes de Julien (dimensions = la hauteur affichée de `site.css`).
const LOGO_NEOMA: LogoClient = { src: '/img/logo-neoma.webp', alt: 'NEOMA Business School', largeur: 94, hauteur: 26 };
const LOGO_EDH: LogoClient = { src: '/img/logo-edh.webp', alt: 'Groupe EDH', largeur: 48, hauteur: 24 };
const LOGO_EDHEC: LogoClient = { src: '/img/logo-edhec.webp', alt: 'EDHEC Business School', largeur: 110, hauteur: 24 };
// Ceux des assureurs, et le prix French Assurtech, tirés des maquettes Assurance
const LOGO_GAN: LogoClient = { src: '/img/logo-gan.webp', alt: 'Gan Prévoyance', largeur: 27, hauteur: 30 };
const LOGO_GROUPAMA: LogoClient = { src: '/img/logo-groupama.webp', alt: 'Groupama Protection Juridique', largeur: 102, hauteur: 28 };
const LOGO_MIEUX_ASSURE: LogoClient = { src: '/img/logo-mieux-assure.webp', alt: 'Mieux Assuré', largeur: 30, hauteur: 30 };
const FRENCH_ASSURTECH = { src: '/img/laureat-french-assurtech-2026.webp', largeur: 84, hauteur: 44 };
// Ceux du tourisme, tirés des maquettes Voyage et tourisme (Thalazur n'y figure qu'en référence, sans cas)
const LOGO_ODALYS: LogoClient = { src: '/img/logo-odalys.webp', alt: 'Odalys Vacances', largeur: 78, hauteur: 30 };
const LOGO_THALAZUR: LogoClient = { src: '/img/logo-thalazur.webp', alt: 'Thalazur', largeur: 111, hauteur: 26 };

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
  readonly references: { readonly titre: string; readonly logos: ReadonlyArray<LogoClient> };
  /** Un prix reçu par Messaging Me, montré dans la une et rappelé avec l'accompagnement (page Assurance) ; `alt` vide quand
   * `texte` dit déjà ce que montre l'image (sinon un lecteur d'écran l'entend deux fois). */
  readonly distinction?: { readonly src: string; readonly alt: string; readonly largeur: number; readonly hauteur: number; readonly texte: string };
  /** Les questions fréquentes du secteur, tirées des cas publiés sur la page, balisées FAQPage (plan SEO, C2). */
  readonly faq?: ReadonlyArray<{ readonly question: string; readonly reponse: string }>;
  readonly captures: ReadonlyArray<{ readonly src: string; readonly alt: string }>;
  readonly enjeux: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly liste: ReadonlyArray<{ readonly num: string; readonly titre: readonly [string, string]; readonly texte: string }>;
    readonly encart: { readonly titre: readonly [string, string]; readonly texte: string };
  };
  readonly terrain: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly film: { readonly nom: string; readonly aria: string; readonly duree: string; readonly publie: string; readonly note?: string };
    /** Le cas du film, au-dessus de ses chiffres : son logo, ce qu'il visait, ce qui a été fait. */
    readonly cas?: { readonly logo: LogoClient; readonly titre: string; readonly texte: string };
    readonly chiffres: ReadonlyArray<{ readonly valeur: string; readonly texte: string }>;
    readonly autres?: ReadonlyArray<AutreCas>;
    readonly source: string;
  };
  readonly usages: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly liste: ReadonlyArray<UsageSecteur>;
    readonly parcours?: string;
    /** Sous les cartes : un appel vers le formulaire de contact, puis une mention. */
    readonly appel?: string;
    readonly note?: string;
    readonly encart?: { readonly titre: readonly [string, string]; readonly texte: string };
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
      faq: [
        { question: 'Comment informer les voyageurs avec une chaîne WhatsApp ?', reponse: 'En publiant l’information du réseau sur une chaîne WhatsApp, que les voyageurs suivent sans nouvelle application à télécharger. Avec Keolis, les réseaux pilotes ont réuni plus de 3&nbsp;500 abonnés en organique, en 3&nbsp;mois.' },
        { question: 'Peut-on répondre aux voyageurs avec une IA ?', reponse: 'Oui : un bot hybride répond aux questions, et l’équipe reprend la main quand il faut. Chez Keolis, il intègre plus de 100 questions fréquentes et plus de 20 lignes.' },
        { question: 'Combien de temps faut-il pour lancer un réseau ?', reponse: 'Avec Keolis, moins de 48&nbsp;heures ont suffi pour certifier deux réseaux.' },
      ],
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
      faq: [
        { question: 'How do I inform travellers with a WhatsApp Channel?', reponse: 'By posting the network’s information on a WhatsApp Channel, which travellers follow with no new app to download. With Keolis, the pilot networks gathered more than 3,500 followers organically, in 3 months.' },
        { question: 'Can an AI answer travellers?', reponse: 'Yes: a hybrid bot answers questions, and the team takes over when needed. At Keolis, it includes more than 100 FAQs and more than 20 lines.' },
        { question: 'How long does it take to launch a network?', reponse: 'With Keolis, under 48 hours were enough to verify two networks.' },
      ],
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
  'enseignement-superieur': {
    fr: {
      faq: [
        { question: 'Comment une école recrute-t-elle sur WhatsApp ?', reponse: 'Par des campagnes WhatsApp aux moments décisifs, des réponses avec IA et le suivi de chaque candidat. NEOMA mène des campagnes entre l’admissibilité et les oraux, et 100&nbsp;% de ses messages entrants sont répartis instantanément.' },
        { question: 'Peut-on recruter des candidats internationaux sur WhatsApp ?', reponse: 'Oui : le Groupe EDH promeut ses écoles et formations dans 11&nbsp;pays avec des campagnes Click-to-WhatsApp et des messages marketing, et plus de 30&nbsp;000 conversations ont été engagées avec les candidats.' },
        { question: 'Plusieurs écoles peuvent-elles partager la même plateforme ?', reponse: 'Oui : le Groupe EDH gère 11 comptes dans une seule plateforme.' },
      ],
      titre: 'WhatsApp pour l’enseignement supérieur · Messaging Me',
      description: 'Campagnes WhatsApp, réponses avec IA et suivi des candidats : accélérez vos recrutements, de l’intérêt à la candidature. Les cas NEOMA, EDH et EDHEC.',
      menu: 'Le recrutement des candidats sur WhatsApp',
      icone: 'i-buildings',
      surtitre: 'Écoles et enseignement supérieur',
      h1: ['Accélérez vos recrutements.', 'Engagez la conversation.'],
      chapeau: 'Du premier intérêt à la candidature, créez un lien direct avec vos futurs étudiants sur WhatsApp.',
      sous: 'Conseil stratégique, plateforme technologique et accompagnement&nbsp;: nous connectons vos campagnes à vos équipes admissions pour faire avancer le choix des candidats.',
      appel: 'Parlons de vos recrutements',
      references: { titre: 'Nos références éducation', logos: [LOGO_NEOMA, LOGO_EDH, LOGO_EDHEC] },
      captures: [
        { src: '/img/education-neoma-oraux.webp', alt: 'NEOMA invite ses admissibles à un webinar sur WhatsApp, puis oriente une question vers le service Admissions' },
        { src: '/img/education-edh-international.webp', alt: 'Venu d’une publicité Instagram, un candidat étranger échange avec EDH sur WhatsApp à propos des formations' },
      ],
      enjeux: {
        surtitre: 'Vos enjeux de recrutement',
        titre: ['Entre l’intérêt et l’inscription,', 'ne laissez pas le lien se perdre.'],
        liste: [
          { num: '01 / Joignabilité', titre: ['Un contact collecté.', 'Un échange à engager.'], texte: 'Après un salon ou une campagne, encore faut-il obtenir une réponse pour faire avancer le projet du candidat.' },
          { num: '02 / Préférence', titre: ['Plusieurs écoles.', 'Un choix à accompagner.'], texte: 'Formations, débouchés, vie étudiante&nbsp;: des réponses précises aident le candidat à se projeter dans votre établissement.' },
          { num: '03 / Suivi', titre: ['Des demandes multiples.', 'Des équipes sollicitées.'], texte: 'Questions récurrentes, services différents et campagnes internationales mobilisent vos équipes à chaque étape.' },
        ],
        encart: { titre: ['WhatsApp.', 'Une conversation pour faire avancer leur choix.'], texte: 'Prolongez vos campagnes dans un échange direct. Le candidat pose ses questions, reçoit les informations adaptées à son projet et rejoint le bon interlocuteur.' },
      },
      terrain: {
        surtitre: 'Notre expérience dans l’éducation',
        titre: ['Des écoles qui font déjà du conversationnel', 'un levier de recrutement.'],
        film: { nom: 'cas-education', aria: 'Film : le cas NEOMA Business School, le recrutement des candidats sur WhatsApp avec Messaging Me', duree: 'PT38S', publie: '2026-10-21T18:00:00+02:00' },
        cas: { logo: LOGO_NEOMA, titre: 'Renforcer la préférence aux moments décisifs.', texte: 'Des campagnes WhatsApp entre l’admissibilité et les oraux, avec une orientation des demandes vers les services compétents.' },
        chiffres: [
          { valeur: 'Plus de 200 participants', texte: 'au webinar promu' },
          { valeur: '100&nbsp;%', texte: 'des messages entrants répartis instantanément' },
        ],
        autres: [
          {
            logo: LOGO_EDH, titre: 'Recruter à l’international. Centraliser le suivi.',
            texte: 'Des campagnes Click-to-WhatsApp et des messages marketing pour promouvoir les écoles et formations dans 11&nbsp;pays.',
            chiffres: [{ valeur: 'Plus de 30&nbsp;000 conversations', texte: 'engagées avec les candidats' }, { valeur: '11 comptes', texte: 'gérés dans une seule plateforme' }],
          },
          {
            logo: LOGO_EDHEC, titre: 'Accompagner le choix des étudiants et de leurs parents.',
            texte: 'Des campagnes push marketing sortantes sur WhatsApp pour valoriser l’école et partager des contenus exclusifs aux étapes clés de l’orientation.',
            resultat: 'Objectif&nbsp;: renforcer la préférence au moment du choix d’école.',
            visuel: { src: '/img/education-edhec-publicite.webp', alt: 'Une publicité EDHEC International BBA dont le bouton ouvre une conversation WhatsApp', largeur: 300, hauteur: 506 },
          },
        ],
        source: 'Source&nbsp;: cas clients présentés par Messaging Me, mai 2026.',
      },
      usages: {
        surtitre: 'Les usages de votre école',
        titre: ['À chaque étape du recrutement,', 'une conversation utile.'],
        liste: [
          {
            titre: 'Engager', accroche: 'Vos formations. Leur prochain projet.',
            texte: 'Promouvez vos formations et vos temps forts sur WhatsApp. Engagez la conversation avec vos futurs candidats.',
            echange: [
              { qui: 'École', texte: 'Vous préparez votre orientation&nbsp;? Découvrez nos formations et échangez avec nos équipes lors de notre prochaine journée portes ouvertes.' },
              { qui: 'Candidat', texte: 'Je souhaite découvrir les programmes et m’inscrire à la JPO.', contact: true },
            ],
          },
          {
            titre: 'Accompagner', accroche: 'Des réponses pour se projeter dans votre école.',
            texte: 'Répondez aux questions sur les programmes et l’admission. L’IA s’appuie sur vos contenus et vos équipes prennent le relais lorsque nécessaire.',
            echange: [
              { qui: 'Candidat', texte: 'Bonjour, je voudrais connaître les conditions d’admission de votre master.', contact: true },
              { qui: 'École', texte: 'Bien sûr&nbsp;! Quel programme vous intéresse et quel diplôme préparez-vous actuellement&nbsp;?' },
            ],
          },
          {
            titre: 'Faire avancer', accroche: 'Le prochain rendez-vous. La prochaine étape.',
            texte: 'Invitez à un événement, proposez un rendez-vous ou rappelez une échéance. Adaptez le suivi à l’étape du candidat, en lien avec votre CRM.',
            echange: [
              { qui: 'École', texte: 'Votre candidature est en cours. Souhaitez-vous échanger avec notre équipe admissions pour préparer la suite&nbsp;?' },
              { qui: 'Candidat', texte: 'Oui, je souhaite prendre rendez-vous.', contact: true },
            ],
          },
        ],
        appel: 'Construisons votre parcours candidat',
        note: 'Exemples illustratifs de parcours à déployer.',
        encart: { titre: ['Ce qui les questionne.', 'Ce qui freine leur décision.'], texte: 'Les données conversationnelles vous aident à enrichir vos réponses, ajuster vos contenus et affiner vos scénarios de suivi.' },
      },
      partenaire: {
        surtitre: 'Votre partenaire conversationnel',
        titre: ['Une stratégie de recrutement.', 'La technologie et l’accompagnement pour la déployer.'],
        liste: [
          { titre: 'Conseil stratégique', texte: 'Définir les audiences, les moments de contact et les parcours adaptés à vos formations et à vos campagnes d’admission.' },
          { titre: 'Plateforme et intégrations', texte: 'Centraliser les conversations, organiser les campagnes et connecter WhatsApp à votre CRM et à vos équipes.' },
          { titre: 'Accompagnement et données conversationnelles', texte: 'Suivre les performances, analyser les questions et faire évoluer les scénarios au fil des campagnes.' },
        ],
        pilotage: 'À piloter ensemble&nbsp;: contacts qualifiés, participation aux événements, candidatures et inscriptions, selon les données disponibles dans votre CRM.',
      },
      projet: {
        titre: 'Parlons de votre prochaine campagne de recrutement.',
        texte: 'Développer votre recrutement international, mobiliser vos admissibles ou mieux accompagner les candidats&nbsp;: identifions le parcours à activer en priorité, du premier échange au suivi des candidatures.',
        bouton: 'Parlons de vos recrutements',
      },
    },
    en: {
      faq: [
        { question: 'How does a school recruit on WhatsApp?', reponse: 'With WhatsApp campaigns at decisive moments, AI answers and follow-up of every candidate. NEOMA runs campaigns between eligibility and the oral exams, and 100% of its incoming messages are dispatched instantly.' },
        { question: 'Can I recruit international candidates on WhatsApp?', reponse: 'Yes: Groupe EDH promotes its schools and programmes in 11 countries with Click-to-WhatsApp campaigns and marketing messages, and more than 30,000 conversations have been started with candidates.' },
        { question: 'Can several schools share the same platform?', reponse: 'Yes: Groupe EDH manages 11 accounts in a single platform.' },
      ],
      titre: 'WhatsApp for higher education · Messaging Me',
      description: 'WhatsApp campaigns, AI answers and candidate follow-up: speed up your recruitment, from first interest to application. The NEOMA, EDH and EDHEC cases.',
      menu: 'Recruiting candidates on WhatsApp',
      icone: 'i-buildings',
      surtitre: 'Schools and higher education',
      h1: ['Speed up your recruitment.', 'Start the conversation.'],
      chapeau: 'From first interest to application, build a direct link with your future students on WhatsApp.',
      sous: 'Strategy, technology platform and support: we connect your campaigns to your admissions teams to move candidates’ choices forward.',
      appel: 'Let’s talk about your recruitment',
      references: { titre: 'Our education references', logos: [LOGO_NEOMA, LOGO_EDH, LOGO_EDHEC] },
      captures: [
        { src: '/img/education-neoma-oraux.webp', alt: 'NEOMA invites its eligible candidates to a webinar on WhatsApp, then routes a question to the Admissions department' },
        { src: '/img/education-edh-international.webp', alt: 'Coming from an Instagram ad, an international candidate chats with EDH on WhatsApp about its programmes' },
      ],
      enjeux: {
        surtitre: 'Your recruitment challenges',
        titre: ['Between interest and enrolment,', 'don’t let the link get lost.'],
        liste: [
          { num: '01 / Reachability', titre: ['A contact collected.', 'A conversation to start.'], texte: 'After a fair or a campaign, you still need an answer to move the candidate’s project forward.' },
          { num: '02 / Preference', titre: ['Several schools.', 'A choice to support.'], texte: 'Programmes, career prospects, student life: precise answers help candidates picture themselves at your school.' },
          { num: '03 / Follow-up', titre: ['Many requests.', 'Busy teams.'], texte: 'Recurring questions, different departments and international campaigns keep your teams busy at every step.' },
        ],
        encart: { titre: ['WhatsApp.', 'A conversation to move their choice forward.'], texte: 'Extend your campaigns into a direct conversation. Candidates ask their questions, get the information that fits their project and reach the right contact.' },
      },
      terrain: {
        surtitre: 'Our experience in education',
        titre: ['Schools already making conversation', 'a recruitment lever.'],
        film: { nom: 'cas-education', aria: 'Film: the NEOMA Business School case, recruiting candidates on WhatsApp with Messaging Me', duree: 'PT38S', publie: '2026-10-21T18:00:00+02:00' },
        cas: { logo: LOGO_NEOMA, titre: 'Strengthen preference at decisive moments.', texte: 'WhatsApp campaigns between eligibility and the oral exams, with requests routed to the right departments.' },
        chiffres: [
          { valeur: 'More than 200 participants', texte: 'at the promoted webinar' },
          { valeur: '100%', texte: 'of incoming messages dispatched instantly' },
        ],
        autres: [
          {
            logo: LOGO_EDH, titre: 'Recruit internationally. Centralize follow-up.',
            texte: 'Click-to-WhatsApp campaigns and marketing messages to promote the schools and programmes in 11 countries.',
            chiffres: [{ valeur: 'More than 30,000 conversations', texte: 'started with candidates' }, { valeur: '11 accounts', texte: 'managed in a single platform' }],
          },
          {
            logo: LOGO_EDHEC, titre: 'Support the choice of students and their parents.',
            texte: 'Outbound push marketing campaigns on WhatsApp to showcase the school and share exclusive content at key steps of the orientation process.',
            resultat: 'Goal: strengthen preference when the school is chosen.',
            visuel: { src: '/img/education-edhec-publicite.webp', alt: 'An EDHEC International BBA ad whose button opens a WhatsApp conversation', largeur: 300, hauteur: 506 },
          },
        ],
        source: 'Source: client cases presented by Messaging Me, May 2026.',
      },
      usages: {
        surtitre: 'Your school’s use cases',
        titre: ['At every step of recruitment,', 'a useful conversation.'],
        liste: [
          {
            titre: 'Engage', accroche: 'Your programmes. Their next project.',
            texte: 'Promote your programmes and key events on WhatsApp. Start the conversation with your future candidates.',
            echange: [
              { qui: 'School', texte: 'Planning your next step? Discover our programmes and talk with our teams at our next open day.' },
              { qui: 'Candidate', texte: 'I’d like to discover the programmes and sign up for the open day.', contact: true },
            ],
          },
          {
            titre: 'Support', accroche: 'Answers to picture themselves at your school.',
            texte: 'Answer questions about programmes and admission. The AI relies on your content, and your teams take over when needed.',
            echange: [
              { qui: 'Candidate', texte: 'Hello, I’d like to know the admission requirements for your master’s programme.', contact: true },
              { qui: 'School', texte: 'Of course! Which programme are you interested in, and which degree are you currently studying for?' },
            ],
          },
          {
            titre: 'Move forward', accroche: 'The next meeting. The next step.',
            texte: 'Invite to an event, offer a meeting or send a deadline reminder. Adapt follow-up to the candidate’s stage, in line with your CRM.',
            echange: [
              { qui: 'School', texte: 'Your application is in progress. Would you like to talk with our admissions team to prepare the next steps?' },
              { qui: 'Candidate', texte: 'Yes, I’d like to book a meeting.', contact: true },
            ],
          },
        ],
        appel: 'Let’s build your candidate journey',
        note: 'Illustrative examples of journeys to deploy.',
        encart: { titre: ['What they wonder about.', 'What holds their decision back.'], texte: 'Conversational data helps you enrich your answers, adjust your content and refine your follow-up scenarios.' },
      },
      partenaire: {
        surtitre: 'Your conversational partner',
        titre: ['A recruitment strategy.', 'The technology and support to deploy it.'],
        liste: [
          { titre: 'Strategy', texte: 'Define the audiences, the moments of contact and the journeys that fit your programmes and admission campaigns.' },
          { titre: 'Platform and integrations', texte: 'Centralize conversations, organize campaigns and connect WhatsApp to your CRM and your teams.' },
          { titre: 'Support and conversational data', texte: 'Track performance, analyze questions and evolve the scenarios campaign after campaign.' },
        ],
        pilotage: 'What we steer together: qualified contacts, event attendance, applications and enrolments, based on the data available in your CRM.',
      },
      projet: {
        titre: 'Let’s talk about your next recruitment campaign.',
        texte: 'Grow your international recruitment, mobilize your eligible candidates or better support applicants: let’s identify the journey to activate first, from the first conversation to application follow-up.',
        bouton: 'Let’s talk about your recruitment',
      },
    },
  },
  assurance: {
    fr: {
      faq: [
        { question: 'Comment une compagnie d’assurance utilise-t-elle WhatsApp ?', reponse: 'Pour joindre ses clients par des campagnes WhatsApp, répondre avec une IA aux questions courantes et passer le relais à un conseiller du réseau. Chez Gan Prévoyance, les campagnes en PER et prévoyance individuelle ont obtenu 30&nbsp;% d’engagement et plus de 85&nbsp;% de lecture.' },
        { question: 'Peut-on faire un devis sur WhatsApp ?', reponse: 'Oui : avec Groupama, une campagne Click-to-WhatsApp en assurance chien-chat donne le devis et les réponses dans la conversation, puis passe le relais à un collaborateur pour finaliser la souscription.' },
        { question: 'Quelle part des demandes une IA peut-elle traiter ?', reponse: 'Chez Mieux Assuré, une IA alimentée par les FAQ auto et habitation traite 40&nbsp;% des sollicitations de service client, et oriente les autres demandes vers un humain.' },
      ],
      titre: 'WhatsApp pour l’assurance · Messaging Me',
      description: 'Campagnes WhatsApp, réponses avec IA et relais vers votre réseau : rapprochez-vous de vos assurés. Les cas Gan Prévoyance, Groupama et Mieux Assuré.',
      menu: 'Joindre ses assurés sur WhatsApp',
      icone: 'i-file-text',
      surtitre: 'Assurance et IA conversationnelle',
      h1: ['Rapprochez-vous de vos assurés.', 'Accélérez vos opportunités.'],
      chapeau: 'Mieux joindre vos clients, obtenir une réponse et faire avancer l’échange&nbsp;: faites de WhatsApp un lien direct avec vos assurés et un levier pour votre réseau commercial.',
      sous: 'Nous associons conseil stratégique, plateforme technologique et accompagnement pour connecter vos conversations à vos équipes et à vos outils.',
      appel: 'Parlons de vos parcours clients',
      references: { titre: 'Nos références assurance', logos: [LOGO_GAN, LOGO_GROUPAMA, LOGO_MIEUX_ASSURE] },
      distinction: { ...FRENCH_ASSURTECH, alt: '', texte: 'Messaging Me, lauréat French Assurtech 2026' },
      captures: [
        { src: '/img/assurance-gan-prevoyance.webp', alt: 'Un client répond à une campagne Gan Prévoyance sur WhatsApp, puis le Service Client prend le relais' },
        { src: '/img/assurance-mieux-assure.webp', alt: 'Un assuré demande une facture justificative au compte WhatsApp de Mieux Assuré, qui lui répond' },
      ],
      enjeux: {
        surtitre: 'Votre premier enjeu&nbsp;: la joignabilité',
        titre: ['Avant de convaincre,', 'encore faut-il réussir à se parler.'],
        liste: [
          { num: '01 / Établir le contact', titre: ['Des appels sans réponse.', 'Des emails sans retour.'], texte: 'Vos équipes multiplient les tentatives pour joindre les clients et ouvrir un échange sur leurs besoins.' },
          { num: '02 / Ouvrir l’échange', titre: ['Une offre reçue.', 'Une réponse à obtenir.'], texte: 'Le client doit pouvoir poser une question et reprendre la conversation au moment qui lui convient.' },
          { num: '03 / Passer le relais', titre: ['Un intérêt exprimé.', 'Le bon conseiller à mobiliser.'], texte: 'La demande doit rejoindre le service compétent ou le réseau commercial, avec le contexte déjà recueilli.' },
        ],
        encart: { titre: ['WhatsApp.', 'Un lien que l’assuré peut reprendre à son rythme.'], texte: 'Engagez une conversation qui reste accessible, apportez une première réponse et préparez le relais vers vos équipes ou votre réseau commercial.' },
      },
      terrain: {
        surtitre: 'Notre expérience dans l’assurance',
        titre: ['De la campagne commerciale', 'à la relation assurés.'],
        film: { nom: 'cas-assurance', aria: 'Film : le cas Gan Prévoyance, des campagnes WhatsApp pour mieux joindre les assurés avec Messaging Me', duree: 'PT38S', publie: '2026-10-21T20:00:00+02:00' },
        cas: { logo: LOGO_GAN, titre: 'Mieux joindre les clients pour alimenter le réseau.', texte: 'Des campagnes WhatsApp en PER et prévoyance individuelle, ciblées selon le profil et l’équipement. Le réseau commercial prend le relais pour conseiller et convertir.' },
        chiffres: [
          { valeur: '30&nbsp;% d’engagement', texte: 'sur les campagnes' },
          { valeur: 'Plus de 85&nbsp;% de lecture', texte: 'des messages de campagne' },
        ],
        autres: [
          {
            logo: LOGO_GROUPAMA, titre: 'Du premier contact au devis, garder le fil.',
            texte: 'Une campagne Click-to-WhatsApp en assurance chien-chat&nbsp;: devis et réponses dans la conversation, puis relais vers un collaborateur pour finaliser la souscription.',
            chiffres: [{ valeur: 'Un devis conversationnel', texte: 'dans WhatsApp' }],
            objectifs: { titre: 'Objectifs de campagne', liste: [{ valeur: 'Coût d’acquisition moyen visé', texte: 'divisé par 2' }, { valeur: '40&nbsp;%', texte: 'd’engagement attendu' }] },
            visuel: { src: '/img/assurance-groupama-publicite.webp', alt: 'Une publicité Groupama pour l’assurance chien-chat, avec le bouton « Faire mon devis »', largeur: 300, hauteur: 294 },
          },
          {
            logo: LOGO_MIEUX_ASSURE, titre: 'Automatiser les demandes courantes. Faciliter le relais.',
            texte: 'Une IA alimentée par les FAQ auto et habitation pour traiter les questions courantes, recueillir les informations utiles et orienter les autres demandes vers un humain.',
            chiffres: [{ valeur: '40&nbsp;% des sollicitations', texte: 'de service client automatisées' }],
            visuel: { src: '/img/assurance-mieux-assure.webp', alt: 'La conversation WhatsApp d’un assuré avec Mieux Assuré', largeur: 486, hauteur: 1034 },
          },
        ],
        source: 'Source&nbsp;: cas clients Messaging Me. Chien-chat&nbsp;: objectifs de campagne.',
      },
      usages: {
        surtitre: 'Les usages de votre organisation',
        titre: ['À chaque étape de la relation,', 'une conversation qui fait avancer.'],
        liste: [
          {
            titre: 'Engager', accroche: 'Un message ciblé. Un échange qui commence.',
            texte: 'Joignez vos clients sur WhatsApp avec des offres ciblées. Ouvrez la conversation et identifiez leur intérêt.',
            echange: [
              { qui: 'Votre assureur', texte: 'Bonjour, souhaitez-vous faire le point sur votre protection et les solutions de prévoyance avec votre conseiller&nbsp;?' },
              { qui: 'Client', texte: 'Oui, je souhaite en parler. Pouvez-vous me proposer un rendez-vous&nbsp;?', contact: true },
            ],
          },
          {
            titre: 'Convertir', accroche: 'Un besoin qualifié. Le réseau prend le relais.',
            texte: 'Facilitez le devis ou la prise de rendez-vous. Transmettez la conversation à vos équipes ou à votre réseau commercial pour poursuivre l’échange.',
            echange: [
              { qui: 'Client', texte: 'Je souhaite échanger avec un conseiller avant de finaliser mon devis.', contact: true },
              { qui: 'Votre assureur', texte: 'Je transmets votre demande et les éléments de notre échange à votre conseiller pour préparer votre rendez-vous.' },
            ],
          },
          {
            titre: 'Accompagner', accroche: 'Une réponse utile. Un relais quand il le faut.',
            texte: 'Traitez les questions fréquentes avec l’IA. Orientez les demandes vers le service compétent ou le réseau commercial selon le besoin.',
            echange: [
              { qui: 'Client', texte: 'Bonjour, où puis-je retrouver mon attestation d’assurance&nbsp;?', contact: true },
              { qui: 'Votre assureur', texte: 'Vous pouvez la retrouver dans votre espace client, dans la rubrique Documents. Si vous ne la trouvez pas, je peux transmettre votre demande à notre équipe.' },
            ],
          },
        ],
        appel: 'Construisons votre parcours client',
        note: 'Exemples illustratifs de parcours à déployer.',
        encart: { titre: ['Chaque conversation', 'prépare la suite.'], texte: 'Les besoins exprimés et les freins identifiés enrichissent votre connaissance client, vos campagnes et les échanges de vos conseillers grâce aux données conversationnelles.' },
      },
      partenaire: {
        surtitre: 'Votre partenaire conversationnel',
        titre: ['Du premier contact', 'au relais dans votre réseau.'],
        liste: [
          { titre: 'Conseil stratégique', texte: 'Définir les moments de contact, les parcours et les règles d’orientation vers vos services ou votre réseau commercial.' },
          { titre: 'Plateforme et intégrations', texte: 'Connecter WhatsApp à vos outils pour transmettre les demandes et le contexte des conversations au bon interlocuteur.' },
          { titre: 'Accompagnement et données conversationnelles', texte: 'Analyser les réponses, suivre la prise en charge et améliorer les scénarios avec vos équipes.' },
        ],
        pilotage: 'À piloter ensemble&nbsp;: réponses obtenues, demandes qualifiées, rendez-vous, souscriptions et sollicitations traitées, selon les données disponibles.',
      },
      projet: {
        titre: 'Et si votre prochaine campagne vous rapprochait de vos assurés&nbsp;?',
        texte: 'Mieux joindre vos clients, alimenter votre réseau commercial ou automatiser les demandes courantes&nbsp;: définissons le premier parcours à activer, du premier échange au relais humain.',
        bouton: 'Parlons de vos parcours clients',
      },
    },
    en: {
      faq: [
        { question: 'How does an insurance company use WhatsApp?', reponse: 'To reach its customers with WhatsApp campaigns, answer routine questions with AI and hand over to an advisor in the network. At Gan Prévoyance, the campaigns on retirement savings and individual protection reached 30% engagement and more than 85% read rate.' },
        { question: 'Can I give a quote on WhatsApp?', reponse: 'Yes: with Groupama, a Click-to-WhatsApp campaign for dog and cat insurance gives the quote and the answers in the conversation, then hands over to a colleague to finalise the subscription.' },
        { question: 'How many requests can an AI handle?', reponse: 'At Mieux Assuré, an AI fed with the car and home insurance FAQs handles 40% of customer service requests, and routes the other requests to a human.' },
      ],
      titre: 'WhatsApp for insurance · Messaging Me',
      description: 'WhatsApp campaigns, AI answers and handover to your network: get closer to your policyholders. The Gan Prévoyance, Groupama and Mieux Assuré cases.',
      menu: 'Reaching policyholders on WhatsApp',
      icone: 'i-file-text',
      surtitre: 'Insurance and conversational AI',
      h1: ['Get closer to your policyholders.', 'Speed up your opportunities.'],
      chapeau: 'Reach your customers better, get an answer and move the conversation forward: make WhatsApp a direct link with your policyholders and a lever for your sales network.',
      sous: 'We combine strategy, a technology platform and support to connect your conversations to your teams and your tools.',
      appel: 'Let’s talk about your customer journeys',
      references: { titre: 'Our insurance references', logos: [LOGO_GAN, LOGO_GROUPAMA, LOGO_MIEUX_ASSURE] },
      distinction: { ...FRENCH_ASSURTECH, alt: '', texte: 'Messaging Me, French Assurtech 2026 winner' },
      captures: [
        { src: '/img/assurance-gan-prevoyance.webp', alt: 'A customer answers a Gan Prévoyance campaign on WhatsApp, then Customer Service takes over' },
        { src: '/img/assurance-mieux-assure.webp', alt: 'A policyholder asks Mieux Assuré’s WhatsApp account for a supporting invoice, and gets an answer' },
      ],
      enjeux: {
        surtitre: 'Your first challenge: reachability',
        titre: ['Before you can convince,', 'you have to be able to talk.'],
        liste: [
          { num: '01 / Making contact', titre: ['Unanswered calls.', 'Emails left unread.'], texte: 'Your teams make attempt after attempt to reach customers and open a conversation about their needs.' },
          { num: '02 / Opening the conversation', titre: ['An offer received.', 'An answer to get.'], texte: 'Customers need to be able to ask a question and pick up the conversation when it suits them.' },
          { num: '03 / Handing over', titre: ['Interest expressed.', 'The right advisor to involve.'], texte: 'The request has to reach the right department or the sales network, with the context already gathered.' },
        ],
        encart: { titre: ['WhatsApp.', 'A link policyholders can pick up at their own pace.'], texte: 'Start a conversation that stays accessible, give a first answer and prepare the handover to your teams or your sales network.' },
      },
      terrain: {
        surtitre: 'Our experience in insurance',
        titre: ['From the sales campaign', 'to the policyholder relationship.'],
        film: { nom: 'cas-assurance', aria: 'Film: the Gan Prévoyance case, WhatsApp campaigns to reach policyholders better with Messaging Me', duree: 'PT38S', publie: '2026-10-21T20:00:00+02:00' },
        cas: { logo: LOGO_GAN, titre: 'Reach customers better to feed the network.', texte: 'WhatsApp campaigns on retirement savings and individual protection, targeted by profile and existing cover. The sales network takes over to advise and convert.' },
        chiffres: [
          { valeur: '30% engagement', texte: 'on the campaigns' },
          { valeur: 'More than 85% read rate', texte: 'on campaign messages' },
        ],
        autres: [
          {
            logo: LOGO_GROUPAMA, titre: 'From first contact to quote, keep the thread.',
            texte: 'A Click-to-WhatsApp campaign for pet insurance (cats and dogs): quotes and answers in the conversation, then handover to an employee to finalize the subscription.',
            chiffres: [{ valeur: 'A conversational quote', texte: 'in WhatsApp' }],
            objectifs: { titre: 'Campaign goals', liste: [{ valeur: 'Target average acquisition cost', texte: 'divided by 2' }, { valeur: '40%', texte: 'expected engagement' }] },
            visuel: { src: '/img/assurance-groupama-publicite.webp', alt: 'A Groupama pet insurance ad, with the “Get my quote” button', largeur: 300, hauteur: 294 },
          },
          {
            logo: LOGO_MIEUX_ASSURE, titre: 'Automate everyday requests. Make handover easy.',
            texte: 'An AI fed with the car and home FAQs to handle everyday questions, gather the useful information and route the other requests to a person.',
            chiffres: [{ valeur: '40% of requests', texte: 'to customer service automated' }],
            visuel: { src: '/img/assurance-mieux-assure.webp', alt: 'A policyholder’s WhatsApp conversation with Mieux Assuré', largeur: 486, hauteur: 1034 },
          },
        ],
        source: 'Source: Messaging Me client cases. Pet insurance: campaign goals.',
      },
      usages: {
        surtitre: 'Your organization’s use cases',
        titre: ['At every step of the relationship,', 'a conversation that moves things forward.'],
        liste: [
          {
            titre: 'Engage', accroche: 'A targeted message. A conversation that begins.',
            texte: 'Reach your customers on WhatsApp with targeted offers. Open the conversation and identify their interest.',
            echange: [
              { qui: 'Your insurer', texte: 'Hello, would you like to review your cover and protection options with your advisor?' },
              { qui: 'Customer', texte: 'Yes, I’d like to talk about it. Could you offer me an appointment?', contact: true },
            ],
          },
          {
            titre: 'Convert', accroche: 'A qualified need. The network takes over.',
            texte: 'Make quotes and appointment booking easy. Pass the conversation to your teams or your sales network to continue the exchange.',
            echange: [
              { qui: 'Customer', texte: 'I’d like to talk with an advisor before finalizing my quote.', contact: true },
              { qui: 'Your insurer', texte: 'I’m passing your request and the details of our conversation to your advisor to prepare your appointment.' },
            ],
          },
          {
            titre: 'Support', accroche: 'A useful answer. A handover when needed.',
            texte: 'Handle frequent questions with AI. Route requests to the right department or the sales network as needed.',
            echange: [
              { qui: 'Customer', texte: 'Hello, where can I find my insurance certificate?', contact: true },
              { qui: 'Your insurer', texte: 'You’ll find it in your customer area, under Documents. If you can’t find it, I can pass your request to our team.' },
            ],
          },
        ],
        appel: 'Let’s build your customer journey',
        note: 'Illustrative examples of journeys to deploy.',
        encart: { titre: ['Every conversation', 'prepares what comes next.'], texte: 'The needs expressed and the obstacles identified enrich your customer knowledge, your campaigns and your advisors’ conversations through conversational data.' },
      },
      partenaire: {
        surtitre: 'Your conversational partner',
        titre: ['From first contact', 'to handover in your network.'],
        liste: [
          { titre: 'Strategy', texte: 'Define the moments of contact, the journeys and the routing rules to your departments or your sales network.' },
          { titre: 'Platform and integrations', texte: 'Connect WhatsApp to your tools to pass requests and conversation context to the right contact.' },
          { titre: 'Support and conversational data', texte: 'Analyze answers, track handling and improve the scenarios with your teams.' },
        ],
        pilotage: 'What we steer together: answers received, qualified requests, appointments, policies taken out and requests handled, based on the data available.',
      },
      projet: {
        titre: 'What if your next campaign brought you closer to your policyholders?',
        texte: 'Reach your customers better, feed your sales network or automate everyday requests: let’s define the first journey to activate, from the first conversation to the human handover.',
        bouton: 'Let’s talk about your customer journeys',
      },
    },
  },
  tourisme: {
    fr: {
      faq: [
        { question: 'Comment préparer l’arrivée des clients sur WhatsApp ?', reponse: 'Par des messages de check-in avant le séjour. Chez Odalys, un pilote d’early check-in sur WhatsApp facilite les démarches avant l’arrivée, et plus de 80&nbsp;% des messages de check-in sont lus.' },
        { question: 'Un bot peut-il aider à choisir un séjour ?', reponse: 'Oui : chez Odalys, un bot conversationnel guide les vacanciers parmi les offres, répond aux questions fréquentes et passe le relais à un conseiller lorsque nécessaire.' },
        { question: 'Combien de messages une marque de tourisme traite-t-elle sur WhatsApp ?', reponse: 'Odalys en traite plus de 2&nbsp;000 par mois.' },
      ],
      titre: 'WhatsApp pour le voyage et le tourisme · Messaging Me',
      description: 'Réservation, préparation de l’arrivée et services pendant le séjour : gardez le lien avec vos voyageurs sur WhatsApp. Le cas Odalys.',
      menu: 'Accompagner chaque séjour sur WhatsApp',
      icone: 'i-key',
      surtitre: 'Tourisme, hébergement et IA conversationnelle',
      h1: ['Engagez la conversation.', 'Enrichissez chaque séjour.'],
      chapeau: 'Du choix de la destination aux expériences sur place, ouvrez un lien direct sur WhatsApp. Accompagnez la réservation, facilitez l’arrivée et valorisez vos services pendant le séjour.',
      sous: 'Conseil stratégique, plateforme technologique et accompagnement&nbsp;: nous connectons les conversations à vos équipes et à vos outils.',
      appel: 'Parlons de vos parcours voyageurs',
      references: { titre: 'Nos références tourisme', logos: [LOGO_ODALYS, LOGO_THALAZUR] },
      captures: [
        { src: '/img/tourisme-odalys.webp', alt: 'Un vacancier répond « Ski et spa » au compte WhatsApp d’Odalys Vacances, qui lui propose une résidence à l’Alpe d’Huez' },
      ],
      enjeux: {
        surtitre: 'Les enjeux de votre relation voyageurs',
        titre: ['Avant l’arrivée comme sur place,', 'gardez le lien avec vos voyageurs.'],
        liste: [
          { num: '01 / Aider à choisir', titre: ['Une question.', 'Un séjour à concrétiser.'], texte: 'Destinations, hébergements, services&nbsp;: une question sans réponse peut interrompre la recherche.' },
          { num: '02 / Préparer l’arrivée', titre: ['Un départ qui approche.', 'Des démarches à simplifier.'], texte: 'Informations pratiques et formalités demandent de joindre les clients au bon moment, avant leur arrivée.' },
          { num: '03 / Garder le contact', titre: ['Des clients sur place.', 'Des services à faire découvrir.'], texte: 'Activités à réserver, offres à proposer, informations à transmettre&nbsp;: comment toucher vos voyageurs pendant le séjour&nbsp;?' },
        ],
        encart: { titre: ['WhatsApp.', 'Un fil de conversation tout au long du séjour.'], texte: 'Accompagnez le choix, simplifiez l’arrivée puis partagez les informations et les offres utiles pendant le séjour.' },
      },
      terrain: {
        surtitre: 'Le cas Odalys',
        titre: ['Du choix du séjour', 'à la préparation de l’arrivée.'],
        film: { nom: 'cas-tourisme', aria: 'Film : le cas Odalys, le séjour qui commence par une conversation WhatsApp avec Messaging Me', duree: 'PT38S', publie: '2026-10-22T12:00:00+02:00' },
        cas: { logo: LOGO_ODALYS, titre: 'Autonomie et contact humain.', texte: 'Un bot conversationnel guide les vacanciers parmi les offres, répond aux questions fréquentes et passe le relais à un conseiller lorsque nécessaire. En complément, un pilote d’early check-in sur WhatsApp facilite les démarches avant l’arrivée, avec de premiers retours positifs.' },
        chiffres: [
          { valeur: 'Plus de 2&nbsp;000 messages', texte: 'traités par mois' },
          { valeur: 'Plus de 80&nbsp;% de lecture', texte: 'des messages de check-in' },
        ],
        source: 'Source&nbsp;: cas Odalys présenté par Messaging Me. Early check-in&nbsp;: pilote.',
      },
      usages: {
        surtitre: 'Les usages de vos établissements',
        titre: ['À chaque moment du séjour,', 'une conversation utile.'],
        liste: [
          {
            titre: 'Choisir et réserver', accroche: 'Les bonnes réponses. Le séjour qui leur correspond.',
            texte: 'Faites découvrir vos offres, répondez aux questions et passez le relais à vos conseillers pour accompagner la réservation.',
            mots: 'Destinations · Hébergements · Services',
            echange: [
              { qui: 'Voyageur', texte: 'Nous cherchons un séjour à la montagne en famille.', contact: true },
              { qui: 'Votre établissement', texte: 'À quelles dates souhaitez-vous partir et combien de personnes voyageront&nbsp;?' },
            ],
          },
          {
            titre: 'Préparer l’arrivée', accroche: 'Le séjour approche. Les démarches avancent.',
            texte: 'Partagez les informations pratiques et facilitez les démarches avant le départ, avec des parcours connectés à vos outils.',
            mots: 'Informations d’accès · Horaires · Formalités',
            echange: [
              { qui: 'Votre établissement', texte: 'Votre séjour approche&nbsp;! Souhaitez-vous préparer votre arrivée&nbsp;?' },
              { qui: 'Voyageur', texte: 'Oui, quelles démarches puis-je effectuer dès maintenant&nbsp;?', contact: true },
            ],
          },
          {
            titre: 'Pendant le séjour', accroche: 'Vos services méritent de faire partie du séjour.',
            texte: 'Informez vos voyageurs et développez les ventes additionnelles&nbsp;: notifications sur les services, suggestions d’activités et offres adaptées au moment du séjour.',
            mots: 'Spa · Restauration · Activités · Départ tardif',
            echange: [
              { qui: 'Votre établissement', texte: 'Envie de vous détendre cet après-midi&nbsp;? Découvrez les soins et les créneaux disponibles au spa.' },
              { qui: 'Voyageur', texte: 'Oui, je veux consulter les disponibilités.', contact: true },
            ],
          },
        ],
        appel: 'Construisons votre parcours voyageur',
        note: 'Exemples illustratifs de parcours à déployer.',
        encart: { titre: ['Mieux comprendre', 'pour mieux accueillir.'], texte: 'Les données conversationnelles révèlent les attentes et les informations manquantes. Enrichissez vos réponses et améliorez les parcours avant et pendant le séjour.' },
      },
      partenaire: {
        surtitre: 'Votre partenaire conversationnel',
        titre: ['Vos destinations, vos équipes.', 'Notre savoir-faire pour garder le lien.'],
        liste: [
          { titre: 'Conseil stratégique', texte: 'Identifier les moments de contact et concevoir les parcours, de la découverte des offres aux services proposés sur place.' },
          { titre: 'Plateforme et intégrations', texte: 'Déployer WhatsApp, connecter vos contenus et vos outils, organiser le relais vers vos conseillers ou vos établissements.' },
          { titre: 'Accompagnement et données conversationnelles', texte: 'Analyser les demandes, suivre les performances et faire évoluer les scénarios avec vos équipes.' },
        ],
        pilotage: 'À piloter ensemble&nbsp;: conversations engagées, réservations, démarches avant l’arrivée, lecture des messages et ventes additionnelles, selon les données disponibles.',
      },
      projet: {
        titre: 'Quel moment du parcours voyageur voulez-vous simplifier&nbsp;?',
        texte: 'Aider à choisir, préparer l’arrivée ou développer les ventes additionnelles pendant le séjour&nbsp;: identifions le premier parcours à activer. Un lien direct, avant et pendant le séjour.',
        bouton: 'Parlons de vos parcours voyageurs',
      },
    },
    en: {
      faq: [
        { question: 'How do I prepare guests’ arrival on WhatsApp?', reponse: 'With check-in messages before the stay. At Odalys, an early check-in pilot on WhatsApp makes formalities easier before arrival, and more than 80% of check-in messages are read.' },
        { question: 'Can a bot help choose a stay?', reponse: 'Yes: at Odalys, a conversational bot guides holidaymakers through the offers, answers frequent questions and hands over to an advisor when needed.' },
        { question: 'How many messages does a tourism brand handle on WhatsApp?', reponse: 'Odalys handles more than 2,000 a month.' },
      ],
      titre: 'WhatsApp for travel and tourism · Messaging Me',
      description: 'Booking, arrival preparation and services during the stay: stay connected with your travellers on WhatsApp. The Odalys case.',
      menu: 'Supporting every stay on WhatsApp',
      icone: 'i-key',
      surtitre: 'Tourism, hospitality and conversational AI',
      h1: ['Start the conversation.', 'Enrich every stay.'],
      chapeau: 'From choosing a destination to experiences on site, open a direct link on WhatsApp. Support the booking, make arrival easier and showcase your services during the stay.',
      sous: 'Strategy, a technology platform and support: we connect conversations to your teams and your tools.',
      appel: 'Let’s talk about your traveller journeys',
      references: { titre: 'Our tourism references', logos: [LOGO_ODALYS, LOGO_THALAZUR] },
      captures: [
        { src: '/img/tourisme-odalys.webp', alt: 'A holidaymaker answers “Ski et spa” to Odalys Vacances’ WhatsApp account, which suggests a residence in Alpe d’Huez' },
      ],
      enjeux: {
        surtitre: 'The challenges of your traveller relationship',
        titre: ['Before arrival and on site,', 'stay connected with your travellers.'],
        liste: [
          { num: '01 / Helping them choose', titre: ['A question.', 'A stay to make happen.'], texte: 'Destinations, accommodation, services: an unanswered question can cut the search short.' },
          { num: '02 / Preparing the arrival', titre: ['A departure coming up.', 'Formalities to simplify.'], texte: 'Practical information and formalities mean reaching customers at the right moment, before they arrive.' },
          { num: '03 / Staying in touch', titre: ['Guests on site.', 'Services to showcase.'], texte: 'Activities to book, offers to suggest, information to pass on: how do you reach your travellers during their stay?' },
        ],
        encart: { titre: ['WhatsApp.', 'One conversation thread for the whole stay.'], texte: 'Support the choice, simplify the arrival, then share useful information and offers during the stay.' },
      },
      terrain: {
        surtitre: 'The Odalys case',
        titre: ['From choosing the stay', 'to preparing the arrival.'],
        film: { nom: 'cas-tourisme', aria: 'Film: the Odalys case, the stay that begins with a WhatsApp conversation with Messaging Me', duree: 'PT38S', publie: '2026-10-22T12:00:00+02:00' },
        cas: { logo: LOGO_ODALYS, titre: 'Self-service and the human touch.', texte: 'A conversational bot guides holidaymakers through the offers, answers frequent questions and hands over to an advisor when needed. On top of that, an early check-in pilot on WhatsApp makes formalities easier before arrival, with positive first feedback.' },
        chiffres: [
          { valeur: 'More than 2,000 messages', texte: 'handled every month' },
          { valeur: 'More than 80% read rate', texte: 'on check-in messages' },
        ],
        source: 'Source: Odalys case presented by Messaging Me. Early check-in: pilot.',
      },
      usages: {
        surtitre: 'Your establishments’ use cases',
        titre: ['At every moment of the stay,', 'a useful conversation.'],
        liste: [
          {
            titre: 'Choose and book', accroche: 'The right answers. The stay that suits them.',
            texte: 'Showcase your offers, answer questions and hand over to your advisors to support the booking.',
            mots: 'Destinations · Accommodation · Services',
            echange: [
              { qui: 'Traveller', texte: 'We’re looking for a family stay in the mountains.', contact: true },
              { qui: 'Your establishment', texte: 'What dates would you like to travel, and how many people will be coming?' },
            ],
          },
          {
            titre: 'Prepare the arrival', accroche: 'The stay is coming up. Formalities move forward.',
            texte: 'Share practical information and make formalities easier before departure, with journeys connected to your tools.',
            mots: 'Access information · Opening hours · Formalities',
            echange: [
              { qui: 'Your establishment', texte: 'Your stay is coming up! Would you like to prepare your arrival?' },
              { qui: 'Traveller', texte: 'Yes, what can I take care of right now?', contact: true },
            ],
          },
          {
            titre: 'During the stay', accroche: 'Your services deserve to be part of the stay.',
            texte: 'Keep your travellers informed and grow additional sales: service notifications, activity suggestions and offers suited to the moment of the stay.',
            mots: 'Spa · Dining · Activities · Late check-out',
            echange: [
              { qui: 'Your establishment', texte: 'Fancy some relaxation this afternoon? Discover the treatments and the slots available at the spa.' },
              { qui: 'Traveller', texte: 'Yes, I’d like to see what’s available.', contact: true },
            ],
          },
        ],
        appel: 'Let’s build your traveller journey',
        note: 'Illustrative examples of journeys to deploy.',
        encart: { titre: ['Understand better', 'to welcome better.'], texte: 'Conversational data reveals expectations and missing information. Enrich your answers and improve the journeys before and during the stay.' },
      },
      partenaire: {
        surtitre: 'Your conversational partner',
        titre: ['Your destinations, your teams.', 'Our know-how to stay connected.'],
        liste: [
          { titre: 'Strategy', texte: 'Identify the moments of contact and design the journeys, from discovering the offers to the services available on site.' },
          { titre: 'Platform and integrations', texte: 'Deploy WhatsApp, connect your content and your tools, organize handover to your advisors or your establishments.' },
          { titre: 'Support and conversational data', texte: 'Analyze requests, track performance and evolve the scenarios with your teams.' },
        ],
        pilotage: 'What we steer together: conversations started, bookings, pre-arrival formalities, message reads and additional sales, based on the data available.',
      },
      projet: {
        titre: 'Which moment of the traveller journey do you want to simplify?',
        texte: 'Helping them choose, preparing the arrival or growing additional sales during the stay: let’s identify the first journey to activate. A direct link, before and during the stay.',
        bouton: 'Let’s talk about your traveller journeys',
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

// Aucune depuis le 2026-10-22 : Voyage et tourisme, la dernière, a reçu son contenu.
export const TEXTES_ATTENTE: Readonly<Record<string, Record<Langue, TexteAttente>>> = {};
