/**
 * Extraction des messages entrants d'un payload webhook Meta (réponses client, taps de boutons). On lit
 * `value.metadata.phone_number_id` (pour mapper au tenant) et chaque `value.messages[]`. `from` peut manquer
 * (BSUID) : repli sur `contacts[].wa_id`.
 */

import { FLOW_REF_KEY } from '../meta/flow-json';
import { estDemandeArret } from '../crm/consentement';
import { asArray, asRecord } from './json';
import { valeurEffective } from './change';
import { tenter } from '../lib/tenter';
import { messageDe } from '../lib/erreur';
import type { EntrantRattache } from './rattachement';

export interface InboundMessage {
  phoneNumberId: string;
  waId: string;
  messageId: string;
  type: string;
  body: string | null;
  buttonPayload: string | null;
  profileName: string | null;
  /**
   * `field` du change source : `'messages'` pour un vrai entrant, `'standby'` quand une autre app (le Meta
   * Business Agent) tient le fil. L'avance de scénario et les automations ignorent un standby, pour ne pas
   * reprendre implicitement le fil ; l'Inbox enregistre tout (grâce à `valeurEffective`, tenu par un test sur un
   * payload réel). `null` si le champ est absent.
   */
  field: string | null;
  /** Publicité Click-to-WhatsApp à l'origine du message. Absent sur un message ordinaire. */
  referral?: InboundReferral;
  /**
   * De quoi retrouver le fichier d'un message média. 🔴 Meta ne transmet pas le fichier, seulement un identifiant
   * pour aller chercher une URL : ne pas le capter ici, c'est perdre le média pour toujours. Il ne vit que sept
   * jours chez Meta (`DUREE_MEDIA_RECU_JOURS`, `src/inbox/media-entrant.ts`). `mime` vient du même corps et est
   * exigé par la transcription ; `nom` est le nom de fichier d'un document, qui n'existe que dans ce corps.
   */
  media?: { id: string; mime: string | null; nom?: string | null };
  /**
   * Quand Meta dit que ce message a été envoyé (`messages[].timestamp`, en secondes). Sert à dater un `standby`
   * par rapport à une escalade : plus ancien, c'est un retardataire ; plus récent, l'agent de Meta tient à nouveau
   * le fil. Absent : on ne sait pas, et la garde reste stricte.
   */
  envoyeLe?: Date;
}

/**
 * La pub qui a amené ce contact (objet `referral` de Meta). Meta ne l'envoie que sur le premier message après le
 * clic : ne pas le capter ici, c'est le perdre. `ctwaClid` sert à renvoyer les conversions à Meta ; il arrive
 * parfois vide, et on le garde tel quel plutôt que d'en faire une condition.
 */
export interface InboundReferral {
  /** `source_id` : l'identifiant de la pub (ou du post), clé de routage. */
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

/** Complétion d'un WhatsApp Flow (nfm_reply parsé) : le discriminant `ref` identifie le flow (donc le tenant
 *  et le mapping), `values` porte les champs saisis. */
export interface FlowCompletion {
  phoneNumberId: string;
  waId: string;
  ref: string;
  values: Record<string, unknown>;
}

/**
 * Ce que `processInbound` écrit. Le numéro vers l'espace n'en fait pas partie : `handleWebhookJob` le lit une fois
 * par numéro (`NumeroVersEspace`, `./rattachement.ts`) et passe des messages déjà rattachés.
 */
export interface InboxStore {
  /** Upsert la conversation (par tenant+wa_id) et insère le message (idempotent par wamid). */
  recordInbound(tenantId: string, m: InboundMessage): Promise<void>;
}

/**
 * Corrige qui détient le fil d'après ce que Meta vient de dire (`ControleDuFil.entrantEnStandby`,
 * `src/inbox/fil.ts`). Le `field` de chaque message entrant est le signal de bascule le plus fréquent :
 * `messaging_handovers` n'arrive que si `handoff` est configuré chez Meta.
 */
export interface DetenteurDuFil {
  entrantEnStandby(tenantId: string, waId: string, envoyeLe?: Date): Promise<void>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Corps, payload de bouton et, pour un média, de quoi le retrouver, selon le type de message entrant. Le média
 * est rendu à part de `body`, qui garde la légende ou un libellé de type (lu par l'aperçu de l'Inbox,
 * l'historique de l'agent et l'analyse).
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
  // Médias : la légende si présente, sinon un libellé de type (aperçu non vide), plus l'identifiant du fichier
  // chez Meta, seul moyen d'aller le chercher ensuite.
  if (type === 'image' || type === 'video' || type === 'document' || type === 'audio' || type === 'sticker') {
    const m = asRecord(msg[type]);
    const id = str(m['id']);
    // `body` garde la légende ou le libellé de type, pour tous ses lecteurs ; le média voyage à côté.
    return {
      body: str(m['caption']) ?? `[${type}]`,
      buttonPayload: null,
      // Le nom de fichier n'existe que sur un document.
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
      // `valeurEffective`, jamais `asRecord` directement : en standby, les messages vivent un niveau plus bas.
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
        // `timestamp` est une chaîne de secondes chez Meta. Illisible ou absent : on n'invente pas de date.
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
 * Extrait les complétions de WhatsApp Flow (nfm_reply) d'un payload webhook. Parse `response_json` et isole le
 * discriminant `_ref` (FLOW_REF_KEY), retiré des `values` : sans lui, flow hors de notre générateur, ignoré. Ne
 * lève jamais (JSON illisible -> complétion ignorée) : donnée externe non fiable.
 */
export function extractFlowCompletions(payload: unknown): FlowCompletion[] {
  const out: FlowCompletion[] = [];
  for (const entryRaw of asArray(asRecord(payload)['entry'])) {
    for (const changeRaw of asArray(asRecord(entryRaw)['changes'])) {
      // `valeurEffective`, jamais `asRecord` directement : en standby, les messages vivent un niveau plus bas.
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

/** Auto-création d'une fiche contact depuis un message entrant (par numéro ou BSUID). Rend idéalement le résultat
 *  de l'upsert : `created` est le signal « 1er message d'un contact inconnu » du déclencheur `new_contact`.
 *  `void` reste accepté. */
export type InboundContactUpsert = (tenantId: string, m: InboundMessage) => Promise<void | 'created' | 'updated' | 'skipped'>;

/**
 * Enregistre le refus d'un contact qui a écrit STOP ; rend l'identifiant touché, `null` si aucune fiche. Requise
 * partout où l'on enregistre des entrants (`DepsEntrants.optOut`, `WebhookJobDeps`) : une dépendance de
 * consentement n'est jamais optionnelle.
 * `messageId`, le wamid du message STOP, est la clé naturelle du refus : il rend le signal `em_opted_out` stable
 * si Meta redélivre ou si le job est rejoué. Un câblage qui l'ignore compile quand même :
 * `tests/signaux-cablage.test.ts` lit le câblage du worker.
 */
export type InboundOptOut = (tenantId: string, waId: string, messageId: string) => Promise<string | null>;

export type InboundAssignation = (tenantId: string, waId: string) => Promise<unknown>;

/**
 * Remonte une réponse comme signal. Reçoit le message entier ; le puits n'en garde que ce que le dictionnaire
 * autorise : jamais le texte, seulement le bouton tapé.
 */
export type SignalReponse = (tenantId: string, m: InboundMessage) => Promise<void>;

/**
 * Les dépendances secondaires de `processInbound`, nommées plutôt qu'en queue de paramètres optionnels (un rang
 * inversé passerait le compilateur). Toutes optionnelles sauf l'opt-out et le détenteur ; `WebhookJobDeps` exige
 * aussi le puits des signaux avec `inbox`.
 */
export interface DepsEntrants {
  upsertContact?: InboundContactUpsert;
  /**
   * 🔴 L'écriture du STOP. Requise : optionnelle, un câblage qui l'oublierait compilerait, se déploierait et
   * laisserait `opted_in` un contact qui a répondu STOP. Les fixtures qui ne parlent pas de consentement disent leur
   * hypothèse avec `aucunStop` (`tests/consentement.ts`).
   */
  optOut: InboundOptOut;
  /**
   * Répartition d'une réponse de campagne. Absente : aucune affectation automatique, la conversation tombe dans
   * « À traiter ». Appelée après `recordInbound`, qui crée la conversation : avant, elle ne trouverait rien à
   * affecter sur la toute première réponse d'un contact.
   */
  assignation?: InboundAssignation;
  /** Les signaux, après `recordInbound` : on ne remonte pas un message non enregistré. */
  signalReponse?: SignalReponse;
  /**
   * La correction du détenteur d'après le `field` de l'entrant. Requise, comme l'opt-out : optionnelle, un câblage
   * qui l'oublierait compilerait et laisserait notre colonne croire qu'un opérateur tient un fil que l'agent de
   * Meta a repris. Les fixtures qui n'en parlent pas le disent avec `aucuneCorrectionDuDetenteur`
   * (`tests/webhook-fixtures.ts`).
   */
  detenteur: DetenteurDuFil;
}

/**
 * Enregistre chaque message entrant, déjà rattaché à son espace (numéro inconnu : ignoré). `upsertContact`, s'il
 * est fourni, crée ou rafraîchit la fiche avant `recordInbound` (pour lier la conversation au contact), isolé : son
 * échec ne casse pas l'enregistrement.
 *
 * 🔴 L'opt-out par mot-clé (STOP), messages texte seulement : le respect d'un refus ne peut pas dépendre de ce
 * que chaque client aura configuré. Deux points d'ordre :
 *  1. après l'upsert : `setOptInByWaId` n'écrit que sur une fiche existante, et un contact inconnu dont le
 *     premier message est STOP serait sinon créé `opted_in` juste après ;
 *  2. avant tout ce qui envoie : le handler appelle `processInbound` avant l'avance et les automations.
 * Un bouton porte son libellé dans `body` : « Stopper la simulation » ne doit désabonner personne.
 */
export async function processInbound(
  entrants: readonly EntrantRattache[],
  store: InboxStore,
  deps: DepsEntrants,
): Promise<void> {
  const { upsertContact, optOut, assignation, signalReponse, detenteur } = deps;
  for (const { message: m, tenantId } of entrants) {
    if (!tenantId) continue;
    if (upsertContact) {
      await tenter('processInbound: auto-création contact ignorée:', () => upsertContact(tenantId, m));
    }
    if (m.type === 'text' && estDemandeArret(m.body)) {
      try {
        const touche = await optOut(tenantId, m.waId, m.messageId);
        if (!touche) {
          // eslint-disable-next-line no-console
          console.error(`STOP WhatsApp reçu de ${m.waId} (${tenantId}) sans fiche contact : rien à désabonner`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('processInbound: opt-out ignoré:', messageDe(err));
      }
    }
    await store.recordInbound(tenantId, m);
    if (signalReponse) {
      await tenter('processInbound: signal de réponse ignoré:', () => signalReponse(tenantId, m));
    }
    /**
     * 🔴 Le détenteur se corrige AVANT l'affectation : on met notre colonne d'accord avec Meta, puis on agit. Dans
     * l'ordre inverse, une réponse de campagne « Inbox » arrivée en `standby` prenait le fil pour l'équipe (`take`
     * accepté, `app_human`), puis ce `standby` réécrivait `mba` : Meta nous donnait le fil, notre colonne le donnait
     * à l'agent, et la prise n'ayant lieu qu'à la première réponse, rien ne la refaisait ensuite.
     */
    await accorderLeDetenteur(detenteur, tenantId, m);
    /**
     * Isolée comme l'auto-création : l'enregistrement du message est le cœur du webhook, et un throw ferait rejouer
     * un job qui a déjà écrit le message.
     */
    if (assignation) {
      await tenter('processInbound: affectation de campagne ignorée:', () => assignation(tenantId, m.waId));
    }
  }
}

/**
 * Remet notre `control_owner` d'accord avec Meta, à partir du `field` du webhook. Un entrant `messages` ne dit
 * rien du détenteur (en déduire `app_workflow` sortait la conversation d'« À traiter »). Deux signaux restent :
 *  - un `standby` : l'agent de Meta tient le fil (il porte ses échos, et aussi les entrants du client quand
 *    l'agent tient le fil, que seul `src/webhooks/test-token.ts` traite) ;
 *  - un `messaging_handovers` / `control_passed` : il nous passe la main (`src/webhooks/handover.ts`).
 * Filet : le balayage de reprise (`src/inbox/control-sweep.ts`).
 * `standby` écrase un `app_human` (Meta a tranché), sauf après une escalade vers l'équipe, que seul un standby plus
 * récent qu'elle lève (`ControleDuFil.entrantEnStandby`). Best-effort : un échec ne fait pas échouer
 * l'enregistrement du message.
 */
async function accorderLeDetenteur(detenteur: DetenteurDuFil, tenantId: string, m: InboundMessage): Promise<void> {
  if (m.field !== 'standby') return;
  try {
    await detenteur.entrantEnStandby(tenantId, m.waId, m.envoyeLe);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('processInbound: détenteur du fil non corrigé:', messageDe(err));
  }
}

