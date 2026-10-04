import type { NiveauRisque, RaisonRisque } from '../engagement/risque';
import type { AccuseDuStatut, SignalAccuse } from '../webhooks/delivery';
import type { InboundMessage, SignalReponse } from '../webhooks/inbound';
import { texteDe } from '../lib/erreur';
import {
  SIGNAUX_PAR_JOB, idSignal, schemaSignal, type CanalSignal, type JobSignaux, type NomEvenement, type Signal,
} from './types';

/**
 * L'émetteur de signaux : le seul point par lequel un chemin du produit dit « il s'est passé quelque chose sur
 * cette fiche ».
 *
 * Il ne lève jamais : ses points d'appel sont des chemins chauds (accusé de chaque message, message entrant,
 * redirection d'un lien), qu'une panne de la remontée ne doit ni retarder ni faire rejouer.
 * Il ne connaît aucun outil : il reçoit une destination par adaptateur (sa file, et les espaces qui l'ont branché).
 * Les espaces actifs se lisent à travers un cache court par process : un outil branché reçoit les signaux émis par
 * le worker jusqu'à une minute plus tard (l'API, elle, invalide son cache à l'enregistrement).
 */
export const DUREE_CACHE_ESPACES_ACTIFS_MS = 60_000;

/**
 * La priorité d'un signal dans la file (pg-boss prend `priority desc`, puis la date de création).
 * Les accusés restent à 0 : une campagne en produit des milliers d'un coup. Ce qui répond à un geste du contact
 * (réponse, clic, désabonnement) ou le résume (analyse) passe en 1, devant cet arriéré : c'est ce qui permet de
 * promettre ces signaux dans la minute.
 */
export const PRIORITE_SIGNAL: Readonly<Record<NomEvenement, number>> = {
  em_message_delivered: 0,
  em_message_read: 0,
  em_message_failed: 0,
  em_replied: 1,
  em_link_clicked: 1,
  em_opted_out: 1,
  em_conversation_analyzed: 1,
  // Le balayage de nuit en émet autant qu'il y a de changements de niveau : un arriéré, comme les accusés.
  em_risk_changed: 0,
};

/**
 * Les types de message WhatsApp qui sont une réponse du contact. Une réaction, un type `unsupported`, un message
 * système ou un type inconnu n'en sont pas : les compter ferait mentir `em_replied` et `em_last_reply_at`. Liste
 * positive : un type que Meta ajouterait ne devient pas une réponse sans qu'on l'ait décidé.
 */
export const TYPES_DE_REPONSE: ReadonlySet<string> = new Set([
  'text', 'button', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'order',
]);

export interface DestinationSignaux {
  /** La file pg-boss de l'adaptateur, déclarée dans `BASE_QUEUES`. */
  file: string;
  /** Les espaces où l'adaptateur est actif, lus à travers un cache court : jamais une requête par signal. */
  espacesActifs(): Promise<ReadonlySet<string>>;
}

export interface DepsEmetteur {
  destinations: readonly DestinationSignaux[];
  queue: { enqueue(file: string, job: JobSignaux, opts: { groupId: string; priority: number }): Promise<unknown> };
  log?(message: string): void;
}

export interface Emetteur {
  emettreSignal(tenantId: string, signal: Signal): Promise<void>;
  /** Plusieurs signaux d'un même espace (un désabonnement de masse) : rangés par priorité, en jobs bornés. */
  emettreSignaux(tenantId: string, signaux: readonly Signal[]): Promise<void>;
  /** Un espace au moins a-t-il branché un outil ? Permet à un accusé de ne rien lire quand la réponse est non. */
  quelquUnEcoute(): Promise<boolean>;
}

export function creerEmetteur(deps: DepsEmetteur): Emetteur {
  const emettreSignaux = async (tenantId: string, signaux: readonly Signal[]): Promise<void> => {
    if (signaux.length === 0) return;
    for (const d of deps.destinations) {
      try {
        if (!(await d.espacesActifs()).has(tenantId)) continue;
        // Validé avant d'entrer dans la file, signal par signal : un job que le lecteur refuse irait jusqu'à la DLQ
        // en emportant les signaux valides avec lui.
        const parPriorite = new Map<number, Signal[]>();
        for (const s of signaux) {
          const valide = schemaSignal.safeParse(s);
          if (!valide.success) {
            deps.log?.(`signaux: ${s.nom} hors contrat pour ${tenantId}, non enfile (${valide.error.issues[0]?.message ?? 'forme'})`);
            continue;
          }
          const p = PRIORITE_SIGNAL[valide.data.nom];
          const liste = parPriorite.get(p) ?? [];
          liste.push(valide.data);
          parPriorite.set(p, liste);
        }
        for (const [priority, liste] of parPriorite) {
          for (let i = 0; i < liste.length; i += SIGNAUX_PAR_JOB) {
            await deps.queue.enqueue(d.file, { tenantId, signaux: liste.slice(i, i + SIGNAUX_PAR_JOB) }, { groupId: tenantId, priority });
          }
        }
      } catch (err) {
        deps.log?.(`signaux: ${signaux.length} signal(aux) non enfile(s) vers ${d.file} pour ${tenantId}: ${texteDe(err)}`);
      }
    }
  };
  return {
    emettreSignaux,
    emettreSignal: (tenantId, signal) => emettreSignaux(tenantId, [signal]),
    async quelquUnEcoute() {
      for (const d of deps.destinations) {
        try {
          if ((await d.espacesActifs()).size > 0) return true;
        } catch (err) {
          deps.log?.(`signaux: espaces actifs illisibles pour ${d.file}: ${texteDe(err)}`);
        }
      }
      return false;
    },
  };
}

const maintenant = (): string => new Date().toISOString();

/** Un accusé en signal. `sent` n'en est pas un (l'envoi est déjà su), et sans destinataire il n'y a pas de fiche. */
export function signalDeLAccuse(a: AccuseDuStatut, canal: CanalSignal): Signal | null {
  if (a.status === 'sent' || a.waId === null || a.waId.trim() === '') return null;
  const le = a.le ?? maintenant();
  if (a.status === 'failed') {
    return {
      nom: 'em_message_failed', id: idSignal('em_message_failed', a.messageId), le, waId: a.waId, canal,
      messageId: a.messageId, motif: a.motif === null ? null : a.motif.slice(0, 500), codeMeta: a.codeMeta,
    };
  }
  if (a.status === 'delivered') {
    return { nom: 'em_message_delivered', id: idSignal('em_message_delivered', a.messageId), le, waId: a.waId, canal, messageId: a.messageId };
  }
  return { nom: 'em_message_read', id: idSignal('em_message_read', a.messageId), le, waId: a.waId, canal, messageId: a.messageId };
}

/**
 * Le libellé du bouton tapé, ou `null`. Jamais un texte saisi : une réponse de formulaire porte dans
 * `buttonPayload` le JSON de ce que la personne a écrit.
 */
export function boutonTape(m: Pick<InboundMessage, 'type' | 'body' | 'buttonPayload'>): string | null {
  if (m.type === 'button') return m.body;
  if (m.type !== 'interactive' || m.buttonPayload === null) return null;
  if (m.buttonPayload.trimStart().startsWith('{') || m.body === '[formulaire]') return null;
  return m.body;
}

export function signalDeLaReponse(r: { messageId: string; waId: string; bouton: string | null; le?: string }, canal: CanalSignal): Signal {
  return {
    nom: 'em_replied', id: idSignal('em_replied', r.messageId), le: r.le ?? maintenant(), waId: r.waId, canal,
    bouton: r.bouton === null ? null : r.bouton.slice(0, 300),
  };
}

/** Un clic attribué (l'adresse portait le jeton du contact). Un clic anonyme ne fait pas de signal. */
export function signalDuClic(contactId: string, code: string): Signal {
  return { nom: 'em_link_clicked', id: idSignal('em_link_clicked'), le: maintenant(), contactId, lien: code };
}

/**
 * Un désabonnement.
 *
 * `messageDuStop`, l'identifiant du message qui a dit STOP, est la clé naturelle du refus : un STOP redélivré par
 * Meta ou un job rejoué rend le même `em_event_id`, et l'outil peut dédupliquer. Sans message connu (fiche, action
 * en masse, API, bloc de scénario), un aléa figé dans le job, donc stable pour un job rejoué.
 * Le doublon est borné ailleurs : un désabonnement n'est annoncé que si le statut change, sur tous les chemins
 * (`src/crm/transition-consentement.ts`). Un STOP reconnu seulement par une automation part donc sous un identifiant
 * aléatoire.
 */
export function signalDesabonnement(waId: string, canal: CanalSignal, messageDuStop?: string): Signal {
  return { nom: 'em_opted_out', id: idSignal('em_opted_out', messageDuStop), le: maintenant(), waId, canal };
}

/** La conversation analysée : une référence. L'analyse se relit au moment de pousser, jamais dans la file. */
export function signalAnalyse(conversationId: string): Signal {
  return { nom: 'em_conversation_analyzed', id: idSignal('em_conversation_analyzed'), le: maintenant(), conversationId };
}

/**
 * Un changement de niveau du risque de désengagement (balayage de nuit).
 * Le calcul voyage dans le job, contrairement à l'analyse : le relire au moment de pousser rendrait peut-être le
 * calcul d'une nuit suivante sous cet identifiant. La clé (fiche, instant du calcul) le rend stable et opaque.
 */
export function signalRisque(r: {
  contactId: string; ancien: NiveauRisque | null; nouveau: NiveauRisque; score: number | null; raisons: RaisonRisque[];
}, calculeLe: Date): Signal {
  const le = calculeLe.toISOString();
  return {
    nom: 'em_risk_changed', id: idSignal('em_risk_changed', `${r.contactId}:${le}`), le, contactId: r.contactId,
    niveau: r.nouveau, ancienNiveau: r.ancien, score: r.score, raisons: [...r.raisons],
  };
}

/**
 * Les deux puits que le webhook Meta reçoit (`src/webhooks/delivery.ts`, `src/webhooks/inbound.ts`).
 *
 * L'ordre de `accuse` est la garantie de coût : un statut `sent` (le plus fréquent) s'arrête avant toute lecture,
 * et tant qu'aucun espace n'a branché d'outil, le numéro n'est même pas résolu.
 * `reponse` garde le `standby` : c'est un message du contact pendant que l'agent de Meta tient le fil (son écho
 * vit sous `message_echoes`, non lu). Scénarios et automations le refusent parce que répondre reprendrait le fil ;
 * un signal n'envoie rien, et le filtrer perdrait les réponses aux campagnes confiées à l'agent de Meta.
 */
export function creerPuitsSignauxMeta(deps: {
  emetteur: Emetteur;
  tenantDuNumero(phoneNumberId: string): Promise<string | null>;
}): { accuse: SignalAccuse; reponse: SignalReponse } {
  return {
    async accuse(phoneNumberId, a) {
      const signal = signalDeLAccuse(a, 'whatsapp');
      if (signal === null) return;
      if (!(await deps.emetteur.quelquUnEcoute())) return;
      const tenantId = await deps.tenantDuNumero(phoneNumberId);
      if (tenantId !== null) await deps.emetteur.emettreSignal(tenantId, signal);
    },
    async reponse(tenantId, m) {
      if (!TYPES_DE_REPONSE.has(m.type)) return;
      await deps.emetteur.emettreSignal(tenantId, signalDeLaReponse({
        messageId: m.messageId,
        waId: m.waId,
        bouton: boutonTape(m),
        ...(m.envoyeLe ? { le: m.envoyeLe.toISOString() } : {}),
      }, 'whatsapp'));
    },
  };
}

/**
 * Compose l'annonce d'opt-out du dépôt des contacts avec les signaux.
 *
 * Posée sur le dépôt, comme l'annonce : elle couvre par construction toute méthode capable d'écrire `opted_out`,
 * au lieu d'être recopiée sur chaque appelant. Le STOP RCS n'y passe pas (`rcs_optout_at`) : il émet lui-même.
 * `finally` : une annonce en panne n'empêche pas le signal, et son erreur remonte au dépôt.
 * `'whatsapp'` dit quel consentement a été retiré, pas le canal où la personne a parlé (`completerSignal`).
 * Une seule émission pour toute la liste : une action en masse s'enfile en quelques jobs (`SIGNAUX_PAR_JOB`).
 * `messageDuStop` ne vaut que pour une personne : posé sur une liste, il donnerait le même `em_event_id` à des
 * fiches différentes, que l'outil fusionnerait.
 */
export function annoncerAussiAuxSignaux(
  annonce: (tenantId: string, waIds: string[]) => Promise<void>,
  emetteur: Emetteur,
): (tenantId: string, waIds: string[], messageDuStop?: string) => Promise<void> {
  return async (tenantId, waIds, messageDuStop) => {
    try {
      await annonce(tenantId, waIds);
    } finally {
      const cle = waIds.length === 1 ? messageDuStop : undefined;
      await emetteur.emettreSignaux(tenantId, waIds.map((waId) => signalDesabonnement(waId, 'whatsapp', cle)));
    }
  };
}
