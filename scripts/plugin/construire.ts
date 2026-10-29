/**
 * « CE QUE VOUS POUVEZ CONSTRUIRE », EN MOTS DE MÉTIER, ÉCRIT UNE SEULE FOIS (Julien, 2026-10-21 : la page développeurs
 * et le README du plugin disaient comment brancher, jamais ce qu'on en fait). `npm run plugin:generer` le publie dans
 * les deux pages développeurs de la vitrine, entre leurs marques, et dans `plugin/README.md` ; `tests/plugin-readme.test.ts`
 * exige les copies identiques, chaque cas en ligne du registre cité, et chaque lien vers une page qui existe.
 *
 * Une ligne par capacité, qui mène à sa page : le cas d'usage du registre (son adresse suit le registre), une page de
 * la vitrine, ou une page de la documentation de la console (`PAGES_DOC`).
 */
import type { CleDePage } from '../../web/lib/doc-api-pages';

type Bilingue = { readonly fr: string; readonly en: string };

export type LienCapacite =
  | { readonly cas: string }
  | { readonly page: Bilingue }
  | { readonly doc: CleDePage };

export interface Capacite {
  readonly texte: Bilingue;
  readonly lien: LienCapacite;
}

/** L'icône d'une famille, sur la vitrine seulement (le README n'en porte pas). */
export type IconeFamille = 'chats' | 'cloche' | 'prises';

export interface FamilleCapacites {
  readonly titre: Bilingue;
  readonly icone: IconeFamille;
  readonly capacites: readonly Capacite[];
}

/**
 * Les trois icônes (Phosphor, graisse duotone, viewBox 256) : `fond` est la forme pleine à 20 %, `trait` le dessin.
 * Recopiées ici une fois, pour que le bloc généré ne dépende ni d'un paquet ni du jeu d'icônes de la page.
 */
export const ICONES_FAMILLES: Readonly<Record<IconeFamille, { readonly fond: string; readonly trait: string }>> = {
  chats: {
    fond: 'M231.66,213.73a8,8,0,0,1-9.93,9.93L194,215.5A72.05,72.05,0,0,1,92.06,175.89h0c1.31.07,2.62.11,3.94.11a72,72,0,0,0,67.93-95.88h0A72,72,0,0,1,223.5,186Z',
    trait: 'M232.07,186.76a80,80,0,0,0-62.5-114.17A80,80,0,1,0,23.93,138.76l-7.27,24.71a16,16,0,0,0,19.87,19.87l24.71-7.27a80.39,80.39,0,0,0,25.18,7.35,80,80,0,0,0,108.34,40.65l24.71,7.27a16,16,0,0,0,19.87-19.86ZM62,159.5a8.28,8.28,0,0,0-2.26.32L32,168l8.17-27.76a8,8,0,0,0-.63-6,64,64,0,1,1,26.26,26.26A8,8,0,0,0,62,159.5Zm153.79,28.73L224,216l-27.76-8.17a8,8,0,0,0-6,.63,64.05,64.05,0,0,1-85.87-24.88A79.93,79.93,0,0,0,174.7,89.71a64,64,0,0,1,41.75,92.48A8,8,0,0,0,215.82,188.23Z',
  },
  cloche: {
    fond: 'M208,192H48a8,8,0,0,1-6.88-12C47.71,168.6,56,147.81,56,112a72,72,0,0,1,144,0c0,35.82,8.3,56.6,14.9,68A8,8,0,0,1,208,192Z',
    trait: 'M224,71.1a8,8,0,0,1-10.78-3.42,94.13,94.13,0,0,0-33.46-36.91,8,8,0,1,1,8.54-13.54,111.46,111.46,0,0,1,39.12,43.09A8,8,0,0,1,224,71.1ZM35.71,72a8,8,0,0,0,7.1-4.32A94.13,94.13,0,0,1,76.27,30.77a8,8,0,1,0-8.54-13.54A111.46,111.46,0,0,0,28.61,60.32,8,8,0,0,0,35.71,72Zm186.1,103.94A16,16,0,0,1,208,200H167.2a40,40,0,0,1-78.4,0H48a16,16,0,0,1-13.79-24.06C43.22,160.39,48,138.28,48,112a80,80,0,0,1,160,0C208,138.27,212.78,160.38,221.81,175.94ZM150.62,200H105.38a24,24,0,0,0,45.24,0ZM208,184c-10.64-18.27-16-42.49-16-72a64,64,0,0,0-128,0c0,29.52-5.38,53.74-16,72Z',
  },
  prises: {
    fond: 'M185,127,127,185a24,24,0,0,1-33.94,0L71,162.91A24,24,0,0,1,71,129L129,71a24,24,0,0,1,33.94,0L185,93.09A24,24,0,0,1,185,127Z',
    trait: 'M237.66,18.34a8,8,0,0,0-11.32,0l-52.4,52.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L100,88.69l-6.34-6.35A8,8,0,0,0,82.34,93.66L88.69,100,65.37,123.31a32,32,0,0,0,0,45.26l5.38,5.37-52.41,52.4a8,8,0,0,0,11.32,11.32l52.4-52.41,5.37,5.38a32.06,32.06,0,0,0,45.26,0L156,167.31l6.34,6.35a8,8,0,0,0,11.32-11.32L167.31,156l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,52.41-52.4A8,8,0,0,0,237.66,18.34Zm-116.29,161a16,16,0,0,1-22.62,0L76.69,157.25a16,16,0,0,1,0-22.62L100,111.31,144.69,156Zm57.94-57.94h0L156,144.69,111.31,100l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22a16,16,0,0,1,0,22.63ZM88.57,35A8,8,0,0,1,103.43,29l8,20A8,8,0,0,1,96.57,55ZM24.57,93A8,8,0,0,1,35,88.57l20,8A8,8,0,0,1,49,111.43l-20-8A8,8,0,0,1,24.57,93ZM231.43,163a8,8,0,0,1-10.4,4.46l-20-8A8,8,0,1,1,207,144.57l20,8A8,8,0,0,1,231.43,163Zm-64,58.06A8,8,0,0,1,152.57,227l-8-20A8,8,0,0,1,159.43,201Z',
  },
};

export const CONSTRUIRE: readonly FamilleCapacites[] = [
  {
    titre: { fr: 'Répondre à vos clients', en: 'Answer your customers' },
    icone: 'chats',
    capacites: [
      {
        texte: {
          fr: 'Un agent IA qui répond jour et nuit avec votre site ou votre documentation, et passe la main à votre équipe quand il faut.',
          en: 'An AI agent that answers day and night from your site or your docs, and hands over to your team when needed.',
        },
        lien: { cas: 'support' },
      },
      {
        texte: {
          fr: 'La bulle WhatsApp sur votre site, Lovable compris : le visiteur écrit, l’agent répond.',
          en: 'The WhatsApp bubble on your site, Lovable included: the visitor writes, the agent answers.',
        },
        lien: { cas: 'bulle-lovable' },
      },
      {
        texte: {
          fr: 'La prise de rendez-vous dans la conversation : l’agent note le motif, votre app propose les créneaux.',
          en: 'Appointment booking in the conversation: the agent notes the reason, your app offers the slots.',
        },
        lien: { cas: 'rendez-vous' },
      },
      {
        texte: {
          fr: 'Vos conversations lues et répondues depuis Claude, dans la fenêtre de 24 heures ou par un modèle.',
          en: 'Your conversations read and answered from Claude, within the 24-hour window or with a template.',
        },
        lien: { page: { fr: '/developpeurs/repondre-a-une-conversation/', en: '/en/developers/reply-to-a-conversation/' } },
      },
    ],
  },
  {
    titre: { fr: 'Leur écrire au bon moment', en: 'Message them at the right time' },
    icone: 'cloche',
    capacites: [
      {
        texte: {
          fr: 'Le suivi de commande quand elle part, et l’agent IA si le client répond.',
          en: 'Order tracking when it ships, and the AI agent if the customer replies.',
        },
        lien: { cas: 'notifications' },
      },
      {
        texte: {
          fr: 'Votre boutique Shopify branchée par Claude : confirmation de commande, avis d’expédition, relance de panier.',
          en: 'Your Shopify store connected by Claude: order confirmation, shipping notice, checkout reminder.',
        },
        lien: { page: { fr: '/solutions/shopify/', en: '/en/solutions/shopify-stores/' } },
      },
      {
        texte: {
          fr: 'Le rappel la veille du rendez-vous : le client confirme ou décale d’un bouton.',
          en: 'The reminder the day before the appointment: the customer confirms or reschedules with one button.',
        },
        lien: { cas: 'rappels' },
      },
      {
        texte: {
          fr: 'Le message de bienvenue à l’inscription, avec un bouton vers le premier usage de votre produit.',
          en: 'The welcome message at sign-up, with a button to the first use of your product.',
        },
        lien: { cas: 'accueil' },
      },
      {
        texte: {
          fr: 'La relance d’un paiement échoué, avec le lien pour mettre à jour la carte.',
          en: 'The failed payment reminder, with the link to update the card.',
        },
        lien: { cas: 'relance-paiement' },
      },
      {
        texte: {
          fr: 'Une campagne vers vos contacts, préparée par Claude et lancée avec votre oui (offre Pro).',
          en: 'A campaign to your contacts, prepared by Claude and launched with your yes (Pro plan).',
        },
        lien: { page: { fr: '/developpeurs/preparer-une-campagne/', en: '/en/developers/prepare-a-campaign/' } },
      },
      {
        texte: {
          fr: 'Vos modèles écrits par Claude et soumis à Meta, et le motif d’un refus.',
          en: 'Your templates written by Claude and submitted to Meta, and the reason for a rejection.',
        },
        lien: { doc: 'templates' },
      },
    ],
  },
  {
    titre: { fr: 'Brancher à votre app', en: 'Connect it to your app' },
    icone: 'prises',
    capacites: [
      {
        texte: {
          fr: 'Chaque message reçu, livré, lu ou en échec, poussé vers votre app par un webhook signé.',
          en: 'Every message received, delivered, read or failed, pushed to your app by a signed webhook.',
        },
        lien: { doc: 'webhooks' },
      },
      {
        texte: {
          fr: 'Vos webhooks créés, testés et rejoués depuis Claude.',
          en: 'Your webhooks created, tested and replayed from Claude.',
        },
        lien: { doc: 'webhook-endpoints' },
      },
      {
        texte: {
          fr: 'Vos envois par l’API ou le SDK TypeScript, rejouables sans doublon grâce à la clé d’idempotence.',
          en: 'Your sends through the API or the TypeScript SDK, safe to retry without duplicates thanks to the idempotency key.',
        },
        lien: { doc: 'sdk' },
      },
      {
        texte: {
          fr: 'Vos contacts et leur consentement, tenus à jour depuis votre app.',
          en: 'Your contacts and their consent, kept up to date from your app.',
        },
        lien: { doc: 'contacts' },
      },
    ],
  },
];
