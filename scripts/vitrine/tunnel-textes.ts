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

import { DROITS, ESSAI_PRO_JOURS, PRIX_PRO_HT_CENTIMES } from '../../src/offres/offres';
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

/** La page qui porte le tunnel : la demande à coller en dépend, jamais les questions. */
export type Origine = 'generique' | 'shopify' | 'saas';
export type OffreTunnel = 'free' | 'pro';

/** Une réponse mène à une autre question ou à une issue (`vers`) ; sans `vers`, elle montre l'aide de sa question.
 * `note` : une phrase qui s'affiche sous la question quand on la choisit (où vérifier son compte Meta Business).
 * `offre` : la réponse choisit l'offre, et chaque issue ne montre ensuite que les boutons de cette offre. */
export interface Reponse { readonly libelle: string; readonly vers?: string; readonly note?: string; readonly offre?: OffreTunnel }
/** `voies` : des cartes côte à côte, et SOUS chacune la réponse de même rang (Julien, 2026-10-27 : sinon on ne sait
 * pas quel bouton va avec quelle carte) ; une réponse sans `vers` (« Je ne sais pas ») reste dessous. */
export interface Question { readonly id: string; readonly texte: string; readonly precision?: string; readonly aide?: string; readonly reponses: readonly Reponse[]; readonly voies?: readonly Voie[]; readonly logo?: string }
/** Une carte d'un choix (une offre), avec ce qu'elle apporte et ce qu'elle coûte. */
export interface Voie { readonly titre: string; readonly plus: readonly string[]; readonly moins: readonly string[] }
/**
 * Une issue : `situation` se lit sans script, quand toutes les issues s'affichent l'une sous l'autre. `autre` mène à une
 * autre issue (le numéro API rappelle qu'on peut garder son application). `numero` : ce que la demande à coller dit du
 * numéro, par offre (le numéro fourni n'a pas le même prix) ; `pasAPas` : la fiche d'aide de ce chemin, pour le Pro.
 */
export interface Issue {
  readonly id: string; readonly situation: string; readonly titre: string; readonly textes: readonly string[];
  readonly autre?: { readonly question: string; readonly lien: string; readonly vers: string };
  readonly numero: Readonly<Record<OffreTunnel, string>>;
  readonly pasAPas: string;
}

export interface TexteTunnel {
  readonly surtitre: string; readonly titre: readonly [string, string]; readonly chapeau: string;
  /** Les mots que personne ne comprend (Julien, 2026-10-24), repliés sous le tunnel. */
  readonly lexique: { readonly titre: string; readonly termes: ReadonlyArray<{ readonly terme: string; readonly definition: string }> };
  readonly questions: readonly Question[]; readonly issues: readonly Issue[];
  readonly plus: string; readonly moins: string; readonly recommencer: string;
  /** L'étape en cours (`{n}` son rang, `{max}` le plus long parcours de l'arbre, que `tunnel.ts` calcule), le mot de
   * l'issue, et le lien qui rouvre une réponse. */
  readonly progression: string; readonly fin: string; readonly modifier: string;
  /** Les mots des boutons de bout de tunnel : le titre de chaque offre, ses boutons, la demande et sa copie. */
  readonly appels: {
    readonly free: string; readonly pro: string; readonly plugin: string; readonly github: string;
    readonly demandeFree: string; readonly demandePro: string; readonly copier: string; readonly copie: string;
    readonly compte: string; readonly pasAPas: string;
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
      moins: ['Pas de console : vous pilotez depuis votre assistant IA.', `${milliers(limite('base', 'contacts'), 'fr')} contacts et ${milliers(limite('base', 'envoisModelesMois'), 'fr')} messages envoyés par mois.`],
    },
    {
      titre: `Pro, ${euros(PRIX_PRO_HT_CENTIMES.mois, 'fr')} HT par mois`,
      plus: ['La console : l’Inbox de l’équipe, les campagnes, les tableaux de bord.', 'Un numéro fourni, inclus.', `${ESSAI_PRO_JOURS}&nbsp;jours d’essai la première fois.`],
      moins: ['Une carte demandée dès l’essai.'],
    },
  ];
  const garder = 'Pas de compte Meta Business ? La fenêtre de Meta le crée en chemin, avec votre profil Facebook, puis vous propose un moyen de paiement.';
  return {
    surtitre: 'Votre numéro WhatsApp',
    titre: ['Votre branchement', 'commence ici.'],
    chapeau: 'En trois questions au plus, sur votre offre, votre compte Meta Business et votre application WhatsApp Business, vous savez quoi faire.',
    lexique: {
      titre: 'Les quatre mots employés ici',
      termes: [
        { terme: 'Le compte Meta Business', definition: `Le compte de votre entreprise chez Meta (un «&nbsp;portefeuille&nbsp;», l’ancien Business Manager), sur ${META_BUSINESS}. Si vous faites de la publicité sur Facebook ou Instagram, vous en avez sans doute un. Sinon, rien à préparer : il est gratuit, et la fenêtre de Meta vous le fait créer en chemin, avec votre profil Facebook.` },
        { terme: 'L’application WhatsApp Business', definition: 'L’application des professionnels, distincte de WhatsApp, à télécharger sur un téléphone, avec le numéro de votre entreprise.' },
        { terme: 'Le numéro API', definition: 'Un numéro relié par Meta à l’API officielle de WhatsApp, que pilote Messaging Me : c’est lui qui envoie vos messages (confirmations, rappels, relances), et Meta facture ses messages.' },
        { terme: 'Garder votre application', definition: 'Le numéro de votre application WhatsApp Business devient aussi un numéro API, sans la quitter : vous répondez toujours depuis votre téléphone, et vos messages partent aussi de Messaging Me.' },
      ],
    },
    // L'arbre de Julien du 2026-10-30 : l'offre, le compte Meta Business, puis l'application WhatsApp Business.
    questions: [
      {
        id: 'offre', texte: 'Quelle offre voulez-vous ?', precision: 'Vous pourrez en changer plus tard.',
        aide: 'La Free suffit pour commencer : vous pilotez tout depuis Claude Code ou Codex, et votre agent IA répond à vos clients. Le Pro ajoute la console, pour vous et votre équipe, et un numéro fourni.',
        voies: offres,
        reponses: [
          { libelle: 'La Free', vers: 'compte', offre: 'free' },
          { libelle: 'Le Pro', vers: 'compte', offre: 'pro' },
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
          `Un numéro libre, qui ne sert ni dans WhatsApp ni dans l’application WhatsApp Business, devient votre numéro API. Sans numéro libre, prenez un numéro fourni : ${numero} HT par mois avec la Free, inclus dans le Pro.`,
          'Meta facture vos messages, et les réponses au-delà d’une franchise mensuelle : un moyen de paiement s’ajoute chez Meta.',
        ],
        autre: { question: 'Votre numéro est déjà dans l’application WhatsApp Business ?', lien: 'Vous pouvez la garder', vers: 'garder' },
        numero: {
          free: `J’ai un compte Meta Business : relie mon numéro libre par Meta en numéro API, ou, si je n’en ai pas, fournis-m’en un (${numero} HT par mois).`,
          pro: 'J’ai un compte Meta Business : relie mon numéro libre par Meta en numéro API, ou, si je n’en ai pas, fournis-m’en un (inclus dans le Pro).',
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
        numero: memes('Je viens d’installer l’application WhatsApp Business avec mon numéro et je veux la garder : relie-le par Meta pour qu’il envoie aussi depuis Messaging Me, guide-moi pour créer mon compte Meta Business en chemin, et si Meta refuse un numéro trop neuf, dis-le-moi : je reviendrai dans quelques jours.'),
        pasAPas: '/aide/garder-mon-application-whatsapp-business/',
      },
    ],
    plus: 'Pour :', moins: 'Contre :',
    recommencer: 'Recommencer',
    progression: 'Question {n} sur {max} au plus', fin: 'Votre chemin', modifier: 'Modifier',
    appels: {
      free: 'Avec la Free, depuis votre assistant IA', pro: 'Avec le Pro',
      plugin: 'Installer le plugin', github: 'Le dépôt GitHub',
      demandeFree: 'Votre demande, à coller dans Claude Code ou Codex une fois Messaging Me installé :',
      demandePro: 'Ou votre demande, à coller dans Claude Code ou Codex :',
      copier: 'Copier', copie: 'Copié',
      compte: 'Créer mon espace', pasAPas: 'Le pas-à-pas',
    },
    demande: {
      debut: {
        generique: { free: 'Mets en service WhatsApp avec l’offre Free de Messaging Me.', pro: 'Mets en service WhatsApp avec l’offre Pro de Messaging Me.' },
        shopify: { free: 'Branche ma boutique Shopify sur WhatsApp avec l’offre Free de Messaging Me.', pro: 'Branche ma boutique Shopify sur WhatsApp avec l’offre Pro de Messaging Me.' },
        saas: { free: 'Branche WhatsApp à mon app avec l’offre Free de Messaging Me.', pro: 'Branche WhatsApp à mon app avec l’offre Pro de Messaging Me.' },
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
      moins: ['No console: you drive everything from your AI assistant.', `${milliers(limite('base', 'contacts'), 'en')} contacts and ${milliers(limite('base', 'envoisModelesMois'), 'en')} messages sent a month.`],
    },
    {
      titre: `Pro, ${euros(PRIX_PRO_HT_CENTIMES.mois, 'en')} excl. VAT a month`,
      plus: ['The console: the team Inbox, campaigns, dashboards.', 'A provided number, included.', `A ${ESSAI_PRO_JOURS}-day trial the first time.`],
      moins: ['A card required from the trial.'],
    },
  ];
  const garder = 'No Meta Business account? Meta’s window creates it along the way, with your Facebook profile, then offers a payment method.';
  return {
    surtitre: 'Your WhatsApp number',
    titre: ['Your setup', 'starts here.'],
    chapeau: 'In three questions at most, about your plan, your Meta Business account and your WhatsApp Business app, you know what to do.',
    lexique: {
      titre: 'The four words used here',
      termes: [
        { terme: 'The Meta Business account', definition: `Your business’s account at Meta (a “portfolio”, formerly Business Manager), on ${META_BUSINESS}. If you advertise on Facebook or Instagram, you probably have one. Otherwise, nothing to prepare: it is free, and Meta’s window has you create it along the way, with your Facebook profile.` },
        { terme: 'The WhatsApp Business app', definition: 'The app for businesses, separate from WhatsApp, to download on a phone, with your business’s number.' },
        { terme: 'The API number', definition: 'A number connected through Meta to the official WhatsApp API, driven by Messaging Me: it sends your messages (confirmations, reminders, follow-ups), and Meta bills its messages.' },
        { terme: 'Keeping your app', definition: 'Your WhatsApp Business app number also becomes an API number, without leaving the app: you still reply from your phone, and your messages also go out from Messaging Me.' },
      ],
    },
    questions: [
      {
        id: 'offre', texte: 'Which plan do you want?', precision: 'You can change it later.',
        aide: 'The Free plan is enough to start: you drive everything from Claude Code or Codex, and your AI agent answers your customers. Pro adds the console, for you and your team, and a provided number.',
        voies: offres,
        reponses: [
          { libelle: 'The Free plan', vers: 'compte', offre: 'free' },
          { libelle: 'The Pro plan', vers: 'compte', offre: 'pro' },
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
        numero: memes('I just installed the WhatsApp Business app with my number and I want to keep it: connect it through Meta so it also sends from Messaging Me, walk me through creating my Meta Business account along the way, and if Meta refuses a number that is too new, tell me: I will come back in a few days.'),
        pasAPas: '/en/help/keep-my-whatsapp-business-app/',
      },
    ],
    plus: 'For:', moins: 'Against:',
    recommencer: 'Start again',
    progression: 'Question {n} of {max} at most', fin: 'Your path', modifier: 'Change',
    appels: {
      free: 'With the Free plan, from your AI assistant', pro: 'With the Pro plan',
      plugin: 'Install the plugin', github: 'The GitHub repository',
      demandeFree: 'Your request, to paste into Claude Code or Codex once Messaging Me is installed:',
      demandePro: 'Or your request, to paste into Claude Code or Codex:',
      copier: 'Copy', copie: 'Copied',
      compte: 'Create my workspace', pasAPas: 'The step-by-step guide',
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

/** La demande à coller d'une issue, pour une offre et une page d'origine : elle reprend les réponses du tunnel. */
export const demandeDe = (t: TexteTunnel, x: Issue, offre: OffreTunnel, origine: Origine): string =>
  `${t.demande.debut[origine][offre]} ${x.numero[offre]} ${t.demande.fin[origine]}`;
