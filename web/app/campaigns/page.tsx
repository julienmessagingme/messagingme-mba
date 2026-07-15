'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import type { Session } from '@/lib/session';
import { explainMetaError } from '@/lib/meta-errors';
import { fmtCost } from '@/lib/format';
import {
  listCampaigns,
  getCampaign,
  listPhoneNumbers,
  createCampaign,
  runCampaign,
  listTemplates,
  listAllContacts,
  listWorkflows,
  getTemplateStats,
  getTemplateHints,
  contactIdentity,
  type CampaignSummary,
  type CampaignDetail,
  type CampaignCategory,
  type PhoneNumber,
  type PricingSummary,
  type TemplateParam,
  type TemplateSummary,
  type Contact,
  type WorkflowSummary,
} from '@/lib/api';

/** Coût estimé d'une campagne = envois facturables (counts.sent) × tarif catégorie (Meta). null si tarif
 *  indisponible. Sur-estime l'utility en fenêtre de service gratuite -> à présenter comme « ~ estimé ». */
function estimateCampaignCost(sent: number, category: CampaignCategory, pricing: PricingSummary | null): number | null {
  const rate = pricing?.byCategory[category]?.ratePerMessage;
  return rate == null ? null : sent * rate;
}

export default function CampaignsPage() {
  return <AppShell active="campagnes">{(session) => <CampaignsInner session={session} />}</AppShell>;
}

const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: 'brouillon', cls: 'bg-ink-100 text-ink-600' },
  running: { text: 'en cours', cls: 'bg-blue-50 text-blue-700' },
  paused: { text: 'en pause', cls: 'bg-amber-50 text-amber-700' },
  completed: { text: 'terminée', cls: 'bg-emerald-50 text-emerald-700' },
  failed: { text: 'échec', cls: 'bg-red-50 text-red-700' },
  pending: { text: 'en attente', cls: 'bg-ink-100 text-ink-600' },
  sending: { text: 'envoi', cls: 'bg-blue-50 text-blue-700' },
  sent: { text: 'envoyé', cls: 'bg-ink-100 text-ink-700' },
  skipped: { text: 'ignoré', cls: 'bg-amber-50 text-amber-700' },
  // Statuts de livraison Meta
  delivered: { text: 'délivré', cls: 'bg-blue-50 text-blue-700' },
  read: { text: 'lu', cls: 'bg-emerald-50 text-emerald-700' },
};
function Badge({ status }: { status: string }) {
  const s = STATUS[status] ?? { text: status, cls: 'bg-ink-100 text-ink-600' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>;
}

function CampaignsInner({ session }: { session: Session }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  // Tarifs Meta chargés UNE fois au montage (hors reload() pollé 6×/2s pendant l'envoi -> pas de martèlement).
  const [pricing, setPricing] = useState<PricingSummary | null>(null);

  useEffect(() => {
    getTemplateStats(session.tenantId).then((ts) => setPricing(ts.pricing)).catch(() => setPricing(null));
  }, [session.tenantId]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [c, n] = await Promise.all([listCampaigns(session.tenantId), listPhoneNumbers(session.tenantId)]);
      setCampaigns(c.campaigns);
      setNumbers(n.phoneNumbers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDetail(id: string) {
    try {
      setDetail(await getCampaign(session.tenantId, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Détail indisponible');
    }
  }

  async function run(id: string) {
    setError(null);
    try {
      await runCampaign(id);
      await openDetail(id); // ouvre le détail de la campagne lancée
      // Le worker traite en ~1-2s : on rafraîchit quelques fois pour voir les statuts évoluer.
      setPolling(true);
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        await reload();
        await openDetail(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lancement impossible');
    } finally {
      setPolling(false);
    }
  }

  // Écran de création (ouvert via « Ajouter une campagne »).
  if (mode === 'create') {
    return (
      <div className="mx-auto max-w-2xl">
        <button onClick={() => setMode('list')} className="mb-4 flex items-center gap-1 text-sm text-brand-600 hover:underline">
          ← Retour aux campagnes
        </button>
        <CreateForm
          tenantId={session.tenantId}
          numbers={numbers}
          onCreated={() => { void reload(); setMode('list'); }}
        />
      </div>
    );
  }

  // Écran par défaut : dashboard de suivi des campagnes.
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink-900">Campagnes ({campaigns.length})</h2>
          {pricing ? (
            <p className="mt-0.5 text-xs text-ink-500">
              coût estimé total ≈ <span className="font-semibold text-ink-800">{fmtCost(campaigns.reduce((acc, c) => acc + (estimateCampaignCost(c.counts.sent, c.category, pricing) ?? 0), 0))}</span> <span className="text-ink-400">(devise du compte)</span>
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-ink-400">coût estimé indisponible (tarif Meta)</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {polling ? (
            <span className="flex items-center gap-1.5 text-xs text-ink-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              actualisation...
            </span>
          ) : (
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
          )}
          <button
            onClick={() => { setDetail(null); setMode('create'); }}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            + Ajouter une campagne
          </button>
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-ink-500">Chargement...</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
          Aucune campagne. Clique « + Ajouter une campagne » pour en créer une.
        </div>
      ) : (
          <ul className="space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge status={c.status} />
                      <span className="text-xs text-ink-400">{c.category}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      template {c.templateName} ({c.templateLanguage}) · {c.counts.total} destinataires
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                      <b className="text-emerald-700">{c.counts.sent}</b> envoyés
                      {c.counts.failed > 0 && <> · <b className="text-red-700">{c.counts.failed}</b> échecs</>}
                      {c.counts.pending > 0 && <> · {c.counts.pending} en attente</>}
                      {c.counts.skipped > 0 && <> · {c.counts.skipped} ignorés</>}
                    </p>
                    {(() => {
                      const cost = estimateCampaignCost(c.counts.sent, c.category, pricing);
                      return (
                        <p className="mt-1 text-xs text-ink-400">
                          coût estimé {cost != null ? <>≈ <span className="font-medium text-ink-700">{fmtCost(cost)}</span> (devise du compte)</> : 'indisponible'}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {/* « Lancer » pour un brouillon (jamais envoyée) ; « Reprendre » pour une campagne mise
                        en pause par le quality gate (elle relance ses destinataires restants). Une campagne
                        en cours / terminée / en échec ne se (re)lance pas depuis la liste. */}
                    {(c.status === 'draft' || c.status === 'paused') && (
                      <button
                        onClick={() => run(c.id)}
                        disabled={polling}
                        className="rounded-lg bg-brand-500 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                      >
                        {c.status === 'paused' ? 'Reprendre' : 'Lancer'}
                      </button>
                    )}
                    <button
                      onClick={() => (detail?.id === c.id ? setDetail(null) : openDetail(c.id))}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {detail?.id === c.id ? 'Masquer' : 'Détails'}
                    </button>
                  </div>
                </div>
                {detail?.id === c.id && (
                  <div className="mt-3">
                    <DetailPanel detail={detail} pricing={pricing} onClose={() => setDetail(null)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function DetailPanel({ detail, pricing, onClose }: { detail: CampaignDetail; pricing: PricingSummary | null; onClose: () => void }) {
  const cost = estimateCampaignCost(detail.counts.sent, detail.category, pricing);
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{detail.name}</span>
          <Badge status={detail.status} />
          <span className="text-xs text-ink-400">coût estimé {cost != null ? `≈ ${fmtCost(cost)} (devise du compte)` : 'indisponible'}</span>
        </div>
        <button onClick={onClose} className="text-xs text-ink-400 hover:text-ink-700">Fermer</button>
      </div>
      {detail.recipients.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-500">Aucun destinataire.</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Destinataire</th>
              <th className="px-4 py-2 font-medium">Envoi</th>
              <th className="px-4 py-2 font-medium">Livraison</th>
              <th className="px-4 py-2 font-medium">Détail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {detail.recipients.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-mono text-xs">{r.toE164}</td>
                <td className="px-4 py-2"><Badge status={r.status} /></td>
                <td className="px-4 py-2">{r.deliveryStatus ? <Badge status={r.deliveryStatus} /> : <span className="text-xs text-ink-400">-</span>}</td>
                <td className="px-4 py-2 text-xs text-ink-500" title={r.deliveryError ?? r.error ?? undefined}>
                  {explainMetaError(r.deliveryError ?? r.error) ?? r.messageId ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

interface VarRow {
  source: 'name' | 'phone' | 'field' | 'literal';
  key: string;
  value: string;
}

function CreateForm({ tenantId, numbers, onCreated }: { tenantId: string; numbers: PhoneNumber[]; onCreated: () => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'marketing' | 'utility'>('marketing');
  const [templateName, setTemplateName] = useState('');
  const [templateLanguage, setTemplateLanguage] = useState('fr');
  const [vars, setVars] = useState<VarRow[]>([]);
  // Quoi envoyer : un template direct OU un workflow (bot builder).
  const [mode, setMode] = useState<'template' | 'workflow'>('template');
  const [workflowId, setWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Anti-course : ne pas appliquer les indices d'un template si l'utilisateur en a choisi un autre entre-temps.
  const chooseSeq = useRef(0);

  // Templates approuvés + contacts (chargés une fois, indépendamment du polling des campagnes).
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!phoneNumberId && numbers[0]) setPhoneNumberId(numbers[0].id);
  }, [numbers, phoneNumberId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, c, w] = await Promise.all([listTemplates(tenantId), listAllContacts(tenantId), listWorkflows(tenantId)]);
        if (!alive) return;
        setTemplates(t.templates.filter((x) => x.status === 'APPROVED'));
        setWorkflows(w.workflows);
        // Contacts joignables = ceux qui ont une identité (numéro OU BSUID).
        const reachable = c.filter((x) => contactIdentity(x) !== null);
        setContacts(reachable);
        setSelected(new Set(reachable.map((x) => x.id))); // tout coché par défaut
      } catch {
        // silencieux : l'erreur de création reste affichée si l'envoi échoue
      } finally {
        if (alive) setLoadingRefs(false);
      }
    })();
    return () => { alive = false; };
  }, [tenantId]);

  const selectedTemplate = templates.find((t) => t.name === templateName);
  // Valeurs d'aperçu par variable (échantillon lisible selon le mapping) pour la miniature WhatsApp.
  const previewExamples = vars.map((v) =>
    v.source === 'literal' ? (v.value.trim() || '…')
      : v.source === 'name' ? 'Julie'
      : v.source === 'phone' ? '+33 6 12 34 56 78'
      : v.source === 'field' ? `[${v.key || 'champ'}]`
      : '',
  );

  async function chooseTemplate(nm: string) {
    setTemplateName(nm);
    const t = templates.find((x) => x.name === nm);
    if (!t) { setVars([]); return; }
    setTemplateLanguage(t.language);
    setCategory((t.category ?? '').toUpperCase() === 'MARKETING' ? 'marketing' : 'utility');
    const n = new Set((t.body ?? '').match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
    // Défaut immédiat : chaque variable -> Nom. On affine ensuite avec les indices posés à la création du template.
    setVars(Array.from({ length: n }, () => ({ source: 'name', key: '', value: '' })));
    if (name.trim() === '') setName(nm);
    if (n === 0) return;
    const seq = ++chooseSeq.current;
    try {
      const { hints } = await getTemplateHints(tenantId, nm, t.language);
      if (seq !== chooseSeq.current) return; // un autre template a été choisi entre-temps
      if (hints.length === 0) return;
      setVars((prev) => {
        if (prev.length !== n) return prev;
        const rows = [...prev];
        for (const h of hints) {
          const i = h.position - 1;
          if (i < 0 || i >= n) continue;
          const s = h.source;
          if (s.type === 'attribute') rows[i] = { source: s.key === 'phone' ? 'phone' : 'name', key: '', value: '' };
          else if (s.type === 'field') rows[i] = { source: 'field', key: s.key ?? '', value: '' };
          else if (s.type === 'literal') rows[i] = { source: 'literal', key: '', value: s.value ?? '' };
        }
        return rows;
      });
    } catch { /* pas d'indices -> on garde le défaut */ }
  }

  // Tous les tags présents (pour les filtres). Requête = filtre par tag(s) + recherche texte
  // élargie (nom, numéro, tags ET valeurs des champs perso).
  const allTags = [...new Set(contacts.flatMap((c) => c.tags ?? []))].sort();
  const filteredContacts = contacts.filter((c) => {
    if (tagFilter.size > 0 && !(c.tags ?? []).some((t) => tagFilter.has(t))) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const hay = [c.profileName ?? '', c.phoneE164 ?? '', c.bsuid ?? '', ...(c.tags ?? []), ...Object.values(c.fields ?? {}).map(String)]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
  // « Tout » agit sur ce qui est AFFICHÉ (filtre/recherche), pour sélectionner un segment entier.
  const filteredAllSelected = filteredContacts.length > 0 && filteredContacts.every((c) => selected.has(c.id));
  // Combien de sélectionnés sont MASQUÉS par le filtre courant (ils partiront quand même).
  const filteredIds = new Set(filteredContacts.map((c) => c.id));
  const selectedOutside = [...selected].filter((id) => !filteredIds.has(id)).length;
  const filterActive = tagFilter.size > 0 || search.trim() !== '';

  function toggleContact(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAllFiltered() {
    setSelected((s) => {
      const n = new Set(s);
      for (const c of filteredContacts) { if (filteredAllSelected) n.delete(c.id); else n.add(c.id); }
      return n;
    });
  }
  function toggleTag(t: string) {
    setTagFilter((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  }

  function toParamMapping(): TemplateParam[] {
    return vars.map((v, i) => {
      const position = i + 1;
      if (v.source === 'name') return { position, source: { type: 'attribute', key: 'name' } };
      if (v.source === 'phone') return { position, source: { type: 'attribute', key: 'phone' } };
      if (v.source === 'field') return { position, source: { type: 'field', key: v.key } };
      return { position, source: { type: 'literal', value: v.value } };
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createCampaign(
        tenantId,
        mode === 'workflow'
          ? { phoneNumberId, name, category, workflowId, contactIds: [...selected] }
          : { phoneNumberId, name, category, templateName, templateLanguage, paramMapping: toParamMapping(), contactIds: [...selected] },
      );
      // Avertissement : contacts sautés faute d'une variable de template (ex. prénom absent de la fiche). L'envoi part
      // quand même aux valides ; ces contacts-là auraient fait échouer Meta -> on les écarte et on le dit.
      const skippedMsg = res.skipped.length > 0 ? ` ${res.skipped.length} contact(s) sautés (variable de template manquante, ex. prénom absent de la fiche).` : '';
      setOk(`Campagne créée : ${res.recipientCount} destinataires.${skippedMsg} Clique « Lancer » pour envoyer.`);
      setName('');
      setTemplateName('');
      setVars([]);
      setWorkflowId('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  }

  // Une variable « champ perso » sans clé ou « texte fixe » vide serait rejetée en 400 par le
  // backend : on bloque en amont pour un message clair plutôt qu'une erreur technique.
  const varsComplete = vars.every((v) =>
    v.source === 'field' ? v.key.trim() !== '' : v.source === 'literal' ? v.value.trim() !== '' : true,
  );
  const contentReady = mode === 'workflow' ? workflowId !== '' : (templateName !== '' && varsComplete);
  const canSubmit = phoneNumberId !== '' && name.trim() !== '' && contentReady && selected.size > 0 && !busy;

  return (
    <section className="h-fit rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold tracking-tight text-ink-900">Nouvelle campagne</h2>
      <p className="mt-1 text-xs text-ink-500">Choisis un template approuvé et les contacts, puis lance l&apos;envoi.</p>

      <Field label="Numéro expéditeur">
        {numbers.length === 0 ? (
          <p className="text-xs text-amber-700">Aucun numéro provisionné pour ce tenant.</p>
        ) : (
          <select value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className={inputCls}>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayPhoneNumber ?? n.id} {n.verifiedName ? `(${n.verifiedName})` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>

      {/* 1. Choix des contacts (D'ABORD : la cible est indépendante de ce qu'on envoie) */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-ink-700">Destinataires</label>
          {contacts.length > 0 && (
            <span className="text-xs text-ink-400">{selected.size} / {contacts.length} sélectionnés</span>
          )}
        </div>
        {loadingRefs ? (
          <p className="text-xs text-ink-400">Chargement des contacts...</p>
        ) : contacts.length === 0 ? (
          <p className="text-xs text-amber-700">Aucun contact joignable. Importe des contacts dans l&apos;onglet Contacts.</p>
        ) : (
          <div>
            {allTags.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-ink-400">Tags :</span>
                {allTags.map((t) => (
                  <button
                    type="button"
                    key={t}
                    onClick={() => toggleTag(t)}
                    className={`rounded-full px-2 py-0.5 text-xs transition ${
                      tagFilter.has(t) ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {t}
                  </button>
                ))}
                {tagFilter.size > 0 && (
                  <button type="button" onClick={() => setTagFilter(new Set())} className="text-[11px] text-brand-600 hover:underline">
                    réinitialiser
                  </button>
                )}
              </div>
            )}
            <div className="mb-2 flex items-center gap-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} flex-1`} placeholder="Rechercher (nom, numéro, tag, champ)" />
              <button type="button" onClick={toggleAllFiltered} className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-xs text-ink-600 hover:bg-ink-50">
                {filteredAllSelected ? 'Vider' : 'Tout'}
              </button>
              {(tagFilter.size > 0 || search.trim() !== '') && (
                <button type="button" onClick={() => setSelected(new Set(filteredContacts.map((c) => c.id)))} className="shrink-0 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-2 text-xs font-medium text-brand-700 hover:bg-brand-100">
                  Uniquement ceux-ci
                </button>
              )}
            </div>
            <div className="max-h-48 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
              {filteredContacts.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-ink-50">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleContact(c.id)} className="accent-brand-500" />
                  <span className="truncate text-sm">{c.profileName ?? contactIdentity(c)}</span>
                  {(c.tags ?? []).slice(0, 3).map((t) => (
                    <span key={t} className="shrink-0 rounded bg-brand-50 px-1 text-[10px] text-brand-700">{t}</span>
                  ))}
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-400">{c.phoneE164 ?? <span title="Compte WhatsApp (sans numéro)">{c.bsuid}</span>}</span>
                  {c.optInStatus === 'opted_out' && <span className="shrink-0 rounded bg-red-50 px-1 text-[10px] text-red-600">opt-out</span>}
                </label>
              ))}
              {filteredContacts.length === 0 && <p className="px-2.5 py-2 text-xs text-ink-400">Aucun contact ne correspond.</p>}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{filteredContacts.length} affichés · les contacts opt-out sont ignorés automatiquement pour le marketing.</p>
            {filterActive && selectedOutside > 0 && (
              <p className="mt-1 text-[11px] text-amber-600">
                ⚠️ {selectedOutside} sélectionné(s) hors du filtre partiront aussi. « Uniquement ceux-ci » pour ne cibler que le segment affiché.
              </p>
            )}
          </div>
        )}
      </div>

      {/* 2. Quoi envoyer : un template direct OU un workflow (bot builder) */}
      <div className="mt-4">
        <label className="mb-1 block text-sm font-medium text-ink-700">Que veux-tu leur envoyer ?</label>
        <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
          {([
            { m: 'template', label: 'Un template', tip: 'Privilégiez cela pour l’envoi d’un message simple avec un ou des boutons (CTA) qui pointent vers des URL.' },
            { m: 'workflow', label: 'Un workflow', tip: 'Privilégiez cette méthode pour un scénario : envoi d’un template PUIS d’autres éléments (ajout d’un tag, d’un champ, envoi d’un WhatsApp Flow, ...).' },
          ] as const).map(({ m, label, tip }) => (
            <span key={m} className="group relative">
              <button type="button" onClick={() => setMode(m)} className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>{label}</button>
              <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-64 -translate-x-1/2 rounded-lg bg-ink-900 px-3 py-2 text-xs font-normal leading-snug text-white shadow-lg group-hover:block">{tip}</span>
            </span>
          ))}
        </div>
      </div>

      {mode === 'template' ? (
        <>
          <Field label="Template">
            {loadingRefs ? (
              <p className="text-xs text-ink-400">Chargement des templates...</p>
            ) : templates.length === 0 ? (
              <p className="text-xs text-amber-700">Aucun template approuvé. Crée-en un dans l&apos;onglet Templates et attends la validation Meta.</p>
            ) : (
              <select value={templateName} onChange={(e) => { void chooseTemplate(e.target.value); }} className={inputCls}>
                <option value="">Choisir un template...</option>
                {templates.map((t) => (
                  <option key={`${t.name}-${t.language}`} value={t.name}>
                    {t.name} ({t.language}, {t.category?.toLowerCase()})
                  </option>
                ))}
              </select>
            )}
            {selectedTemplate?.body && (
              <div className="mt-3">
                <WhatsAppPreview body={selectedTemplate.body} examples={previewExamples} buttons={[]} hideNote />
              </div>
            )}
          </Field>

          {vars.length > 0 && (
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium text-ink-700">Variables ({vars.length})</label>
              <div className="space-y-2">
                {vars.map((v, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="w-8 shrink-0 text-xs text-ink-400">{`{{${i + 1}}}`}</span>
                    <select
                      value={v.source}
                      onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, source: e.target.value as VarRow['source'] } : x)))}
                      className={`${inputCls} flex-1`}
                    >
                      <option value="name">Nom du contact</option>
                      <option value="phone">Téléphone</option>
                      <option value="field">Champ perso</option>
                      <option value="literal">Texte fixe</option>
                    </select>
                    {v.source === 'field' && (
                      <input
                        value={v.key}
                        onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                        className={`${inputCls} w-24`}
                        placeholder="clé (ex ville)"
                      />
                    )}
                    {v.source === 'literal' && (
                      <input
                        value={v.value}
                        onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                        className={`${inputCls} w-24`}
                        placeholder="valeur"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <Field label="Catégorie (pour l'opt-in)">
            <select value={category} onChange={(e) => setCategory(e.target.value as 'marketing' | 'utility')} className={inputCls}>
              <option value="marketing">Marketing (opt-in requis)</option>
              <option value="utility">Utility</option>
            </select>
          </Field>
          <Field label="Workflow">
            {workflows.length === 0 ? (
              <p className="text-xs text-amber-700">Aucun workflow. Crée-en un dans le menu « Flow » à gauche.</p>
            ) : (
              <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} className={inputCls}>
                <option value="">Choisir un workflow…</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.graph.nodes.length} bloc{w.graph.nodes.length > 1 ? 's' : ''})</option>
                ))}
              </select>
            )}
          </Field>
        </>
      )}

      {/* 3. Libellé de la campagne */}
      <Field label="Nom de la campagne (interne)">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Promo été" />
      </Field>

      {!varsComplete && <p className="mt-3 text-xs text-amber-600">Complète les valeurs des variables (champ perso / texte fixe).</p>}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {ok && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {busy ? 'Création...' : 'Créer la campagne'}
      </button>
    </section>
  );
}

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-ink-700">{label}</label>
      {children}
    </div>
  );
}
