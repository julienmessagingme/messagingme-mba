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

export interface FamilleCapacites {
  readonly titre: Bilingue;
  readonly capacites: readonly Capacite[];
}

export const CONSTRUIRE: readonly FamilleCapacites[] = [
  {
    titre: { fr: 'Répondre à vos clients', en: 'Answer your customers' },
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
    ],
  },
  {
    titre: { fr: 'Brancher à votre app', en: 'Connect it to your app' },
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
