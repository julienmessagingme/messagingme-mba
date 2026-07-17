import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { normalizePhone } from '../crm/phone';
import { buildRecipients } from '../campaign/build';
import { buildApiRecipients } from '../api/sends-build';
import type { ApiSkip } from '../api/sends-build';
import type { BuildContact, BuiltRecipient } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { TemplateParam } from '../crm/template';
import type { ResolveResult } from '../ids/resolve';
import type { IdempotencyClaim } from '../api/idempotency-store.pg';

export interface V1SendCreateInput {
  tenantId: string;
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  workflowId?: string;
}

export interface V1SendsRouteDeps {
  resolveScenario(tenantId: string, ref: string): Promise<ResolveResult<{ id: string; name: string }>>;
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  findContactByPhone(tenantId: string, phoneE164: string): Promise<{ id: string } | null>;
  createContactByPhone(tenantId: string, phoneE164: string): Promise<{ id: string }>;
  listContactsForBuildByIds(tenantId: string, ids: string[]): Promise<BuildContact[]>;
  createSend(input: V1SendCreateInput, recipients: BuiltRecipient[]): Promise<{ campaignId: string; recipientCount: number }>;
  enqueue(campaignId: string, pendingCount: number, ratePerMinute: number | null): Promise<void>;
  idempotencyClaim(tenantId: string, key: string): Promise<IdempotencyClaim>;
  idempotencyComplete(tenantId: string, key: string, sendId: string, response: unknown): Promise<void>;
  idempotencyRelease(tenantId: string, key: string): Promise<void>;
  getSendDetail(sendId: string, tenantId: string): Promise<unknown | null>;
}

const MAX_RECIPIENTS = 50;
const MAX_SKIPPED_REPORT = 200;
const CATEGORIES: readonly string[] = ['marketing', 'utility'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * API publique /v1 des envois. Tenant issu de la clé (req.auth). Guard attendu :
 * [makeRequireApiKey, requireScope('sends:create')]. Cible scénario (par code/nom) ou template ; le node est
 * différé (422). Idempotency-Key OBLIGATOIRE (D-4). Rapport skipped détaillé par numéro (D-5). Upsert-then-send (D-3).
 */
export function registerV1Sends(app: FastifyInstance, deps: V1SendsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/v1/sends', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    const tenantId = req.auth.tenantId;

    const idem = req.headers['idempotency-key'];
    const idemKey = (Array.isArray(idem) ? idem[0] : idem)?.trim();
    if (!idemKey) return reply.code(400).send({ error: 'header Idempotency-Key requis' });

    const b = (req.body ?? {}) as { target?: unknown; category?: unknown; recipients?: unknown; params?: unknown; ratePerMinute?: unknown; phoneNumberId?: unknown; createMissing?: unknown };
    if (!CATEGORIES.includes(String(b.category))) return reply.code(400).send({ error: 'category requise (marketing|utility)' });
    const category = b.category as CampaignCategory;
    if (!isObj(b.target)) return reply.code(400).send({ error: 'target requis' });
    if (!Array.isArray(b.recipients) || b.recipients.length === 0) return reply.code(400).send({ error: 'recipients (tableau non vide) requis' });
    if (b.recipients.length > MAX_RECIPIENTS) return reply.code(400).send({ error: `maximum ${MAX_RECIPIENTS} destinataires par envoi` });
    const params: TemplateParam[] = Array.isArray(b.params) ? (b.params as TemplateParam[]) : [];
    const ratePerMinute = typeof b.ratePerMinute === 'number' && b.ratePerMinute > 0 ? Math.min(80, Math.floor(b.ratePerMinute)) : null;
    const createMissing = b.createMissing !== false; // défaut true (upsert-then-send)

    // Résolution de la cible : scénario (code/nom), template (name+language), node (différé).
    const t = b.target as Record<string, unknown>;
    let workflowId: string | undefined;
    let templateName = '';
    let templateLanguage = '';
    let label = '';
    if (typeof t.scenario === 'string') {
      const r = await deps.resolveScenario(tenantId, t.scenario);
      if (!r.ok && r.reason === 'not_found') return reply.code(404).send({ error: 'scénario introuvable' });
      if (!r.ok && r.reason === 'ambiguous') return reply.code(409).send({ error: 'nom de scénario ambigu : plusieurs correspondances, utilise le code scn_', matches: r.matches.map((m) => m.id) });
      if (!r.ok) return reply.code(404).send({ error: 'scénario introuvable' });
      workflowId = r.value.id;
      label = r.value.name;
    } else if (isObj(t.template) && typeof t.template.name === 'string' && typeof t.template.language === 'string') {
      templateName = t.template.name;
      templateLanguage = t.template.language;
      label = templateName;
    } else if (typeof t.node === 'string') {
      return reply.code(422).send({ error: 'cible node non encore supportée (à venir)' });
    } else {
      return reply.code(400).send({ error: 'target invalide : {scenario} | {template:{name,language}} | {node}' });
    }

    // Numéro expéditeur : fourni (vérifié tenant) ou défaut du tenant.
    let phoneNumberId: string;
    if (typeof b.phoneNumberId === 'string' && b.phoneNumberId !== '') {
      if (!(await deps.phoneNumberBelongsToTenant(b.phoneNumberId, tenantId))) return reply.code(400).send({ error: 'numéro inconnu pour ce tenant' });
      phoneNumberId = b.phoneNumberId;
    } else {
      const def = await deps.getTenantPhoneNumberId(tenantId);
      if (!def) return reply.code(400).send({ error: 'aucun numéro connecté pour ce tenant' });
      phoneNumberId = def;
    }

    // Idempotence : claim atomique. Concurrent -> 409 ; déjà calculé -> rejeu du rapport.
    const claim = await deps.idempotencyClaim(tenantId, idemKey);
    if (!claim.claimed && 'pending' in claim) return reply.code(409).send({ error: 'envoi identique en cours (Idempotency-Key)' });
    if (!claim.claimed) return reply.code(201).send(claim.response);

    // Rempli + scellé dans le try ; l'enqueue (hors try) le lit après scellement (definite assignment).
    let report!: { sendId: string; recipientCount: number; created: number; matched: number; skipped: ApiSkip[]; skippedTotal: number };
    try {
      // Upsert-then-send (D-3) : résout chaque téléphone en contactId.
      const skipped: ApiSkip[] = [];
      const ids: string[] = [];
      let created = 0;
      let matched = 0;
      for (const raw of b.recipients as unknown[]) {
        const p = normalizePhone(String(raw ?? ''), 'FR');
        if (!p.e164) { skipped.push({ phone: String(raw ?? ''), reason: 'invalid_phone' }); continue; }
        const existing = await deps.findContactByPhone(tenantId, p.e164);
        if (existing) { matched += 1; ids.push(existing.id); continue; }
        if (!createMissing) { skipped.push({ phone: p.e164, reason: 'unknown_contact' }); continue; }
        const c = await deps.createContactByPhone(tenantId, p.e164);
        created += 1;
        ids.push(c.id);
      }

      const contacts = await deps.listContactsForBuildByIds(tenantId, ids);
      const { eligible, skipped: optSkips } = buildApiRecipients(category, contacts);
      skipped.push(...optSkips);
      // Résolution des variables de template (missing_variable) sur les éligibles. Scénario : params vide.
      const built = buildRecipients(category, params, eligible);
      for (const s of built.skipped) skipped.push({ phone: s.toE164, reason: 'missing_variable' });

      const name = `[API] ${label}`.slice(0, 120);
      report = {
        sendId: '',
        recipientCount: built.recipients.length,
        created,
        matched,
        skipped: skipped.slice(0, MAX_SKIPPED_REPORT),
        skippedTotal: skipped.length,
      };
      const send = await deps.createSend(
        { tenantId, phoneNumberId, name, category, templateName, templateLanguage, paramMapping: params, ...(workflowId ? { workflowId } : {}) },
        built.recipients,
      );
      report.sendId = send.campaignId;
      // SCELLE l'idempotence AVANT l'enqueue : sans ça, un échec de complete APRÈS un enqueue réussi
      // ferait release -> un retry recréerait une 2e campagne (nouveau campaignId, singletonKey inutile)
      // et renverrait les messages EN DOUBLE. Sceller ici garantit qu'un retry rejoue ce rapport (même
      // campaignId) sans jamais réémettre. Échec avant scellement -> release + throw (retry propre).
      await deps.idempotencyComplete(tenantId, idemKey, send.campaignId, report);
    } catch (err) {
      await deps.idempotencyRelease(tenantId, idemKey);
      throw err;
    }

    // Idempotence scellée. enqueue est idempotent (singletonKey=campaignId) et HORS du chemin de release :
    // un échec laisse une campagne non lancée (sous-envoi, jamais sur-envoi), à ré-enfiler hors bande.
    try {
      await deps.enqueue(report.sendId, report.recipientCount, ratePerMinute);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('v1/sends: enqueue échoué après scellement idempotence (campagne non lancée):', report.sendId, err instanceof Error ? err.message : err);
    }
    return reply.code(201).send(report);
  });

  app.get('/v1/sends/:sendId', opts, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'clé d’API requise' });
    const { sendId } = req.params as { sendId: string };
    const detail = await deps.getSendDetail(sendId, req.auth.tenantId);
    if (!detail) return reply.code(404).send({ error: 'envoi inconnu' });
    return reply.code(200).send(detail);
  });
}
