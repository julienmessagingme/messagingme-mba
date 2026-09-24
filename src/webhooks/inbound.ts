/**
 * Extraction des messages ENTRANTS d'un payload webhook Meta (réponses client, taps de
 * boutons quick-reply). On lit `value.metadata.phone_number_id` (pour mapper au tenant) et
 * chaque `value.messages[]`. BSUID-native : `from` peut manquer -> fallback `contacts[].wa_id`.
 */

import { FLOW_REF_KEY } from '../meta/flow-json';
import { estDemandeArret } from '../crm/consentement';
import type { ControlOwner } from '../inbox/store.pg';
import { asArray, asRecord } from './json';
import { valeurEffective } from './change';

export interface InboundMessage {
  phoneNumberId: string;
  waId: string;
  messageId: string;
  type: string;
  body: string | null;
  buttonPayload: string | null;
  profileName: string | null;
  /**
   * `field` du change webhook source : `'messages'` pour un vrai entrant, `'standby'` quand une autre app
   * tient le fil (le Meta Business Agent). Sert au consommateur d'AVANCE de scénario et aux déclencheurs
   * d'automation à IGNORER un standby : répondre reprendrait implicitement le fil au MBA.
   *
   * 🔴 CE COMMENTAIRE AFFIRMAIT « L'INBOX, ELLE, ENREGISTRE TOUT », ET C'ÉTAIT FAUX. L'extraction lisait
   * `value.messages` alors qu'un standby imbrique tout sous `value.standby` : l'Inbox n'a rien enregistré
   * pendant les deux jours où l'agent de Meta a répondu à notre place (2026-09-08 au 2026-09-10, zéro
   * entrant et zéro statut mesurés en base). C'est vrai depuis `valeurEffective` (`./change.ts`), et c'est
   * un test sur le payload réel qui le tient, plus une phrase. `null` si le champ est absent.
   */
  field: string | null;
  /** Publicité Click-to-WhatsApp à l'origine du message. Absent sur un message ordinaire. */
  referral?: InboundReferral;
  /**
   * De quoi RETROUVER le fichier d'un message média (2026-09-09).
   *
   * 🔴 Meta ne transmet PAS le fichier dans le webhook, seulement un identifiant avec lequel on va chercher
   * une URL de téléchargement. Ne pas le capter ICI, c'est perdre le média pour toujours : rien en aval ne
   * peut le rattraper. C'est exactement ce qui se passait avant cette ligne, où un vocal se réduisait au
   * libellé `[audio]`.
   *
   * ⚠️ ET CET IDENTIFIANT NE VIT QUE SEPT JOURS chez Meta, pas trente comme ce commentaire l'a affirmé
   * jusqu'au 2026-09-19 (mesuré ce jour-là : `DUREE_MEDIA_RECU_JOURS`, `src/inbox/media-entrant.ts`).
   *
   * `mime` vient du même corps et est EXIGÉ par l'API de transcription : le redemander plus tard ferait
   * dépendre une transcription d'un appel de plus qui peut échouer.
   *
   * `nom` : le nom de fichier d'un DOCUMENT tel que WhatsApp l'annonce (migration 0160). Il n'existe que dans
   * ce corps, comme l'identifiant : sans lui, un PDF reçu se télécharge sous un nom inventé.
   */
  media?: { id: string; mime: string | null; nom?: string | null };
  /**
   * QUAND Meta dit que ce message a été envoyé (`messages[].timestamp`, en secondes).
   *
   * 🔴 IL SERT À DATER UN `standby` PAR RAPPORT À UNE ESCALADE (revue finale du 2026-09-23) : un standby plus
   * ANCIEN que la passation est un retardataire traité en parallèle, un standby plus RÉCENT prouve que l'agent
   * de Meta tient le fil de nouveau. Sans lui, `saufEscalade` écartait tout standby pour toujours.
   * ⚠️ Absent = on ne sait pas, et la garde reste stricte : une donnée externe manquante ne doit pas ouvrir.
   */
  envoyeLe?: Date;
}

/**
 * La pub qui a amené ce contact (objet `referral` de Meta).
 *
 * 🔴 Meta ne l'envoie que sur le PREMIER message après le clic. Les suivants ne le portent plus : ne pas le
 * capter ici, c'est le perdre pour toujours.
 *
 * `ctwaClid` sert à renvoyer les conversions à Meta (attribution publicitaire). Il arrive parfois VIDE, vu
 * dans un corps réel : on le garde tel quel plutôt que d'en faire une condition.
 */
export interface InboundReferral {
  /** `source_id` : l'identifiant de la PUB (ou du post). C'est la clé de routage. */
  adId: string;
  /** `source_type` : 'ad' | 'post'. */
  sourceType: string | null;
  /** `headline` : le titre de la pub, lisible par un humain. */
  titre: string | null;
  /** `source_url` : le lien de la pub. */
  url: string | null;
  ctwaClid: string | null;
}

/** Referral d'un message, ou undefined. Sans `source_id` il n'y a rien à router : on ignore. */
function referralOf(msg: Record<string, unknown>): InboundReferral | undefined {
  const r = asRecord(msg['referral']);
  const adId = str(r['source_id']);
  if (!adId) return undefined;
  return {
    adId,
    sourceType: str(r['source_type']) ?? null,
    titre: str(r['headline']) ?? null,
    url: str(r['source_url']) ?? null,
    ctwaClid: str(r['ctwa_clid']) ?? null,
  };
}

/** Complétion d'un WhatsApp Flow (nfm_reply parsé) : le discriminant `ref` identifie le flow (donc le
 *  tenant + le mapping), `values` porte les champs saisis (clés = clés de champ du flow). */
export interface FlowCompletion {
  phoneNumberId: string;
  waId: string;
  ref: string;
  values: Record<string, unknown>;
}

export interface InboxStore {
  /** Tenant propriétaire du numéro (mappe le message entrant à un tenant). null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Upsert la conversation (par tenant+wa_id) et insère le message (idempotent par wamid). */
  recordInbound(tenantId: string, m: InboundMessage): Promise<void>;
  /**
   * Corrige QUI détient le fil, d'après ce que Meta vient de dire. OPTIONNEL (deps de test minimales).
   *
   * 🔴 C'EST LE SEUL SIGNAL DE BASCULE QU'ON REÇOIVE VRAIMENT. On comptait sur l'événement
   * `messaging_handovers` : **zéro occurrence** sur les 58 payloads réels du 2026-09-10. Notre
   * `control_owner` ne pouvait donc être corrigé que par nous-mêmes, et il dérivait en silence dès que Meta
   * changeait d'avis. Le `field` de CHAQUE message entrant, lui, le dit à chaque fois.
   */
  setControlOwner?(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    opts?: { only?: readonly ControlOwner[]; saufEscalade?: boolean; messageEnvoyeLe?: Date },
  ): Promise<boolean>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Corps, payload de bouton, et pour un MÉDIA de quoi le retrouver, selon le type de message entrant.
 *
 * ⚠️ Le média est rendu SÉPARÉMENT de `body`, jamais dedans : `body` est lu par l'aperçu de l'Inbox,
 * l'historique de l'agent et l'analyse, et il garde exactement ce qu'il portait avant (la légende, sinon un
 * libellé de type).
 */
function contentOf(msg: Record<string, unknown>): { body: string | null; buttonPayload: string | null; media?: { id: string; mime: string | null; nom?: string | null } } {
  const type = str(msg['type']) ?? '';
  if (type === 'text') return { body: str(asRecord(msg['text'])['body']), buttonPayload: null };
  if (type === 'button') {
    const btn = asRecord(msg['button']);
    return { body: str(btn['text']), buttonPayload: str(btn['payload']) };
  }
  if (type === 'interactive') {
    const it = asRecord(msg['interactive']);
    const br = asRecord(it['button_reply']);
    const lr = asRecord(it['list_reply']);
    const nfm = asRecord(it['nfm_reply']);
    if (br['id'] || br['title']) return { body: str(br['title']), buttonPayload: str(br['id']) };
    if (lr['id'] || lr['title']) return { body: str(lr['title']), buttonPayload: str(lr['id']) };
    // Fin de WhatsApp Flow (nfm_reply) : garder le libellé + la réponse structurée en payload.
    if (nfm['name'] || nfm['body'] || nfm['response_json']) {
      const rj = nfm['response_json'];
      return {
        body: str(nfm['body']) ?? str(nfm['name']) ?? '[formulaire]',
        buttonPayload: typeof rj === 'string' ? rj.slice(0, 2000) : str(nfm['name']),
      };
    }
    // Sous-type interactif inconnu : ne pas perdre le fait qu'il y a eu une interaction.
    return { body: '[interactif]', buttonPayload: null };
  }
  if (type === 'reaction') {
    const r = asRecord(msg['reaction']);
    return { body: str(r['emoji']), buttonPayload: str(r['message_id']) };
  }
  // Médias : garder la légende si présente, sinon un libellé de type (aperçu non vide), PLUS l'identifiant
  // du fichier chez Meta, qui est la seule chose permettant d'aller le chercher ensuite.
  if (type === 'image' || type === 'video' || type === 'document' || type === 'audio' || type === 'sticker') {
    const m = asRecord(msg[type]);
    const id = str(m['id']);
    // ⚠️ `body` NE CHANGE PAS : il garde la légende, sinon le libellé de type. Tout ce qui le lit aujourd'hui
    // (aperçu de l'Inbox, historique de l'agent, analyse) continue à l'identique. Le média voyage À CÔTÉ.
    return {
      body: str(m['caption']) ?? `[${type}]`,
      buttonPayload: null,
      // Le nom de fichier n'existe que sur un DOCUMENT : une photo ou un vocal n'en portent pas.
      ...(id ? { media: { id, mime: str(m['mime_type']), ...(type === 'document' ? { nom: str(m['filename']) } : {}) } } : {}),
    };
  }
  if (type === 'location') {
    const loc = asRecord(msg['location']);
    return { body: str(loc['name']) ?? str(loc['address']) ?? '[localisation]', buttonPayload: null };
  }
  return { body: null, buttonPayload: null };
}

export function extractInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      // 🔴 `valeurEffective`, JAMAIS `asRecord` directement : voir `./change.ts`. En standby, les messages
      // vivent un niveau plus bas, et les lire ici ne rendait simplement rien, sans erreur.
      const value = valeurEffective(asRecord(changeRaw)['value']);
      const phoneNumberId = str(asRecord(value['metadata'])['phone_number_id']);
      if (!phoneNumberId) continue;
      const contacts = asArray(value['contacts']).map(asRecord);
      const fallbackWaId = str(contacts[0]?.['wa_id']);
      const profileName = str(asRecord(contacts[0]?.['profile'])['name']);
      const field = str(asRecord(changeRaw)['field']) ?? null; // 'messages' | 'standby' | ... (null si absent)
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        const messageId = str(msg['id']);
        const waId = str(msg['from']) ?? fallbackWaId;
        if (!messageId || !waId) continue;
        const { body, buttonPayload, media } = contentOf(msg);
        // `timestamp` est une chaîne de SECONDES chez Meta. Illisible ou absent -> on n'invente pas de date.
        const secondes = Number(str(msg['timestamp']) ?? '');
        const envoyeLe = Number.isFinite(secondes) && secondes > 0 ? new Date(secondes * 1000) : undefined;
        out.push({
          phoneNumberId,
          waId,
          messageId,
          type: str(msg['type']) ?? 'unknown',
          body,
          buttonPayload,
          profileName,
          field,
          ...(referralOf(msg) ? { referral: referralOf(msg)! } : {}),
          ...(media ? { media } : {}),
          ...(envoyeLe ? { envoyeLe } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Extrait les complétions de WhatsApp Flow (nfm_reply) d'un payload webhook. Parse `response_json` et
 * isole le discriminant `_ref` (FLOW_REF_KEY) : sans lui on ne sait pas à quel flow/mapping rattacher les
 * valeurs -> on ignore (flow hors de notre générateur). Le `_ref` est retiré des `values`. Ne lève JAMAIS
 * (JSON illisible -> complétion ignorée) : c'est de la donnée externe non fiable.
 */
export function extractFlowCompletions(payload: unknown): FlowCompletion[] {
  const out: FlowCompletion[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      // 🔴 `valeurEffective`, JAMAIS `asRecord` directement : voir `./change.ts`. En standby, les messages
      // vivent un niveau plus bas, et les lire ici ne rendait simplement rien, sans erreur.
      const value = valeurEffective(asRecord(changeRaw)['value']);
      const phoneNumberId = str(asRecord(value['metadata'])['phone_number_id']);
      if (!phoneNumberId) continue;
      const contacts = asArray(value['contacts']).map(asRecord);
      const fallbackWaId = str(contacts[0]?.['wa_id']);
      for (const msgRaw of asArray(value['messages'])) {
        const msg = asRecord(msgRaw);
        if (str(msg['type']) !== 'interactive') continue;
        const rj = asRecord(asRecord(msg['interactive'])['nfm_reply'])['response_json'];
        if (typeof rj !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rj);
        } catch {
          continue;
        }
        const obj = asRecord(parsed);
        const ref = str(obj[FLOW_REF_KEY]);
        if (!ref) continue;
        const waId = str(msg['from']) ?? fallbackWaId;
        if (!waId) continue;
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) if (k !== FLOW_REF_KEY) values[k] = v;
        out.push({ phoneNumberId, waId, ref, values });
      }
    }
  }
  return out;
}

/** Auto-création d'une fiche contact depuis un message entrant (par numéro OU BSUID).
 *  Renvoie idéalement le résultat de l'upsert : `created` est LE signal « 1er message d'un contact inconnu »,
 *  consommé par le déclencheur d'automation `new_contact`. `void` reste accepté (câblages qui ne le disent pas). */
export type InboundContactUpsert = (tenantId: string, m: InboundMessage) => Promise<void | 'created' | 'updated' | 'skipped'>;

/** Enregistre le refus d'un contact qui a écrit STOP. Rend l'identifiant touché, `null` si aucune fiche. */
export type InboundOptOut = (tenantId: string, waId: string) => Promise<string | null>;

/**
 * Mappe chaque message entrant à son tenant et l'enregistre. Si `upsertContact` est fourni, crée/rafraîchit
 * la fiche contact AVANT `recordInbound` (pour que la conversation se lie au contact). L'auto-création est
 * ISOLÉE (best-effort) : un échec ne casse pas l'enregistrement inbox (cœur du webhook).
 *
 * 🔴 L'OPT-OUT PAR MOT-CLÉ, AJOUTÉ LE 2026-08-29, ET C'EST DE LA CONFORMITÉ. Le RCS désabonnait sur STOP
 * depuis toujours ; WhatsApp, le canal principal, ne le faisait PAS. Un contact qui répondait STOP restait
 * `opted_in` et recevait la campagne suivante. Il existait bien un contournement (câbler soi-même une
 * automation à mot-clé vers le bloc « Action »), mais le respect d'un refus ne peut pas dépendre de ce que
 * chaque client aura pensé à configurer.
 *
 * ⚠️ DEUX POINTS D'ORDRE, ET AUCUN N'EST ARBITRAIRE.
 *
 * 1. L'opt-out passe APRÈS l'upsert, alors que le RCS le fait en premier. `setOptInByWaId` est merge-only :
 *    elle n'écrit que sur une fiche EXISTANTE. Le faire avant laisserait donc sans effet le cas qui compte le
 *    plus, celui du contact inconnu dont le tout premier message est STOP : il serait créé juste après, et
 *    créé `opted_in`. L'intention du RCS (« que rien qui puisse échouer ne passe avant ») est préservée
 *    autrement : l'upsert est déjà isolé dans son propre `try`, donc son échec n'empêche pas la tentative.
 *
 * 2. Mais il passe AVANT tout ce qui envoie. Le handler appelle `processInbound` avant l'avance de scénario
 *    et avant les automations : le refus est donc enregistré avant qu'une seule réponse ne parte.
 *
 * ⚠️ SEULEMENT LES MESSAGES TEXTE, comme en RCS. Un bouton porte son libellé dans `body` : un bouton
 * « Stopper la simulation » désabonnerait quelqu'un qui voulait juste sortir d'un parcours.
 */
export type InboundAssignation = (tenantId: string, waId: string) => Promise<unknown>;

/**
 * Remonte une RÉPONSE comme signal (spec 2026-09-24, § 8). Reçoit le message ENTIER, et c'est au puits de n'en
 * garder que ce que le dictionnaire autorise : jamais le texte, seulement le bouton tapé.
 */
export type SignalReponse = (tenantId: string, m: InboundMessage) => Promise<void>;

/**
 * Les dépendances SECONDAIRES de `processInbound`, NOMMÉES (lot 6 de l'API publique, 2026-09-24).
 *
 * 🔴 UN OBJET, PLUS UNE QUEUE DE PARAMÈTRES OPTIONNELS. Le quatrième s'ajoutait au rang six, derrière trois
 * optionnels de types voisins : un rang inversé y passe le compilateur en silence. Même leçon que
 * `WebhookJobDeps` (`./handler.ts`) et `PuitsAccuses` (`./delivery.ts`, revue finale du 2026-09-23). Toutes
 * restent optionnelles ICI (les tests de réception s'en passent) ; c'est `WebhookJobDeps` qui exige le puits
 * des signaux avec `inbox`.
 */
export interface DepsEntrants {
  upsertContact?: InboundContactUpsert;
  optOut?: InboundOptOut;
  /**
   * RÉPARTITION D'UNE RÉPONSE DE CAMPAGNE (migration 0134). Absente -> aucune affectation automatique,
   * c'est-à-dire le comportement d'avant : la conversation tombe dans « À traiter ».
   *
   * 🔴 ELLE PASSE APRÈS `recordInbound`, ET C'EST OBLIGATOIRE : c'est cet appel-là qui CRÉE la
   * conversation (`upsertConversationByWaId`). L'affectation vise une ligne de `conversations` ; jouée
   * avant, elle ne trouverait rien à affecter sur la toute première réponse d'un contact, c'est-à-dire
   * précisément le cas qu'elle existe pour servir.
   */
  assignation?: InboundAssignation;
  /** Les signaux (spec 2026-09-24, § 8). APRÈS `recordInbound` : on ne remonte pas un message non enregistré. */
  signalReponse?: SignalReponse;
}

export async function processInbound(
  payload: unknown,
  store: InboxStore,
  deps: DepsEntrants = {},
): Promise<void> {
  const { upsertContact, optOut, assignation, signalReponse } = deps;
  for (const m of extractInbound(payload)) {
    const tenantId = await store.phoneNumberTenant(m.phoneNumberId);
    if (!tenantId) continue;
    if (upsertContact) {
      try {
        await upsertContact(tenantId, m);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: auto-création contact ignorée:', err instanceof Error ? err.message : err);
      }
    }
    if (optOut && m.type === 'text' && estDemandeArret(m.body)) {
      try {
        const touche = await optOut(tenantId, m.waId);
        if (!touche) {
          // eslint-disable-next-line no-console
          console.error(`STOP WhatsApp reçu de ${m.waId} (${tenantId}) sans fiche contact : rien à désabonner`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: opt-out ignoré:', err instanceof Error ? err.message : err);
      }
    }
    await store.recordInbound(tenantId, m);
    if (signalReponse) {
      try {
        await signalReponse(tenantId, m);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: signal de réponse ignoré:', err instanceof Error ? err.message : err);
      }
    }
    /**
     * ⚠️ ISOLÉE, comme l'auto-création de contact plus haut et pour la même raison : l'enregistrement du
     * message est le CŒUR du webhook, et une affectation ratée ne doit jamais le faire échouer. Un throw
     * ici ferait rejouer, puis passer en DLQ, un job qui a déjà écrit le message.
     */
    if (assignation) {
      try {
        await assignation(tenantId, m.waId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: affectation de campagne ignorée:', err instanceof Error ? err.message : err);
      }
    }
    await accorderLeDetenteur(store, tenantId, m);
  }
}

/**
 * Remet notre `control_owner` d'accord avec Meta, à partir du `field` du webhook.
 *
 * 🔴 CE COMMENTAIRE A AFFIRMÉ UNE SÉMANTIQUE FAUSSE PENDANT CINQ JOURS, ET LE CODE LA SUIVAIT. Il disait :
 * « `standby` veut dire « l'agent de Meta tient ce fil », `messages` veut dire « nous le tenons ». Ces deux
 * mots arrivent sur CHAQUE message entrant. » Mesuré sur 30 jours de webhooks RÉELS le 2026-09-15 :
 *
 *   - 126 messages ENTRANTS du client, **100 % en `messages`**, ZÉRO en `standby` ;
 *   - 23 payloads `standby`, **aucun ne porte d'expéditeur**, tous portent un `message` SORTANT.
 *
 * Autrement dit, SUR CES 30 JOURS-LÀ : `standby` ne portait que l'écho de ce que l'agent de Meta avait envoyé.
 *
 * 🔴 ET CETTE CONCLUSION ÉTAIT TROP LARGE, corrigée le 2026-09-16 par DEUX essais réels de Julien. Un entrant
 * de client arrive BEL ET BIEN en `standby` quand l'agent de Meta tient le fil : il a envoyé un jeton de test,
 * et le corps reçu en `standby` était SON texte, pas un écho. La mesure de 30 jours n'était pas fausse, elle
 * était incomplète : sur cette période, l'agent ne tenait presque jamais un fil dont le client repartait.
 * `src/webhooks/test-token.ts` traite donc désormais ce canal, et lui seul le fait.
 *
 * ⚠️ CE QUE ÇA NE CHANGE PAS : la branche `messages` reste supprimée, et l'avance de scénario comme les
 * automations continuent de refuser le `standby`. Un entrant ne dit toujours RIEN du détenteur ; ce qui a
 * changé, c'est qu'on sait maintenant qu'un entrant PEUT arriver par ce canal.
 *
 * 🔴 CE QUE LA BRANCHE `messages` FAISAIT DONC VRAIMENT : elle se déclenchait sur CHAQUE message du client et
 * écrasait l'état `mba`, c'est-à-dire l'inverse de ce qu'elle croyait faire. C'est elle qui rendait une
 * conversation invisible du dossier « À traiter » après un scénario (constaté par Julien le 2026-09-15) :
 * elle écrivait `app_workflow`, la seule valeur que ce dossier exclut, sur un fil qu'aucun scénario ne gérait.
 *
 * ⚠️ LA CORRECTION EST UNE SUPPRESSION. Un entrant ne dit RIEN du détenteur : on n'en déduit plus rien. Il
 * reste DEUX signaux, et ils sont tous les deux observés dans les vraies données :
 *   - un `standby` : l'agent de Meta vient de parler, donc il tient le fil ;
 *   - un `messaging_handovers` / `control_passed` : il nous passe la main (`src/webhooks/handover.ts`).
 * Le filet, si les deux manquent, est le balayage de reprise (`src/inbox/control-sweep.ts`).
 *
 * ⚠️ `standby` ÉCRASE un `app_human` : Meta a tranché, et un opérateur qui se croit maître du fil se ferait
 * doubler sans comprendre. SAUF une ESCALADE (0164, 2026-09-23) : une fois le fil passé à l'équipe par l'agent,
 * Meta nous envoie les messages sur `messages`, donc un `standby` traité après est un retardataire.
 *
 * BEST-EFFORT : un échec ici ne doit pas faire échouer l'enregistrement du message, qui est la donnée
 * métier. Il reste visible en console.
 */
async function accorderLeDetenteur(store: InboxStore, tenantId: string, m: InboundMessage): Promise<void> {
  if (!store.setControlOwner || m.field !== 'standby') return;
  try {
    // ⚠️ SAUF ESCALADE (0164), ET LA DATE DU MESSAGE TRANCHE (revue finale du 2026-09-23). Après une passation
    // à l'équipe, un standby ANTÉRIEUR à l'escalade est un retardataire traité en parallèle : il rendait la
    // conversation à l'agent sous le nez de l'équipe. Un standby POSTÉRIEUR, lui, prouve que Meta a redonné le
    // fil à l'agent, et l'écarter laisserait l'escalade durer pour toujours. Sans date, la garde reste stricte.
    await store.setControlOwner(tenantId, m.waId, 'mba', { saufEscalade: true, ...(m.envoyeLe ? { messageEnvoyeLe: m.envoyeLe } : {}) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('processInbound: détenteur du fil non corrigé:', err instanceof Error ? err.message : err);
  }
}

