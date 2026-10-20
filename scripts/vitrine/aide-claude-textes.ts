// scripts/vitrine/aide-claude-textes.ts
// Les pages « Depuis Claude Code » de la doc développeurs (plan du centre d'aide, tâche 7) : UNE source, en français et
// en anglais, sur le modèle de la FAQ du plugin (`scripts/plugin/faq.ts`). `npm run vitrine:aide` les écrit sur le
// gabarit du centre d'aide ; `tests/vitrine-aide.test.ts` exige que chaque outil cité existe dans le catalogue MCP.
//
// 🔴 Chaque étape dit ce qu'on dit à Claude, les outils qu'il appelle (leurs vrais noms, `web/lib/partage/catalogue-mcp.ts`)
// et ce qu'il répond, relus dans `src/mcp/` et dans les skills du plugin. Les commandes viennent de `web/lib/demarrer.ts`.
import { DUREE_CODE_MS } from '../../src/campaign/confirmation';
import { COMMANDE_DEMARRAGE, COMMANDES_PLUGIN, SERVEUR_PLUGIN_MCP } from '../../web/lib/demarrer';

export interface Bilingue {
  readonly fr: string;
  readonly en: string;
}

/**
 * Une étape : ce que la personne tape ou dit (`dire`, un texte entre accents graves s'affiche comme une commande), les
 * outils que Claude appelle, et ce qu'il fait ou répond.
 */
export interface EtapeClaude {
  readonly titre: Bilingue;
  readonly dire: Bilingue;
  readonly outils: readonly string[];
  readonly reponse: Bilingue;
}

export interface PageClaude {
  readonly cle: string;
  readonly adresse: Bilingue;
  readonly titre: Bilingue;
  readonly chapeau: Bilingue;
  readonly etapes: readonly EtapeClaude[];
  readonly bonASavoir?: Bilingue;
  /** La page demande l'offre Pro (outils de la fonction `console` ou `statistiques`). */
  readonly offrePro?: boolean;
  /** Un film de `site/films/` (et sa version `-en`), 16:9. */
  readonly film?: string;
}

const MINUTES_CODE = Math.round(DUREE_CODE_MS / 60_000);

export const PAGES_CLAUDE: readonly PageClaude[] = [
  {
    cle: 'installer-le-plugin',
    adresse: { fr: '/developpeurs/installer-le-plugin/', en: '/en/developers/install-the-plugin/' },
    titre: { fr: 'Installer le plugin et relier votre espace', en: 'Install the plugin and link your workspace' },
    chapeau: {
      fr: 'Deux commandes dans Claude Code, une autorisation avec Google, et Claude pilote votre WhatsApp. L’espace se crée à l’autorisation, sans formulaire.',
      en: 'Two commands in Claude Code, one authorization with Google, and Claude runs your WhatsApp. The workspace is created at authorization, with no form.',
    },
    film: 'cas-onboarding',
    etapes: [
      {
        titre: { fr: 'Ajouter le plugin', en: 'Add the plugin' },
        dire: { fr: `\`${COMMANDES_PLUGIN[0]}\` puis, séparément, \`${COMMANDES_PLUGIN[1]}\``, en: `\`${COMMANDES_PLUGIN[0]}\` then, separately, \`${COMMANDES_PLUGIN[1]}\`` },
        outils: [],
        reponse: {
          fr: 'Claude Code installe le plugin Messaging Me : ses outils et ses consignes. Tapez les deux commandes l’une après l’autre : collées, Claude Code n’en lancerait qu’une.',
          en: 'Claude Code installs the Messaging Me plugin: its tools and its instructions. Type the two commands one after the other: pasted together, Claude Code would only run one.',
        },
      },
      {
        titre: { fr: 'Autoriser l’accès', en: 'Authorize access' },
        dire: { fr: `\`/mcp\`, choisissez \`${SERVEUR_PLUGIN_MCP}\`, puis Authenticate`, en: `\`/mcp\`, choose \`${SERVEUR_PLUGIN_MCP}\`, then Authenticate` },
        outils: [],
        reponse: {
          fr: 'Une page s’ouvre dans votre navigateur : continuez avec Google, puis autorisez. Sans compte, votre espace naît à ce moment, sans formulaire.',
          en: 'A page opens in your browser: continue with Google, then authorize. With no account yet, your workspace is created right then, with no form.',
        },
      },
      {
        titre: { fr: 'Lancer la mise en service', en: 'Start the setup' },
        dire: { fr: `\`${COMMANDE_DEMARRAGE}\``, en: `\`${COMMANDE_DEMARRAGE}\`` },
        outils: ['get_setup_state'],
        reponse: {
          fr: 'Claude lit où en est votre espace et propose l’étape suivante : connecter le numéro, construire l’agent IA, poser la bulle WhatsApp sur votre site. Une mise en service interrompue reprend où elle s’était arrêtée.',
          en: 'Claude reads where your workspace stands and offers the next step: connect the number, build the AI agent, put the WhatsApp bubble on your site. An interrupted setup resumes where it stopped.',
        },
      },
    ],
  },
  {
    cle: 'connecter-son-numero',
    adresse: { fr: '/developpeurs/connecter-son-numero/', en: '/en/developers/connect-your-number/' },
    titre: { fr: 'Connecter votre numéro WhatsApp depuis Claude', en: 'Connect your WhatsApp number from Claude' },
    chapeau: {
      fr: 'Claude vous donne le lien de la fenêtre de Meta, suit la connexion pendant que vous la faites, et vous dit quand le numéro est prêt.',
      en: 'Claude gives you the link to Meta’s window, follows the connection while you go through it, and tells you when the number is ready.',
    },
    etapes: [
      {
        titre: { fr: 'Choisir le numéro', en: 'Choose the number' },
        dire: { fr: 'Connecte mon numéro WhatsApp.', en: 'Connect my WhatsApp number.' },
        outils: ['get_setup_state'],
        reponse: {
          fr: 'Claude rappelle ce que Meta exige (un portefeuille d’entreprise) et demande quel numéro utiliser : un numéro que nous fournissons, ou le vôtre, à condition qu’il ne serve pas dans l’application WhatsApp.',
          en: 'Claude recalls what Meta requires (a business portfolio) and asks which number to use: a number we provide, or yours, as long as it is not used in the WhatsApp app.',
        },
      },
      {
        titre: { fr: 'Ouvrir le lien', en: 'Open the link' },
        dire: { fr: 'Un numéro fourni, s’il te plaît.', en: 'A provided number, please.' },
        outils: ['start_whatsapp_connection'],
        reponse: {
          fr: 'Claude écrit le lien, valable une heure, puis les étapes de la fenêtre de Meta, une par ligne : les mêmes que sur la page.',
          en: 'Claude writes the link, valid for one hour, then the steps of Meta’s window, one per line: the same as on the page.',
        },
      },
      {
        titre: { fr: 'Suivre la connexion', en: 'Follow the connection' },
        dire: { fr: 'J’ai ouvert la fenêtre de Meta.', en: 'I opened Meta’s window.' },
        outils: ['watch_whatsapp_connection'],
        reponse: {
          fr: 'Claude suit la connexion et vous écrit le code de vérification dès qu’il arrive : vous le tapez dans la fenêtre de Meta, puis vous allez jusqu’au dernier écran, « Finish ».',
          en: 'Claude follows the connection and writes the verification code as soon as it arrives: you type it into Meta’s window, then go all the way to the last screen, “Finish”.',
        },
      },
      {
        titre: { fr: 'Ajouter la carte chez Meta', en: 'Add the card at Meta' },
        dire: { fr: 'C’est fini ?', en: 'Is it done?' },
        outils: ['get_setup_state'],
        reponse: {
          fr: 'Claude confirme le numéro connecté et vous donne les étapes pour ajouter une carte Visa ou Mastercard chez Meta : sans elle, les modèles ne partent pas.',
          en: 'Claude confirms the connected number and gives you the steps to add a Visa or Mastercard card at Meta: without it, templates do not go out.',
        },
      },
    ],
    bonASavoir: {
      fr: 'Le premier numéro de votre espace reçoit 1 € de crédit IA dès que Meta l’a vérifié. Le détail de ce qu’il faut chez Meta est dans le guide du compte Meta Business.',
      en: 'Your workspace’s first number receives €1 of AI credit as soon as Meta has verified it. What you need at Meta is detailed in the Meta Business account guide.',
    },
  },
  {
    cle: 'repondre-a-une-conversation',
    adresse: { fr: '/developpeurs/repondre-a-une-conversation/', en: '/en/developers/reply-to-a-conversation/' },
    titre: { fr: 'Répondre à un client depuis Claude', en: 'Reply to a customer from Claude' },
    chapeau: {
      fr: 'Claude lit vos conversations, vous dit si la fenêtre de 24 heures est ouverte, et répond pour vous quand vous le lui demandez.',
      en: 'Claude reads your conversations, tells you whether the 24-hour window is open, and replies for you when you ask.',
    },
    etapes: [
      {
        titre: { fr: 'Voir qui vous a écrit', en: 'See who wrote to you' },
        dire: { fr: 'Qui m’a écrit aujourd’hui ?', en: 'Who wrote to me today?' },
        outils: ['list_conversations'],
        reponse: {
          fr: 'Claude liste les conversations récentes, la plus récente d’abord, avec le dernier message de chacune.',
          en: 'Claude lists the recent conversations, most recent first, with the last message of each.',
        },
      },
      {
        titre: { fr: 'Lire une conversation', en: 'Read a conversation' },
        dire: { fr: 'Montre-moi celle de Léa.', en: 'Show me Léa’s.' },
        outils: ['get_conversation'],
        reponse: {
          fr: 'Claude résume l’échange et vous dit si la fenêtre de 24 heures est ouverte, c’est-à-dire si Léa vous a écrit dans les vingt-quatre dernières heures.',
          en: 'Claude sums up the exchange and tells you whether the 24-hour window is open, that is whether Léa wrote to you in the last twenty-four hours.',
        },
      },
      {
        titre: { fr: 'Répondre dans la fenêtre', en: 'Reply within the window' },
        dire: { fr: 'Réponds-lui que sa commande part demain.', en: 'Tell her that her order ships tomorrow.' },
        outils: ['reply_in_open_window'],
        reponse: {
          fr: 'La fenêtre est ouverte : Claude envoie le message, tel qu’elle le lira. Fenêtre fermée, l’envoi est refusé, et Claude vous propose un modèle.',
          en: 'The window is open: Claude sends the message, as she will read it. With the window closed, the send is refused, and Claude offers you a template.',
        },
      },
      {
        titre: { fr: 'Hors de la fenêtre, un modèle', en: 'Outside the window, a template' },
        dire: { fr: 'Envoie-lui le modèle de suivi de commande.', en: 'Send her the order follow-up template.' },
        outils: ['list_templates', 'send_template_to_contact'],
        reponse: {
          fr: 'Claude choisit le modèle approuvé, remplit ses variables avec la fiche de Léa et l’envoie.',
          en: 'Claude picks the approved template, fills in its variables from Léa’s record and sends it.',
        },
      },
    ],
  },
  {
    cle: 'preparer-une-campagne',
    adresse: { fr: '/developpeurs/preparer-une-campagne/', en: '/en/developers/prepare-a-campaign/' },
    titre: { fr: 'Préparer et lancer une campagne depuis Claude', en: 'Prepare and launch a campaign from Claude' },
    chapeau: {
      fr: 'Dites à qui écrire et quoi envoyer : Claude prépare un brouillon, vous montre le récapitulatif, et ne lance qu’avec votre oui et son code.',
      en: 'Say who to write to and what to send: Claude prepares a draft, shows you the summary, and only launches with your yes and its code.',
    },
    offrePro: true,
    etapes: [
      {
        titre: { fr: 'Trouver les destinataires', en: 'Find the recipients' },
        dire: { fr: 'Qui a parlé de la collection d’automne cette semaine ?', en: 'Who talked about the autumn collection this week?' },
        outils: ['list_conversations', 'find_contacts'],
        reponse: {
          fr: 'Claude retrouve les contacts concernés et leur nombre. Il faut au moins un critère : il n’existe pas de cible « tout le monde ».',
          en: 'Claude finds the contacts concerned and how many there are. At least one criterion is needed: there is no “everyone” target.',
        },
      },
      {
        titre: { fr: 'Préparer la campagne', en: 'Prepare the campaign' },
        dire: { fr: 'Prépare une campagne avec le modèle de la collection d’automne pour eux, envoi demain à 10 h.', en: 'Prepare a campaign with the autumn collection template for them, sending tomorrow at 10 am.' },
        outils: ['prepare_campaign'],
        reponse: {
          fr: 'Claude crée un brouillon, visible dans la console, sans rien envoyer, et vous montre le récapitulatif : combien partent, qui est écarté et pourquoi, cinq noms, la date en heure de Paris, et un code de confirmation.',
          en: 'Claude creates a draft, visible in the console, without sending anything, and shows you the summary: how many go out, who is left out and why, five names, the date in Paris time, and a confirmation code.',
        },
      },
      {
        titre: { fr: 'Dire oui', en: 'Say yes' },
        dire: { fr: 'Oui, lance-la.', en: 'Yes, launch it.' },
        outils: ['launch_campaign'],
        reponse: {
          fr: 'Claude lance avec le code du récapitulatif : la campagne est programmée pour la date choisie, ou part tout de suite si aucune date n’a été donnée.',
          en: 'Claude launches with the summary’s code: the campaign is scheduled for the chosen date, or starts right away if no date was given.',
        },
      },
      {
        titre: { fr: 'Suivre les résultats', en: 'Follow the results' },
        dire: { fr: 'Où en est la campagne ?', en: 'How is the campaign doing?' },
        outils: ['get_campaign_stats'],
        reponse: {
          fr: 'Claude lit les envois, les lectures et les réponses de la campagne.',
          en: 'Claude reads the campaign’s sends, reads and replies.',
        },
      },
    ],
    bonASavoir: {
      fr: `Le code de confirmation sert une fois, pendant ${MINUTES_CODE} minutes, et pour la campagne exactement telle que résumée : si quelque chose change, Claude la prépare à nouveau. Un modèle marketing ne part qu’aux contacts qui ont donné leur consentement, et ceux qui ont répondu STOP sont écartés.`,
      en: `The confirmation code works once, for ${MINUTES_CODE} minutes, and only for the campaign exactly as summarized: if anything changes, Claude prepares it again. A marketing template only reaches contacts who gave their consent, and those who replied STOP are left out.`,
    },
  },
];
