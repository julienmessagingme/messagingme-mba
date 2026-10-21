// scripts/vitrine/secteurs-textes.ts
// Les textes des pages de secteur (rubrique Solutions), en français et en anglais : la seule chose écrite à la main de
// ces pages, que `scripts/vitrine/cas.ts` assemble (npm run vitrine:cas). La première, Transport et mobilités, reprend la
// maquette de Julien du 2026-10-20 (`maquette-landing-mobilite`), avec le cas Keolis. La deuxième, Enseignement
// supérieur, reprend ses trois maquettes du 2026-10-21 (`landing-education-*`), avec les cas NEOMA, EDH et EDHEC.
// ⚠️ Un client n'est cité (nom, chiffres, captures) qu'avec son accord écrit (spec des cas d'usage) : Keolis et SNCF le
// sont sur la maquette de Julien, NEOMA, EDH et EDHEC sur les siennes.

import type { Langue } from './cas-textes';

/** Le logo d'un client, sur fond blanc ; sa hauteur affichée vit dans `site.css` (`.sec-logo img[src$=...]`). */
export interface LogoClient { readonly src: string; readonly alt: string; readonly largeur: number; readonly hauteur: number }

/** Un autre cas du secteur, en carte sous le film (page Enseignement supérieur). */
export interface AutreCas {
  readonly logo: LogoClient;
  readonly titre: string;
  readonly texte: string;
  readonly chiffres?: ReadonlyArray<{ readonly valeur: string; readonly texte: string }>;
  /** Ce que le cas cherche à obtenir, quand il n'a pas de chiffre publié. */
  readonly resultat?: string;
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
  'enseignement-superieur': {
    fr: {
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
