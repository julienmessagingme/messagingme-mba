import { MetaApiError } from '../meta/errors';
import type { MetaErrorBody } from '../meta/errors';
import type { FetchLike } from '../meta/templates';
import type { EvenementAgent } from './evenement';

/**
 * Client de la surface Meta Business Agent (`agent_config/*`) : la base de connaissance et les réglages de
 * l'agent, pilotés par numéro.
 * MBA ne vit pas sur `graph.facebook.com` (« Unknown path components », code 2500) mais sur `api.facebook.com`,
 * sans version dans le chemin : la version passe par l'en-tête `X-API-Version`, toujours envoyé.
 * Erreurs : `{title, detail, status}` ici, `{error:{message,code}}` sur le reste de Graph ; les deux sont
 * normalisées, sinon un message utile serait perdu au profit d'un « erreur inconnue ».
 */
const BASE = 'https://api.facebook.com';
/** Version de toute la surface `agent_config/*` et compagnie. */
const VERSION_AGENT_CONFIG = '2.0.0';
/**
 * `thread_control` est le seul endpoint MBA versionné en 1.0.0 : `2.0.0` y est hors énumération, d'où une
 * version par appel plutôt qu'une propriété du client.
 */
const VERSION_THREAD_CONTROL = '1.0.0';

/** Informations générales sur l'entreprise. Ressource singleton : le PUT est un remplacement complet. */
export interface BusinessInfo {
  payment_method?: string;
  return_policy?: string;
  purchase_info?: string;
  delivery_and_shipping?: string;
  business_description?: string;
  contact_info?: { email?: string; hours_of_operation?: string; address?: string } | null;
}

/** Une question/réponse. `id` absent à la création. */
export interface Faq {
  id?: string;
  question: string;
  answer: string;
  metadata?: Record<string, string>;
}

/**
 * Une « skill » : des instructions en langage naturel, pas une fonction appelable (le tool calling, ce sont
 * les connecteurs). `description` dit à l'agent quand l'appliquer, `skill` quoi faire.
 */
export interface Skill {
  id?: string;
  /** Minuscules, chiffres et tirets, sans tiret au début ni à la fin. 64 caractères max. */
  title: string;
  /** Le déclencheur : « Apply when the customer asks about returns ». 1024 caractères max. */
  description: string;
  /** Le corps d'instructions. 20 000 caractères max. */
  skill: string;
  /**
   * `active`, `pending_review` ou `blocked`, tel que Meta le rend : Meta relit les compétences avant de les
   * activer, et une compétence en relecture n'agit pas encore. Optionnel : Meta le rend, nous ne l'écrivons
   * jamais.
   */
  status?: string;
}

/** Un site web crawlé par Meta pour alimenter la connaissance. */
export interface Website {
  id?: string;
  url: string;
  crawl_status?: string;
  pages_crawled?: number;
  last_crawled_at?: string;
}

/** Un fichier de connaissance (PDF, doc, image). Le contenu ne se relit pas, seulement les métadonnées. */
export interface KnowledgeFile {
  id: string;
  file_name?: string;
  status?: string;
  created_at?: string;
}

/** Réglages de l'agent. Voir la mise en garde sur le remplacement complet dans `putSettings`. */
export interface AgentSettings {
  agent_id?: string;
  channel?: string;
  rollout?: { enabled?: boolean };
  ai_audience?: 'EVERYONE' | 'ALLOWLISTED_ONLY';
  followup?: { enabled?: boolean; followup_interval_in_seconds?: number };
  never_say_phrases?: string[];
  /**
   * Passage de main de l'agent vers un humain ; Meta ne le renvoie pas tant qu'il n'est pas configuré. `enabled`
   * n'active pas le transfert (l'agent décide seul, `handoff_reason: customer_request`) : il dit s'il lâche le
   * fil après l'avoir annoncé. À `false`, le client lit « un conseiller arrive » et personne n'est prévenu : ne le
   * mettre à `false` qu'avec un `message` qui ne promet personne.
   */
  handoff?: {
    enabled?: boolean;
    /** Le texte lu par le client au moment du transfert. N'a d'effet qu'avec `message_selection: 'CUSTOM'`. */
    message?: string;
    /** Qui rédige ce texte : Meta (`DEFAULT`), l'agent lui-même (`AGENT`), ou nous (`CUSTOM`). */
    message_selection?: 'DEFAULT' | 'AGENT' | 'CUSTOM';
    [autre: string]: unknown;
  };
  /** Tout champ que Meta ajouterait : conservé tel quel par le read-modify-write. */
  [autre: string]: unknown;
}

export interface AllowlistEntry {
  id?: string;
  consumer_phone_number: string;
}

export class MbaClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async appel<T>(
    methode: string, chemin: string, corps?: unknown, version = VERSION_AGENT_CONFIG, signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchImpl(`${BASE}/${chemin}`, {
      method: methode,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-API-Version': version,
        ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
      ...(signal ? { signal } : {}),
    });

    const txt = await res.text();
    let json: unknown;
    try { json = txt === '' ? null : JSON.parse(txt); } catch { json = txt; }

    if (!res.ok) throw erreurMba(res.status, json);
    return json as T;
  }

  // ---------- Événement (agent_event) ----------

  /**
   * Déclenche l'agent de Meta dans la conversation d'un client. `to` en E.164 avec « + »
   * (`destinataireAgentEvent`). Un 200 dit seulement que l'événement est en file (`accepted`).
   */
  async agentEvent(phoneNumberId: string, to: string, event: EvenementAgent, signal?: AbortSignal): Promise<unknown> {
    return this.appel<unknown>('POST', `${phoneNumberId}/agent_event`, { to, event }, VERSION_AGENT_CONFIG, signal);
  }

  // ---------- Informations business (singleton) ----------

  async getBusinessInfo(phoneNumberId: string): Promise<BusinessInfo> {
    return this.appel<BusinessInfo>('GET', `${phoneNumberId}/agent_config/business_info`);
  }

  /**
   * Remplacement complet : l'appelant doit fusionner sur l'existant (`fusionnerBusinessInfo`), un objet partiel
   * efface le reste.
   */
  async putBusinessInfo(phoneNumberId: string, info: BusinessInfo): Promise<BusinessInfo> {
    return this.appel<BusinessInfo>('PUT', `${phoneNumberId}/agent_config/business_info`, info);
  }

  // ---------- FAQ ----------

  async listFaqs(phoneNumberId: string): Promise<Faq[]> {
    return this.appel<Faq[]>('GET', `${phoneNumberId}/agent_config/faq`);
  }

  async createFaq(phoneNumberId: string, faq: Faq): Promise<Faq> {
    return this.appel<Faq>('POST', `${phoneNumberId}/agent_config/faq`, faq);
  }

  async updateFaq(phoneNumberId: string, faqId: string, faq: Faq): Promise<Faq> {
    return this.appel<Faq>('PUT', `${phoneNumberId}/agent_config/faq/${faqId}`, faq);
  }

  async deleteFaq(phoneNumberId: string, faqId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_config/faq/${faqId}`);
  }

  // ---------- Skills ----------

  /**
   * `agentId` est toujours passé explicitement : sans lui, Meta lit et écrit sous « les settings les plus
   * récemment créés pour le canal », peut-être pas ceux qu'on croit piloter (`docs/MBA-API-REFERENCE.md`).
   */
  async listSkills(phoneNumberId: string, agentId: string): Promise<Skill[]> {
    return this.appel<Skill[]>('GET', `${phoneNumberId}/agent_config/skills?agent_id=${encodeURIComponent(agentId)}`);
  }

  async createSkill(phoneNumberId: string, agentId: string, skill: Skill): Promise<Skill> {
    return this.appel<Skill>('POST', `${phoneNumberId}/agent_config/skills?agent_id=${encodeURIComponent(agentId)}`, skill);
  }

  async updateSkill(phoneNumberId: string, skillId: string, skill: Skill): Promise<Skill> {
    return this.appel<Skill>('PUT', `${phoneNumberId}/agent_config/skills/${skillId}`, skill);
  }

  async deleteSkill(phoneNumberId: string, skillId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_config/skills/${skillId}`);
  }

  // ---------- Sites web ----------

  async listWebsites(phoneNumberId: string): Promise<Website[]> {
    return this.appel<Website[]>('GET', `${phoneNumberId}/agent_config/websites`);
  }

  async createWebsite(phoneNumberId: string, url: string): Promise<Website> {
    return this.appel<Website>('POST', `${phoneNumberId}/agent_config/websites`, { url });
  }

  async deleteWebsite(phoneNumberId: string, websiteId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_config/websites/${websiteId}`);
  }

  // ---------- Fichiers ----------

  async listFiles(phoneNumberId: string): Promise<KnowledgeFile[]> {
    return this.appel<KnowledgeFile[]>('GET', `${phoneNumberId}/agent_config/files`);
  }

  /**
   * Envoi multipart (pas de JSON) : `file_name` + `file`, 100 Mo max côté Meta. Le `Content-Type` est laissé à
   * `FormData`, qui pose lui-même sa frontière.
   */
  async uploadFile(phoneNumberId: string, fileName: string, contenu: Blob): Promise<KnowledgeFile> {
    const form = new FormData();
    form.append('file_name', fileName);
    form.append('file', contenu, fileName);
    const res = await this.fetchImpl(`${BASE}/${phoneNumberId}/agent_config/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'X-API-Version': VERSION_AGENT_CONFIG },
      body: form,
    });
    const txt = await res.text();
    let json: unknown;
    try { json = txt === '' ? null : JSON.parse(txt); } catch { json = txt; }
    if (!res.ok) throw erreurMba(res.status, json);
    return json as KnowledgeFile;
  }

  async deleteFile(phoneNumberId: string, fileId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_config/files/${fileId}`);
  }

  // ---------- Réglages, allowlist, éligibilité ----------

  async isEligible(phoneNumberId: string): Promise<boolean> {
    const r = await this.appel<{ is_eligible?: boolean }>('GET', `${phoneNumberId}/agent_eligibility`);
    return r.is_eligible === true;
  }

  /** Meta renvoie un tableau (un élément par canal), pas un objet : on rend le premier, ou null. */
  async getSettings(phoneNumberId: string): Promise<AgentSettings | null> {
    const r = await this.appel<AgentSettings[]>('GET', `${phoneNumberId}/agent_config/settings`);
    return Array.isArray(r) ? (r[0] ?? null) : null;
  }

  /**
   * Remplacement complet, le piège le plus coûteux de cette API : passer par `modifierSettings`, qui relit l'objet
   * et ne touche qu'aux clés voulues. `agent_id` et `channel` sont dans la réponse du GET mais pas dans le schéma
   * de requête (400) : retirés du corps, `agent_id` repart en query, sans quoi Meta fait du « create-or-fetch » et
   * on ne sait plus quelle configuration on écrit.
   */
  async putSettings(phoneNumberId: string, settings: AgentSettings, agentId?: string): Promise<unknown> {
    const corps: Record<string, unknown> = { ...settings };
    delete corps.agent_id;
    delete corps.channel;
    const q = agentId === undefined ? '' : `?agent_id=${encodeURIComponent(agentId)}`;
    return this.appel<unknown>('PUT', `${phoneNumberId}/agent_config/settings${q}`, corps);
  }

  // ---------- Connecteurs et leurs outils ----------

  /**
   * Les connecteurs d'un numéro, c'est-à-dire les systèmes que l'agent de Meta sait interroger. La surface
   * accepte `connector_protocol` `HTTP` ou `MCP` (fixé à la création, `HTTP` par défaut) ; ce client ne l'envoie
   * pas, donc tout part en HTTP : un manque de code, pas une limite de Meta. Nous ne posons qu'une clé d'API
   * (`upsertApiKey`), pas `upsertOAuth` ni `upsertCertificate`. L'énumération d'`auth_type` liste six valeurs,
   * mais Meta n'en supporte que trois (`OAUTH2_CLIENT_CREDENTIALS`, `API_KEY`, `NONE`).
   */
  async listConnectors(phoneNumberId: string): Promise<Array<{ id: string; name: string; base_url?: string; auth_type?: string }>> {
    const r = await this.appel<unknown>('GET', `${phoneNumberId}/agent_connectors`);
    return Array.isArray(r) ? r as Array<{ id: string; name: string }> : ((r as { data?: unknown })?.data as Array<{ id: string; name: string }>) ?? [];
  }

  async createConnector(phoneNumberId: string, corps: {
    name: string; description: string; base_url: string; auth_type: string; auth_config?: unknown;
  }): Promise<{ id: string }> {
    return this.appel<{ id: string }>('POST', `${phoneNumberId}/agent_connectors`, corps);
  }

  async updateConnector(phoneNumberId: string, connectorId: string, corps: {
    name?: string; description?: string; base_url?: string; auth_type?: string; auth_config?: unknown;
  }): Promise<unknown> {
    return this.appel<unknown>('PUT', `${phoneNumberId}/agent_connectors/${connectorId}`, corps);
  }

  async deleteConnector(phoneNumberId: string, connectorId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_connectors/${connectorId}`);
  }

  /**
   * Pose ou fait tourner le secret d'un connecteur. Le corps de création l'accepterait aussi, mais cette route est
   * la seule qui le remplace sans recréer le connecteur : un secret n'a ainsi qu'un chemin d'écriture à auditer
   * (notre discipline, pas une contrainte de Meta).
   */
  async upsertApiKey(phoneNumberId: string, connectorId: string, corps: unknown): Promise<unknown> {
    return this.appel<unknown>('POST', `${phoneNumberId}/agent_connectors/${connectorId}/upsertApiKey`, corps);
  }

  /**
   * `request_definition` est rendu tel quel : le plan de publication le compare, et sans lui chaque publication
   * demanderait la mise à jour de tous les outils.
   */
  async listConnectorTools(phoneNumberId: string, connectorId: string): Promise<Array<{
    id: string; name: string; description?: string; request_definition?: Record<string, unknown>;
  }>> {
    // Toute la définition, pas seulement `method` et `path` : le plan compare aussi les en-têtes et le corps.
    type T = { id: string; name: string; description?: string; request_definition?: Record<string, unknown> };
    const r = await this.appel<unknown>('GET', `${phoneNumberId}/agent_connectors/${connectorId}/tools`);
    return Array.isArray(r) ? r as T[] : ((r as { data?: unknown })?.data as T[]) ?? [];
  }

  /**
   * Crée un outil sur un connecteur. `user_auth_required` est exigé par le schéma de Meta, envoyé à `false` :
   * `true` demanderait un jeton par utilisateur final, que nous ne collectons pas.
   */
  async createConnectorTool(phoneNumberId: string, connectorId: string, corps: {
    name: string; description: string; request_definition: unknown; user_auth_required: boolean;
  }): Promise<{ id: string }> {
    return this.appel<{ id: string }>('POST', `${phoneNumberId}/agent_connectors/${connectorId}/tools`, corps);
  }

  async updateConnectorTool(phoneNumberId: string, connectorId: string, toolId: string, corps: unknown): Promise<unknown> {
    return this.appel<unknown>('PUT', `${phoneNumberId}/agent_connectors/${connectorId}/tools/${toolId}`, corps);
  }

  async deleteConnectorTool(phoneNumberId: string, connectorId: string, toolId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_connectors/${connectorId}/tools/${toolId}`);
  }

  async listAllowlist(phoneNumberId: string): Promise<AllowlistEntry[]> {
    return this.appel<AllowlistEntry[]>('GET', `${phoneNumberId}/agent_config/allowlist`);
  }

  async addToAllowlist(phoneNumberId: string, consumerPhoneNumber: string): Promise<AllowlistEntry> {
    return this.appel<AllowlistEntry>('POST', `${phoneNumberId}/agent_config/allowlist`, { consumer_phone_number: consumerPhoneNumber });
  }

  async removeFromAllowlist(phoneNumberId: string, entryId: string): Promise<void> {
    await this.appel<unknown>('DELETE', `${phoneNumberId}/agent_config/allowlist/${entryId}`);
  }

  // ---------- Contrôle du fil ----------

  /**
   * Rend le fil à MBA, qui redevient le répondeur automatique (miroir : `takeThread`). Précondition de Meta :
   * « You must currently hold thread control for the conversation » ; l'appelant consulte son état de contrôle
   * avant. La réponse ne porte aucune information et aucun endpoint ne dit qui détient un fil : la confirmation
   * arrive par le webhook `messaging_handovers`.
   *
   * @param to Identifiant du consommateur. Convention Cloud API : E.164 sans `+` ni séparateur.
   */
  async releaseThread(phoneNumberId: string, to: string): Promise<void> {
    await this.controleDuFil(phoneNumberId, 'release', to);
  }

  /**
   * Prend le fil à l'agent de Meta, sans écrire au client (action `take` de `thread_control`, absente du corpus
   * OpenAPI téléchargé mais documentée : « Use the `take` action to take control before you send anything »).
   * Meta la réserve au « configured escalation partner », qu'il ne définit pas : un refus est un cas normal, que
   * l'appelant traduit pour l'opérateur ; écrire prend le fil à coup sûr. Confirmation asynchrone, comme `release`.
   *
   * @param to Identifiant du consommateur. Convention Cloud API : E.164 sans `+` ni séparateur.
   */
  async takeThread(phoneNumberId: string, to: string): Promise<void> {
    await this.controleDuFil(phoneNumberId, 'take', to);
  }

  /** L'appel commun à `releaseThread` et `takeThread` : seule l'action change. */
  private async controleDuFil(phoneNumberId: string, action: 'release' | 'take', to: string): Promise<void> {
    await this.appel<unknown>(
      'POST',
      `business/whatsapp/phone_numbers/${phoneNumberId}/thread_control`,
      { messaging_product: 'whatsapp', action, to },
      VERSION_THREAD_CONTROL,
    );
  }

  /** Bac à sable : joue un message sans destinataire réel. Meta ne facture pas les jetons consommés ici. */
  async test(phoneNumberId: string, userMsg: string, conversationId?: string): Promise<{
    agent_response?: string;
    conversation_id?: string;
    handoff_reason?: string;
    no_response_reason?: string;
    quick_replies?: unknown[];
  }> {
    return this.appel('POST', `${phoneNumberId}/agent_test`, {
      user_msg: userMsg,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    });
  }
}

/**
 * Normalise les deux formes d'erreur de cette surface. MBA répond `{title, detail, status}` quand le reste de
 * Graph répond `{error:{message,code}}` : sans ça, le `detail` de Meta (souvent la marche à suivre exacte,
 * URL comprise) serait perdu et l'écran afficherait « erreur inconnue ».
 */
function erreurMba(status: number, json: unknown): MetaApiError {
  const o = (json ?? {}) as { title?: string; detail?: string; error?: MetaErrorBody };
  if (o.error) return new MetaApiError(status, o.error);
  const message = [o.title, o.detail].filter(Boolean).join(' : ') || `HTTP ${status}`;
  // `error_user_msg` : c'est ce champ que les écrans affichent. Le `detail` de Meta porte souvent la marche
  // à suivre exacte (« Add a payment method in the Billing Hub and try again : <URL> »), il doit arriver
  // jusqu'au client tel quel.
  return new MetaApiError(status, { message, type: 'MbaError', error_user_msg: o.detail ?? message, error_user_title: o.title });
}

/** Lecture puis fusion : l'appelant ne fournit que ce qu'il change, le reste est préservé. */
export async function fusionnerBusinessInfo(
  client: MbaClient,
  phoneNumberId: string,
  patch: BusinessInfo,
): Promise<BusinessInfo> {
  const actuel = await client.getBusinessInfo(phoneNumberId);
  const contact = patch.contact_info === undefined
    ? actuel.contact_info
    : { ...(actuel.contact_info ?? {}), ...(patch.contact_info ?? {}) };
  return client.putBusinessInfo(phoneNumberId, {
    ...actuel,
    ...patch,
    ...(contact === undefined ? {} : { contact_info: contact }),
  });
}

/**
 * Lecture puis modification ciblée des réglages. Les clés absentes du patch sont repassées telles quelles, y
 * compris celles que ce code ne connaît pas : seule façon de survivre à un champ ajouté par Meta.
 */
export async function modifierSettings(
  client: MbaClient,
  phoneNumberId: string,
  patch: Partial<AgentSettings>,
): Promise<unknown> {
  const actuel = (await client.getSettings(phoneNumberId)) ?? {};
  return client.putSettings(
    phoneNumberId,
    {
      ...actuel,
      ...patch,
      ...(patch.rollout ? { rollout: { ...(actuel.rollout ?? {}), ...patch.rollout } } : {}),
      ...(patch.followup ? { followup: { ...(actuel.followup ?? {}), ...patch.followup } } : {}),
      // Même fusion par sous-objet que ci-dessus, et pour la même raison : patcher `handoff.enabled` seul
      // effacerait sinon `message` et `message_selection`, donc le texte lu par le client au transfert.
      ...(patch.handoff ? { handoff: { ...(actuel.handoff ?? {}), ...patch.handoff } } : {}),
    },
    // Relu à l'instant : c'est la configuration qu'on vient de lire qu'on réécrit, pas « la plus récente ».
    typeof actuel.agent_id === 'string' ? actuel.agent_id : undefined,
  );
}
