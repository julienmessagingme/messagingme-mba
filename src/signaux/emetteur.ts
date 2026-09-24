import type { AccuseDuStatut, SignalAccuse } from '../webhooks/delivery';
import type { InboundMessage, SignalReponse } from '../webhooks/inbound';
import {
  SIGNAUX_PAR_JOB, idSignal, schemaSignal, type CanalSignal, type JobSignaux, type NomEvenement, type Signal,
} from './types';

/**
 * L'ÉMETTEUR DE SIGNAUX (spec 2026-09-24, § 8) : le SEUL point par lequel un chemin du produit dit « il s'est
 * passé quelque chose sur cette fiche ».
 *
 * 🔴 IL NE LÈVE JAMAIS, et ses points d'appel sont des chemins CHAUDS : l'accusé de chaque message, chaque
 * message entrant, la redirection d'un lien suivi. Une panne de la remontée ne doit ni retarder ni faire
 * rejouer aucun d'eux.
 *
 * 🔴 IL NE CONNAÎT AUCUN OUTIL. Il reçoit une liste de DESTINATIONS (une par adaptateur : sa file, et les
 * espaces qui l'ont branché) ; brancher un second outil ajoute une destination, rien d'autre.
 *
 * ⚠️ LA LISTE DES ESPACES ACTIFS SE LIT À TRAVERS UN CACHE COURT (`DUREE_CACHE_ESPACES_ACTIFS_MS`), par
 * process. Conséquence assumée : un outil branché depuis l'écran reçoit les signaux émis par le WORKER jusqu'à
 * une minute plus tard (l'API, elle, invalide son cache à l'enregistrement).
 */
export const DUREE_CACHE_ESPACES_ACTIFS_MS = 60_000;

/**
 * 🔴 LA PRIORITÉ D'UN SIGNAL DANS LA FILE (pg-boss prend `priority desc`, puis par date de création).
 *
 * Les ACCUSÉS restent à 0 : une campagne en produit des milliers d'un coup, et la file d'un espace les traite un
 * par un. Tout ce qui répond à un GESTE du contact (réponse, clic, désabonnement) ou le résume (analyse) passe
 * en 1, donc devant cet arriéré : c'est ce qui permet à la documentation de promettre ces signaux dans la minute.
 */
export const PRIORITE_SIGNAL: Readonly<Record<NomEvenement, number>> = {
  em_message_delivered: 0,
  em_message_read: 0,
  em_message_failed: 0,
  em_replied: 1,
  em_link_clicked: 1,
  em_opted_out: 1,
  em_conversation_analyzed: 1,
};

/**
 * Les types de message WhatsApp qui sont une RÉPONSE du contact : ce qu'il a composé ou tapé. Une réaction (un
 * emoji posé sur un message), un type non pris en charge par Meta (`unsupported`), un message système ou un type
 * inconnu n'en sont pas : les compter ferait mentir `em_replied` et `em_last_reply_at`. Liste POSITIVE, donc un
 * type que Meta ajouterait demain ne devient pas une réponse sans qu'on l'ait décidé.
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
  enfiler(file: string, job: JobSignaux, opts: { groupId: string; priority: number }): Promise<void>;
  log?(message: string): void;
}

export interface Emetteur {
  emettreSignal(tenantId: string, signal: Signal): Promise<void>;
  /** Plusieurs signaux d'un même espace (un désabonnement de masse) : rangés par priorité, en jobs bornés. */
  emettreSignaux(tenantId: string, signaux: readonly Signal[]): Promise<void>;
  /** Un espace au moins a-t-il branché un outil ? Permet à un accusé de ne rien lire quand la réponse est non. */
  quelquUnEcoute(): Promise<boolean>;
}

const texteErreur = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function creerEmetteur(deps: DepsEmetteur): Emetteur {
  const emettreSignaux = async (tenantId: string, signaux: readonly Signal[]): Promise<void> => {
    if (signaux.length === 0) return;
    for (const d of deps.destinations) {
      try {
        if (!(await d.espacesActifs()).has(tenantId)) continue;
        // Validé AVANT d'entrer dans la file, signal par signal : le lecteur relit le job avec le même schéma, et
        // un job qu'il refuse irait jusqu'à la DLQ après cinq essais, en emportant les signaux valides avec lui.
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
            await deps.enfiler(d.file, { tenantId, signaux: liste.slice(i, i + SIGNAUX_PAR_JOB) }, { groupId: tenantId, priority });
          }
        }
      } catch (err) {
        deps.log?.(`signaux: ${signaux.length} signal(aux) non enfile(s) vers ${d.file} pour ${tenantId}: ${texteErreur(err)}`);
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
          deps.log?.(`signaux: espaces actifs illisibles pour ${d.file}: ${texteErreur(err)}`);
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
 * Le libellé du bouton tapé, ou `null`. JAMAIS un texte saisi : une réponse de FORMULAIRE porte son JSON dans
 * `buttonPayload`, et ce JSON est ce que la personne a écrit.
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

/** Un clic ATTRIBUÉ (l'adresse portait le jeton du contact). Un clic anonyme ne fait pas de signal : sans fiche, pas de profil. */
export function signalDuClic(contactId: string, code: string): Signal {
  return { nom: 'em_link_clicked', id: idSignal('em_link_clicked'), le: maintenant(), contactId, lien: code };
}

export function signalDesabonnement(waId: string, canal: CanalSignal): Signal {
  return { nom: 'em_opted_out', id: idSignal('em_opted_out'), le: maintenant(), waId, canal };
}

/** La conversation analysée : une RÉFÉRENCE. L'analyse se relit au moment de pousser, jamais dans la file. */
export function signalAnalyse(conversationId: string): Signal {
  return { nom: 'em_conversation_analyzed', id: idSignal('em_conversation_analyzed'), le: maintenant(), conversationId };
}

/**
 * Les deux puits que le webhook Meta reçoit (`src/webhooks/delivery.ts`, `src/webhooks/inbound.ts`).
 *
 * 🔴 L'ORDRE DE `accuse` EST LA GARANTIE DE COÛT : un statut `sent` (le plus fréquent) s'arrête avant toute
 * lecture, et tant qu'aucun espace n'a branché d'outil, le numéro n'est même pas résolu.
 *
 * ⚠️ `reponse` GARDE LE `standby`, délibérément. Un message extrait par `processInbound` en `standby` est un
 * message du CONTACT pendant que l'agent de Meta tient le fil (payload réel, essais du 2026-09-16) ; l'écho de
 * ce que l'agent a dit vit sous `message_echoes`, que `extractInbound` ne lit pas. L'avance de scénario et les
 * automations le refusent parce que RÉPONDRE reprendrait le fil à l'agent ; un signal n'envoie rien au contact.
 * Le filtrer perdrait chaque réponse faite à une campagne qui confie ses réponses à l'agent de Meta.
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
 * 🔴 POSÉE SUR LE DÉPÔT, COMME L'ANNONCE : elle couvre par CONSTRUCTION toutes les méthodes capables d'écrire
 * `opted_out` (mot-clé entrant, fiche, action en masse, consentement de l'API), au lieu d'être recopiée sur
 * chaque appelant. Le STOP RCS n'y passe pas (il écrit `rcs_optout_at` ailleurs) : il émet lui-même.
 *
 * ⚠️ `finally` : une annonce en panne n'empêche pas le signal, et son erreur remonte au dépôt, qui la journalise.
 *
 * ⚠️ `'whatsapp'` dit ici QUEL CONSENTEMENT le dépôt a retiré (`opt_in_status`), pas le canal sur lequel la
 * personne a parlé : celui-là se déduit de la source au moment de pousser (`completerSignal`).
 *
 * 🔴 UNE SEULE ÉMISSION pour toute la liste : une action en masse de milliers de fiches s'enfile en quelques
 * jobs (`SIGNAUX_PAR_JOB`), dans la requête HTTP de l'opérateur, et non en un enfilement par fiche.
 */
export function annoncerAussiAuxSignaux(
  annonce: (tenantId: string, waIds: string[]) => Promise<void>,
  emetteur: Emetteur,
): (tenantId: string, waIds: string[]) => Promise<void> {
  return async (tenantId, waIds) => {
    try {
      await annonce(tenantId, waIds);
    } finally {
      await emetteur.emettreSignaux(tenantId, waIds.map((waId) => signalDesabonnement(waId, 'whatsapp')));
    }
  };
}
