/**
 * Répondre dans la fenêtre de service de 24 h. Une seule implémentation pour la console et le serveur MCP :
 * un outil MCP n'a jamais de logique métier à lui, sinon un agent tiers enverrait des WhatsApp avec d'autres
 * garde-fous que l'interface.
 *
 * L'ordre des gestes compte :
 *   1. la conversation existe et appartient à cet espace (sinon rien de plus, IDOR) ;
 *   2. la fenêtre est ouverte (Meta refuse le texte libre en dehors : on refuse avant d'appeler). Sur la filière
 *      application, répondre reste toujours possible, par le service de connexions ; mais hors des 24 heures, une
 *      réponse qu'une machine écrit est un message écrit en premier : elle part par la porte (`ecrirePremier`), comptée
 *      et espacée (plan 2026-10-23, tâche 3) ;
 *   3. l'envoi ;
 *   4. la prise du fil et le journal, après l'envoi et en best-effort : un échec d'état ne doit jamais faire
 *      croire à un message perdu.
 */
import type { OrigineMessage } from './origine';
import { auteurDeLEnvoi, type AuteurDuChangement } from './evenements';
import { journaliserEnvoiAccepte, type EtatJournalSortant } from './journal-sortant';
import type { EnvoiApplication } from '../application/envoi';
import type { RaisonClient } from '../application/client';
import type { DemandePremierMessage, OriginePremier, RefusPremier, ResultatPremier } from '../application/premier-message';
import { sha256Hex } from '../lib/signature';

/** Ce que la réponse lit et écrit des conversations. */
export interface ConversationsRepondre {
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null>;
  recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    /** D'où vient le message. Obligatoire : déduite, elle a menti dès qu'un appelant sans expéditeur humain est
    *  apparu (le serveur MCP). */
    origine: OrigineMessage,
    type?: string,
    templateCategory?: string | null,
    templateName?: string | null,
    senderUserId?: string | null,
    /** Canal de la bulle. Absent -> WhatsApp. */
    channel?: 'whatsapp' | 'rcs',
    /**
     * Ce que l'opérateur avait écrit avant de faire traduire. `body`, lui, porte ce qui est parti. Absent -> les
     * deux sont la même chose, ce qui est le cas de tout envoi non traduit.
     */
    redactionOrigine?: string | null,
  ): Promise<void>;
}

export interface DepsRepondre {
  inbox: ConversationsRepondre;
  repo: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  sendReply(tenantId: string, phoneNumberId: string, to: string, text: string): Promise<string>;
  /**
   * Prend le fil. `par` : qui écrit, l'opérateur ou la machine (`auteurDeLEnvoi`), pour le journal du panneau
   * Détail de l'Inbox, qui dit « prise à l'agent de Meta par ... ».
   */
  takeControl(tenantId: string, waId: string, par: AuteurDuChangement): Promise<void>;
  /**
   * 🔴 Ce contact a-t-il demandé à ne plus être contacté ? Requise, lue seulement pour une origine machine :
   * la réponse d'un opérateur ne paie aucune requête.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * « Mon application répond » (lot 12, B) : le fil est-il tenu par l'application du client ? Lue seulement pour l'origine
   * `api` : sa réponse ne prend alors pas le fil, et le message suivant du client lui revient (`ControleDuFil`).
   */
  filTenuParLApplication(tenantId: string, waId: string): Promise<boolean>;
  /**
   * 🔴 La filière application (2026-10-22). Requise : un espace sans compte Meta Business n'a pas de numéro de Meta,
   * et une réponse qui l'ignorerait refuserait en silence « aucun numéro ».
   */
  application: Pick<EnvoiApplication, 'filiere' | 'envoyer'>;
  /**
   * 🔴 La porte « écrire en premier » de la filière application (`enfilerPremierMessage`, plan 2026-10-23). Requise :
   * hors des 24 heures, une réponse de machine y passe (limite du mois, espacement, consentement), et un câblage qui
   * l'oublierait ne doit pas compiler, sinon la réponse contournerait toutes ses gardes.
   */
  ecrirePremier(demande: DemandePremierMessage): Promise<ResultatPremier>;
}

/**
 * Le refus est typé : la route HTTP en fait un code de statut (404 / 422 / 400), l'outil MCP un message
 * lisible par un agent. Une chaîne unique obligerait l'un des deux à deviner.
 */
export type RefusReponse =
  | { motif: 'conversation_inconnue' }
  | { motif: 'fenetre_fermee' }
  | { motif: 'aucun_numero' }
  | { motif: 'contact_desabonne' }
  /** Filière application : le compte n'est pas relié (coupé, endormi), WhatsApp a refusé, ou le service ne répond pas. */
  | { motif: 'application_indisponible'; raison: RaisonClient }
  /** Filière application : seul le texte part (un média ou des boutons attendent un lot suivant). */
  | { motif: 'format_non_pris_en_charge' }
  /** Filière application, hors des 24 heures : la porte « écrire en premier » a refusé le message. */
  | { motif: 'premier_message'; refus: RefusPremier };

/**
 * `differe` : filière application, hors des 24 heures, le message est en file (la porte « écrire en premier ») ; il part
 * à `prevuLe` (ISO 8601), et il n'est encore ni envoyé, ni tracé, ni le fil pris.
 */
export type ResultatReponse =
  | { messageId: string; journal: EtatJournalSortant }
  | { differe: { id: string; prevuLe: string } }
  | { refus: RefusReponse };

/**
 * Ce qui part par la porte quand une réponse sort des 24 heures, sur la filière application. Absent : une réponse
 * (`reponse`), la fiche déjà consentante, et la clé de `cleDeReponse`. L'API publique passe le sien : son origine, le
 * consentement déclaré dans l'appel, et la clé de l'appel, la même qu'à une personne sans fil (`src/http/v1-messages.ts`).
 */
export interface HorsFenetre {
  origine: OriginePremier;
  consentement: DemandePremierMessage['consentement'];
  cle: string;
}

/** Une empreinte courte, assez pour distinguer deux textes d'une même minute, jamais le texte lui-même. */
export const empreinte = (texte: string): string => sha256Hex(texte).slice(0, 16);
/** La minute UTC d'un instant (`2026-10-24T13:05`) : la même demande rejouée dans la minute ne part qu'une fois. */
export const minuteUtc = (d: Date): string => d.toISOString().slice(0, 16);

/** La clé d'une réponse différée : la conversation, le texte, la minute. */
export const cleDeReponse = (conversationId: string, texte: string, maintenant: Date): string =>
  `reponse:${conversationId}:${empreinte(texte)}:${minuteUtc(maintenant)}`;

/**
 * Le numéro qu'on peut écrire en premier depuis un `wa_id` : les chiffres d'un numéro. Un identifiant masqué (`…@lid`)
 * n'en porte aucun, et la porte n'écrit qu'à un numéro : `null`.
 */
export const telephoneDuWaId = (waId: string): string | null => (/^[0-9]{8,15}$/.test(waId) ? waId : null);

/** Ce que rend la porte, dans la forme d'une réponse : en file, ou refusée. */
export function reponseDuPremier(r: ResultatPremier): ResultatReponse {
  return r.ok ? { differe: { id: r.id, prevuLe: r.prevuLe.toISOString() } } : { refus: { motif: 'premier_message', refus: r.refus } };
}

/**
 * `auteur` = l'humain qui écrit, ou `null` (agent tiers via MCP) : il finit dans `sender_user_id` et signe le
 * message dans l'inbox. `origine` est séparée et obligatoire : elle dit ce qui l'a écrit, et un agent tiers
 * qui ne signe personne n'est pas un scénario pour autant.
 */
export async function repondreDansLaFenetre(
  deps: DepsRepondre,
  tenantId: string,
  conversationId: string,
  texte: string,
  auteur: string | null,
  origine: OrigineMessage,
  /**
   * `texte` est ce qui part, traduit ou non : c'est ce que le client recevra, notre trace doit y correspondre.
   * `redactionOrigine` garde ce que l'opérateur avait écrit avant traduction ; `null` pour un envoi non traduit.
   */
  redactionOrigine: string | null = null,
  /** Filière application, hors des 24 heures : ce qui part par la porte. `null` : une réponse (voir `HorsFenetre`). */
  horsFenetre: HorsFenetre | null = null,
): Promise<ResultatReponse> {
  return repondreAvec(deps, tenantId, conversationId, {
    envoyer: (phoneNumberId, to) => deps.sendReply(tenantId, phoneNumberId, to, texte),
    texteApplication: texte,
    trace: texte,
    type: 'text',
  }, auteur, origine, redactionOrigine, horsFenetre);
}

/**
 * Un message au FORMAT DE META (lot 13, domaine 2) : texte, média par URL, lieu, réaction, interactif. Les MÊMES gardes
 * que le texte (`repondreAvec`) : un seul chemin, pour qu'une garde ajoutée demain vaille pour les deux.
 * `envoyerMessage` : l'envoi générique du client Meta (`MetaClient.sendMessage`), le contenu déjà validé.
 */
export async function repondreAvecUnMessage(
  deps: DepsRepondre,
  envoyerMessage: (tenantId: string, phoneNumberId: string, to: string, corps: Record<string, unknown>) => Promise<string>,
  tenantId: string,
  conversationId: string,
  message: { corps: Record<string, unknown>; trace: string; type: string },
  auteur: string | null,
  origine: OrigineMessage,
): Promise<ResultatReponse> {
  return repondreAvec(deps, tenantId, conversationId, {
    envoyer: (phoneNumberId, to) => envoyerMessage(tenantId, phoneNumberId, to, message.corps),
    trace: message.trace,
    type: message.type,
  }, auteur, origine, null, null);
}

/**
 * Les gardes d'une réponse dans la fenêtre de 24 h, puis l'envoi, la prise du fil et la trace dans l'Inbox. `envoi.trace`
 * est ce que l'Inbox affiche du message parti, `envoi.type` son type.
 */
async function repondreAvec(
  deps: DepsRepondre,
  tenantId: string,
  conversationId: string,
  /** `texteApplication` : ce qui part par la filière application ; absent, le message n'y part pas (format de Meta). */
  envoi: { envoyer(phoneNumberId: string, to: string): Promise<string>; texteApplication?: string; trace: string; type: string },
  auteur: string | null,
  origine: OrigineMessage,
  redactionOrigine: string | null,
  horsFenetre: HorsFenetre | null,
): Promise<ResultatReponse> {
  const ctx = await deps.inbox.getConversationContext(conversationId, tenantId);
  if (ctx === null) return { refus: { motif: 'conversation_inconnue' } };
  const application = (await deps.application.filiere(tenantId)) === 'application';
  if (application && envoi.texteApplication === undefined) return { refus: { motif: 'format_non_pris_en_charge' } };
  if (!application && !ctx.windowOpen) return { refus: { motif: 'fenetre_fermee' } };

  /**
   * 🔴 Une machine ne parle pas à quelqu'un qui a dit STOP, un opérateur si : sans cette exception, il ne
   * pourrait même plus accuser réception d'un opt-out. La règle vise tout ce qui n'est pas un humain, pas une
   * liste d'appelants, pour qu'une nouvelle machine ne passe pas à travers. La requête n'est payée que par
   * l'origine machine.
   */
  if (origine !== 'humain' && await deps.estDesabonne(tenantId, ctx.waId)) {
    return { refus: { motif: 'contact_desabonne' } };
  }

  /**
   * 🔴 HORS DES 24 HEURES, UNE MACHINE ÉCRIT EN PREMIER (conception 2026-10-23, § 5.1) : la même règle que l'API, la
   * fenêtre de 24 heures. Sans ce détour, un premier message Shopify créerait le fil, et tout ce qu'une machine enverrait
   * ensuite par une porte de réponse contournerait la limite du mois, l'espacement et le consentement. Dans les
   * 24 heures, rien ne change : la réponse part tout de suite, et rien n'est compté. Un opérateur répond toujours
   * directement, comme sur un fil qu'il tient. Le message en file ne prend pas le fil : le job le trace sans le prendre.
   */
  const texte = envoi.texteApplication;
  if (application && texte !== undefined && !ctx.windowOpen && origine !== 'humain') {
    const telephone = telephoneDuWaId(ctx.waId);
    if (telephone === null) return { refus: { motif: 'premier_message', refus: 'sans_telephone' } };
    const h: HorsFenetre = horsFenetre
      ?? { origine: 'reponse', consentement: { mode: 'exige_opt_in' }, cle: cleDeReponse(conversationId, texte, new Date()) };
    // Décision de Julien (2026-10-24) : un contact qui nous a écrit a donné son accord pour qu'on lui réponde, même plus
    // tard. Sans accord déclaré, la réponse différée part donc à qui a écrit ; seul un STOP l'arrête (la porte le relit).
    const consentement: DemandePremierMessage['consentement'] =
      h.consentement.mode === 'exige_opt_in' && ctx.lastInboundAt !== null ? { mode: 'conversation' } : h.consentement;
    return reponseDuPremier(await deps.ecrirePremier({
      tenantId, cle: h.cle, telephone, texte, origine: h.origine, reference: null, consentement,
    }));
  }

  let messageId: string;
  if (application) {
    const r = await deps.application.envoyer(tenantId, ctx.waId, envoi.texteApplication!);
    if (!r.ok) return { refus: { motif: 'application_indisponible', raison: r.raison } };
    messageId = r.messageId;
  } else {
    const phoneNumberId = await deps.repo.getTenantPhoneNumberId(tenantId);
    if (!phoneNumberId) return { refus: { motif: 'aucun_numero' } };
    messageId = await envoi.envoyer(phoneNumberId, ctx.waId);
  }
  // Le fil est pris : le scénario cesse d'avancer tout seul sur ce contact et MBA cesse de répondre, quel que
  // soit le tiers qui écrit. Ce que ça n'arrête pas : une campagne (déclenchée par un opérateur) et un clic sur un
  // bouton de chaîne (geste explicite de l'abonné), dont le type de lancement reprend le fil
  // (`POLITIQUE_DE_LANCEMENT`, `src/workflow/lancements.ts`). Une automation ordinaire par mot-clé reste arrêtée.
  // Sauf la réponse de l'application à un fil qu'elle tient (mode « mon application répond ») : prendre le fil
  // l'écarterait de la conversation, et le message suivant du client irait à « À traiter » au lieu de lui revenir.
  const laisserALApplication = origine === 'api' && await deps.filTenuParLApplication(tenantId, ctx.waId).catch(() => false);
  if (!laisserALApplication) await deps.takeControl(tenantId, ctx.waId, auteurDeLEnvoi(origine, auteur)).catch(() => {});
  const journal = await journaliserEnvoiAccepte(tenantId, conversationId, messageId, () =>
    deps.inbox.recordOutbound(conversationId, envoi.trace, messageId, origine, envoi.type, null, null, auteur, 'whatsapp', redactionOrigine));
  return { messageId, journal };
}
