// scripts/vitrine/boutique-textes.ts
// Les textes de la page « Boutiques Shopify » (rubrique Solutions), en français et en anglais : la seule chose écrite à
// la main de cette page, que `scripts/vitrine/boutique.ts` assemble (npm run vitrine:cas). Conception
// `docs/superpowers/specs/2026-10-23-vitrine-shopify-design.md`, plan `2026-10-24-boutiques-shopify.md`.
//
// 🔴 CE QUE LA PAGE AFFIRME SE RELIT DANS LE CODE (§ 4 de la conception) : les chiffres d'offre viennent de
// `src/offres/offres.ts` ; le numéro fourni, de `src/stripe/abonnement.ts` (`tests/vitrine-boutique.test.ts` les
// compare). Le tunnel du numéro WhatsApp n'est plus ici : il vit dans `tunnel-textes.ts`, le même sur chaque page
// qui le porte (l'arbre de Julien du 2026-10-30), et seule sa demande à coller parle de la boutique.
// ⚠️ Marque Shopify : compatibilité seulement (`tests/vitrine-marque-shopify.test.ts`).
// Les textes sont du HTML écrit par nous (`&nbsp;` compris) ; le français reçoit ses espaces insécables à l'assemblage.

import { ESSAI_PRO_JOURS, PRIX_PRO_HT_CENTIMES, type Fonction } from '../../src/offres/offres';
import type { NomOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { Langue } from './cas-textes';
import { PRIX_NUMERO_AFFICHE_HT_CENTIMES, euros, limite, milliers } from './tunnel-textes';

export interface BulleTel { readonly texte: string; readonly heure: string; readonly envoye?: boolean; readonly pied?: string }
export interface Carte { readonly titre: string; readonly texte: string; readonly icone?: string }
/**
 * Une carte de « Tout ce que Claude fait » : les outils qui la font, cités sous elle, et la fonction de la console qui la
 * porte quand Claude ne la fait pas (l'Inbox, les publicités). Son étiquette d'offre se CALCULE (`offreDeLaCarte`,
 * `scripts/vitrine/offres-outils.ts`), jamais écrite ici.
 */
export interface CarteClaude {
  readonly titre: string; readonly texte: string; readonly icone: string;
  readonly outils: readonly NomOutilMcp[]; readonly fonction?: Fonction;
}
export interface Besoin { readonly titre: string; readonly cartes: readonly CarteClaude[] }
export interface Etape { readonly titre: string; readonly texte: string }

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
  readonly scenario: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly etapes: readonly Etape[] };
  /** Le film (lot 3 de la conception, fait le 2026-10-28 dans `~/engageme-motion/engageme-cas-shopify`) : `site/films/<nom>`, `-en` et `-9x16`. */
  readonly film: {
    readonly nom: string; readonly surtitre: string; readonly titre: readonly [string, string]; readonly texte: string;
    readonly aria: string; readonly duree: string; readonly publie: string;
  };
  readonly branchez: { readonly surtitre: string; readonly titre: readonly [string, string]; readonly cartes: readonly Carte[] };
  /**
   * Tout ce que Claude fait pour la boutique (décisions de Julien du 2026-10-28, `docs/BILAN-CAS-USAGE-MCP-2026-10-28.md`
   * § 5) : des besoins, une étiquette d'offre sur CHAQUE carte (`etiquetteDOffre`), puis ce que le Pro
   * ajoute, pour donner envie de monter, et la liste de tous les outils, repliée par famille (`{n}` : leur nombre).
   * `lienUne` : le lien de la une vers la section ; `console` : la ligne d'une carte qu'aucun outil ne fait.
   */
  readonly claude: {
    readonly surtitre: string; readonly titre: readonly [string, string]; readonly chapeau: string; readonly lienUne: string;
    readonly avec: string; readonly console: string;
    readonly besoins: readonly Besoin[];
    readonly pro: { readonly titre: string; readonly liste: readonly string[]; readonly prix: string; readonly bouton: string };
    readonly versOutils: string;
    readonly outils: { readonly titre: readonly [string, string]; readonly texte: string; readonly nombre: string; readonly doc: string };
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
    },
    film: {
      nom: 'cas-shopify', surtitre: 'Le film',
      titre: ['Votre boutique et votre WhatsApp,', 'branchés depuis Claude Code.'],
      texte: 'Vous le demandez à Claude Code : il relie votre numéro WhatsApp, crée l’app dans votre organisation Shopify, rédige les messages que Meta approuve et fait lire votre site à votre agent IA. Puis votre client reçoit la relance, pose sa question et commande.',
      aria: 'Film : une boutique Shopify et son WhatsApp branchés depuis Claude Code, puis la relance d’un panier, la réponse de l’agent IA et la commande',
      duree: 'PT41S', publie: '2026-10-28T23:00:00+01:00',
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
    claude: {
      surtitre: 'Avec Claude Code',
      titre: ['Tout ce que Claude fait', 'pour votre boutique.'],
      chapeau: 'Votre boutique branchée, vous demandez, Claude le fait. Chaque carte dit la formule qui l’ouvre : Free couvre déjà l’essentiel, Pro ajoute vos campagnes et leurs chiffres, votre équipe et le bilan de votre agent IA.',
      lienUne: 'Tout ce que Claude fait',
      avec: 'Avec', console: 'Dans la console',
      besoins: [
        {
          titre: 'Répondre à vos clients',
          cartes: [
            { titre: 'Votre agent IA connaît votre boutique', texte: 'Claude lit vos pages de livraison, de retours et vos produits, et en nourrit votre agent IA, qui répond quand un client écrit, sur votre crédit IA prépayé.', icone: 'i-lightning', outils: ['import_site', 'create_agent', 'activate_agent', 'set_default_responder'] },
            { titre: '« Où est ma commande ? »', texte: 'Le lien de suivi part dans l’avis d’expédition. Votre agent IA répond sur les délais d’après vos pages, et vous passe la main pour un colis précis, en annonçant vos heures d’ouverture.', icone: 'i-package', outils: ['set_shopify_message', 'set_business_hours'] },
            { titre: 'Vous répondez depuis Claude', texte: '« Qui m’a écrit aujourd’hui ? », puis votre réponse dans les 24&nbsp;heures qui suivent le message du client, avec une photo de produit ou des boutons. Vous prenez la main sur votre agent IA, et vous la lui rendez.', icone: 'i-chat-circle-dots', outils: ['list_conversations', 'reply_in_open_window', 'send_message', 'control_conversation'] },
            { titre: 'Votre équipe répond dans l’Inbox', texte: 'La console partage les conversations entre vous : chacun voit qui répond, les attribue, les étiquette et reprend la main à votre agent IA.', icone: 'i-user', outils: ['assign_conversation', 'tag_conversation'], fonction: 'inbox' },
          ],
        },
        {
          titre: 'Vendre et faire revenir',
          cartes: [
            { titre: 'La bulle WhatsApp sur votre boutique', texte: 'Claude crée la bulle et vous donne la balise à coller dans votre thème : vos visiteurs vous écrivent sur WhatsApp d’un clic, et votre agent IA répond.', icone: 'i-whatsapp', outils: ['create_widget', 'update_widget'] },
            { titre: 'Un message à un client précis', texte: 'Un geste après un retard, un article revenu pour qui l’attendait : Claude écrit le message, le fait approuver par Meta et l’envoie depuis votre numéro API.', icone: 'i-send', outils: ['create_template', 'send_template_to_contact'] },
            { titre: 'Vos promotions, à votre oui', texte: 'Claude prépare une campagne à vos clients qui ont accepté WhatsApp, vous montre qui la recevra, qui en est écarté et pourquoi, puis la lance ou la programme quand vous dites oui.', icone: 'i-broadcast', outils: ['find_contacts', 'prepare_campaign', 'launch_campaign'] },
            { titre: 'La publicité Click-to-WhatsApp', texte: 'Une publicité Facebook ou Instagram qui ouvre la conversation, et votre agent IA qui la reprend.', icone: 'i-megaphone', outils: [], fonction: 'publicites' },
          ],
        },
        {
          titre: 'Piloter depuis Claude',
          cartes: [
            { titre: 'Votre boutique en un coup d’œil', texte: 'Les paniers de la semaine, ce qui est parti sur 30&nbsp;jours, vos messages livrés, lus ou en échec.', icone: 'i-chart-line-up', outils: ['get_shopify_state', 'get_message_stats'] },
            { titre: 'Vos messages, écrits pour vous', texte: 'Claude rédige vos modèles, les soumet à Meta et vous dit pourquoi l’un est refusé.', icone: 'i-file-text', outils: ['create_template', 'get_template_status'] },
            { titre: 'Vos contacts en ordre', texte: 'Claude retrouve un client, bloque un contact indésirable et supprime ceux dont vous n’avez plus besoin, conversations comprises, après votre confirmation.', icone: 'i-tag', outils: ['search_contacts', 'block_contact', 'delete_contacts'] },
            { titre: 'Vos campagnes et votre agent IA en chiffres', texte: 'Le coût et les clics de chaque campagne, ce que votre agent IA a coûté, écrit et passé à votre équipe.', icone: 'i-funnel', outils: ['get_campaign_stats', 'get_ai_stats'] },
          ],
        },
      ],
      pro: {
        titre: 'Ce que la formule Pro ajoute',
        liste: [
          'Vos promotions en campagne, à vos clients ciblés par étiquette',
          'La console : l’Inbox de votre équipe et la carte de votre boutique',
          'Le coût et les clics de vos campagnes, le travail de votre agent IA en chiffres',
          'La bulle WhatsApp sans la mention « Propulsé par Messaging Me »',
          'Un numéro fourni, inclus',
          `Envois illimités, ${milliers(limite('pro', 'contacts'), 'fr')} contacts créés et les contacts entrants illimités, ${limite('pro', 'utilisateurs')}&nbsp;utilisateurs`,
        ],
        prix: `${euros(PRIX_PRO_HT_CENTIMES.mois, 'fr')} HT par mois, ${ESSAI_PRO_JOURS}&nbsp;jours d’essai la première fois, carte demandée.`,
        bouton: `Essayer Pro ${ESSAI_PRO_JOURS}&nbsp;jours`,
      },
      versOutils: 'Tous les outils de Claude, un par un',
      outils: {
        titre: ['Les outils de Claude,', 'un par un.'],
        texte: 'Claude les choisit pour vous, selon ce que vous demandez. Un outil hors de votre offre vous le dit, avec le lien pour en changer.',
        nombre: '{n} outils',
        doc: 'La documentation complète du serveur MCP',
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
        { id: 'faq-promotion', q: 'Puis-je envoyer une promotion à mes clients ?', r: 'Oui, avec l’offre Pro : Claude prépare la campagne, vous montre qui la recevra, et ne la lance qu’avec votre oui. Elle ne part qu’à ceux qui ont accepté WhatsApp, depuis un numéro API, et un STOP est toujours respecté. En formule Free, Claude envoie un message à un client à la fois.' },
        { id: 'faq-repondre', q: 'Puis-je répondre moi-même à mes clients ?', r: 'Oui, en le demandant à Claude : il vous montre qui vous a écrit, vous répondez dans les 24&nbsp;heures qui suivent leur message, et vous reprenez la main sur votre agent IA quand vous le voulez. En formule Pro, votre équipe répond aussi depuis l’Inbox de la console.' },
        { id: 'faq-numero', q: 'Quel numéro WhatsApp utiliser ?', r: `Celui que le guide ci-dessus vous donne, en trois questions au plus. Les messages de votre boutique partent d’un numéro API, relié par Meta : votre numéro libre, un numéro fourni à ${numero} HT par mois (inclus en formule Pro), ou le numéro de votre application WhatsApp Business, que vous gardez. Pas de compte Meta Business ? La fenêtre de Meta le crée en chemin.` },
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
    },
    film: {
      nom: 'cas-shopify', surtitre: 'The film',
      titre: ['Your store and your WhatsApp,', 'connected from Claude Code.'],
      texte: 'You ask Claude Code: it connects your WhatsApp number, creates the app in your Shopify organization, writes the messages Meta approves and has your AI agent read your website. Then your customer gets the reminder, asks their question and orders.',
      aria: 'Film: a Shopify store and its WhatsApp connected from Claude Code, then a checkout reminder, the AI agent’s answer and the order',
      duree: 'PT41S', publie: '2026-10-28T23:00:00+01:00',
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
    claude: {
      surtitre: 'With Claude Code',
      titre: ['Everything Claude does', 'for your store.'],
      chapeau: 'Once your store is connected, you ask, Claude does it. Each card shows the plan that opens it: the Free plan already covers the essentials, Pro adds your campaigns and their figures, your team and your AI agent’s figures.',
      lienUne: 'Everything Claude does',
      avec: 'With', console: 'In the console',
      besoins: [
        {
          titre: 'Answer your customers',
          cartes: [
            { titre: 'Your AI agent knows your store', texte: 'Claude reads your delivery and returns pages and your products, and feeds them to your AI agent, which answers when a customer writes, using your prepaid AI credit.', icone: 'i-lightning', outils: ['import_site', 'create_agent', 'activate_agent', 'set_default_responder'] },
            { titre: '“Where is my order?”', texte: 'The tracking link goes out in the shipping notice. Your AI agent answers about delivery times from your pages, and hands over to you for a specific parcel, announcing your opening hours.', icone: 'i-package', outils: ['set_shopify_message', 'set_business_hours'] },
            { titre: 'You reply from Claude', texte: '“Who wrote to me today?”, then your reply within 24 hours of the customer’s message, with a product photo or buttons. You take over from your AI agent, and hand it back.', icone: 'i-chat-circle-dots', outils: ['list_conversations', 'reply_in_open_window', 'send_message', 'control_conversation'] },
            { titre: 'Your team answers in the Inbox', texte: 'The console shares conversations among you: everyone sees who is answering, assigns them, tags them and takes over from your AI agent.', icone: 'i-user', outils: ['assign_conversation', 'tag_conversation'], fonction: 'inbox' },
          ],
        },
        {
          titre: 'Sell and bring them back',
          cartes: [
            { titre: 'The WhatsApp bubble on your store', texte: 'Claude creates the bubble and gives you the tag to paste into your theme: your visitors write to you on WhatsApp in one click, and your AI agent answers.', icone: 'i-whatsapp', outils: ['create_widget', 'update_widget'] },
            { titre: 'A message to one customer', texte: 'A gesture after a delay, an item back in stock for someone who was waiting: Claude writes the message, has Meta approve it and sends it from your API number.', icone: 'i-send', outils: ['create_template', 'send_template_to_contact'] },
            { titre: 'Your promotions, once you say yes', texte: 'Claude prepares a campaign to your customers who accepted WhatsApp, shows you who will receive it, who is left out and why, then launches or schedules it when you say yes.', icone: 'i-broadcast', outils: ['find_contacts', 'prepare_campaign', 'launch_campaign'] },
            { titre: 'Click-to-WhatsApp ads', texte: 'A Facebook or Instagram ad that opens the conversation, and your AI agent that takes it over.', icone: 'i-megaphone', outils: [], fonction: 'publicites' },
          ],
        },
        {
          titre: 'Run it from Claude',
          cartes: [
            { titre: 'Your store at a glance', texte: 'The week’s checkouts, what went out over 30 days, your messages delivered, read or failed.', icone: 'i-chart-line-up', outils: ['get_shopify_state', 'get_message_stats'] },
            { titre: 'Your messages, written for you', texte: 'Claude writes your templates, submits them to Meta and tells you why one is rejected.', icone: 'i-file-text', outils: ['create_template', 'get_template_status'] },
            { titre: 'Your contacts in order', texte: 'Claude finds a customer, blocks an unwanted contact and deletes those you no longer need, conversations included, after your confirmation.', icone: 'i-tag', outils: ['search_contacts', 'block_contact', 'delete_contacts'] },
            { titre: 'Your campaigns and your AI agent in figures', texte: 'The cost and clicks of each campaign, what your AI agent cost, wrote and passed to your team.', icone: 'i-funnel', outils: ['get_campaign_stats', 'get_ai_stats'] },
          ],
        },
      ],
      pro: {
        titre: 'What Pro adds',
        liste: [
          'Your promotions as campaigns, to your customers targeted by tag',
          'The console: your team’s Inbox and your store’s card',
          'The cost and clicks of your campaigns, your AI agent’s work in figures',
          'The WhatsApp bubble without the “Powered by Messaging Me” line',
          'A provided number, included',
          `Unlimited sends, ${milliers(limite('pro', 'contacts'), 'en')} contacts created and unlimited inbound contacts, ${limite('pro', 'utilisateurs')} users`,
        ],
        prix: `${euros(PRIX_PRO_HT_CENTIMES.mois, 'en')} excl. VAT a month, a ${ESSAI_PRO_JOURS}-day trial the first time, card required.`,
        bouton: `Try Pro for ${ESSAI_PRO_JOURS} days`,
      },
      versOutils: 'All of Claude’s tools, one by one',
      outils: {
        titre: ['Claude’s tools,', 'one by one.'],
        texte: 'Claude picks them for you, based on what you ask. A tool outside your plan tells you so, with the link to change it.',
        nombre: '{n} tools',
        doc: 'The full MCP server documentation',
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
        { id: 'faq-promotion', q: 'Can I send a promotion to my customers?', r: 'Yes, with the Pro plan: Claude prepares the campaign, shows you who will receive it, and only launches it with your yes. It only goes to those who accepted WhatsApp, from an API number, and a STOP is always respected. With the Free plan, Claude sends a message to one customer at a time.' },
        { id: 'faq-repondre', q: 'Can I reply to my customers myself?', r: 'Yes, by asking Claude: it shows you who wrote to you, you reply within 24 hours of their message, and you take over from your AI agent whenever you want. With Pro, your team also replies from the console’s Inbox.' },
        { id: 'faq-numero', q: 'Which WhatsApp number should I use?', r: `The one the guide above gives you, in three questions at most. Your store’s messages go out from an API number, connected through Meta: your available number, a provided number at ${numero} excl. VAT a month (included in Pro), or the number of your WhatsApp Business app, which you keep. No Meta Business account? Meta’s window creates it along the way.` },
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

/**
 * La phrase d'un outil dans la liste repliée, quand celle de la doc MCP ne convient pas à la page (relecture du
 * 2026-10-29) : écrite sans offre, elle nommait à côté d'une étiquette « Offre Free » l'agent de Meta, les scénarios,
 * l'analyse ou l'attribution, qui ne le sont pas, et parlait « du marchand » à qui la lit. 🔴 Une ligne Free qui nomme
 * une fonction payante dit son offre (`tests/vitrine-boutique.test.ts`). Les autres outils gardent la phrase de la doc.
 */
export const PHRASES_OUTILS: Readonly<Partial<Record<NomOutilMcp, Readonly<Record<Langue, string>>>>> = {
  set_default_responder: {
    fr: 'Choisir qui répond au client (un nouveau contact, et tout message que personne ne tient)&nbsp;: un agent IA actif, l’équipe ou votre application, et en formule Pro un scénario publié, en formule Business l’agent de Meta.',
    en: 'Choose who answers the customer (a new contact, and every message nobody handles): an active AI agent, the team or your app, plus a published scenario with Pro and Meta’s agent with Business.',
  },
  list_scenarios: {
    fr: 'Les scénarios de l’espace, et lesquels sont publiés&nbsp;: ils se construisent dans la console, en formule Pro.',
    en: 'The workspace’s scenarios, and which are published: they are built in the console, with Pro.',
  },
  search_contacts: {
    fr: 'Chercher un contact par nom ou par numéro, et avec l’Entreprise, sa dernière analyse.',
    en: 'Find a contact by name or number, with their latest analysis on the Enterprise plan.',
  },
  get_contact: {
    fr: 'La fiche d’un contact à partir de son numéro, et avec l’Entreprise, sa dernière analyse et son résumé.',
    en: 'A contact record from its number, with their latest analysis and its summary on the Enterprise plan.',
  },
  list_members: {
    fr: 'Les membres de l’espace&nbsp;; en formule Pro, vous leur confiez des fils.',
    en: 'The workspace members; with Pro, you assign threads to them.',
  },
  create_field: {
    fr: 'Créer un champ personnalisé&nbsp;: sa clé vient du libellé.',
    en: 'Create a custom field: its key comes from the label.',
  },
  delete_contacts: {
    fr: 'Supprimer pour de bon les contacts d’une sélection préparée, avec son code&nbsp;: fiches, conversations et messages effacés.',
    en: 'Delete for good the contacts of a prepared selection, with its code: records, conversations and messages erased.',
  },
  send_template_to_contact: {
    fr: 'Envoyer un modèle approuvé à un client, même hors de la fenêtre de 24&nbsp;h, dans les règles des envois (STOP, modèles du mois).',
    en: 'Send an approved template to one customer, even outside the 24-hour window, within the sending rules (STOP, monthly templates).',
  },
  connect_shopify: {
    fr: 'Brancher votre boutique Shopify avec l’app que Claude a créée dans votre organisation Shopify.',
    en: 'Connect your Shopify store with the app Claude created in your Shopify organization.',
  },
  set_shopify_message: {
    fr: 'Envoyer un message quand une commande est payée ou expédiée, ou relancer une fois un panier abandonné&nbsp;: un modèle approuvé, avec les données Shopify, dans les règles des envois (STOP, modèles du mois, limite de contacts).',
    en: 'Send a message when an order is paid or shipped, or remind an abandoned checkout once: an approved template, with Shopify data, within the sending rules (STOP, monthly templates, contact limit).',
  },
  preview_shopify_customers: {
    fr: 'Compter, sans rien écrire, vos clients Shopify abonnés à votre marketing (e-mail ou SMS) qui ont un téléphone&nbsp;: déjà dans l’espace, nouveaux, places restantes dans votre offre, importables.',
    en: 'Count, without writing anything, your Shopify customers subscribed to your marketing (email or SMS) who have a phone: already in the workspace, new, room left in your plan, importable.',
  },
  import_shopify_customers: {
    fr: 'Importer les clients Shopify abonnés que vous avez choisis, les plus récents d’abord&nbsp;: des fiches étiquetées Shopify, consentantes sur votre déclaration, dans la limite de votre offre.',
    en: 'Import the subscribed Shopify customers you chose, newest first: records tagged Shopify, opted in on your declaration, within your plan’s limit.',
  },
};

export const TEXTES_BOUTIQUES: Readonly<Record<string, Readonly<Record<Langue, TexteBoutique>>>> = {
  shopify: { fr: fr(), en: en() },
};
