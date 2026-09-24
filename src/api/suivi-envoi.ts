import type { EnvoiApiBrut } from '../campaign/store.pg';
import type { CampaignStatus } from '../campaign/types';
import { ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';

/**
 * LE CONTRAT DE `GET /v1/sends/{sendId}` (spec 2026-09-24, § 3).
 *
 * 🔴 UNE MISE EN FORME DÉDIÉE, ET PAS L'OBJET DE LA CONSOLE : un changement de la console ne change plus l'API.
 *
 * ⚠️ Pour un scénario ou un bloc, la ligne décrit le DÉPART du parcours, et `channel` (au rang 1) son canal d'ouverture ;
 * la suite du parcours se lit dans la console. L'ouverture est recalculée sur le graphe PUBLIÉ relu
 * maintenant (aucune colonne ne la fige) : un scénario republié entre-temps se lit tel qu'il est.
 *
 * ⚠️ LA LECTURE VOIT TOUTE CAMPAGNE DE L'ESPACE, console comprise. Une campagne RCS de la console porte
 * `template_name` à `''` : le CANAL est donc jugé AVANT le template, et un nom vide n'est jamais une cible.
 * Sa cible est `{ rcsMessage: null }` : la campagne garde le CONTENU du message (`campaigns.rcs_message`), pas
 * son nom dans la bibliothèque, et ce lot ne l'invente pas.
 *
 * ⚠️ `channel` EST CELUI DE CHAQUE DESTINATAIRE : au rang 1, le canal d'ouverture ; au-delà (chaîne de repli de
 * la console, 0134), le canal de l'étage où il est, e-mail compris.
 *
 * ⚠️ `recipients` rend 500 lignes au plus ; `recipientsTotal` dit combien la campagne en compte.
 */
export type CibleSuivi =
  | { template: { name: string; language: string } }
  | { scenario: string | null }
  | { node: string | null }
  | { rcsMessage: string | null };

export interface DestinataireSuivi {
  contactId: string;
  externalId: string | null;
  channel: 'whatsapp' | 'rcs' | 'email';
  status: string;
  messageId: string | null;
  delivery: string | null;
  error: { message: string; metaCode: number | null } | null;
  sentAt: string | null;
}

export interface SuiviEnvoiApi {
  sendId: string;
  status: CampaignStatus;
  target: CibleSuivi;
  opening: OuvertureApi | null;
  createdAt: string;
  counts: { pending: number; sending: number; sent: number; failed: number; skipped: number };
  /** Le nombre de destinataires ; `recipients` en rend 500 au plus. */
  recipientsTotal: number;
  recipients: DestinataireSuivi[];
}

/**
 * Préfixe de l'identifiant SYNTHÉTIQUE qu'une campagne de scénario écrit à la place d'un wamid
 * (`wf-<workflowId>`, `src/campaign/engine.ts`). Le rendre ferait chercher à l'intégrateur un message qui
 * n'existe pas chez Meta : il vaut null.
 */
const ID_SYNTHETIQUE = 'wf-';

/** Un nom de template ÉCRIT : null et `''` ne désignent aucun template. */
const nomDeTemplate = (b: EnvoiApiBrut): string | null =>
  (b.templateName !== null && b.templateName.trim() !== '' ? b.templateName : null);

function cibleDe(b: EnvoiApiBrut): CibleSuivi {
  // Le CANAL d'abord : une campagne RCS porte `template_name` à `''`, pas null.
  if (b.channel === 'rcs') return { rcsMessage: null };
  const nom = nomDeTemplate(b);
  if (nom !== null) return { template: { name: nom, language: b.templateLanguage ?? '' } };
  if (b.startNodeId !== null) {
    const noeud = b.graph?.nodes.find((n) => n.id === b.startNodeId);
    return { node: typeof noeud?.data.code === 'string' ? noeud.data.code : null };
  }
  return { scenario: b.workflowCode };
}

function ouvertureDe(b: EnvoiApiBrut): OuvertureApi | null {
  if (b.channel === 'rcs') return 'rcs';
  if (nomDeTemplate(b) !== null) return 'whatsapp_template';
  if (b.graph === null) return null;
  return ouvertureApi(b.graph, b.startNodeId ?? undefined).ouverture;
}

export function formaterSuiviEnvoi(b: EnvoiApiBrut): SuiviEnvoiApi {
  const opening = ouvertureDe(b);
  const channel: 'whatsapp' | 'rcs' = opening === 'rcs' ? 'rcs' : 'whatsapp';
  return {
    sendId: b.id,
    status: b.status,
    target: cibleDe(b),
    opening,
    createdAt: b.createdAt,
    counts: { ...b.counts },
    recipientsTotal: b.recipientsTotal,
    recipients: b.recipients.map((r) => {
      // « En échec » a deux définitions en base (`RECIPIENT_FAILED_SQL`) : le refus à l'envoi, et l'échec
      // de livraison signalé plus tard, où `status` reste `sent`. L'API dit `failed` dans les deux cas.
      const echec = r.status === 'failed' || r.deliveryStatus === 'failed';
      return {
        contactId: r.contactId,
        externalId: r.externalId,
        channel: r.rang > 1 && r.canalEtage !== null ? r.canalEtage : channel,
        status: echec ? 'failed' : r.status,
        messageId: r.messageId !== null && !r.messageId.startsWith(ID_SYNTHETIQUE) ? r.messageId : null,
        delivery: r.deliveryStatus,
        error: echec ? { message: r.error ?? r.deliveryError ?? 'échec d’envoi', metaCode: r.errorCode } : null,
        sentAt: r.sentAt,
      };
    }),
  };
}
