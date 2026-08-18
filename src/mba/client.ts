import { MetaApiError } from '../meta/errors';
import type { MetaErrorBody } from '../meta/errors';
import type { FetchLike } from '../meta/templates';

/**
 * Client de la surface Meta Business Agent (`agent_config/*`) : la base de connaissance de l'agent et ses
 * réglages, pilotés PAR NUMÉRO.
 *
 * ⚠️ MBA ne vit PAS sur `graph.facebook.com`. Ces routes y répondent « Unknown path components » (code 2500,
 * mesuré le 2026-08-18). C'est `api.facebook.com`, SANS version dans le chemin : la version passe par
 * l'en-tête `X-API-Version`, qu'on envoie toujours plutôt que de dépendre d'un défaut non documenté.
 *
 * ⚠️ Erreurs : cette surface renvoie `{title, detail, status}` là où le reste de Graph renvoie
 * `{error:{message,code}}`. Les deux formes sont normalisées ici, sinon un message utile (« A payment method
 * is required to enable Meta Business Agent... ») serait perdu au profit d'un « erreur inconnue ».
 */
const BASE = 'https://api.facebook.com';
const API_VERSION = '2.0.0';

/** Informations générales sur l'entreprise. Ressource SINGLETON : le PUT est un remplacement complet. */
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
 * Une « skill » : des INSTRUCTIONS en langage naturel, pas une fonction appelable (le tool calling, ce sont
 * les connecteurs). `description` dit à l'agent QUAND l'appliquer, `skill` dit QUOI faire.
 */
export interface Skill {
  id?: string;
  /** Minuscules, chiffres et tirets, sans tiret au début ni à la fin. 64 caractères max. */
  title: string;
  /** Le déclencheur : « Apply when the customer asks about returns ». 1024 caractères max. */
  description: string;
  /** Le corps d'instructions. 20 000 caractères max. */
  skill: string;
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
  /** Meta le documente mais ne le renvoie pas tant qu'il n'est pas configuré (« Null if not configured »). */
  handoff?: Record<string, unknown>;
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

  private async appel<T>(methode: string, chemin: string, corps?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${BASE}/${chemin}`, {
      method: methode,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-API-Version': API_VERSION,
        ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
    });

    const txt = await res.text();
    let json: unknown;
    try { json = txt === '' ? null : JSON.parse(txt); } catch { json = txt; }

    if (!res.ok) throw erreurMba(res.status, json);
    return json as T;
  }

  // ---------- Informations business (singleton) ----------

  async getBusinessInfo(phoneNumberId: string): Promise<BusinessInfo> {
    return this.appel<BusinessInfo>('GET', `${phoneNumberId}/agent_config/business_info`);
  }

  /**
   * ⚠️ REMPLACEMENT COMPLET. L'appelant DOIT fusionner sur l'existant : un objet partiel efface le reste.
   * Voir `fusionnerBusinessInfo`, qui fait la lecture et la fusion.
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
   * ⚠️ `agentId` est passé EXPLICITEMENT, toujours. Sans lui, Meta lit et écrit sous « les settings les plus
   * récemment créés pour le canal », donc potentiellement sous une configuration qui n'est pas celle qu'on
   * croit piloter. Le piège est documenté dans `docs/MBA-API-REFERENCE.md`.
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
   * Envoi MULTIPART (pas de JSON) : `file_name` + `file`. 100 Mo max côté Meta.
   * Le `Content-Type` est laissé à `FormData`, qui doit poser lui-même sa frontière multipart.
   */
  async uploadFile(phoneNumberId: string, fileName: string, contenu: Blob): Promise<KnowledgeFile> {
    const form = new FormData();
    form.append('file_name', fileName);
    form.append('file', contenu, fileName);
    const res = await this.fetchImpl(`${BASE}/${phoneNumberId}/agent_config/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'X-API-Version': API_VERSION },
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

  /** Meta renvoie un TABLEAU (un élément par canal), pas un objet. On rend le premier, ou null. */
  async getSettings(phoneNumberId: string): Promise<AgentSettings | null> {
    const r = await this.appel<AgentSettings[]>('GET', `${phoneNumberId}/agent_config/settings`);
    return Array.isArray(r) ? (r[0] ?? null) : null;
  }

  /**
   * ⚠️ REMPLACEMENT COMPLET, et c'est le piège le plus coûteux de cette API. Passer par `modifierSettings`,
   * qui relit l'objet et ne touche qu'aux clés voulues : un modèle typé fermé effacerait `never_say_phrases`,
   * `handoff` et tout champ que Meta ajouterait, sans que personne le demande.
   */
  async putSettings(phoneNumberId: string, settings: AgentSettings): Promise<unknown> {
    return this.appel<unknown>('PUT', `${phoneNumberId}/agent_config/settings`, settings);
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

  /** Bac à sable : joue un message sans destinataire réel. Meta ne facture PAS les jetons consommés ici. */
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
 * Lecture puis modification ciblée des réglages. Les clés absentes du patch sont repassées TELLES QUELLES,
 * y compris celles que ce code ne connaît pas : c'est la seule façon de survivre à un champ ajouté par Meta.
 */
export async function modifierSettings(
  client: MbaClient,
  phoneNumberId: string,
  patch: Partial<AgentSettings>,
): Promise<unknown> {
  const actuel = (await client.getSettings(phoneNumberId)) ?? {};
  return client.putSettings(phoneNumberId, {
    ...actuel,
    ...patch,
    ...(patch.rollout ? { rollout: { ...(actuel.rollout ?? {}), ...patch.rollout } } : {}),
    ...(patch.followup ? { followup: { ...(actuel.followup ?? {}), ...patch.followup } } : {}),
  });
}
