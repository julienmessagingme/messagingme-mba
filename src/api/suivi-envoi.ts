import type { EnvoiApiBrut } from '../campaign/store.pg';
import type { CampaignStatus } from '../campaign/types';
import { ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';
import { nomDuMessageRcs } from './cible-rcs';

/**
 * Le contrat de `GET /v1/sends/{sendId}`, mis en forme à part de l'objet de la console : un changement de la
 * console ne change pas l'API.
 *
 * Pour un scénario ou un bloc, la ligne décrit le départ du parcours ; l'ouverture est recalculée sur le
 * graphe publié relu maintenant. La lecture voit toute campagne de l'espace, console comprise : une campagne
 * RCS porte `template_name` à `''`, donc le canal est jugé avant le template ; sa cible est
 * `{ rcsMessage: <nom> }` pour un envoi de l'API, `{ rcsMessage: null }` pour une campagne de la console, qui
 * ne garde que le contenu. `channel` est celui de chaque destinataire (au-delà du rang 1, le canal de son
 * étage, e-mail compris).
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
 * Préfixe de l'identifiant synthétique qu'une campagne de scénario écrit à la place d'un wamid
 * (`wf-<workflowId>`) : le rendre ferait chercher un message qui n'existe pas chez Meta, il vaut null.
 */
const ID_SYNTHETIQUE = 'wf-';

/** Un nom de template écrit : null et `''` ne désignent aucun template. */
const nomDeTemplate = (b: EnvoiApiBrut): string | null =>
  (b.templateName !== null && b.templateName.trim() !== '' ? b.templateName : null);

function cibleDe(b: EnvoiApiBrut): CibleSuivi {
  // Le canal d'abord : une campagne RCS porte `template_name` à `''`, pas null. Un envoi RCS de l'API nomme son
  // message ; une campagne RCS de la console reste à `null`.
  if (b.channel === 'rcs') return { rcsMessage: nomDuMessageRcs(b.name) };
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
