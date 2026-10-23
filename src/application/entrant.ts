import { z } from 'zod';
import { processInbound, type DepsEntrants, type InboundMessage, type InboxStore } from '../webhooks/inbound';
import { processRemiseMbaEntrant, type RemiseMbaEntrantDeps } from '../webhooks/remise-mba-entrant';
import { processWorkflowAdvance, type WorkflowAdvanceDeps } from '../webhooks/workflow-advance';
import { auteurDeLEnvoi, type AuteurDuChangement } from '../inbox/evenements';
import type { OrigineMessage } from '../inbox/origine';
import { TYPES_MESSAGE, estIndividuel, idDuMessage } from './message';
import type { JobEntrant } from './sessions';
import type { Filiere } from './comptes';

/**
 * RECEVOIR, FILIÈRE APPLICATION (plan 2026-10-22, tâche 4) : le job de la file `application-entrant`, traité par le
 * worker comme le canal RCS (`src/rcs/message-entrant.ts`), sur l'ingestion commune. `processInbound` fait la fiche,
 * le STOP, l'écriture et le détenteur ; l'avance fait suivre un parcours en attente, celui de l'agent IA en pleine
 * conversation ; la remise commune décide si l'agent IA répond, avec ses gardes.
 *
 * Ce qui n'existe pas sur l'application n'est pas appelé : publicités, Flows, déclencheurs d'automations et jetons de
 * test, agent de Meta. `handleWebhookJob` reste intact.
 */

const lu = z.object({
  tenantId: z.string().uuid(),
  compteId: z.string().uuid(),
  message: z.object({
    id: z.string().min(1).max(200),
    jid: z.string().min(3).max(200),
    deMoi: z.boolean(),
    nom: z.string().nullable(),
    horodatage: z.string(),
    type: z.enum(TYPES_MESSAGE),
    texte: z.string().nullable(),
    numero: z.string().regex(/^[0-9]{8,15}$/).nullable(),
  }),
});

/** Le job tel que la file le rend, ou `null` s'il est mal formé (jamais deviné). */
export function lireJobEntrant(data: unknown): JobEntrant | null {
  const r = lu.safeParse(data);
  return r.success ? r.data : null;
}

/**
 * Le message de l'application en message entrant, comme ceux de Meta. `waId` : les chiffres du numéro quand WhatsApp
 * les donne, sinon l'identifiant masqué (`…@lid`), que `classifyWaId` range en identifiant opaque. Un média entre comme
 * un message de son type, sans téléchargement. `null` pour un groupe ou un statut.
 */
export function versInboundMessage(job: JobEntrant): InboundMessage | null {
  const m = job.message;
  if (!estIndividuel(m.jid)) return null;
  const envoyeLe = new Date(m.horodatage);
  return {
    phoneNumberId: '',
    waId: m.numero ?? m.jid,
    messageId: idDuMessage(job.compteId, m.id),
    type: m.type,
    body: m.texte ?? `[${m.type}]`,
    buttonPayload: null,
    // Le nom joint à un message tapé sur le téléphone est celui du compte, pas du contact.
    profileName: m.deMoi ? null : m.nom?.slice(0, 120) ?? null,
    field: 'messages',
    ...(envoyeLe.getTime() > 0 ? { envoyeLe } : {}),
  };
}

export interface DepsEntrantApplication {
  /** Ce message est-il déjà enregistré dans l'espace ? Un message redonné ne refait rien. */
  dejaRecu(tenantId: string, messageId: string): Promise<boolean>;
  inbox: InboxStore & {
    recordOutboundByWaId(tenantId: string, waId: string, msg: { body: string; messageId: string | null; type?: string; origine: OrigineMessage }): Promise<void>;
  };
  /** Les dépendances de l'ingestion commune : le STOP et le détenteur y sont requis. */
  entrants: DepsEntrants;
  remise: RemiseMbaEntrantDeps;
  /**
   * L'avance du parcours en attente de ce contact, la même que la réception de Meta. 🔴 Un agent IA qui converse EST un
   * parcours en attente : sans elle, il ne répondait qu'au premier message (essai réel du 2026-10-22).
   */
  avance: WorkflowAdvanceDeps;
  /**
   * La filière de l'espace (`filiereDe`). 🔴 Un espace qui a relié l'API de Meta ignore ce que la session de
   * l'application reçoit encore : sinon l'avance ferait progresser des parcours de l'API sur une réponse arrivée par
   * l'autre numéro, et leurs blocs partiraient par Meta (relecture du 2026-10-22).
   */
  filiere(tenantId: string): Promise<Filiere | null>;
  /** La prise de main humaine, comme une réponse de l'Inbox (`ControleDuFil.prisEnEcrivant`). */
  priseDeMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<void>;
}

/**
 * Un message reçu : enregistré par l'ingestion commune, donné au parcours qui l'attend (l'agent IA en pleine
 * conversation), sinon remis (l'agent IA répond si personne ne suit). Un message
 * tapé sur le téléphone du compte : une réponse humaine, qui prend le fil, et l'agent se retire selon les réglages de
 * retour. Un message déjà enregistré (Baileys le redonne, ou le job est rejoué) ne refait rien : l'enregistrement est
 * la dernière étape qui puisse lever, la remise ne l'est jamais.
 */
export async function traiterEntrantApplication(job: JobEntrant, deps: DepsEntrantApplication): Promise<void> {
  const m = versInboundMessage(job);
  if (!m) return;
  if ((await deps.filiere(job.tenantId)) === 'api') {
    // eslint-disable-next-line no-console
    console.warn(`application-entrant : l'espace ${job.tenantId} est sur l'API de Meta, message ${m.messageId} du compte ${job.compteId} ignoré`);
    return;
  }
  if (await deps.dejaRecu(job.tenantId, m.messageId)) return;
  if (job.message.deMoi) {
    await deps.inbox.recordOutboundByWaId(job.tenantId, m.waId, { body: m.body ?? `[${m.type}]`, messageId: m.messageId, type: m.type, origine: 'humain' });
    await deps.priseDeMain(job.tenantId, m.waId, auteurDeLEnvoi('humain', null));
    return;
  }
  const entrants = [{ message: m, tenantId: job.tenantId }];
  const rouvertes = await processInbound(entrants, deps.inbox, deps.entrants);
  // L'avance avant la remise, comme la réception de Meta (`src/webhooks/handler.ts`) : un message qu'un parcours a reçu
  // est à lui, la remise ne le confie pas une seconde fois à l'agent.
  const parParcours = await processWorkflowAdvance(entrants, deps.avance);
  await processRemiseMbaEntrant(entrants, deps.remise, parParcours, rouvertes);
}
