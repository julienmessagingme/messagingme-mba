// scripts/vitrine/boutique-textes.ts
// Les textes de la page « Boutiques Shopify » (rubrique Solutions), en français et en anglais : la seule chose écrite à
// la main de cette page, que `scripts/vitrine/boutique.ts` assemble (npm run vitrine:cas). Conception
// `docs/superpowers/specs/2026-10-23-vitrine-shopify-design.md`, plan `2026-10-24-boutiques-shopify.md`.
//
// 🔴 CE QUE LA PAGE AFFIRME SE RELIT DANS LE CODE (§ 4 de la conception) : les chiffres d'offre viennent de
// `src/offres/offres.ts` ; le numéro fourni, de `src/stripe/abonnement.ts` (`tests/vitrine-boutique.test.ts` les
// compare). Le numéro WhatsApp Business, l'application reliée comme un appareil (techniquement le QR code, mot que la
// page n'emploie plus depuis le 2026-10-27 : « personne comprend rien », Julien), ne fait que RÉPONDRE (décision du
// 2026-10-24, après la mesure : écrire en premier à un inconnu depuis un tel numéro le fait couper) : aucune phrase ne
// lui promet un message de la boutique, et seul le Free y mène. La coexistence (garder son application WhatsApp
// Business) est ouverte depuis le 2026-10-25 : en Pro, son issue renvoie à la fiche d'aide
// `garder-mon-application-whatsapp-business`. Le mot « coexistence » ne s'écrit jamais face au client (Julien,
// 2026-10-25) : « garder votre application WhatsApp Business ».
// ⚠️ Marque Shopify : compatibilité seulement (`tests/vitrine-marque-shopify.test.ts`).
// Les textes sont du HTML écrit par nous (`&nbsp;` compris) ; le français reçoit ses espaces insécables à l'assemblage.

import { DROITS, ESSAI_PRO_JOURS, PRIX_PRO_HT_CENTIMES } from '../../src/offres/offres';
import type { Langue } from './cas-textes';

/** Le numéro fourni, en centimes HT par mois : la valeur de `PRIX_NUMERO_HT_CENTIMES`, gardée égale par le test. */
export const PRIX_NUMERO_AFFICHE_HT_CENTIMES = 350;

const euros = (centimes: number, langue: Langue): string => {
  const entier = centimes % 100 === 0;
  const n = (centimes / 100).toFixed(entier ? 0 : 2);
  return langue === 'fr' ? `${n.replace('.', ',')}&nbsp;€` : `€${n}`;
};
/** Une limite chiffrée de l'offre ; une limite absente (illimitée) n'a rien à faire dans une phrase qui la chiffre. */
const limite = (offre: 'base' | 'pro', nom: 'contacts' | 'envoisModelesMois'): number => {
  const v = DROITS[offre].limites[nom];
  if (v === null) throw new Error(`boutique-textes : ${offre}.${nom} est illimité`);
  return v;
};
/** L'icône de l'application WhatsApp Business (la bulle au « + »), à côté de la question qui la nomme, pour la reconnaître sur son téléphone. */
const LOGO_APPLICATION = '/img/logos/whatsapp-business.png';
const milliers = (n: number, langue: Langue): string =>
  (langue === 'fr' ? n.toLocaleString('fr-FR').replace(/\s/g, '&nbsp;') : n.toLocaleString('en-US'));

export interface BulleTel { readonly texte: string; readonly heure: string; readonly envoye?: boolean; readonly pied?: string }
export interface Carte { readonly titre: string; readonly texte: string; readonly icone?: string; readonly offre?: string }
export interface Etape { readonly titre: string; readonly texte: string }
/** Une réponse mène à une autre question ou à une issue (`vers`) ; sans `vers`, elle montre l'aide de sa question.
 * `note` : une phrase qui s'affiche sous la question quand on la choisit (le Pro dit que le compte Meta se crée en
 * chemin). `offre` : la réponse choisit l'offre, et chaque issue ne montre ensuite que les boutons de cette offre. */
export interface Reponse { readonly libelle: string; readonly vers?: string; readonly note?: string; readonly offre?: 'free' | 'pro' }
/** `voies` : des cartes côte à côte, et SOUS chacune la réponse de même rang (Julien, 2026-10-27 : sinon on ne sait
 * pas quel bouton va avec quelle carte) ; une réponse sans `vers` (« Je ne sais pas ») reste dessous. */
export interface Question { readonly id: string; readonly texte: string; readonly precision?: string; readonly aide?: string; readonly reponses: readonly Reponse[]; readonly voies?: readonly Voie[]; readonly logo?: string }
/** Une carte d'un choix (une offre, un numéro), avec ce qu'elle apporte et ce qu'elle coûte. */
export interface Voie { readonly titre: string; readonly plus: readonly string[]; readonly moins: readonly string[] }
/**
 * `situation` se lit sans script, quand toutes les issues s'affichent l'une sous l'autre. Le bout du tunnel : en Free,
 * `demande`, la phrase à coller dans Claude Code après l'installation du plugin, qui reprend les réponses données ; en
 * Pro, `pasAPas`, la fiche d'aide de ce chemin, absente quand l'issue n'existe pas en Pro (le numéro WhatsApp Business).
 */
export interface Issue { readonly id: string; readonly situation: string; readonly titre: string; readonly textes: readonly string[]; readonly voies?: readonly Voie[]; readonly demande: string; readonly pasAPas?: string }

export interface TexteBoutique {
  readonly titre: string;
  readonly description: string;
  /** La ligne sous le titre dans le menu Solutions. */
  readonly menu: string;
  readonly icone: string;
  readonly surtitre: string;
  readonly h1: readonly [string, string];
  readonly chapeau: string;
  readonly boutonClaude: string;
  readonly boutonConsole: string;
  readonly compat: string;
  readonly telephone: { readonly aria: string; readonly boutique: string; readonly compte: string; readonly jour: string; readonly bulles: readonly BulleTel[] };
  readonly probleme: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly texte: string; readonly source: string };
  readonly scenario: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly etapes: readonly Etape[]; readonly note: string };
  readonly branchez: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly cartes: readonly Carte[] };
  readonly ensuite: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly cartes: readonly Carte[]; readonly offre: string };
  readonly numero: {
    readonly surtitre: string; readonly titre: readonly [string, string]; readonly chapeau: string;
    /** Les mots que personne ne comprend (Julien, 2026-10-24), expliqués AVANT la première question. */
    readonly lexique: { readonly titre: string; readonly termes: ReadonlyArray<{ readonly terme: string; readonly definition: string }> };
    /** L'arbre de Julien (2026-10-24) : la première question ouvre, chaque réponse mène plus loin. */
    readonly questions: readonly Question[]; readonly issues: readonly Issue[];
    readonly plus: string; readonly moins: string; readonly recommencer: string;
    /**
     * Le tunnel (Julien, 2026-10-27 : « c'est le début de l'onboarding ») : l'étape en cours (`{n}` son rang, `{max}` le
     * plus long parcours de l'arbre, que `boutique.ts` calcule), le mot de l'issue, et le lien qui rouvre une réponse.
     */
    readonly progression: string; readonly fin: string; readonly modifier: string;
    /** Les mots des boutons de bout de tunnel : le titre de chaque offre, ses boutons, la demande et sa copie. */
    readonly appels: {
      readonly free: string; readonly pro: string; readonly plugin: string; readonly github: string;
      readonly demande: string; readonly copier: string; readonly copie: string; readonly compte: string; readonly pasAPas: string;
    };
  };
  readonly commencer: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly etapes: readonly Etape[]; readonly bouton: string; readonly aide: string };
  readonly prix: {
    readonly surtitre: string; readonly titre: readonly [string, string];
    readonly offres: ReadonlyArray<{ readonly nom: string; readonly prix: string; readonly detail: string; readonly liste: readonly string[] }>;
    readonly note: string; readonly tarifs: string;
  };
  readonly faq: { readonly titre: string; readonly questions: ReadonlyArray<{ readonly id: string; readonly q: string; readonly r: string }> };
  readonly appel: { readonly titre: string; readonly texte: string; readonly contact: string };
}

const fr = (): TexteBoutique => {
  const numero = euros(PRIX_NUMERO_AFFICHE_HT_CENTIMES, 'fr');
  // L'arbre de Julien du 2026-10-27 : l'offre d'abord. Le Pro demande un numéro API (donc un compte Meta Business, que
  // la fenêtre de Meta fait créer en chemin) ; la Free laisse choisir entre le numéro WhatsApp Business (l'application
  // reliée comme un appareil, l'ancien « QR code » que personne ne comprenait : il ne fait que répondre) et le numéro API.
  // Le mot « coexistence » ne s'écrit jamais face au client : on dit « garder l'application ».
  const offres: readonly Voie[] = [
    {
      titre: 'Free, 0&nbsp;€ d’abonnement',
      plus: ['Tout se fait en parlant à Claude Code : le numéro, la boutique, l’agent IA.', 'Votre agent IA répond, et avec un numéro API, les trois messages de votre boutique partent.'],
      moins: ['Pas de console : vous pilotez depuis Claude Code.', `${milliers(limite('base', 'contacts'), 'fr')} contacts et ${milliers(limite('base', 'envoisModelesMois'), 'fr')} messages envoyés par mois.`],
    },
    {
      titre: `Pro, ${euros(PRIX_PRO_HT_CENTIMES.mois, 'fr')} HT par mois`,
      plus: ['La console : l’Inbox de l’équipe, les campagnes, la carte de votre boutique.', 'Un numéro fourni, inclus.', `${ESSAI_PRO_JOURS}&nbsp;jours d’essai la première fois, carte demandée.`],
      moins: ['Un numéro API, donc un compte Meta Business, que la fenêtre de Meta vous fait créer en chemin.'],
    },
  ];
  const numerosFree: readonly Voie[] = [
    {
      titre: 'Numéro WhatsApp Business, pour répondre',
      plus: ['Aucun compte : ni profil Facebook, ni carte chez Meta.', 'Meta ne facture pas les réponses.', 'Plus tard, vous pourrez garder ce numéro et le transformer en numéro API, pour envoyer des messages à vos clients (relance de panier, confirmation de commande).'],
      moins: [
        'Votre agent IA répond aux clients qui écrivent, mais rien ne part en premier : ni confirmation, ni relance.',
        'Il faut télécharger l’application WhatsApp Business sur un téléphone, et WhatsApp peut couper le numéro.',
      ],
    },
    {
      titre: 'Numéro API, avec un compte Meta Business',
      plus: ['Les trois messages de votre boutique partent : confirmation, expédition, relance.', 'Votre agent IA répond.'],
      moins: [
        'Un compte Meta Business, que la fenêtre de Meta vous fait créer en chemin, et un moyen de paiement chez Meta.',
        'Meta facture les messages de votre boutique, et les réponses au-delà d’une franchise mensuelle.',
      ],
    },
  ];
  return {
    titre: 'Boutiques Shopify : relance de panier sur WhatsApp · Messaging Me',
    description: 'Votre boutique Shopify sur WhatsApp par Claude Code, offre Free à 0 € : confirmation de commande, avis d’expédition, relance des paniers abandonnés.',
    menu: 'Relancer les paniers sur WhatsApp',
    icone: 'i-cart',
    surtitre: 'Boutiques Shopify',
    h1: ['Relancez vos paniers sur WhatsApp.', 'Votre agent IA répond, le client commande.'],
    chapeau: 'Branchez votre boutique Shopify en le demandant à Claude Code, avec l’offre Free&nbsp;: 0&nbsp;€ d’abonnement. Vos clients reçoivent sur WhatsApp la confirmation de leur commande, l’avis d’expédition et une relance de leur panier, et votre agent IA répond quand ils écrivent.',
    boutonClaude: 'Brancher gratuitement avec Claude Code',
    boutonConsole: 'Tout faire depuis la console',
    compat: 'Se branche à votre boutique',
    telephone: {
      aria: 'Exemple : la relance d’un panier sur WhatsApp, la question du client, la réponse de l’agent IA, puis la confirmation de la commande',
      boutique: 'Votre boutique', compte: 'Compte professionnel', jour: 'Aujourd’hui',
      bulles: [
        { texte: 'Bonjour, vous avez laissé des articles dans votre panier. Il vous attend ici : votre-boutique.fr/panier', heure: '18:04', pied: 'Répondez STOP pour ne plus recevoir ces messages' },
        { texte: 'La livraison est offerte ?', heure: '18:11', envoye: true },
        { texte: 'Oui, dès 50&nbsp;€ d’achat, livrée en 48&nbsp;heures.', heure: '18:11' },
        { texte: 'Parfait, je commande !', heure: '18:12', envoye: true },
        { texte: 'Merci pour votre commande #1002 de 64,00&nbsp;€ !', heure: '18:14' },
      ],
    },
    probleme: {
      surtitre: 'Le problème',
      titre: ['Sept paniers sur dix sont abandonnés.', 'L’e-mail de relance se perd.'],
      texte: 'En moyenne, 70&nbsp;% des paniers en ligne ne vont pas jusqu’à la commande. La relance par e-mail arrive au milieu des promotions, et la question qui retenait le client reste sans réponse. Sur WhatsApp, la relance arrive là où il lit ses messages, et il peut répondre.',
      source: 'Baymard Institute, moyenne de 50 études',
    },
    scenario: {
      surtitre: 'Le scénario',
      titre: ['Du panier laissé à la commande,', 'sur WhatsApp.'],
      etapes: [
        { titre: 'Le client laisse son panier', texte: 'Il a donné son téléphone au paiement, puis il est parti sans commander.' },
        { titre: 'Il reçoit la relance sur WhatsApp', texte: 'Au délai que vous choisissez, de 15 minutes à 72 heures (une heure par défaut), avec le lien qui rouvre son panier. Une seule fois, et rien ne part s’il a commandé entre-temps.' },
        { titre: 'Il répond, avec sa question', texte: 'Les frais de port, une taille, un délai de livraison.' },
        { titre: 'Votre agent IA lui répond', texte: 'Avec ce qu’il sait de votre boutique : vos délais, vos transporteurs, vos retours, vos produits. Sans la réponse, il vous passe la main.' },
        { titre: 'Il commande', texte: 'La confirmation arrive sur WhatsApp, puis l’avis d’expédition avec le lien de suivi.' },
      ],
      note: 'La relance est un message marketing : le consentement de vos clients relève de vous, et elle dit comment répondre STOP.',
    },
    branchez: {
      surtitre: 'Ce que vous branchez',
      titre: ['Trois messages,', 'et vos clients déjà abonnés.'],
      cartes: [
        { titre: 'La commande payée', texte: 'La confirmation, avec le numéro de la commande, son montant et son lien.', icone: 'i-wallet' },
        { titre: 'L’expédition', texte: 'L’avis d’expédition, avec le transporteur et le lien de suivi.', icone: 'i-package' },
        { titre: 'Le panier abandonné', texte: 'Une relance, avec le lien qui rouvre le panier.', icone: 'i-cart' },
        { titre: 'Vos clients abonnés', texte: 'L’import de vos clients abonnés à votre marketing (e-mail ou SMS) qui ont un téléphone. Leur accord pour WhatsApp relève de vous, et un STOP est toujours respecté.', icone: 'i-user' },
      ],
    },
    ensuite: {
      surtitre: 'Et ensuite',
      titre: ['Ce que la conversation', 'rend possible.'],
      offre: 'Offre',
      cartes: [
        { titre: '« Où est ma commande ? »', texte: 'Votre agent IA répond sur la livraison d’après vos pages, et vous passe la main pour un colis précis.', icone: 'i-chat-circle-dots' },
        { titre: 'Vos promotions', texte: 'Une campagne à vos clients, qui part à ceux qui ont accepté WhatsApp.', icone: 'i-send', offre: 'Pro' },
        { titre: 'La publicité Click-to-WhatsApp', texte: 'Une publicité Facebook ou Instagram qui ouvre la conversation, et votre agent IA qui la reprend.', icone: 'i-megaphone', offre: 'Entreprise' },
      ],
    },
    numero: {
      surtitre: 'Votre numéro WhatsApp',
      titre: ['Votre branchement', 'commence ici.'],
      chapeau: 'En cinq questions au plus sur votre offre, votre application WhatsApp Business et votre numéro, vous savez quoi faire.',
      lexique: {
        titre: 'Les quatre mots employés ici',
        termes: [
          { terme: 'Le compte Meta Business', definition: 'Le compte de votre entreprise chez Meta (un «&nbsp;portefeuille&nbsp;», l’ancien Business Manager). Si vous faites de la publicité sur Facebook ou Instagram, vous en avez sans doute un. Sinon, rien à préparer : il est gratuit, et la fenêtre de Meta vous le fait créer en chemin, avec votre profil Facebook.' },
          { terme: 'Le numéro WhatsApp Business', definition: 'Le numéro de l’application WhatsApp Business, l’application des professionnels, à télécharger sur un téléphone. Il se relie à Messaging Me comme un ordinateur («&nbsp;Appareils liés&nbsp;»), sans aucun compte (ni profil Facebook, ni carte chez Meta) : votre agent IA répond à ceux qui vous écrivent sans que Meta facture ses réponses, mais rien ne part en premier, et WhatsApp peut couper le numéro. Plus tard, vous pourrez le transformer en numéro API.' },
          { terme: 'Le numéro API', definition: 'Un numéro relié par Meta à l’API officielle de WhatsApp, que pilote Messaging Me : c’est lui qui envoie la confirmation, l’expédition et la relance, et Meta facture ses messages. Il faut un compte Meta Business, que la fenêtre de Meta vous fait créer en chemin.' },
          { terme: 'Garder votre application', definition: 'Votre numéro WhatsApp Business devient aussi un numéro API, sans quitter l’application : vous répondez toujours depuis votre téléphone, et les messages de votre boutique partent de Messaging Me.' },
        ],
      },
      // L'arbre de Julien du 2026-10-27 : l'offre, puis, en Free, le numéro WhatsApp Business ou le numéro API ; le Pro
      // et le numéro API se rejoignent sur l'application WhatsApp Business (la garder, ou un numéro à part).
      questions: [
        {
          id: 'offre', texte: 'Quelle offre voulez-vous ?', precision: 'Vous pourrez en changer plus tard.',
          aide: 'La Free suffit pour commencer : votre agent IA répond à vos clients, et avec un numéro API, les messages de votre boutique partent. Le Pro ajoute la console, pour vous et votre équipe, et un numéro fourni.',
          voies: offres,
          reponses: [
            { libelle: 'La Free', vers: 'type-numero', offre: 'free' },
            { libelle: 'Le Pro', vers: 'application', offre: 'pro', note: 'Le Pro demande un numéro API, donc un compte Meta Business : la fenêtre de Meta vous le fait créer en chemin, avec votre profil Facebook.' },
            { libelle: 'Je ne sais pas' },
          ],
        },
        {
          id: 'type-numero', texte: 'Quel numéro pour votre boutique ?', precision: 'Avec la Free, deux numéros possibles :',
          voies: numerosFree,
          reponses: [{ libelle: 'Le numéro WhatsApp Business', vers: 'qr' }, { libelle: 'Le numéro API', vers: 'application' }],
        },
        {
          id: 'application', texte: 'Avez-vous l’application WhatsApp Business sur le numéro de votre entreprise ?', precision: 'L’application des professionnels, distincte de WhatsApp.', logo: LOGO_APPLICATION,
          reponses: [{ libelle: 'Oui', vers: 'garder' }, { libelle: 'Non', vers: 'numero' }],
        },
        {
          id: 'garder', texte: 'Voulez-vous garder ce numéro dans l’application, ou prendre un numéro à part ?', precision: 'Gardé, votre numéro WhatsApp Business devient aussi un numéro API.',
          reponses: [{ libelle: 'Le garder', vers: 'garder-application' }, { libelle: 'Un numéro à part', vers: 'numero' }],
        },
        {
          id: 'numero', texte: 'Avez-vous un numéro libre ?', precision: 'Un numéro qui ne sert pas dans WhatsApp, ni dans l’application WhatsApp Business.',
          reponses: [{ libelle: 'Oui', vers: 'api' }, { libelle: 'Non', vers: 'api-fourni' }],
        },
      ],
      issues: [
        {
          id: 'garder-application', situation: 'Avec l’application WhatsApp Business, que vous voulez garder', titre: 'Gardez votre application WhatsApp Business',
          textes: [
            'Votre numéro WhatsApp Business devient aussi un numéro API, sans quitter l’application : vous continuez d’y répondre depuis votre téléphone, et les messages de votre boutique partent de Messaging Me.',
            'La fenêtre de Meta prend votre compte Meta Business, ou vous le fait créer en chemin avec votre profil Facebook, puis vous propose un moyen de paiement. Meta facture les messages partis de Messaging Me, réponses comprises au-delà d’une franchise mensuelle ; ceux que vous tapez dans l’application restent gratuits.',
            'Quelques fonctions de l’application s’arrêtent, comme les listes de diffusion et le message d’absence, et il faut l’ouvrir au moins toutes les deux semaines. Ce que vous y tapez n’apparaît pas encore dans Messaging Me : votre agent IA ne voit pas vos réponses.',
          ],
          demande: 'Branche ma boutique Shopify sur WhatsApp avec l’offre Free de Messaging Me. Mon numéro est dans l’application WhatsApp Business et je veux la garder : relie-le par Meta pour qu’il devienne aussi un numéro API. Envoie la confirmation de commande, l’avis d’expédition et la relance de panier, et crée mon agent IA à partir de mon site.',
          pasAPas: '/aide/garder-mon-application-whatsapp-business/',
        },
        {
          id: 'api', situation: 'Avec un numéro libre, en numéro API', titre: 'Votre numéro libre devient un numéro API',
          textes: [
            'La fenêtre de Meta prend votre compte Meta Business, ou vous le fait créer en chemin avec votre profil Facebook, puis relie votre numéro.',
            'Les trois messages de votre boutique partent, et votre agent IA répond. Meta facture les messages de votre boutique, et les réponses au-delà d’une franchise mensuelle : un moyen de paiement s’ajoute chez Meta.',
          ],
          demande: 'Branche ma boutique Shopify sur WhatsApp avec l’offre Free de Messaging Me, sur mon numéro libre, relié par Meta en numéro API. Envoie la confirmation de commande, l’avis d’expédition et la relance de panier, et crée mon agent IA à partir de mon site.',
          pasAPas: '/aide/connecter-mon-numero-whatsapp/',
        },
        {
          id: 'api-fourni', situation: 'Sans numéro libre, avec un numéro fourni en numéro API', titre: 'Un numéro fourni, en numéro API',
          textes: [
            `Prenez un numéro fourni, à ${numero} HT par mois avec la Free, inclus dans le Pro : il se relie à votre compte Meta Business, que la fenêtre de Meta vous fait créer en chemin s’il vous manque.`,
            'Les trois messages de votre boutique partent, et votre agent IA répond. Meta facture les messages de votre boutique, et les réponses au-delà d’une franchise mensuelle : un moyen de paiement s’ajoute chez Meta.',
          ],
          demande: `Branche ma boutique Shopify sur WhatsApp avec l’offre Free de Messaging Me. Je n’ai pas de numéro libre : fournis-moi un numéro (${numero} HT par mois) et relie-le par Meta en numéro API. Envoie la confirmation de commande, l’avis d’expédition et la relance de panier, et crée mon agent IA à partir de mon site.`,
          pasAPas: '/aide/connecter-mon-numero-whatsapp/',
        },
        {
          id: 'qr', situation: 'Avec la Free, un numéro WhatsApp Business, pour répondre', titre: 'Votre numéro WhatsApp Business, pour répondre',
          textes: [
            `Téléchargez l’application WhatsApp Business sur un téléphone, avec votre numéro ou un numéro fourni à ${numero} HT par mois, puis reliez-la à Messaging Me en scannant un code, sans aucun compte : votre agent IA répond aux clients qui vous écrivent, et Meta ne facture pas ces réponses.`,
            'Mais rien ne part en premier, ni confirmation, ni expédition, ni relance : WhatsApp peut couper un numéro relié ainsi qui écrit à des inconnus. Un numéro fourni garde le vôtre à l’abri.',
            'Plus tard, vous pourrez garder ce numéro et le transformer en numéro API, pour envoyer des messages à vos clients (relance de panier, confirmation de commande) : la fenêtre de Meta vous fera créer le compte Meta Business, et vos conversations restent.',
          ],
          demande: 'Relie mon numéro WhatsApp Business à Messaging Me avec l’offre Free, par le code à scanner depuis l’application de mon téléphone, sans compte Meta Business. Crée ensuite mon agent IA à partir de mon site, pour qu’il réponde aux clients qui m’écrivent.',
        },
      ],
      plus: 'Pour :', moins: 'Contre :',
      recommencer: 'Recommencer',
      progression: 'Question {n} sur {max} au plus', fin: 'Votre chemin', modifier: 'Modifier',
      appels: {
        free: 'Avec la Free, depuis Claude Code', pro: 'Avec le Pro, depuis la console',
        plugin: 'Installer le plugin', github: 'Le dépôt GitHub',
        demande: 'Votre demande à Claude, à coller une fois le plugin installé :', copier: 'Copier', copie: 'Copié',
        compte: 'Créer mon compte', pasAPas: 'Le pas-à-pas',
      },
    },
    commencer: {
      surtitre: 'Commencer avec Claude Code',
      titre: ['Quatre étapes,', 'et votre boutique est branchée.'],
      etapes: [
        { titre: 'Installez le plugin', texte: 'Le plugin Messaging Me, dans Claude Code : la page du plugin vous donne la commande.' },
        { titre: 'Autorisez avec Google', texte: 'Votre espace se crée à l’autorisation, avec l’offre Free.' },
        { titre: 'Reliez votre numéro WhatsApp', texte: 'Le chemin du guide ci-dessus : Claude vous accompagne.' },
        { titre: 'Demandez « branche ma boutique Shopify »', texte: 'Claude crée l’app dans votre propre organisation Shopify, vous cliquez « Installer », puis il vous propose vos messages et les fait approuver.' },
      ],
      bouton: 'Installer le plugin',
      aide: 'Sans Claude Code : le pas à pas de la console',
    },
    prix: {
      surtitre: 'Le prix',
      titre: ['0 € d’abonnement,', 'depuis Claude Code.'],
      offres: [
        {
          nom: 'Free', prix: '0&nbsp;€', detail: 'sans limite de durée',
          liste: [
            'Votre boutique branchée par Claude Code : les trois messages et l’import',
            `${milliers(limite('base', 'contacts'), 'fr')} contacts (chaque nouveau client de la boutique en compte un, chaque personne qui vous écrit aussi), ${milliers(limite('base', 'envoisModelesMois'), 'fr')} messages envoyés par mois`,
            'Votre agent IA',
            `Votre numéro relié par Meta, ou un numéro fourni à ${numero} HT par mois`,
          ],
        },
        {
          nom: 'Pro', prix: euros(PRIX_PRO_HT_CENTIMES.mois, 'fr'), detail: `HT par mois, essai gratuit de ${ESSAI_PRO_JOURS}&nbsp;jours, carte demandée`,
          liste: [
            'La console, la carte de votre boutique comprise',
            `Envois illimités, ${milliers(limite('pro', 'contacts'), 'fr')} contacts créés et les contacts entrants illimités`,
            'Un numéro fourni, inclus',
            'Les campagnes et l’Inbox de l’équipe',
          ],
        },
      ],
      note: 'Meta facture chaque message directement à votre boutique ; Messaging Me n’y ajoute rien. Votre agent IA consomme un crédit prépayé, rechargeable dès 5&nbsp;€ HT.',
      tarifs: 'Toutes les offres',
    },
    faq: {
      titre: 'Questions fréquentes',
      questions: [
        { id: 'faq-prix', q: 'Combien coûte la relance des paniers abandonnés ?', r: `0&nbsp;€ d’abonnement avec l’offre Free, en la branchant depuis Claude Code. Meta facture chaque message envoyé à votre boutique, sans supplément de notre part. Il vous faut un numéro relié par Meta (le vôtre, ou un numéro fourni à ${numero} HT par mois), et votre agent IA consomme un crédit prépayé.` },
        { id: 'faq-app', q: 'Faut-il installer une app de l’App Store de Shopify ?', r: 'Non. Claude crée l’app dans votre propre organisation Shopify, sans validation de Shopify : vous n’avez qu’à cliquer « Installer ».' },
        { id: 'faq-reponse', q: 'Qui répond quand le client répond à la relance ?', r: 'Celui que vous avez choisi : votre agent IA, avec ce qu’il sait de votre boutique, ou votre équipe. L’agent n’a pas accès à vos commandes : pour un colis précis, il passe la main.' },
        { id: 'faq-numero', q: 'Quel numéro WhatsApp utiliser ?', r: `Cela dépend de votre offre et de votre numéro : le guide ci-dessus vous donne votre chemin. Les messages de votre boutique partent d’un numéro API, relié par Meta : le vôtre s’il est libre, un numéro fourni à ${numero} HT par mois (inclus dans le Pro), ou le numéro de votre application WhatsApp Business, que vous gardez. La fenêtre de Meta vous fait créer votre compte Meta Business en chemin s’il vous manque. Avec la Free et sans aucun compte, votre numéro WhatsApp Business, relié depuis l’application, sert à répondre : WhatsApp peut couper un numéro relié ainsi qui écrit en premier. Plus tard, vous pourrez le transformer en numéro API pour écrire en premier, en gardant ses conversations.` },
        { id: 'faq-stop', q: 'Que devient le client qui répond STOP ?', r: 'Il ne reçoit plus rien de votre boutique. La relance porte en bas la mention « Répondez STOP pour ne plus recevoir ces messages ».' },
      ],
    },
    appel: {
      titre: 'Relancez vos paniers sur WhatsApp, dès aujourd’hui.',
      texte: '0&nbsp;€ d’abonnement avec l’offre Free, depuis Claude Code.',
      contact: 'Nous contacter',
    },
  };
};

const en = (): TexteBoutique => {
  const numero = euros(PRIX_NUMERO_AFFICHE_HT_CENTIMES, 'en');
  const offres: readonly Voie[] = [
    {
      titre: 'Free, €0 a month',
      plus: ['Everything happens by talking to Claude Code: the number, the store, the AI agent.', 'Your AI agent answers, and with an API number, your store’s three messages go out.'],
      moins: ['No console: you drive everything from Claude Code.', `${milliers(limite('base', 'contacts'), 'en')} contacts and ${milliers(limite('base', 'envoisModelesMois'), 'en')} messages sent a month.`],
    },
    {
      titre: `Pro, ${euros(PRIX_PRO_HT_CENTIMES.mois, 'en')} excl. VAT a month`,
      plus: ['The console: the team Inbox, campaigns, your store’s card.', 'A provided number, included.', `A ${ESSAI_PRO_JOURS}-day trial the first time, card required.`],
      moins: ['An API number, so a Meta Business account, which Meta’s window has you create along the way.'],
    },
  ];
  const numerosFree: readonly Voie[] = [
    {
      titre: 'WhatsApp Business number, to answer',
      plus: ['No account at all: neither a Facebook profile nor a card at Meta.', 'Meta does not bill the replies.', 'Later, you will be able to keep this number and turn it into an API number, to send messages to your customers (checkout reminder, order confirmation).'],
      moins: [
        'Your AI agent answers the customers who write, but nothing goes out first: neither confirmation nor reminder.',
        'You need to download the WhatsApp Business app on a phone, and WhatsApp can cut the number.',
      ],
    },
    {
      titre: 'API number, with a Meta Business account',
      plus: ['Your store’s three messages go out: confirmation, shipping, reminder.', 'Your AI agent answers.'],
      moins: [
        'A Meta Business account, which Meta’s window has you create along the way, and a payment method at Meta.',
        'Meta bills your store’s messages, and replies beyond a monthly allowance.',
      ],
    },
  ];
  return {
    titre: 'Shopify stores: checkout reminders on WhatsApp · Messaging Me',
    description: 'Your Shopify store on WhatsApp through Claude Code, Free plan at €0: order confirmation, shipping notice, abandoned checkout reminders, an AI agent.',
    menu: 'Recover checkouts on WhatsApp',
    icone: 'i-cart',
    surtitre: 'Shopify stores',
    h1: ['Recover your checkouts on WhatsApp.', 'Your AI agent answers, the customer orders.'],
    chapeau: 'Connect your Shopify store by asking Claude Code, with the Free plan: €0 a month. Your customers get on WhatsApp their order confirmation, the shipping notice and a reminder for their checkout, and your AI agent answers when they write.',
    boutonClaude: 'Connect for free with Claude Code',
    boutonConsole: 'Do it all from the console',
    compat: 'Connects to your store',
    telephone: {
      aria: 'Example: a checkout reminder on WhatsApp, the customer’s question, the AI agent’s answer, then the order confirmation',
      boutique: 'Your store', compte: 'Business account', jour: 'Today',
      bulles: [
        { texte: 'Hello, you left items in your cart. It is waiting for you here: your-store.com/cart', heure: '18:04', pied: 'Reply STOP to stop these messages' },
        { texte: 'Is shipping free?', heure: '18:11', envoye: true },
        { texte: 'Yes, from €50, delivered within 48 hours.', heure: '18:11' },
        { texte: 'Great, I’m ordering!', heure: '18:12', envoye: true },
        { texte: 'Thank you for your order #1002 of €64.00!', heure: '18:14' },
      ],
    },
    probleme: {
      surtitre: 'The problem',
      titre: ['Seven checkouts out of ten are abandoned.', 'The reminder email gets lost.'],
      texte: 'On average, 70% of online checkouts never become an order. The reminder email lands among the promotions, and the question that held the customer back stays unanswered. On WhatsApp, the reminder lands where they read their messages, and they can reply.',
      source: 'Baymard Institute, average of 50 studies',
    },
    scenario: {
      surtitre: 'The scenario',
      titre: ['From the abandoned checkout to the order,', 'on WhatsApp.'],
      etapes: [
        { titre: 'The customer leaves their checkout', texte: 'They gave their phone number at checkout, then left without ordering.' },
        { titre: 'They get the reminder on WhatsApp', texte: 'At the delay you choose, from 15 minutes to 72 hours (one hour by default), with the link that reopens their checkout. Only once, and nothing goes out if they ordered in the meantime.' },
        { titre: 'They reply, with their question', texte: 'Shipping costs, a size, a delivery time.' },
        { titre: 'Your AI agent answers them', texte: 'With what it knows about your store: your delivery times, your carriers, your returns, your products. Without the answer, it hands over to you.' },
        { titre: 'They order', texte: 'The confirmation arrives on WhatsApp, then the shipping notice with the tracking link.' },
      ],
      note: 'The reminder is a marketing message: your customers’ consent is your responsibility, and it says how to reply STOP.',
    },
    branchez: {
      surtitre: 'What you connect',
      titre: ['Three messages,', 'and your subscribed customers.'],
      cartes: [
        { titre: 'The paid order', texte: 'The confirmation, with the order number, its total and its link.', icone: 'i-wallet' },
        { titre: 'The shipment', texte: 'The shipping notice, with the carrier and the tracking link.', icone: 'i-package' },
        { titre: 'The abandoned checkout', texte: 'A reminder, with the link that reopens the checkout.', icone: 'i-cart' },
        { titre: 'Your subscribed customers', texte: 'The import of your customers subscribed to your marketing (email or SMS) who have a phone number. Their agreement to WhatsApp is your responsibility, and a STOP is always respected.', icone: 'i-user' },
      ],
    },
    ensuite: {
      surtitre: 'And then',
      titre: ['What the conversation', 'makes possible.'],
      offre: 'Plan',
      cartes: [
        { titre: '“Where is my order?”', texte: 'Your AI agent answers about delivery from your pages, and hands over to you for a specific parcel.', icone: 'i-chat-circle-dots' },
        { titre: 'Your promotions', texte: 'A campaign to your customers, sent to those who accepted WhatsApp.', icone: 'i-send', offre: 'Pro' },
        { titre: 'Click-to-WhatsApp ads', texte: 'A Facebook or Instagram ad that opens the conversation, and your AI agent that takes it over.', icone: 'i-megaphone', offre: 'Enterprise' },
      ],
    },
    numero: {
      surtitre: 'Your WhatsApp number',
      titre: ['Your setup', 'starts here.'],
      chapeau: 'In five questions at most about your plan, your WhatsApp Business app and your number, you know what to do.',
      lexique: {
        titre: 'The four words used here',
        termes: [
          { terme: 'The Meta Business account', definition: 'Your business’s account at Meta (a “portfolio”, formerly Business Manager). If you advertise on Facebook or Instagram, you probably have one. Otherwise, nothing to prepare: it is free, and Meta’s window has you create it along the way, with your Facebook profile.' },
          { terme: 'The WhatsApp Business number', definition: 'The number of the WhatsApp Business app, the app for businesses, to download on a phone. It links to Messaging Me like a computer (“Linked devices”), with no account at all (no Facebook profile, no card at Meta): your AI agent answers those who write to you without Meta billing its replies, but nothing goes out first, and WhatsApp can cut the number. Later, you will be able to turn it into an API number.' },
          { terme: 'The API number', definition: 'A number connected through Meta to the official WhatsApp API, driven by Messaging Me: it sends the confirmation, the shipping notice and the reminder, and Meta bills its messages. It needs a Meta Business account, which Meta’s window has you create along the way.' },
          { terme: 'Keeping your app', definition: 'Your WhatsApp Business number also becomes an API number, without leaving the app: you still reply from your phone, and your store’s messages go out from Messaging Me.' },
        ],
      },
      questions: [
        {
          id: 'offre', texte: 'Which plan do you want?', precision: 'You can change it later.',
          aide: 'The Free plan is enough to start: your AI agent answers your customers, and with an API number, your store’s messages go out. Pro adds the console, for you and your team, and a provided number.',
          voies: offres,
          reponses: [
            { libelle: 'The Free plan', vers: 'type-numero', offre: 'free' },
            { libelle: 'The Pro plan', vers: 'application', offre: 'pro', note: 'Pro needs an API number, so a Meta Business account: Meta’s window has you create it along the way, with your Facebook profile.' },
            { libelle: 'I don’t know' },
          ],
        },
        {
          id: 'type-numero', texte: 'Which number for your store?', precision: 'With the Free plan, two numbers are possible:',
          voies: numerosFree,
          reponses: [{ libelle: 'The WhatsApp Business number', vers: 'qr' }, { libelle: 'The API number', vers: 'application' }],
        },
        {
          id: 'application', texte: 'Do you have the WhatsApp Business app on your business’s number?', precision: 'The app for businesses, separate from WhatsApp.', logo: LOGO_APPLICATION,
          reponses: [{ libelle: 'Yes', vers: 'garder' }, { libelle: 'No', vers: 'numero' }],
        },
        {
          id: 'garder', texte: 'Do you want to keep this number in the app, or take a separate number?', precision: 'Kept, your WhatsApp Business number also becomes an API number.',
          reponses: [{ libelle: 'Keep it', vers: 'garder-application' }, { libelle: 'A separate number', vers: 'numero' }],
        },
        {
          id: 'numero', texte: 'Do you have an available number?', precision: 'A number that is not used in WhatsApp, nor in the WhatsApp Business app.',
          reponses: [{ libelle: 'Yes', vers: 'api' }, { libelle: 'No', vers: 'api-fourni' }],
        },
      ],
      issues: [
        {
          id: 'garder-application', situation: 'With the WhatsApp Business app, which you want to keep', titre: 'Keep your WhatsApp Business app',
          textes: [
            'Your WhatsApp Business number also becomes an API number, without leaving the app: you keep replying from your phone, and your store’s messages go out from Messaging Me.',
            'Meta’s window takes your Meta Business account, or has you create it along the way with your Facebook profile, then offers a payment method. Meta bills the messages sent from Messaging Me, replies included beyond a monthly allowance; those you type in the app stay free.',
            'A few app features stop, such as broadcast lists and the away message, and you need to open the app at least every two weeks. What you type there does not show in Messaging Me yet: your AI agent does not see your replies.',
          ],
          demande: 'Connect my Shopify store to WhatsApp with the Messaging Me Free plan. My number is in the WhatsApp Business app and I want to keep it: connect it through Meta so it also becomes an API number. Send the order confirmation, the shipping notice and the checkout reminder, and create my AI agent from my website.',
          pasAPas: '/en/help/keep-my-whatsapp-business-app/',
        },
        {
          id: 'api', situation: 'With an available number, as an API number', titre: 'Your available number becomes an API number',
          textes: [
            'Meta’s window takes your Meta Business account, or has you create it along the way with your Facebook profile, then connects your number.',
            'Your store’s three messages go out, and your AI agent answers. Meta bills your store’s messages, and replies beyond a monthly allowance: a payment method is added at Meta.',
          ],
          demande: 'Connect my Shopify store to WhatsApp with the Messaging Me Free plan, on my available number, connected through Meta as an API number. Send the order confirmation, the shipping notice and the checkout reminder, and create my AI agent from my website.',
          pasAPas: '/en/help/connect-my-whatsapp-number/',
        },
        {
          id: 'api-fourni', situation: 'Without an available number, with a provided API number', titre: 'A provided number, as an API number',
          textes: [
            `Take a provided number, at ${numero} excl. VAT a month with the Free plan, included in Pro: it connects to your Meta Business account, which Meta’s window has you create along the way if you lack one.`,
            'Your store’s three messages go out, and your AI agent answers. Meta bills your store’s messages, and replies beyond a monthly allowance: a payment method is added at Meta.',
          ],
          demande: `Connect my Shopify store to WhatsApp with the Messaging Me Free plan. I have no available number: provide one (${numero} excl. VAT a month) and connect it through Meta as an API number. Send the order confirmation, the shipping notice and the checkout reminder, and create my AI agent from my website.`,
          pasAPas: '/en/help/connect-my-whatsapp-number/',
        },
        {
          id: 'qr', situation: 'With the Free plan, a WhatsApp Business number, to answer', titre: 'Your WhatsApp Business number, to answer',
          textes: [
            `Download the WhatsApp Business app on a phone, with your number or a provided number at ${numero} excl. VAT a month, then link it to Messaging Me by scanning a code, with no account at all: your AI agent answers the customers who write to you, and Meta does not bill those replies.`,
            'But nothing goes out first, neither confirmation, nor shipping notice, nor reminder: WhatsApp can cut a number linked this way that writes to strangers. A provided number keeps yours safe.',
            'Later, you will be able to keep this number and turn it into an API number, to send messages to your customers (checkout reminder, order confirmation): Meta’s window will have you create the Meta Business account, and your conversations stay.',
          ],
          demande: 'Link my WhatsApp Business number to Messaging Me with the Free plan, with the code to scan from the app on my phone, without a Meta Business account. Then create my AI agent from my website, so it answers the customers who write to me.',
        },
      ],
      plus: 'For:', moins: 'Against:',
      recommencer: 'Start again',
      progression: 'Question {n} of {max} at most', fin: 'Your path', modifier: 'Change',
      appels: {
        free: 'With the Free plan, from Claude Code', pro: 'With the Pro plan, from the console',
        plugin: 'Install the plugin', github: 'The GitHub repository',
        demande: 'Your request to Claude, to paste once the plugin is installed:', copier: 'Copy', copie: 'Copied',
        compte: 'Create my account', pasAPas: 'The step-by-step guide',
      },
    },
    commencer: {
      surtitre: 'Start with Claude Code',
      titre: ['Four steps,', 'and your store is connected.'],
      etapes: [
        { titre: 'Install the plugin', texte: 'The Messaging Me plugin, in Claude Code: the plugin page gives you the command.' },
        { titre: 'Authorize with Google', texte: 'Your workspace is created when you authorize, with the Free plan.' },
        { titre: 'Connect your WhatsApp number', texte: 'The path of the guide above: Claude walks you through it.' },
        { titre: 'Ask “connect my Shopify store”', texte: 'Claude creates the app in your own Shopify organization, you click “Install”, then it suggests your messages and has them approved.' },
      ],
      bouton: 'Install the plugin',
      aide: 'Without Claude Code: the console step by step',
    },
    prix: {
      surtitre: 'The price',
      titre: ['€0 a month,', 'from Claude Code.'],
      offres: [
        {
          nom: 'Free', prix: '€0', detail: 'with no time limit',
          liste: [
            'Your store connected by Claude Code: the three messages and the import',
            `${milliers(limite('base', 'contacts'), 'en')} contacts (each new store customer counts as one, and so does each person who writes to you), ${milliers(limite('base', 'envoisModelesMois'), 'en')} messages sent a month`,
            'Your AI agent',
            `Your number connected through Meta, or a provided number at ${numero} excl. VAT a month`,
          ],
        },
        {
          nom: 'Pro', prix: euros(PRIX_PRO_HT_CENTIMES.mois, 'en'), detail: `excl. VAT a month, ${ESSAI_PRO_JOURS}-day free trial, card required`,
          liste: [
            'The console, your store’s card included',
            `Unlimited sends, ${milliers(limite('pro', 'contacts'), 'en')} contacts created and unlimited inbound contacts`,
            'A provided number, included',
            'Campaigns and the team Inbox',
          ],
        },
      ],
      note: 'Meta bills each message directly to your store; Messaging Me adds nothing on top. Your AI agent uses prepaid credit, rechargeable from €5 excl. VAT.',
      tarifs: 'All plans',
    },
    faq: {
      titre: 'Frequently asked questions',
      questions: [
        { id: 'faq-prix', q: 'How much does the abandoned checkout reminder cost?', r: `€0 a month with the Free plan, by connecting it from Claude Code. Meta bills each message sent to your store, with no surcharge from us. You need a number connected through Meta (yours, or a provided number at ${numero} excl. VAT a month), and your AI agent uses prepaid credit.` },
        { id: 'faq-app', q: 'Do I need to install an app from the Shopify App Store?', r: 'No. Claude creates the app in your own Shopify organization, with no Shopify review: all you have to do is click “Install”.' },
        { id: 'faq-reponse', q: 'Who answers when the customer replies to the reminder?', r: 'The one you chose: your AI agent, with what it knows about your store, or your team. The agent has no access to your orders: for a specific parcel, it hands over.' },
        { id: 'faq-numero', q: 'Which WhatsApp number should I use?', r: `It depends on your plan and your number: the guide above gives you your path. Your store’s messages go out from an API number, connected through Meta: yours if it is available, a provided number at ${numero} excl. VAT a month (included in Pro), or the number of your WhatsApp Business app, which you keep. Meta’s window has you create your Meta Business account along the way if you lack one. With the Free plan and no account at all, your WhatsApp Business number, linked from the app, serves to answer: WhatsApp can cut a number linked this way that writes first. Later, you will be able to turn it into an API number to write first, keeping its conversations.` },
        { id: 'faq-stop', q: 'What happens to a customer who replies STOP?', r: 'They no longer receive anything from your store. The reminder carries at the bottom the line “Reply STOP to stop these messages”.' },
      ],
    },
    appel: {
      titre: 'Recover your checkouts on WhatsApp, starting today.',
      texte: '€0 a month with the Free plan, from Claude Code.',
      contact: 'Contact us',
    },
  };
};

export const TEXTES_BOUTIQUES: Readonly<Record<string, Readonly<Record<Langue, TexteBoutique>>>> = {
  shopify: { fr: fr(), en: en() },
};
