// scripts/vitrine/tunnel-textes.ts
// Les textes du tunnel du numéro WhatsApp, en français et en anglais : l'arbre de Julien du 2026-10-30, le même sur
// chaque page qui le porte (la page « Démarrer », Boutiques Shopify, SaaS et app builders), que `tunnel.ts` assemble.
// Plan `docs/superpowers/plans/2026-10-30-tunnel-numero-generique.md`.
//
// 🔴 CE QUE LE TUNNEL NE DIT PLUS : le numéro relié par code, qui ne faisait que répondre (Julien, 2026-10-30 : « on
// supprime une bonne fois pour toutes l'option QR code »). Chaque voie mène à un numéro de l'API officielle, et
// l'application WhatsApp Business se garde. Ni « QR code » ni « coexistence » face au visiteur, ni « boutique » dans
// les questions : seule la demande à coller s'adapte à la page d'origine (`Origine`).
// Les chiffres viennent du code : les offres de `src/offres/offres.ts`, le numéro fourni de `src/stripe/abonnement.ts`
// (`PRIX_NUMERO_AFFICHE_HT_CENTIMES`, gardé égal par `tests/vitrine-tunnel.test.ts`).
// Les textes sont du HTML écrit par nous (`&nbsp;` compris) ; le français reçoit ses espaces insécables à l'assemblage.

import { DROITS, ESSAI_PRO_JOURS, PRIX_BUSINESS_HT_CENTIMES, PRIX_PRO_HT_CENTIMES } from '../../src/offres/offres';
import type { Langue } from './cas-textes';

/** Le numéro fourni, en centimes HT par mois : la valeur de `PRIX_NUMERO_HT_CENTIMES`, gardée égale par le test. */
export const PRIX_NUMERO_AFFICHE_HT_CENTIMES = 350;

export const euros = (centimes: number, langue: Langue): string => {
  const entier = centimes % 100 === 0;
  const n = (centimes / 100).toFixed(entier ? 0 : 2);
  return langue === 'fr' ? `${n.replace('.', ',')}&nbsp;€` : `€${n}`;
};
/** Une limite chiffrée de l'offre ; une limite absente (illimitée) n'a rien à faire dans une phrase qui la chiffre. */
export const limite = (offre: 'base' | 'pro', nom: 'contacts' | 'envoisModelesMois' | 'utilisateurs'): number => {
  const v = DROITS[offre].limites[nom];
  if (v === null) throw new Error(`tunnel-textes : ${offre}.${nom} est illimité`);
  return v;
};
/** Une phrase du numéro qui ne dépend pas de l'offre. */
const memes = (p: string): Readonly<Record<OffreTunnel, string>> => ({ free: p, pro: p });
export const milliers = (n: number, langue: Langue): string =>
  (langue === 'fr' ? n.toLocaleString('fr-FR').replace(/\s/g, '&nbsp;') : n.toLocaleString('en-US'));
/** L'icône de l'application WhatsApp Business (la bulle au « + »), à côté de la question qui la nomme. */
const LOGO_APPLICATION = '/img/logos/whatsapp-business.png';
const META_BUSINESS = '<a href="https://business.facebook.com/" rel="noopener">business.facebook.com</a>';
/** Les fiches officielles de l'application WhatsApp Business (vérifiées le 2026-10-30 : 200, « WhatsApp Business App »). */
export const MAGASINS = {
  appStore: 'https://apps.apple.com/app/whatsapp-business/id1386412985',
  googlePlay: 'https://play.google.com/store/apps/details?id=com.whatsapp.w4b',
  metaBusiness: 'https://business.facebook.com/',
} as const;

/** La page qui porte le tunnel : la demande à coller en dépend, jamais les questions. */
export type Origine = 'generique' | 'shopify' | 'saas';
/** Les formules qui se branchent depuis le tunnel ; Business et Entreprise se décident avec nous (Julien, 2026-10-30). */
export type OffreTunnel = 'free' | 'pro';
export type FormuleTunnel = OffreTunnel | 'business' | 'entreprise';
/** Un lien externe, sous un mot du lexique ou dans une issue (les magasins d'applications, le compte Meta Business). */
export interface Lien { readonly libelle: string; readonly href: string }

/** Une réponse mène à une autre question ou à une issue (`vers`) ; sans `vers`, elle montre l'aide de sa question.
 * `note` : une phrase qui s'affiche sous la question quand on la choisit (où vérifier son compte Meta Business).
 * `offre` : la réponse choisit la formule, et chaque issue ne montre ensuite que les boutons de cette formule. */
export interface Reponse { readonly libelle: string; readonly vers?: string; readonly note?: string; readonly offre?: FormuleTunnel }
/** `voies` : des cartes côte à côte, et SOUS chacune la réponse de même rang (Julien, 2026-10-27 : sinon on ne sait
 * pas quel bouton va avec quelle carte) ; une réponse sans `vers` (« Je ne sais pas ») reste dessous. */
export interface Question { readonly id: string; readonly texte: string; readonly precision?: string; readonly aide?: string; readonly reponses: readonly Reponse[]; readonly voies?: readonly Voie[]; readonly logo?: string }
/** Une carte d'un choix (une offre), avec ce qu'elle apporte et ce qu'elle coûte. */
export interface Voie { readonly titre: string; readonly plus: readonly string[]; readonly moins: readonly string[] }
/**
 * Une issue : `situation` se lit sans script, quand toutes les issues s'affichent l'une sous l'autre. `autre` mène à une
 * autre issue (le numéro API rappelle qu'on peut garder son application) ; `liens` : des boutons vers l'extérieur (les
 * magasins d'applications). Une issue de branchement porte `numero`, ce que la demande à coller dit du numéro, par
 * formule (le numéro fourni n'a pas le même prix), et `pasAPas`, la fiche d'aide de ce chemin, pour Pro ; une issue
 * `contact` (Business et Entreprise) finit sur la démo et le contact, sans demande à coller.
 */
export type Issue = {
  readonly id: string; readonly situation: string; readonly titre: string; readonly textes: readonly string[];
  readonly autre?: { readonly question: string; readonly lien: string; readonly vers: string };
  readonly liens?: readonly Lien[];
} & (
  | { readonly contact?: undefined; readonly numero: Readonly<Record<OffreTunnel, string>>; readonly pasAPas: string }
  | { readonly contact: true; readonly numero?: undefined; readonly pasAPas?: undefined }
);
/** Un mot du lexique : le mot et sa phrase courte, visibles ; le détail et ses liens, au clic. */
export interface Mot { readonly terme: string; readonly court: string; readonly detail: string; readonly liens?: readonly Lien[] }

export interface TexteTunnel {
  readonly surtitre: string; readonly titre: readonly [string, string]; readonly chapeau: string;
  /** Les mots que personne ne comprend (Julien, 2026-10-24), repliés sous le tunnel, un par ligne et dépliables un à un
   * (Julien, 2026-10-30 : « ça donne pas envie de le lire »). Le titre ne compte pas les mots. */
  readonly lexique: { readonly titre: string; readonly termes: readonly Mot[] };
  readonly questions: readonly Question[]; readonly issues: readonly Issue[];
  readonly plus: string; readonly moins: string; readonly recommencer: string;
  /** Les flèches du carrousel des formules, sur le bureau. */
  readonly defiler: { readonly precedente: string; readonly suivante: string };
  /** L'étape en cours (`{n}` son rang, `{max}` le plus long parcours de l'arbre, que `tunnel.ts` calcule), et le mot
   * de l'issue. */
  readonly progression: string; readonly fin: string;
  /** Les mots des boutons de bout de tunnel : le titre de chaque offre, ses boutons, la demande et sa copie. */
  readonly appels: {
    readonly free: string; readonly pro: string; readonly plugin: string; readonly github: string;
    readonly demandeFree: string; readonly demandePro: string; readonly copier: string; readonly copie: string;
    readonly compte: string; readonly pasAPas: string;
    /** La fin de Business et Entreprise : son titre, la démo et le contact. */
    readonly equipe: string; readonly demo: string; readonly contacter: string;
  };
  /** La demande à coller : son début (la page d'origine et l'offre), la phrase du numéro de l'issue, puis sa fin. */
  readonly demande: { readonly debut: Readonly<Record<Origine, Readonly<Record<OffreTunnel, string>>>>; readonly fin: Readonly<Record<Origine, string>> };
}

const fr = (): TexteTunnel => {
  const numero = euros(PRIX_NUMERO_AFFICHE_HT_CENTIMES, 'fr');
  const offres: readonly Voie[] = [
    {
      titre: 'Free, 0&nbsp;€ d’abonnement',
      plus: ['Tout se fait en parlant à Claude Code ou Codex : votre numéro, votre agent IA, vos messages.', 'Sans limite de durée.'],
      moins: ['Pas de console : il faut un agent IA comme Claude Code ou Codex.', `${milliers(limite('base', 'contacts'), 'fr')} contacts et ${milliers(limite('base', 'envoisModelesMois'), 'fr')} messages envoyés par mois.`],
    },
    {
      titre: `Pro, ${euros(PRIX_PRO_HT_CENTIMES.mois, 'fr')} HT par mois`,
      plus: ['La console : l’Inbox de l’équipe, les campagnes, les tableaux de bord.', 'Un numéro fourni, inclus.', `${ESSAI_PRO_JOURS}&nbsp;jours d’essai la première fois.`],
      moins: ['Une carte demandée dès l’essai.'],
    },
    // Business et Entreprise (Julien, 2026-10-30) : leur contenu est celui de la page Tarifs, tenue égale au code.
    {
      titre: `Business, ${euros(PRIX_BUSINESS_HT_CENTIMES.mois, 'fr')} HT par mois`,
      plus: ['Tout Pro, plus le Meta Business Agent et HubSpot.', `${DROITS.business.limites.utilisateurs}&nbsp;utilisateurs et un accompagnement les deux premiers mois.`],
      moins: ['Sur facture, après un échange avec nous.'],
    },
    {
      titre: 'Entreprise, sur devis',
      plus: ['Tout Business, plus le RCS, Salesforce, l’analyse des conversations et les publicités Click-to-WhatsApp.', 'Contacts, utilisateurs et webhooks à votre mesure.'],
      moins: ['Un devis selon votre volume.'],
    },
  ];
  const garder = 'Pas de compte Meta Business ? La fenêtre de Meta le crée en chemin, avec votre profil Facebook, puis vous propose un moyen de paiement.';
  const magasins: readonly Lien[] = [{ libelle: 'App Store (iPhone)', href: MAGASINS.appStore }, { libelle: 'Google Play (Android)', href: MAGASINS.googlePlay }];
  return {
    surtitre: 'Votre numéro WhatsApp',
    titre: ['Votre branchement', 'commence ici.'],
    chapeau: 'En trois questions au plus, sur votre formule, votre compte Meta Business et votre application WhatsApp Business, vous savez quoi faire.',
    lexique: {
      titre: 'Les mots de ce guide, expliqués',
      termes: [
        {
          terme: 'Le compte Meta Business', court: 'Le compte de votre entreprise chez Meta, l’ancien Business Manager.',
          detail: 'Si vous faites de la publicité sur Facebook ou Instagram, vous en avez sans doute un. Sinon, rien à préparer : il est gratuit, et la fenêtre de Meta vous le fait créer en chemin, avec votre profil Facebook.',
          liens: [{ libelle: 'Voir mon compte Meta Business', href: MAGASINS.metaBusiness }],
        },
        {
          terme: 'L’application WhatsApp Business', court: 'L’application des professionnels, distincte de WhatsApp.',
          detail: 'Elle s’installe sur un téléphone, avec le numéro de votre entreprise. Gardée, elle continue de vous servir pendant que Messaging Me envoie vos messages.',
          liens: magasins,
        },
        {
          terme: 'Le numéro API', court: 'Le numéro relié par Meta à l’API officielle de WhatsApp.',
          detail: 'C’est lui qui envoie vos messages (confirmations, rappels, relances), pilotés par Messaging Me. Meta facture ses messages.',
        },
        {
          terme: 'Garder votre application', court: 'Votre numéro reste dans l’application et envoie aussi depuis Messaging Me.',
          detail: 'Il devient aussi un numéro API : vous répondez toujours depuis votre téléphone, et vos confirmations, rappels et relances partent de Messaging Me.',
        },
      ],
    },
    // L'arbre de Julien du 2026-10-30 : l'offre, le compte Meta Business, puis l'application WhatsApp Business.
    questions: [
      {
        id: 'offre', texte: 'Quelle formule voulez-vous ?', precision: 'Vous pourrez en changer plus tard.',
        aide: 'Free se pilote uniquement depuis un agent IA comme Claude Code ou Codex : sans lui, Free ne marche pas. Sans agent IA, choisissez Pro : la console, pour vous et votre équipe, avec un numéro fourni.',
        voies: offres,
        reponses: [
          { libelle: 'Free', vers: 'compte', offre: 'free' },
          { libelle: 'Pro', vers: 'compte', offre: 'pro' },
          { libelle: 'Business', vers: 'echange', offre: 'business' },
          { libelle: 'Entreprise', vers: 'echange', offre: 'entreprise' },
          { libelle: 'Je ne sais pas' },
        ],
      },
      {
        id: 'compte', texte: 'Avez-vous un compte Meta Business ?', precision: 'L’ancien Business Manager : le compte de votre entreprise chez Meta.',
        reponses: [
          { libelle: 'Oui', vers: 'api' },
          { libelle: 'Non', vers: 'application', note: 'Rien à préparer : la fenêtre de Meta vous le fera créer en chemin.' },
          { libelle: 'Je ne sais pas', vers: 'application', note: `Pour le vérifier : ${META_BUSINESS}. Si vous faites de la publicité sur Facebook ou Instagram, vous en avez sans doute un. Sinon, la fenêtre de Meta vous le fera créer en chemin.` },
        ],
      },
      {
        id: 'application', texte: 'Avez-vous déjà l’application WhatsApp Business ?', precision: 'L’application des professionnels, distincte de WhatsApp.', logo: LOGO_APPLICATION,
        reponses: [{ libelle: 'Oui', vers: 'garder' }, { libelle: 'Non', vers: 'telecharger' }],
      },
    ],
    issues: [
      {
        id: 'api', situation: 'Avec un compte Meta Business', titre: 'Votre numéro API',
        textes: [
          'La fenêtre de Meta prend votre compte Meta Business et relie votre numéro à l’API officielle de WhatsApp : il envoie vos messages, et votre agent IA répond.',
          `Un numéro libre, qui ne sert ni dans WhatsApp ni dans l’application WhatsApp Business, devient votre numéro API. Sans numéro libre, prenez un numéro fourni : ${numero} HT par mois en formule Free, inclus en formule Pro.`,
          'Meta facture vos messages, et les réponses au-delà d’une franchise mensuelle : un moyen de paiement s’ajoute chez Meta.',
        ],
        autre: { question: 'Votre numéro est déjà dans l’application WhatsApp Business ?', lien: 'Vous pouvez la garder', vers: 'garder' },
        numero: {
          free: `J’ai un compte Meta Business : relie mon numéro libre par Meta en numéro API, ou, si je n’en ai pas, fournis-m’en un (${numero} HT par mois).`,
          pro: 'J’ai un compte Meta Business : relie mon numéro libre par Meta en numéro API, ou, si je n’en ai pas, fournis-m’en un (inclus en formule Pro).',
        },
        pasAPas: '/aide/connecter-mon-numero-whatsapp/',
      },
      {
        id: 'garder', situation: 'Avec l’application WhatsApp Business', titre: 'Gardez votre application WhatsApp Business',
        textes: [
          'Votre numéro reste dans l’application et envoie aussi depuis Messaging Me : vous répondez toujours depuis votre téléphone, et vos confirmations, rappels et relances partent de Messaging Me.',
          `${garder} Meta facture les messages partis de Messaging Me, réponses comprises au-delà d’une franchise mensuelle ; ceux que vous tapez dans l’application restent gratuits.`,
          'Quelques fonctions de l’application s’arrêtent, comme les listes de diffusion et le message d’absence, et il faut l’ouvrir au moins toutes les deux semaines. Ce que vous y tapez n’apparaît pas dans Messaging Me : votre agent IA ne voit pas vos réponses.',
        ],
        numero: memes('Mon numéro est dans l’application WhatsApp Business et je veux la garder : relie-le par Meta pour qu’il envoie aussi depuis Messaging Me, et s’il me manque un compte Meta Business, guide-moi pour le créer en chemin.'),
        pasAPas: '/aide/garder-mon-application-whatsapp-business/',
      },
      {
        // Julien, 2026-10-30 : on branche tout de suite ; si Meta refuse un numéro trop neuf, on revient quelques jours
        // après. Meta ne publie aucun seuil : aucun nombre de jours ici.
        id: 'telecharger', situation: 'Sans l’application WhatsApp Business', titre: 'Téléchargez l’application WhatsApp Business',
        textes: [
          'Installez l’application WhatsApp Business sur un téléphone, avec le numéro de votre entreprise, puis branchez-le tout de suite en gardant l’application : votre numéro reste sur votre téléphone et envoie aussi depuis Messaging Me.',
          garder,
          'Meta refuse parfois un numéro trop neuf : servez-vous alors de l’application quelques jours, puis revenez le brancher.',
        ],
        liens: magasins,
        numero: memes('Je viens d’installer l’application WhatsApp Business avec mon numéro et je veux la garder : relie-le par Meta pour qu’il envoie aussi depuis Messaging Me, guide-moi pour créer mon compte Meta Business en chemin, et si Meta refuse un numéro trop neuf, dis-le-moi : je reviendrai dans quelques jours.'),
        pasAPas: '/aide/garder-mon-application-whatsapp-business/',
      },
      {
        // Business et Entreprise ne se branchent pas seuls (Julien, 2026-10-30 : « request a demo ou contact »), et ce
        // que la page Tarifs en dit (sur facture, essai sur demande, devis) se reprend ici mot pour mot.
        id: 'echange', situation: 'En formule Business ou Entreprise', titre: 'Parlons de votre projet', contact: true,
        textes: [
          'Business et Entreprise se mettent en place après un échange avec nous : nous posons la formule sur votre espace, sur facture, sans paiement en ligne, et nous vous accompagnons dans la mise en service.',
          'Un essai de 14&nbsp;jours de Business est possible sur demande. Entreprise se chiffre sur devis, selon votre volume.',
        ],
      },
    ],
    plus: 'Pour :', moins: 'Contre :',
    defiler: { precedente: 'Formules précédentes', suivante: 'Formules suivantes' },
    recommencer: 'Recommencer',
    progression: 'Question {n} sur {max} au plus', fin: 'Votre chemin',
    appels: {
      free: 'En formule Free, depuis votre assistant IA', pro: 'En formule Pro',
      plugin: 'Installer le plugin', github: 'Le dépôt GitHub',
      demandeFree: 'Votre demande, à coller dans Claude Code ou Codex une fois Messaging Me installé :',
      demandePro: 'Ou votre demande, à coller dans Claude Code ou Codex :',
      copier: 'Copier', copie: 'Copié',
      compte: 'Créer mon espace', pasAPas: 'Le pas-à-pas',
      equipe: 'Avec notre équipe', demo: 'Demander une démo', contacter: 'Nous contacter',
    },
    demande: {
      debut: {
        generique: { free: 'Mets en service WhatsApp avec la formule Free de Messaging Me.', pro: 'Mets en service WhatsApp avec la formule Pro de Messaging Me.' },
        shopify: { free: 'Branche ma boutique Shopify sur WhatsApp avec la formule Free de Messaging Me.', pro: 'Branche ma boutique Shopify sur WhatsApp avec la formule Pro de Messaging Me.' },
        saas: { free: 'Branche WhatsApp à mon app avec la formule Free de Messaging Me.', pro: 'Branche WhatsApp à mon app avec la formule Pro de Messaging Me.' },
      },
      fin: {
        generique: 'Puis crée mon agent IA à partir de mon site, pour qu’il réponde à mes clients.',
        shopify: 'Envoie la confirmation de commande, l’avis d’expédition et la relance de panier, et crée mon agent IA à partir de mon site.',
        saas: 'Puis crée la clé d’API de mon app, et mon agent IA à partir de mon site.',
      },
    },
  };
};

const en = (): TexteTunnel => {
  const numero = euros(PRIX_NUMERO_AFFICHE_HT_CENTIMES, 'en');
  const offres: readonly Voie[] = [
    {
      titre: 'Free, €0 a month',
      plus: ['Everything happens by talking to Claude Code or Codex: your number, your AI agent, your messages.', 'With no time limit.'],
      moins: ['No console: you need an AI agent such as Claude Code or Codex.', `${milliers(limite('base', 'contacts'), 'en')} contacts and ${milliers(limite('base', 'envoisModelesMois'), 'en')} messages sent a month.`],
    },
    {
      titre: `Pro, ${euros(PRIX_PRO_HT_CENTIMES.mois, 'en')} excl. VAT a month`,
      plus: ['The console: the team Inbox, campaigns, dashboards.', 'A provided number, included.', `A ${ESSAI_PRO_JOURS}-day trial the first time.`],
      moins: ['A card required from the trial.'],
    },
    {
      titre: `Business, ${euros(PRIX_BUSINESS_HT_CENTIMES.mois, 'en')} excl. VAT a month`,
      plus: ['Everything in Pro, plus the Meta Business Agent and HubSpot.', `${DROITS.business.limites.utilisateurs} users and dedicated support for the first two months.`],
      moins: ['Invoiced, after a conversation with us.'],
    },
    {
      titre: 'Enterprise, on quote',
      plus: ['Everything in Business, plus RCS, Salesforce, conversation analysis and Click-to-WhatsApp ads.', 'Contacts, users and webhooks sized for you.'],
      moins: ['A quote based on your volume.'],
    },
  ];
  const garder = 'No Meta Business account? Meta’s window creates it along the way, with your Facebook profile, then offers a payment method.';
  const magasins: readonly Lien[] = [{ libelle: 'App Store (iPhone)', href: MAGASINS.appStore }, { libelle: 'Google Play (Android)', href: MAGASINS.googlePlay }];
  return {
    surtitre: 'Your WhatsApp number',
    titre: ['Your setup', 'starts here.'],
    chapeau: 'In three questions at most, about your plan, your Meta Business account and your WhatsApp Business app, you know what to do.',
    lexique: {
      titre: 'The words of this guide, explained',
      termes: [
        {
          terme: 'The Meta Business account', court: 'Your business’s account at Meta, formerly Business Manager.',
          detail: 'If you advertise on Facebook or Instagram, you probably have one. Otherwise, nothing to prepare: it is free, and Meta’s window has you create it along the way, with your Facebook profile.',
          liens: [{ libelle: 'See my Meta Business account', href: MAGASINS.metaBusiness }],
        },
        {
          terme: 'The WhatsApp Business app', court: 'The app for businesses, separate from WhatsApp.',
          detail: 'It installs on a phone, with your business’s number. Kept, it keeps serving you while Messaging Me sends your messages.',
          liens: magasins,
        },
        {
          terme: 'The API number', court: 'The number connected through Meta to the official WhatsApp API.',
          detail: 'It sends your messages (confirmations, reminders, follow-ups), driven by Messaging Me. Meta bills its messages.',
        },
        {
          terme: 'Keeping your app', court: 'Your number stays in the app and also sends from Messaging Me.',
          detail: 'It also becomes an API number: you still reply from your phone, and your confirmations, reminders and follow-ups go out from Messaging Me.',
        },
      ],
    },
    questions: [
      {
        id: 'offre', texte: 'Which plan do you want?', precision: 'You can change it later.',
        aide: 'Free is driven only from an AI agent such as Claude Code or Codex: without one, Free does not work. Without an AI agent, choose Pro: the console, for you and your team, with a provided number.',
        voies: offres,
        reponses: [
          { libelle: 'Free', vers: 'compte', offre: 'free' },
          { libelle: 'Pro', vers: 'compte', offre: 'pro' },
          { libelle: 'Business', vers: 'echange', offre: 'business' },
          { libelle: 'Enterprise', vers: 'echange', offre: 'entreprise' },
          { libelle: 'I don’t know' },
        ],
      },
      {
        id: 'compte', texte: 'Do you have a Meta Business account?', precision: 'Formerly Business Manager: your business’s account at Meta.',
        reponses: [
          { libelle: 'Yes', vers: 'api' },
          { libelle: 'No', vers: 'application', note: 'Nothing to prepare: Meta’s window will have you create it along the way.' },
          { libelle: 'I don’t know', vers: 'application', note: `To check: ${META_BUSINESS}. If you advertise on Facebook or Instagram, you probably have one. Otherwise, Meta’s window will have you create it along the way.` },
        ],
      },
      {
        id: 'application', texte: 'Do you already have the WhatsApp Business app?', precision: 'The app for businesses, separate from WhatsApp.', logo: LOGO_APPLICATION,
        reponses: [{ libelle: 'Yes', vers: 'garder' }, { libelle: 'No', vers: 'telecharger' }],
      },
    ],
    issues: [
      {
        id: 'api', situation: 'With a Meta Business account', titre: 'Your API number',
        textes: [
          'Meta’s window takes your Meta Business account and connects your number to the official WhatsApp API: it sends your messages, and your AI agent answers.',
          `An available number, not used in WhatsApp nor in the WhatsApp Business app, becomes your API number. Without an available number, take a provided one: ${numero} excl. VAT a month with the Free plan, included in Pro.`,
          'Meta bills your messages, and replies beyond a monthly allowance: a payment method is added at Meta.',
        ],
        autre: { question: 'Is your number already in the WhatsApp Business app?', lien: 'You can keep it', vers: 'garder' },
        numero: {
          free: `I have a Meta Business account: connect my available number through Meta as an API number, or, if I have none, provide one (${numero} excl. VAT a month).`,
          pro: 'I have a Meta Business account: connect my available number through Meta as an API number, or, if I have none, provide one (included in Pro).',
        },
        pasAPas: '/en/help/connect-my-whatsapp-number/',
      },
      {
        id: 'garder', situation: 'With the WhatsApp Business app', titre: 'Keep your WhatsApp Business app',
        textes: [
          'Your number stays in the app and also sends from Messaging Me: you still reply from your phone, and your confirmations, reminders and follow-ups go out from Messaging Me.',
          `${garder} Meta bills the messages sent from Messaging Me, replies included beyond a monthly allowance; those you type in the app stay free.`,
          'A few app features stop, such as broadcast lists and the away message, and you need to open the app at least every two weeks. What you type there does not show in Messaging Me: your AI agent does not see your replies.',
        ],
        numero: memes('My number is in the WhatsApp Business app and I want to keep it: connect it through Meta so it also sends from Messaging Me, and if I lack a Meta Business account, walk me through creating it along the way.'),
        pasAPas: '/en/help/keep-my-whatsapp-business-app/',
      },
      {
        id: 'telecharger', situation: 'Without the WhatsApp Business app', titre: 'Download the WhatsApp Business app',
        textes: [
          'Install the WhatsApp Business app on a phone, with your business’s number, then connect it right away while keeping the app: your number stays on your phone and also sends from Messaging Me.',
          garder,
          'Meta sometimes refuses a number that is too new: then use the app for a few days, and come back to connect it.',
        ],
        liens: magasins,
        numero: memes('I just installed the WhatsApp Business app with my number and I want to keep it: connect it through Meta so it also sends from Messaging Me, walk me through creating my Meta Business account along the way, and if Meta refuses a number that is too new, tell me: I will come back in a few days.'),
        pasAPas: '/en/help/keep-my-whatsapp-business-app/',
      },
      {
        id: 'echange', situation: 'With the Business or Enterprise plan', titre: 'Let’s talk about your project', contact: true,
        textes: [
          'Business and Enterprise are set up after a conversation with us: we put the plan on your workspace, invoiced, with no online payment, and we support you through the setup.',
          'A 14-day Business trial is possible on request. Enterprise is priced on quote, based on your volume.',
        ],
      },
    ],
    plus: 'For:', moins: 'Against:',
    defiler: { precedente: 'Previous plans', suivante: 'Next plans' },
    recommencer: 'Start again',
    progression: 'Question {n} of {max} at most', fin: 'Your path',
    appels: {
      free: 'With the Free plan, from your AI assistant', pro: 'With the Pro plan',
      plugin: 'Install the plugin', github: 'The GitHub repository',
      demandeFree: 'Your request, to paste into Claude Code or Codex once Messaging Me is installed:',
      demandePro: 'Or your request, to paste into Claude Code or Codex:',
      copier: 'Copy', copie: 'Copied',
      compte: 'Create my workspace', pasAPas: 'The step-by-step guide',
      equipe: 'With our team', demo: 'Request a demo', contacter: 'Contact us',
    },
    demande: {
      debut: {
        generique: { free: 'Set up WhatsApp with the Messaging Me Free plan.', pro: 'Set up WhatsApp with the Messaging Me Pro plan.' },
        shopify: { free: 'Connect my Shopify store to WhatsApp with the Messaging Me Free plan.', pro: 'Connect my Shopify store to WhatsApp with the Messaging Me Pro plan.' },
        saas: { free: 'Connect WhatsApp to my app with the Messaging Me Free plan.', pro: 'Connect WhatsApp to my app with the Messaging Me Pro plan.' },
      },
      fin: {
        generique: 'Then create my AI agent from my website, so it answers my customers.',
        shopify: 'Send the order confirmation, the shipping notice and the checkout reminder, and create my AI agent from my website.',
        saas: 'Then create my app’s API key, and my AI agent from my website.',
      },
    },
  };
};

export const TEXTES_TUNNEL: Readonly<Record<Langue, TexteTunnel>> = { fr: fr(), en: en() };

/** Une issue qui se branche depuis le tunnel (Free ou Pro), avec sa demande à coller. */
export type IssueBranchement = Extract<Issue, { readonly numero: Readonly<Record<OffreTunnel, string>> }>;

/** La demande à coller d'une issue, pour une offre et une page d'origine : elle reprend les réponses du tunnel. */
export const demandeDe = (t: TexteTunnel, x: IssueBranchement, offre: OffreTunnel, origine: Origine): string =>
  `${t.demande.debut[origine][offre]} ${x.numero[offre]} ${t.demande.fin[origine]}`;
