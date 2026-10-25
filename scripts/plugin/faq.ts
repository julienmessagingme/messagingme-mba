/**
 * LA FAQ DE MESSAGING ME POUR LES DÉVELOPPEURS (lot 10) : UNE source, en français et en anglais. `npm run plugin:generer`
 * l'écrit dans la skill `faq` du plugin Claude Code (`plugin/skills/faq/SKILL.md`) et dans le bloc FAQ des deux pages
 * développeurs de la vitrine ; `tests/plugin-faq.test.ts` refait les sorties et exige l'égalité au caractère près.
 *
 * 🔴 CHAQUE RÉPONSE NOMME SA SOURCE (`source`), relue au moment de l'écrire. Les chiffres de nos offres viennent du code,
 * jamais recopiés. Les tarifs de Meta ne portent AUCUN chiffre (décision du lot 17) : ils changent plusieurs fois par an,
 * et notre fiche produit (`brain/MESSAGINGME.md`, § tarifs) est la seule référence avant d'en écrire un mot.
 */
import { DROITS, PRIX_SIEGE_HT_CENTIMES } from '../../src/offres/offres';
import { PRIX_NUMERO_HT_CENTIMES } from '../../src/stripe/abonnement';
import { ETAPES_CARTE_META, PREREQUIS_META } from '../../web/lib/partage/etapes-meta';
import { DUREE_CODE_MS } from '../../src/campaign/confirmation';
import { NOMS_DU_RECAPITULATIF } from '../../src/mcp/outils-campagnes';

export interface EntreeFaq {
  /** L'ancre, stable : la vitrine et la skill la portent. */
  id: string;
  question: { fr: string; en: string };
  reponse: { fr: string; en: string };
  /** Ce qui fait foi pour la réponse : un fichier du dépôt, une fiche d'aide, la fiche produit. */
  source: string;
}

const prix = (centimes: number, langue: 'fr' | 'en'): string => {
  const e = (centimes / 100).toFixed(2);
  return langue === 'fr' ? `${e.replace('.', ',')} € HT` : `€${e} excl. VAT`;
};
const NUMERO_FR = `${prix(PRIX_NUMERO_HT_CENTIMES, 'fr')} par mois`;
const NUMERO_EN = `${prix(PRIX_NUMERO_HT_CENTIMES, 'en')} a month`;
const nombre = (n: number, langue: 'fr' | 'en'): string =>
  langue === 'fr' ? n.toLocaleString('fr-FR').replace(/\u202f/g, ' ') : n.toLocaleString('en-US');
/** Les modèles par mois d'une offre, dits depuis `DROITS` : `null` (sans limite) se dit, il ne devient jamais « 0 ». */
const modeles = (limite: number | null, langue: 'fr' | 'en'): string => limite === null
  ? (langue === 'fr' ? 'illimités' : 'unlimited')
  : (langue === 'fr' ? `${nombre(limite, 'fr')} modèles par mois` : `${nombre(limite, 'en')} templates a month`);
const UTILISATEURS_FREE = DROITS.base.limites.utilisateurs;
const UTILISATEURS_PRO = DROITS.pro.limites.utilisateurs;
/** Le prix d'un utilisateur en plus du Pro, au mois (livraison 7), en euros entiers. */
const SIEGE_MOIS = PRIX_SIEGE_HT_CENTIMES.mois / 100;
const INCLUS_FR = DROITS.pro.limites.numeroInclus ? ', inclus dans le Pro' : '';
const INCLUS_EN = DROITS.pro.limites.numeroInclus ? ', included in Pro' : '';
const GRILLE_META = 'https://developers.facebook.com/docs/whatsapp/pricing';
/** Les étapes chez Meta, de la même source que la console et que Claude (`web/lib/partage/etapes-meta.ts`). */
const enUnBloc = (etapes: ReadonlyArray<{ fr: string; en: string }>, langue: 'fr' | 'en'): string =>
  etapes.map((e, i) => `${i + 1}) ${e[langue]}`).join(' ');

export const FAQ: readonly EntreeFaq[] = [
  {
    id: 'api-officielle',
    question: { fr: 'C’est l’API officielle de WhatsApp ?', en: 'Is this the official WhatsApp API?' },
    reponse: {
      fr: 'Avec un compte Meta Business, oui : la WhatsApp Business Platform de Meta. Messaging Me est Tech Provider de Meta, et le compte WhatsApp Business est dans votre Business Manager et reste à vous. Sans compte Meta Business, vous pouvez relier l’application WhatsApp Business de votre téléphone : elle passe par WhatsApp comme un appareil lié, ce n’est pas l’API officielle.',
      en: 'With a Meta Business account, yes: Meta’s WhatsApp Business Platform. Messaging Me is a Meta Tech Provider, and the WhatsApp Business account lives in your Business Manager and stays yours. Without a Meta Business account, you can link the WhatsApp Business app on your phone: it goes through WhatsApp as a linked device, it is not the official API.',
    },
    source: 'src/http/embedded-signup.ts (connexion par l’Embedded Signup de Meta) ; src/application/ (filière application, 2026-10-22) ; brain/MESSAGINGME.md',
  },
  {
    id: 'application-whatsapp-business',
    question: { fr: 'Je n’ai pas de compte Meta Business : je peux quand même ?', en: 'I have no Meta Business account: can I still use it?' },
    reponse: {
      fr: 'Oui, de deux façons. La fenêtre de Meta vous fait créer votre compte Meta Business en chemin, avec votre profil Facebook, et votre numéro passe par l’API officielle. Ou bien reliez l’application WhatsApp Business de votre téléphone par un QR code, sans aucun compte (ni profil Facebook, ni carte chez Meta) : l’agent IA y répond aux clients qui écrivent, sans que Meta facture ces réponses, Claude y lit et y répond, et vous répondez toujours depuis le téléphone. Elle passe par WhatsApp comme un appareil lié, ce n’est pas l’API officielle. Rien n’y part en premier (ni modèles, ni campagnes, ni messages Shopify), et WhatsApp peut couper un numéro. Plus tard, pour écrire en premier, ce numéro garde l’application et passe par Meta, en gardant ses conversations : la fenêtre de Meta crée alors le compte Meta Business. L’offre Pro demande l’API.',
      en: 'Yes, in two ways. Meta’s window has you create your Meta Business account along the way, with your Facebook profile, and your number goes through the official API. Or link the WhatsApp Business app on your phone with a QR code, with no account at all (no Facebook profile, no card at Meta): the AI agent answers the customers who write, without Meta billing those replies, Claude reads and replies there, and you can still reply from the phone. It goes through WhatsApp as a linked device, it is not the official API. Nothing goes out first there (no templates, campaigns or Shopify messages), and WhatsApp can cut a number. Later, to write first, this number keeps the app and goes through Meta, keeping its conversations: Meta’s window then creates the Meta Business account. The Pro plan needs the API.',
    },
    source: 'src/application/ (filière application, spec du 2026-10-22) ; src/application/premier-message.ts (lot C, 2026-10-24 : le numéro QR code ne fait que répondre) ; src/stripe/pro.ts ; web/lib/partage/etapes-meta.ts (la fenêtre de Meta crée le portefeuille)',
  },
  {
    id: 'api-ou-application',
    question: { fr: 'Numéro de l’API ou application WhatsApp Business : lequel choisir ?', en: 'API number or WhatsApp Business app: which one should I choose?' },
    reponse: {
      fr: `Cela dépend de ce que votre numéro doit faire. Un numéro de l’API officielle, relié par Meta, écrit en premier. Il envoie modèles, confirmations, rappels, campagnes et messages Shopify ; il demande un compte Meta Business, gratuit, que la fenêtre de Meta vous fait créer en chemin avec votre profil Facebook, et un moyen de paiement chez Meta, qui facture les modèles et, au-delà d’une franchise mensuelle, les réponses. Sans compte Meta Business, pour un numéro à part, l’application WhatsApp Business reliée par QR code ne demande aucun compte, Meta ne facture pas ses réponses et elle reste sur votre téléphone, mais elle ne fait que répondre à ceux qui vous écrivent. Bientôt, vous pourrez aussi garder votre application WhatsApp Business sur le même numéro tout en passant par l’API, si vous le voulez : c’est aussi la suite d’un numéro relié par QR code qui veut écrire en premier, ses conversations comprises. Sans numéro libre, un numéro fourni coûte ${NUMERO_FR}${INCLUS_FR}. Claude vous pose les questions une par une pendant la mise en service.`,
      en: `It depends on what your number must do. An official API number, connected through Meta, writes first. It sends templates, confirmations, reminders, campaigns and Shopify messages; it needs a Meta Business account, free, which Meta’s window has you create along the way with your Facebook profile, and a payment method at Meta, which bills the templates and, beyond a monthly allowance, the replies. Without a Meta Business account, for a separate number, the WhatsApp Business app linked by QR code needs no account, Meta does not bill its replies and it stays on your phone, but it only answers those who write to you. Soon, you will also be able to keep your WhatsApp Business app on the same number while going through the API, if you want: it is also the next step of a number linked by QR code that wants to write first, conversations included. Without a free number, a provided number costs ${NUMERO_EN}${INCLUS_EN}. Claude asks you the questions one at a time during setup.`,
    },
    source: 'l’arbre du numéro de Julien (2026-10-24, revu le 2026-10-25 après l’essai 161), repris par scripts/vitrine/boutique-textes.ts et la skill mise-en-service ; docs/superpowers/specs/2026-10-24-coexistence-design.md ; src/application/premier-message.ts (lot C) ; src/stripe/abonnement.ts',
  },
  {
    id: 'compte-meta',
    question: { fr: 'Que faut-il chez Meta avant de commencer ?', en: 'What do I need at Meta before I start?' },
    reponse: { fr: enUnBloc(PREREQUIS_META, 'fr'), en: enUnBloc(PREREQUIS_META, 'en') },
    source: 'web/lib/partage/etapes-meta.ts (doc Embedded Signup de Meta, aide « Créer un portefeuille business », relues le 2026-10-13)',
  },
  {
    id: 'nom-affiche',
    question: { fr: 'Mon nom d’entreprise s’affiche mal sur WhatsApp.', en: 'My business name shows up wrong on WhatsApp.' },
    reponse: {
      fr: 'C’est le nom d’affichage WhatsApp, distinct du nom de votre espace. Il se change dans votre Business Manager, et Meta relit chaque changement : pendant la relecture, ou après un refus, WhatsApp peut afficher le numéro à la place.',
      en: 'That is the WhatsApp display name, separate from your workspace name. You change it in your Business Manager, and Meta reviews every change: during the review, or after a rejection, WhatsApp may show the number instead.',
    },
    source: 'docs/aide/fiches/connecter-mon-numero-whatsapp.md',
  },
  {
    id: 'fenetre-24-heures',
    question: { fr: 'Mon message n’est pas parti.', en: 'My message was not sent.' },
    reponse: {
      fr: 'Passé 24 heures sans message de la personne, seul un modèle approuvé par Meta peut partir (send_template_to_contact). Dans les 24 heures qui suivent son dernier message, une réponse libre part (reply_in_open_window). get_conversation dit si la fenêtre est ouverte.',
      en: 'After 24 hours without a message from the person, only a template approved by Meta can be sent (send_template_to_contact). Within 24 hours of their last message, a free-form reply goes out (reply_in_open_window). get_conversation tells whether the window is open.',
    },
    source: 'docs/aide/fiches/la-fenetre-de-24-heures.md',
  },
  {
    id: 'ce-que-meta-facture',
    question: { fr: 'Pourquoi Meta me demande une carte, et que facture-t-il ?', en: 'Why does Meta ask for a card, and what does it charge?' },
    reponse: {
      fr: `Meta facture directement votre entreprise, sur le moyen de paiement de votre Business Manager : les modèles, et depuis le 1er octobre 2026 les réponses dans la fenêtre de 24 heures aussi, selon sa grille et le pays de la personne. Messaging Me ne touche pas à ces frais. La grille de Meta : ${GRILLE_META}. Pour ajouter la carte : ${enUnBloc(ETAPES_CARTE_META, 'fr')}`,
      en: `Meta bills your business directly, on the payment method of your Business Manager: templates, and since October 1, 2026 replies within the 24-hour window too, according to its rate card and the person’s country. Messaging Me never touches these fees. Meta’s rate card: ${GRILLE_META}. To add the card: ${enUnBloc(ETAPES_CARTE_META, 'en')}`,
    },
    source: 'brain/MESSAGINGME.md, § Pricing WhatsApp (fin de la fenêtre de service gratuite le 2026-10-01) ; web/lib/partage/etapes-meta.ts (aide Meta 488291839463771, relue le 2026-10-13)',
  },
  {
    id: 'modele-refuse',
    question: { fr: 'Mon modèle a été refusé.', en: 'My template was rejected.' },
    reponse: {
      fr: 'Claude lit le motif du refus (get_template_status), propose une version corrigée et la soumet de nouveau (create_template). Meta peut aussi changer la catégorie d’un modèle : list_templates montre celle qui s’applique.',
      en: 'Claude reads the rejection reason (get_template_status), suggests a corrected version and submits it again (create_template). Meta may also change a template’s category: list_templates shows the one that applies.',
    },
    source: 'docs/aide/fiches/faire-approuver-un-modele.md ; src/mcp/outils-modeles.ts',
  },
  {
    id: 'agent-muet',
    question: { fr: 'Mon agent IA ne répond plus.', en: 'My AI agent stopped answering.' },
    reponse: {
      fr: 'Trois causes. Le crédit IA est épuisé : get_credit, puis buy_credit. L’agent a été désactivé, ou n’est plus celui qui répond : get_setup_state le dit. Quelqu’un a répondu à la main, Claude compris (reply_in_open_window) : répondre prend la conversation, et l’agent se tait jusqu’à ce qu’elle lui revienne, d’elle-même après un délai sans nouvelle réponse, ou tout de suite : control_conversation la rend depuis Claude, ou « Rendre la main » dans l’Inbox de la console.',
      en: 'Three causes. The AI credit is used up: get_credit, then buy_credit. The agent was deactivated, or is no longer the one answering: get_setup_state tells. Someone replied by hand, Claude included (reply_in_open_window): replying takes over the conversation, and the agent stays silent until it gets it back, on its own after a delay without a new reply, or right away: control_conversation hands it back from Claude, or “Hand back” in the console Inbox.',
    },
    source: 'docs/aide/fiches/recharger-le-credit-ia.md ; docs/aide/fiches/repondre-dans-l-inbox.md (le délai, « Rendre la main ») ; src/mcp/outils.ts (reply_in_open_window prend le fil, control_conversation le rend) ; src/mcp/mise-en-service.ts',
  },
  {
    id: 'agent-actions',
    question: { fr: 'Mon agent IA peut-il agir dans mon application ?', en: 'Can my AI agent act in my application?' },
    reponse: {
      fr: 'Oui, par une action : set_agent_action la pose sur l’agent, avec une consigne (quand la déclencher, quoi dire au client ensuite) et ce qu’il recueille (un numéro de contrat, une date, un motif), tout facultatif. Quand le client fait la demande, l’agent lui répond ce que prévoit la consigne et continue, et votre application reçoit le webhook agent.action, une fois par jour au plus par contact et par action. Ce type est décoché par défaut : ajoutez-le à l’adresse qui sert déjà votre application (update_webhook_endpoint, ou la console, Developers > Webhooks sortants), ou créez-en une (create_webhook_endpoint). Sans application, une automation de la console peut partir de l’action.',
      en: 'Yes, through an action: set_agent_action adds it to the agent, with an instruction (when to trigger it, what to tell the customer next) and what it collects (a contract number, a date, a reason), all optional. When the customer makes the request, the agent answers what the instruction says and carries on, and your application receives the agent.action webhook, at most once a day per contact and per action. This type is unchecked by default: add it to the address that already serves your application (update_webhook_endpoint, or the console, Developers > Webhooks sortants), or create one (create_webhook_endpoint). Without an application, a console automation can start from the action.',
    },
    source: 'src/agent/actions.ts ; src/mcp/outils-agent.ts (set_agent_action) ; docs/superpowers/specs/2026-10-13-actions-agent-design.md',
  },
  {
    id: 'code-de-verification',
    question: { fr: 'Le code de vérification n’arrive pas.', en: 'The verification code does not arrive.' },
    reponse: {
      fr: 'Avec un numéro fourni par Messaging Me, le code est capté pour vous et Claude l’affiche (watch_whatsapp_connection). Avec votre numéro, demandez l’appel plutôt que le SMS quand Meta laisse le choix. Meta ne tolère que dix demandes de code par numéro sur 72 heures.',
      en: 'With a number provided by Messaging Me, the code is captured for you and Claude shows it (watch_whatsapp_connection). With your own number, ask for a call rather than an SMS when Meta offers the choice. Meta allows only ten code requests per number over 72 hours.',
    },
    source: 'docs/aide/fiches/connecter-mon-numero-whatsapp.md',
  },
  {
    id: 'numero-dans-l-application',
    question: { fr: 'Puis-je garder ce numéro dans l’application WhatsApp ?', en: 'Can I keep this number in the WhatsApp app?' },
    reponse: {
      fr: 'Pas encore avec l’API : un numéro qui y est branché quitte l’application WhatsApp. Bientôt, vous pourrez garder l’application WhatsApp Business sur le même numéro, si vous le voulez. En attendant, prenez un numéro dédié pour l’API, le vôtre ou un numéro fourni.',
      en: 'Not yet with the API: a number connected to it leaves the WhatsApp app. Soon, you will be able to keep the WhatsApp Business app on the same number, if you want. Meanwhile, use a dedicated number for the API, your own or a provided one.',
    },
    source: 'docs/superpowers/specs/2026-10-24-coexistence-design.md (la coexistence, en construction) ; src/application/premier-message.ts (lot C)',
  },
  {
    id: 'numero-fourni',
    question: { fr: 'Le numéro fourni m’appartient-il ?', en: 'Do I own the provided number?' },
    reponse: {
      fr: `Non : il est loué ${NUMERO_FR}${INCLUS_FR}. Un numéro que vous apportez reste à vous.`,
      en: `No: it is rented for ${NUMERO_EN}${INCLUS_EN}. A number you bring stays yours.`,
    },
    source: 'src/stripe/abonnement.ts (PRIX_NUMERO_HT_CENTIMES) ; src/offres/offres.ts (numeroInclus)',
  },
  {
    id: 'combien-de-messages',
    question: { fr: 'Combien de messages puis-je envoyer ?', en: 'How many messages can I send?' },
    reponse: {
      fr: `Trois limites. Celle de l’offre : ${modeles(DROITS.base.limites.envoisModelesMois, 'fr')} en Free, ${modeles(DROITS.pro.limites.envoisModelesMois, 'fr')} en Pro ; les réponses dans la fenêtre de 24 heures n’y comptent jamais. Celle de l’API : un quota par jour et par espace, selon l’offre, où les modèles et les réponses se comptent à part (un envoi de modèles ne prend jamais la place des réponses), relevable sur demande ; au-delà, le refus quota_exceeded jusqu’au lendemain. Et celle de Meta, qui fixe ce qu’un numéro peut envoyer et l’augmente avec sa qualité.`,
      en: `Three limits. The plan’s: ${modeles(DROITS.base.limites.envoisModelesMois, 'en')} on Free, ${modeles(DROITS.pro.limites.envoisModelesMois, 'en')} on Pro; replies within the 24-hour window never count. The API’s: a daily quota per workspace, set by the plan, where templates and replies are counted separately (sending templates never takes the room of replies), raised on request; beyond it, the quota_exceeded refusal until the next day. And Meta’s, which sets what a number can send and raises it with its quality.`,
    },
    // Le quota du jour ne se chiffre pas : une limite invisible (spec offres v2), comme les plafonds d'appels.
    source: 'src/offres/offres.ts (DROITS) ; src/api/quotas.ts (les familles du quota) ; docs/aide/fiches/choisir-mon-offre.md',
  },
  {
    id: 'preparer-une-campagne',
    question: { fr: 'Claude peut-il préparer et lancer une campagne ?', en: 'Can Claude prepare and launch a campaign?' },
    reponse: {
      fr: `Oui, en Pro, et rien ne part sans votre oui. Claude trouve les contacts (find_contacts), en fait un segment, qui est une étiquette (tag_contacts), puis prépare la campagne (prepare_campaign) : un brouillon visible dans la console, avec un récapitulatif (contacts visés, combien partiront, les écartés et pourquoi, ${NOMS_DU_RECAPITULATIF} noms, le nombre de messages facturables par Meta) et un code valable ${DUREE_CODE_MS / 60_000} minutes. Il ne lance (launch_campaign) qu'après votre oui, avec ce code ; une date choisie programme l'envoi. Vous pouvez aussi lancer le brouillon depuis la console. Le modèle doit être approuvé, et un modèle marketing ne part qu'aux contacts qui ont consenti.`,
      en: `Yes, on Pro, and nothing goes out without your yes. Claude finds the contacts (find_contacts), turns them into a segment, which is a tag (tag_contacts), then prepares the campaign (prepare_campaign): a draft visible in the console, with a summary (contacts targeted, how many will receive it, those left out and why, ${NOMS_DU_RECAPITULATIF} names, the number of messages Meta bills) and a code valid for ${DUREE_CODE_MS / 60_000} minutes. It only launches (launch_campaign) after your yes, with that code; a chosen date schedules the send. You can also launch the draft from the console. The template must be approved, and a marketing template only reaches contacts who opted in.`,
    },
    source: 'docs/superpowers/specs/2026-10-20-campagnes-depuis-claude-design.md ; src/mcp/outils-campagnes.ts ; src/campaign/confirmation.ts',
  },
  {
    id: 'ajouter-un-collegue',
    question: { fr: 'Comment ajouter un collègue ?', en: 'How do I add a colleague?' },
    reponse: {
      fr: `Depuis la console, par une invitation. ${UTILISATEURS_FREE} utilisateur en Free, ${UTILISATEURS_PRO} en Pro puis ${SIEGE_MOIS} € HT par utilisateur en plus et par mois (proposé à l'invitation), selon le devis en Entreprise.`,
      en: `From the console, with an invitation. ${UTILISATEURS_FREE} user on Free, ${UTILISATEURS_PRO} on Pro then €${SIEGE_MOIS} excl. VAT per extra user per month (offered when inviting), per quote on Enterprise.`,
    },
    source: 'src/offres/offres.ts (DROITS) ; docs/aide/fiches/inviter-mon-equipe-et-gerer-les-acces.md',
  },
  {
    id: 'resilier',
    question: { fr: 'Comment résilier, et que devient le numéro ?', en: 'How do I cancel, and what happens to the number?' },
    reponse: {
      fr: `Le Pro et le numéro fourni se gèrent dans le portail de Stripe, depuis la page Offre de la console ou par Claude (manage_number_subscription). À la fin d’un Pro, le numéro fourni passe à ${NUMERO_FR} sur la même carte, sauf si vous choisissez de le rendre (return_number_at_plan_end).`,
      en: `Pro and the provided number are managed in the Stripe portal, from the console Plan page or through Claude (manage_number_subscription). When Pro ends, the provided number moves to ${NUMERO_EN} on the same card, unless you choose to give it back (return_number_at_plan_end).`,
    },
    source: 'docs/aide/fiches/choisir-mon-offre.md ; src/mcp/outils-numero.ts',
  },
  {
    id: 'mettre-a-jour-le-plugin',
    question: { fr: 'Comment mettre à jour le plugin ?', en: 'How do I update the plugin?' },
    reponse: {
      fr: 'Il ne se met pas à jour tout seul. Dans Claude Code : /plugin, onglet Marketplaces, messagingme, « Update marketplace » (ou « Enable auto-update » pour la suite). En terminal : claude plugin update messagingme@messagingme ; sous Windows, dans PowerShell, écrivez claude.cmd au lieu de claude (PowerShell bloque le script claude.ps1). Le nouveau code se charge à la session suivante, ou après /reload-plugins.',
      en: 'It does not update on its own. In Claude Code: /plugin, Marketplaces tab, messagingme, “Update marketplace” (or “Enable auto-update” from then on). In a terminal: claude plugin update messagingme@messagingme; on Windows, in PowerShell, type claude.cmd instead of claude (PowerShell blocks the claude.ps1 script). The new code loads in the next session, or after /reload-plugins.',
    },
    source: 'documentation de Claude Code (plugins, mises à jour), lue le 2026-10-12 ; claude.ps1 refusé par la politique d’exécution de PowerShell, claude.cmd accepté, mesuré le 2026-10-22 sur le poste de Julien',
  },
  {
    id: 'serveur-ajoute-a-la-main',
    question: { fr: 'J’avais déjà ajouté le serveur à la main : que faire ?', en: 'I had already added the server by hand: what now?' },
    reponse: {
      fr: 'Branché sans clé (autorisé par /mcp) : rien à faire. Claude Code garde le vôtre et met celui du plugin de côté, sans outil en double. Branché avec une clé d’API : retirez-le (claude mcp remove suivi de son nom). Une clé n’ouvre pas les outils de mise en service, et c’est pourtant ce serveur-là que Claude Code garderait.',
      en: 'Connected without a key (authorized through /mcp): nothing to do. Claude Code keeps yours and sets the plugin’s aside, with no duplicate tools. Connected with an API key: remove it (claude mcp remove followed by its name). A key does not open the setup tools, and yet Claude Code would keep that server.',
    },
    source: 'Claude Code, journal de débogage lu le 2026-10-13 (« Suppressing plugin MCP server … duplicates manually-configured »)',
  },
];
