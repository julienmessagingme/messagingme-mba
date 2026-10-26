// scripts/vitrine/boutique-textes.ts
// Les textes de la page « Boutiques Shopify » (rubrique Solutions), en français et en anglais : la seule chose écrite à
// la main de cette page, que `scripts/vitrine/boutique.ts` assemble (npm run vitrine:cas). Conception
// `docs/superpowers/specs/2026-10-23-vitrine-shopify-design.md`, plan `2026-10-24-boutiques-shopify.md`.
//
// 🔴 CE QUE LA PAGE AFFIRME SE RELIT DANS LE CODE (§ 4 de la conception) : les chiffres d'offre viennent de
// `src/offres/offres.ts` ; le numéro fourni, de `src/stripe/abonnement.ts` (`tests/vitrine-boutique.test.ts` les
// compare). Un numéro relié par QR code ne fait que RÉPONDRE (décision de Julien du 2026-10-24, après la mesure : écrire
// en premier à un inconnu depuis un tel numéro le fait couper) : aucune phrase ne lui promet un message de la boutique.
// La coexistence (garder son application WhatsApp Business) s'annonce « bientôt » : elle est en construction. Le mot
// « coexistence » ne s'écrit jamais face au client (Julien, 2026-10-25) : « garder votre application WhatsApp Business ».
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
 * `note` : une phrase qui s'affiche sous la question quand on la choisit (le « Non » au compte n'arrête rien). */
export interface Reponse { readonly libelle: string; readonly vers?: string; readonly note?: string }
export interface Question { readonly id: string; readonly texte: string; readonly precision?: string; readonly aide?: string; readonly reponses: readonly Reponse[]; readonly voies?: readonly Voie[]; readonly logo?: string }
/** Une des deux voies d'une issue à choix (QR code ou API), avec ce qu'elle apporte et ce qu'elle coûte. */
export interface Voie { readonly titre: string; readonly plus: readonly string[]; readonly moins: readonly string[] }
/** `situation` se lit sans script, quand toutes les issues s'affichent l'une sous l'autre. */
export interface Issue { readonly id: string; readonly situation: string; readonly titre: string; readonly textes: readonly string[]; readonly voies?: readonly Voie[] }

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
  // Les deux voies du seul choix où le QR code se propose (Julien, 2026-10-25) : sans compte Meta Business, pour un
  // numéro à part ou un nouveau numéro. Le QR code (aucun compte, des réponses que Meta ne facture pas, mais rien ne part
  // en premier) ou un compte Meta Business créé en chemin (un moyen de paiement, mais les messages partent). Avec un
  // compte, et pour garder l'application, l'arbre ne le propose pas. Le mot « coexistence » ne s'écrit jamais face au
  // client : on dit « garder l'application ».
  const voiesSansCompte: readonly Voie[] = [
    {
      titre: 'Par QR code, pour répondre',
      plus: ['Aucun compte : ni profil Facebook, ni carte chez Meta.', 'Meta ne facture pas les réponses.', 'Plus tard, le même numéro peut garder l’application et passer par Meta, pour écrire en premier.'],
      moins: [
        'Votre agent IA répond aux clients qui écrivent, mais rien ne part en premier : ni confirmation, ni relance.',
        'Le numéro doit être dans l’application WhatsApp Business d’un téléphone, et WhatsApp peut le couper.',
      ],
    },
    {
      titre: 'Avec un compte Meta Business, l’API officielle',
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
      titre: ['Le bon numéro,', 'en quelques questions.'],
      chapeau: 'Selon votre compte Meta Business, votre application WhatsApp Business et votre numéro, voici votre chemin, en cinq questions au plus.',
      lexique: {
        titre: 'Avant de répondre, cinq mots à connaître',
        termes: [
          { terme: 'Le compte Meta Business', definition: 'Le compte de votre entreprise chez Meta (un «&nbsp;portefeuille&nbsp;», l’ancien Business Manager). Si vous faites de la publicité sur Facebook ou Instagram, vous en avez sans doute un. Sinon, rien à préparer : il est gratuit, et la fenêtre de Meta vous le fait créer en chemin, avec votre profil Facebook.' },
          { terme: 'L’application WhatsApp Business', definition: 'L’application gratuite des professionnels, sur votre téléphone : le numéro de la boutique, son profil, les réponses que vous tapez. Elle n’envoie pas seule les messages de votre boutique.' },
          { terme: 'L’API officielle', definition: 'Le même WhatsApp, piloté par un logiciel, sur un numéro relié par Meta : c’est elle qui envoie la confirmation, l’expédition et la relance, et Meta facture ses messages. Il faut un compte Meta Business, et le numéro quitte l’application, sauf si vous la gardez.' },
          { terme: 'Garder votre application (bientôt)', definition: 'Votre numéro reste dans l’application WhatsApp Business et passe en même temps par Meta : vous répondez toujours depuis votre téléphone, et les messages de votre boutique partent de Messaging Me.' },
          { terme: 'Le QR code', definition: 'Votre application WhatsApp Business reliée à Messaging Me comme un ordinateur («&nbsp;Appareils liés&nbsp;»), sans aucun compte (ni profil Facebook, ni carte chez Meta) : votre agent IA répond à ceux qui vous écrivent sans que Meta facture ses réponses, mais rien ne part en premier, et WhatsApp peut couper le numéro. Plus tard, le même numéro peut garder l’application et passer par Meta, pour écrire en premier.' },
        ],
      },
      // L'arbre de Julien, précisé le 2026-10-25 : l'application demandée à tous ; le QR code seulement sans compte Meta
      // Business, pour un numéro à part ou un nouveau numéro (le choix « QR code ou compte Meta ? ») ; avec un compte, et
      // pour garder l'application, l'API seule.
      questions: [
        {
          id: 'compte', texte: 'Avez-vous un compte Meta Business ?', precision: 'Un portefeuille d’entreprise, l’ancien Business Manager.',
          aide: 'Connectez-vous sur business.facebook.com avec votre profil Facebook : le menu sous «&nbsp;Accueil&nbsp;», en haut à gauche, liste vos portefeuilles. Aucun ? Répondez «&nbsp;Non&nbsp;», ce n’est pas un problème.',
          reponses: [
            { libelle: 'Oui', vers: 'application-compte' },
            { libelle: 'Non', vers: 'application', note: 'Pas de souci : la fenêtre de Meta vous le fera créer en chemin, avec votre profil Facebook. Et pour un numéro à part, le QR code s’en passe, mais il ne fait que répondre.' },
            { libelle: 'Je ne sais pas' },
          ],
        },
        {
          id: 'application-compte', texte: 'Avez-vous l’application WhatsApp Business sur le numéro de votre entreprise ?', precision: 'L’application des professionnels, distincte de WhatsApp.', logo: LOGO_APPLICATION,
          reponses: [{ libelle: 'Oui', vers: 'garder-compte' }, { libelle: 'Non', vers: 'numero' }],
        },
        {
          id: 'garder-compte', texte: 'Voulez-vous garder ce numéro dans l’application, ou prendre un numéro à part ?',
          reponses: [{ libelle: 'Le garder dans l’application', vers: 'garder-application' }, { libelle: 'Un numéro à part', vers: 'numero' }],
        },
        {
          id: 'application', texte: 'Avez-vous l’application WhatsApp Business sur le numéro de votre entreprise ?', precision: 'L’application des professionnels, distincte de WhatsApp.', logo: LOGO_APPLICATION,
          reponses: [{ libelle: 'Oui', vers: 'garder' }, { libelle: 'Non', vers: 'choix' }],
        },
        {
          id: 'garder', texte: 'Voulez-vous garder ce numéro dans l’application, ou prendre un numéro à part ?',
          reponses: [{ libelle: 'Le garder dans l’application', vers: 'garder-application' }, { libelle: 'Un numéro à part', vers: 'choix' }],
        },
        {
          id: 'choix', texte: 'Par QR code, pour répondre, ou avec un compte Meta Business créé en chemin ?', precision: 'Sans compte Meta Business, pour un numéro à part ou un nouveau numéro, deux voies :',
          voies: voiesSansCompte,
          reponses: [{ libelle: 'Le QR code, pour répondre', vers: 'qr' }, { libelle: 'Créer le compte', vers: 'numero' }],
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
            'Bientôt, votre numéro passera aussi par Meta sans quitter l’application : vous continuerez d’y répondre depuis votre téléphone, et les messages de votre boutique partiront de Messaging Me.',
            'La fenêtre de Meta prendra votre compte Meta Business, ou vous le fera créer en chemin avec votre profil Facebook, puis vous proposera un moyen de paiement. Meta facturera les messages partis de Messaging Me, réponses comprises au-delà d’une franchise mensuelle ; ceux que vous tapez dans l’application restent gratuits.',
            'Quelques fonctions de l’application s’arrêteront, comme les listes de diffusion et le message d’absence, et il faudra l’ouvrir au moins toutes les deux semaines.',
            'En attendant, rien à faire : Claude vous le proposera dès que c’est ouvert. Pour envoyer les messages de votre boutique dès maintenant, prenez un numéro à part.',
          ],
        },
        {
          id: 'api', situation: 'Avec un numéro libre, relié par Meta', titre: 'Votre numéro, relié par Meta',
          textes: [
            'Claude ouvre la fenêtre de Meta : vous y prenez votre compte Meta Business, ou vous le créez en chemin avec votre profil Facebook, puis vous reliez votre numéro.',
            'Les trois messages de votre boutique partent, et votre agent IA répond. Meta facture les messages de votre boutique, et les réponses au-delà d’une franchise mensuelle : un moyen de paiement s’ajoute chez Meta.',
          ],
        },
        {
          id: 'api-fourni', situation: 'Sans numéro libre, avec un numéro fourni relié par Meta', titre: 'Un numéro fourni, relié par Meta',
          textes: [
            `Prenez un numéro fourni, à ${numero} HT par mois avec l’offre Free, inclus dans le Pro : Claude le relie à votre compte Meta Business, que la fenêtre de Meta vous fait créer en chemin s’il vous manque.`,
            'Les trois messages de votre boutique partent, et votre agent IA répond. Meta facture les messages de votre boutique, et les réponses au-delà d’une franchise mensuelle : un moyen de paiement s’ajoute chez Meta.',
          ],
        },
        {
          id: 'qr', situation: 'Sans compte Meta Business, par QR code, pour répondre', titre: 'Votre numéro par QR code, pour répondre',
          textes: [
            `Reliez votre numéro, ou un numéro fourni à ${numero} HT par mois, par QR code et sans aucun compte : votre agent IA répond aux clients qui vous écrivent, et Meta ne facture pas ces réponses.`,
            'Mais rien ne part en premier, ni confirmation, ni expédition, ni relance : WhatsApp peut couper un numéro relié ainsi qui écrit à des inconnus. Le numéro doit être dans l’application WhatsApp Business d’un téléphone, et un numéro fourni garde le vôtre à l’abri. L’offre Pro demande un compte Meta Business.',
            'Plus tard, pour écrire en premier (les messages de votre boutique), vous garderez votre application et relierez le même numéro par Meta («&nbsp;Garder mon application WhatsApp Business&nbsp;», depuis Claude ou l’Accueil de la console) : la fenêtre de Meta vous fera créer le compte Meta Business, et vos conversations restent.',
          ],
        },
      ],
      plus: 'Pour :', moins: 'Contre :',
      recommencer: 'Recommencer',
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
            'La console complète, la carte de votre boutique comprise',
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
        { id: 'faq-numero', q: 'Quel numéro WhatsApp utiliser ?', r: `Cela dépend de votre numéro et de votre application WhatsApp Business : le guide ci-dessus vous donne votre chemin. Les messages de votre boutique partent d’un numéro relié par Meta : le vôtre s’il est libre, un numéro fourni à ${numero} HT par mois, et bientôt le numéro de votre application WhatsApp Business, que vous gardez. La fenêtre de Meta vous fait créer votre compte Meta Business en chemin s’il vous manque. Sans aucun compte, un numéro relié par QR code sert à répondre : WhatsApp peut couper un numéro relié ainsi qui écrit en premier. Plus tard, ce numéro pourra garder l’application et passer par Meta pour écrire en premier, en gardant ses conversations.` },
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
  const voiesSansCompte: readonly Voie[] = [
    {
      titre: 'By QR code, to answer',
      plus: ['No account at all: neither a Facebook profile nor a card at Meta.', 'Meta does not bill the replies.', 'Later, the same number can keep the app and go through Meta, to write first.'],
      moins: [
        'Your AI agent answers the customers who write, but nothing goes out first: neither confirmation nor reminder.',
        'The number must be in the WhatsApp Business app on a phone, and WhatsApp can cut it.',
      ],
    },
    {
      titre: 'With a Meta Business account, the official API',
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
      titre: ['The right number,', 'in a few questions.'],
      chapeau: 'Depending on your Meta Business account, your WhatsApp Business app and your number, here is your path, in five questions at most.',
      lexique: {
        titre: 'Before you answer, five words to know',
        termes: [
          { terme: 'The Meta Business account', definition: 'Your business’s account at Meta (a “portfolio”, formerly Business Manager). If you advertise on Facebook or Instagram, you probably have one. Otherwise, nothing to prepare: it is free, and Meta’s window has you create it along the way, with your Facebook profile.' },
          { terme: 'The WhatsApp Business app', definition: 'The free app for businesses, on your phone: your store’s number, its profile, the replies you type. It does not send your store’s messages on its own.' },
          { terme: 'The official API', definition: 'The same WhatsApp, driven by software, on a number connected through Meta: it sends the confirmation, the shipping notice and the reminder, and Meta bills its messages. It needs a Meta Business account, and the number leaves the app, unless you keep it.' },
          { terme: 'Keeping your app (soon)', definition: 'Your number stays in the WhatsApp Business app and goes through Meta at the same time: you still reply from your phone, and your store’s messages go out from Messaging Me.' },
          { terme: 'The QR code', definition: 'Your WhatsApp Business app linked to Messaging Me like a computer (“Linked devices”), with no account at all (no Facebook profile, no card at Meta): your AI agent answers those who write to you without Meta billing its replies, but nothing goes out first, and WhatsApp can cut the number. Later, the same number can keep the app and go through Meta, to write first.' },
        ],
      },
      questions: [
        {
          id: 'compte', texte: 'Do you have a Meta Business account?', precision: 'A business portfolio, formerly Business Manager.',
          aide: 'Sign in to business.facebook.com with your Facebook profile: the menu under “Home”, at the top left, lists your portfolios. None? Answer “No”, that is not a problem.',
          reponses: [
            { libelle: 'Yes', vers: 'application-compte' },
            { libelle: 'No', vers: 'application', note: 'No problem: Meta’s window will have you create it along the way, with your Facebook profile. And for a separate number, the QR code does without it, but it only answers.' },
            { libelle: 'I don’t know' },
          ],
        },
        {
          id: 'application-compte', texte: 'Do you have the WhatsApp Business app on your business’s number?', precision: 'The app for businesses, separate from WhatsApp.', logo: LOGO_APPLICATION,
          reponses: [{ libelle: 'Yes', vers: 'garder-compte' }, { libelle: 'No', vers: 'numero' }],
        },
        {
          id: 'garder-compte', texte: 'Do you want to keep this number in the app, or take a separate number?',
          reponses: [{ libelle: 'Keep it in the app', vers: 'garder-application' }, { libelle: 'A separate number', vers: 'numero' }],
        },
        {
          id: 'application', texte: 'Do you have the WhatsApp Business app on your business’s number?', precision: 'The app for businesses, separate from WhatsApp.', logo: LOGO_APPLICATION,
          reponses: [{ libelle: 'Yes', vers: 'garder' }, { libelle: 'No', vers: 'choix' }],
        },
        {
          id: 'garder', texte: 'Do you want to keep this number in the app, or take a separate number?',
          reponses: [{ libelle: 'Keep it in the app', vers: 'garder-application' }, { libelle: 'A separate number', vers: 'choix' }],
        },
        {
          id: 'choix', texte: 'By QR code, to answer, or with a Meta Business account created along the way?', precision: 'Without a Meta Business account, for a separate or a new number, two ways:',
          voies: voiesSansCompte,
          reponses: [{ libelle: 'The QR code, to answer', vers: 'qr' }, { libelle: 'Create the account', vers: 'numero' }],
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
            'Soon, your number will also go through Meta without leaving the app: you will keep replying from your phone, and your store’s messages will go out from Messaging Me.',
            'Meta’s window will take your Meta Business account, or have you create it along the way with your Facebook profile, then offer a payment method. Meta will bill the messages sent from Messaging Me, replies included beyond a monthly allowance; those you type in the app stay free.',
            'A few app features will stop, such as broadcast lists and the away message, and you will need to open the app at least every two weeks.',
            'Meanwhile, nothing to do: Claude will offer it to you as soon as it opens. To send your store’s messages right away, take a separate number.',
          ],
        },
        {
          id: 'api', situation: 'With an available number, connected through Meta', titre: 'Your number, connected through Meta',
          textes: [
            'Claude opens Meta’s window: you choose your Meta Business account there, or create it along the way with your Facebook profile, then connect your number.',
            'Your store’s three messages go out, and your AI agent answers. Meta bills your store’s messages, and replies beyond a monthly allowance: a payment method is added at Meta.',
          ],
        },
        {
          id: 'api-fourni', situation: 'Without an available number, with a provided number connected through Meta', titre: 'A provided number, connected through Meta',
          textes: [
            `Take a provided number, at ${numero} excl. VAT a month with the Free plan, included in Pro: Claude connects it to your Meta Business account, which Meta’s window has you create along the way if you lack one.`,
            'Your store’s three messages go out, and your AI agent answers. Meta bills your store’s messages, and replies beyond a monthly allowance: a payment method is added at Meta.',
          ],
        },
        {
          id: 'qr', situation: 'Without a Meta Business account, by QR code, to answer', titre: 'Your number by QR code, to answer',
          textes: [
            `Link your number, or a provided number at ${numero} excl. VAT a month, by QR code and with no account at all: your AI agent answers the customers who write to you, and Meta does not bill those replies.`,
            'But nothing goes out first, neither confirmation, nor shipping notice, nor reminder: WhatsApp can cut a number linked this way that writes to strangers. The number must be in the WhatsApp Business app on a phone, and a provided number keeps yours safe. The Pro plan needs a Meta Business account.',
            'Later, to write first (your store’s messages), you will keep your app and connect the same number through Meta (“Keep my WhatsApp Business app”, from Claude or the console’s Home): Meta’s window will have you create the Meta Business account, and your conversations stay.',
          ],
        },
      ],
      plus: 'For:', moins: 'Against:',
      recommencer: 'Start again',
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
            'The full console, your store’s card included',
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
        { id: 'faq-numero', q: 'Which WhatsApp number should I use?', r: `It depends on your number and your WhatsApp Business app: the guide above gives you your path. Your store’s messages go out from a number connected through Meta: yours if it is available, a provided number at ${numero} excl. VAT a month, and soon the number of your WhatsApp Business app, which you keep. Meta’s window has you create your Meta Business account along the way if you lack one. With no account at all, a number linked by QR code serves to answer: WhatsApp can cut a number linked this way that writes first. Later, this number will be able to keep the app and go through Meta to write first, keeping its conversations.` },
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
