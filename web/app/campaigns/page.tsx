'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import type { Session } from '@/lib/session';
import { explainMetaError } from '@/lib/meta-errors';
import { fmtCost } from '@/lib/format';
import { useT } from '@/lib/i18n';
import {
  listCampaigns,
  getCampaign,
  listPhoneNumbers,
  createCampaign,
  runCampaign,
  listTemplates,
  listAllContacts,
  listWorkflows,
  listUserFields,
  getTemplateStats,
  getTemplateHints,
  contactIdentity,
  type UserFieldDef,
  type CampaignSummary,
  type CampaignDetail,
  type CampaignCategory,
  type CreateCampaignInput,
  type RecipientCounts,
  type PhoneNumber,
  type PricingSummary,
  type TemplateParam,
  type TemplateSummary,
  type Contact,
  type WorkflowSummary,
  type WorkflowGraph,
  type WorkflowNode,
} from '@/lib/api';
import { SYSTEM_FIELDS, customFieldsOnly, isSystemFieldKey, systemFieldExample } from '@/lib/fields';

/** Coût estimé d'une campagne = envois facturables (counts.sent) × tarif catégorie (Meta). null si tarif
 *  indisponible. Sur-estime l'utility en fenêtre de service gratuite -> à présenter comme « ~ estimé ». */
function estimateCampaignCost(sent: number, category: CampaignCategory, pricing: PricingSummary | null): number | null {
  const rate = pricing?.byCategory[category]?.ratePerMessage;
  return rate == null ? null : sent * rate;
}

export default function CampaignsPage() {
  return <AppShell active="campagnes" fullBleed>{(session) => <CampaignsInner session={session} />}</AppShell>;
}

// Chaque statut porte ses DEUX libellés [fr, en] (résolus au rendu via t) : la const vit hors composant, donc
// useT() y est inappelable -> on fait porter les deux langues à la valeur.
const STATUS: Record<string, { text: [string, string]; cls: string }> = {
  draft: { text: ['brouillon', 'draft'], cls: 'bg-ink-100 text-ink-600' },
  running: { text: ['en cours', 'running'], cls: 'bg-blue-50 text-blue-700' },
  paused: { text: ['en pause', 'paused'], cls: 'bg-amber-50 text-amber-700' },
  completed: { text: ['terminée', 'completed'], cls: 'bg-emerald-50 text-emerald-700' },
  failed: { text: ['échec', 'failed'], cls: 'bg-red-50 text-red-700' },
  pending: { text: ['en attente', 'pending'], cls: 'bg-ink-100 text-ink-600' },
  sending: { text: ['envoi', 'sending'], cls: 'bg-blue-50 text-blue-700' },
  sent: { text: ['envoyé', 'sent'], cls: 'bg-ink-100 text-ink-700' },
  skipped: { text: ['ignoré', 'skipped'], cls: 'bg-amber-50 text-amber-700' },
  // Statuts de livraison Meta
  delivered: { text: ['délivré', 'delivered'], cls: 'bg-blue-50 text-blue-700' },
  read: { text: ['lu', 'read'], cls: 'bg-emerald-50 text-emerald-700' },
};
function Badge({ status }: { status: string }) {
  const t = useT();
  const s = STATUS[status] ?? { text: [status, status] as [string, string], cls: 'bg-ink-100 text-ink-600' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{t(...s.text)}</span>;
}

function CampaignsInner({ session }: { session: Session }) {
  const t = useT();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  // Un lancement inline (étape 2) est en cours dans CreateForm -> on gèle le retour liste (remonté par callback).
  const [createBusy, setCreateBusy] = useState(false);
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
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDetail(id: string) {
    try {
      setDetail(await getCampaign(session.tenantId, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Détail indisponible', 'Detail unavailable'));
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
      setError(err instanceof Error ? err.message : t('Lancement impossible', 'Launch failed'));
    } finally {
      setPolling(false);
    }
  }

  // Écran de création (ouvert via « Ajouter une campagne »). Pleine largeur : fullBleed retire le padding et
  // impose overflow-hidden sur <main>, donc on gère ici notre propre scroll et notre propre padding.
  if (mode === 'create') {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        {/* Retour désactivé pendant un lancement en cours (createBusy) : on n'invite pas à quitter l'écran
            au milieu du mini-polling. */}
        <button onClick={() => setMode('list')} disabled={createBusy} className="mb-4 flex items-center gap-1 text-sm text-brand-600 hover:underline disabled:opacity-40">
          ← {t('Retour aux campagnes', 'Back to campaigns')}
        </button>
        <CreateForm
          tenantId={session.tenantId}
          numbers={numbers}
          onBusyChange={setCreateBusy}
          onCreated={() => { void reload(); setMode('list'); }}
        />
      </div>
    );
  }

  // Écran par défaut : dashboard de suivi des campagnes. Même conteneur scrollable pleine largeur que la création.
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Campagnes', 'Campaigns')} ({campaigns.length})</h2>
          {pricing ? (
            <p className="mt-0.5 text-xs text-ink-500">
              {t('coût estimé total', 'estimated total cost')} ≈ <span className="font-semibold text-ink-800">{fmtCost(campaigns.reduce((acc, c) => acc + (estimateCampaignCost(c.counts.sent, c.category, pricing) ?? 0), 0))}</span> <span className="text-ink-400">({t('devise du compte', 'account currency')})</span>
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-ink-400">{t('coût estimé indisponible (tarif Meta)', 'estimated cost unavailable (Meta pricing)')}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {polling ? (
            <span className="flex items-center gap-1.5 text-xs text-ink-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              {t('actualisation...', 'refreshing...')}
            </span>
          ) : (
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
          )}
          <button
            onClick={() => { setDetail(null); setMode('create'); }}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            + {t('Ajouter une campagne', 'Add a campaign')}
          </button>
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
          {t('Aucune campagne. Clique « + Ajouter une campagne » pour en créer une.', 'No campaigns. Click "+ Add a campaign" to create one.')}
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
                      template {c.templateName} ({c.templateLanguage}) · {c.counts.total} {t('destinataires', 'recipients')}
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                      <b className="text-emerald-700">{c.counts.sent}</b> {t('envoyés', 'sent')}
                      {c.counts.failed > 0 && <> · <b className="text-red-700">{c.counts.failed}</b> {t('échecs', 'failures')}</>}
                      {c.counts.pending > 0 && <> · {c.counts.pending} {t('en attente', 'pending')}</>}
                      {c.counts.skipped > 0 && <> · {c.counts.skipped} {t('ignorés', 'skipped')}</>}
                    </p>
                    {(() => {
                      const cost = estimateCampaignCost(c.counts.sent, c.category, pricing);
                      return (
                        <p className="mt-1 text-xs text-ink-400">
                          {t('coût estimé', 'estimated cost')} {cost != null ? <>≈ <span className="font-medium text-ink-700">{fmtCost(cost)}</span> ({t('devise du compte', 'account currency')})</> : t('indisponible', 'unavailable')}
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
                        {c.status === 'paused' ? t('Reprendre', 'Resume') : t('Lancer', 'Launch')}
                      </button>
                    )}
                    <button
                      onClick={() => (detail?.id === c.id ? setDetail(null) : openDetail(c.id))}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {detail?.id === c.id ? t('Masquer', 'Hide') : t('Détails', 'Details')}
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
    </div>
  );
}

function DetailPanel({ detail, pricing, onClose }: { detail: CampaignDetail; pricing: PricingSummary | null; onClose: () => void }) {
  const t = useT();
  const cost = estimateCampaignCost(detail.counts.sent, detail.category, pricing);
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{detail.name}</span>
          <Badge status={detail.status} />
          <span className="text-xs text-ink-400">{t('coût estimé', 'estimated cost')} {cost != null ? `≈ ${fmtCost(cost)} (${t('devise du compte', 'account currency')})` : t('indisponible', 'unavailable')}</span>
        </div>
        <button onClick={onClose} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
      </div>
      {detail.recipients.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-500">{t('Aucun destinataire.', 'No recipients.')}</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">{t('Destinataire', 'Recipient')}</th>
              <th className="px-4 py-2 font-medium">{t('Envoi', 'Sending')}</th>
              <th className="px-4 py-2 font-medium">{t('Livraison', 'Delivery')}</th>
              <th className="px-4 py-2 font-medium">{t('Détail', 'Detail')}</th>
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
  /** Option choisie dans le sélecteur : 'sys:<key>' (champ de base), 'field:<key>' (champ perso), ou 'literal'. */
  sel: string;
  /** Valeur saisie (uniquement pour 'literal'). */
  value: string;
}

/** Option choisie -> ParamSource envoyée au backend. */
function selToSource(sel: string, value: string): TemplateParam['source'] {
  if (sel === 'literal') return { type: 'literal', value };
  if (sel.startsWith('sys:')) {
    const f = SYSTEM_FIELDS.find((s) => `sys:${s.key}` === sel);
    return f ? f.source : { type: 'attribute', key: 'name' };
  }
  return { type: 'field', key: sel.slice('field:'.length) };
}

/** ParamSource (indice de template stocké) -> option à présélectionner. `customFields` = les champs perso RÉELS :
 *  un indice vers un champ inexistant (ex. indice périmé « nom » d'un champ supprimé) retombe sur « Nom » : sinon
 *  le `<select>` afficherait la 1re option (« Nom ») tout en gardant en interne un `sel` fantôme qui saute le contact. */
function selForSource(s: TemplateParam['source'], customFields: UserFieldDef[]): string {
  if (s.type === 'literal') return 'literal';
  if (s.type === 'attribute') return `sys:${s.key ?? 'name'}`;
  const key = s.key ?? '';
  if (isSystemFieldKey(key)) return `sys:${key}`; // prenom/email = champ système
  return customFields.some((f) => f.key === key) ? `field:${key}` : 'sys:name';
}

/** Bloc d'entrée d'un workflow = un bloc SANS arête entrante (défaut : le 1er bloc). null si vide.
 *  Miroir de `entryNode` côté serveur : sert à vérifier que le workflow commence par un envoi de template. */
function entryNodeOf(graph: WorkflowGraph): WorkflowNode | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  return graph.nodes.find((nn) => !hasIncoming.has(nn.id)) ?? graph.nodes[0] ?? null;
}

function CreateForm({ tenantId, numbers, onCreated, onBusyChange }: { tenantId: string; numbers: PhoneNumber[]; onCreated: () => void; onBusyChange?: (busy: boolean) => void }) {
  const t = useT();
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
  // Message bloquant si le 1er bloc du workflow choisi n'est pas un envoi de template (pas de cible au mapping).
  const [wfError, setWfError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Lancement rapatrié sur l'écran (étape 2) : idle -> creating -> launching (avec polling inline) -> done|error.
  const [launch, setLaunch] = useState<{
    phase: 'idle' | 'creating' | 'launching' | 'done' | 'error';
    campaignId?: string;
    detail?: CampaignDetail;
    message?: string;
  }>({ phase: 'idle' });
  // Anti-course : ne pas appliquer les indices d'un template si l'utilisateur en a choisi un autre entre-temps.
  const chooseSeq = useRef(0);
  // Garde de démontage : le mini-polling du lancement est une boucle async hors cycle React -> on l'arrête si
  // l'utilisateur quitte l'écran (retour liste) pour ne pas continuer à fetch/setState sur un composant démonté.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Templates approuvés + contacts + champs perso (chargés une fois, indépendamment du polling des campagnes).
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
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
        const [t, c, w, uf] = await Promise.all([listTemplates(tenantId), listAllContacts(tenantId), listWorkflows(tenantId), listUserFields(tenantId)]);
        if (!alive) return;
        setTemplates(t.templates.filter((x) => x.status === 'APPROVED'));
        setWorkflows(w.workflows);
        setUserFields(uf.fields);
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

  const selectedTemplate = templates.find((tpl) => tpl.name === templateName);
  // Valeurs d'aperçu par variable (échantillon lisible selon le mapping) pour la miniature WhatsApp.
  const previewExamples = vars.map((v) =>
    v.sel === 'literal' ? (v.value.trim() || '…')
      : v.sel.startsWith('sys:') ? systemFieldExample(v.sel.slice('sys:'.length))
      : `[${v.sel.slice('field:'.length) || 'champ'}]`,
  );

  // Charge les variables d'un template (corps -> nb de {{n}}) et pré-remplit chaque ligne via les indices posés au
  // design (hints). Réutilisé par le mode template DIRECT et par le 1er template d'un workflow. Ne touche NI la
  // catégorie NI le nom de campagne (le workflow choisit sa catégorie à part).
  async function loadTemplateVars(nm: string, language: string) {
    const tpl = templates.find((x) => x.name === nm);
    const n = new Set((tpl?.body ?? '').match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
    // Défaut immédiat : chaque variable -> Nom. On affine ensuite avec les indices posés à la création du template.
    setVars(Array.from({ length: n }, () => ({ sel: 'sys:name', value: '' })));
    if (n === 0) return;
    const seq = ++chooseSeq.current;
    try {
      const { hints } = await getTemplateHints(tenantId, nm, language);
      if (seq !== chooseSeq.current) return; // un autre template/workflow a été choisi entre-temps
      if (hints.length === 0) return;
      setVars((prev) => {
        if (prev.length !== n) return prev;
        const rows = [...prev];
        for (const h of hints) {
          const i = h.position - 1;
          if (i < 0 || i >= n) continue;
          rows[i] = { sel: selForSource(h.source, userFields), value: h.source.type === 'literal' ? (h.source.value ?? '') : '' };
        }
        return rows;
      });
    } catch { /* pas d'indices -> on garde le défaut */ }
  }

  async function chooseTemplate(nm: string) {
    setTemplateName(nm);
    const tpl = templates.find((x) => x.name === nm);
    if (!tpl) { setVars([]); return; }
    setTemplateLanguage(tpl.language);
    setCategory((tpl.category ?? '').toUpperCase() === 'MARKETING' ? 'marketing' : 'utility');
    if (name.trim() === '') setName(nm);
    await loadTemplateVars(nm, tpl.language);
  }

  // Choix d'un workflow : on VÉRIFIE que le 1er bloc est un envoi de template (sinon le mapping n'a pas de cible ->
  // message bloquant, comme côté serveur), puis on remonte ce template + ses variables dans le MÊME sélecteur que
  // le mode direct. Le mapping collecté part avec la campagne (résolu par contact, contacts sans la valeur sautés).
  async function chooseWorkflow(id: string) {
    setWorkflowId(id);
    setWfError(null);
    setTemplateName('');
    setVars([]);
    if (id === '') return;
    const wf = workflows.find((w) => w.id === id);
    if (!wf) return;
    const entry = entryNodeOf(wf.graph);
    const tplName = entry && entry.type === 'template' ? String(entry.data.templateName ?? '').trim() : '';
    if (!entry || entry.type !== 'template' || tplName === '') {
      setWfError(t('Le workflow doit commencer par un envoi de template.', 'The scenario must start by sending a template.'));
      return;
    }
    const language = String(entry.data.language ?? 'fr');
    setTemplateName(tplName);
    setTemplateLanguage(language);
    await loadTemplateVars(tplName, language);
  }

  // Bascule template <-> workflow : on repart d'un état propre (variables/erreurs/choix précédents) pour ne pas
  // mélanger le mapping d'un template direct avec celui du 1er template d'un workflow.
  function chooseMode(m: 'template' | 'workflow') {
    setMode(m);
    setWfError(null);
    setVars([]);
    setTemplateName('');
    setWorkflowId('');
  }

  // Tous les tags présents (pour les filtres). Requête = filtre par tag(s) + recherche texte
  // élargie (nom, numéro, tags ET valeurs des champs perso).
  const allTags = [...new Set(contacts.flatMap((c) => c.tags ?? []))].sort();
  const filteredContacts = contacts.filter((c) => {
    if (tagFilter.size > 0 && !(c.tags ?? []).some((tag) => tagFilter.has(tag))) return false;
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
  function toggleTag(tag: string) {
    setTagFilter((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });
  }

  function toParamMapping(): TemplateParam[] {
    return vars.map((v, i) => ({ position: i + 1, source: selToSource(v.sel, v.value) }));
  }

  // Payload de création partagé par le brouillon (submit) et le lancement direct (createAndLaunch).
  function buildCreateInput(): CreateCampaignInput {
    return mode === 'workflow'
      ? { phoneNumberId, name, category, workflowId, paramMapping: toParamMapping(), contactIds: [...selected] }
      : { phoneNumberId, name, category, templateName, templateLanguage, paramMapping: toParamMapping(), contactIds: [...selected] };
  }

  // Remise à zéro pour « Nouvelle campagne » après un lancement réussi (sans quitter l'écran de création).
  function resetForm() {
    setName('');
    setTemplateName('');
    setVars([]);
    setWorkflowId('');
    setWfError(null);
    setError(null);
    setOk(null);
    setLaunch({ phase: 'idle' });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = TOUS sautés (la variable du template n'a aucune valeur sur les fiches choisies) : la campagne
      // serait vide et « Lancer » n'enverrait à personne. Avertissement ROUGE + on RESTE sur le formulaire (pas de
      // navigation, pas de reset) pour corriger la source de la variable ou les fiches. Cf. bug « ça n'envoie à personne ».
      if (res.recipientCount === 0) {
        setError(t(
          `Aucun destinataire : les ${res.skipped.length} contact(s) sélectionné(s) ont été sautés car la variable du template n'a pas de valeur sur leur fiche. Choisis une autre source pour la variable (ex. « Nom ») ou complète les fiches.`,
          `No recipients: the ${res.skipped.length} selected contact(s) were skipped because the template variable has no value on their record. Choose another source for the variable (e.g. "Name") or complete the records.`,
        ));
        return; // le finally remet busy à false
      }
      // Avertissement : contacts sautés faute d'une variable de template (ex. prénom absent de la fiche). L'envoi part
      // quand même aux valides ; ces contacts-là auraient fait échouer Meta -> on les écarte et on le dit.
      const skippedMsg = res.skipped.length > 0
        ? t(
            ` ${res.skipped.length} contact(s) sautés (variable de template manquante, ex. prénom absent de la fiche).`,
            ` ${res.skipped.length} contact(s) skipped (missing template variable, e.g. first name absent from the record).`,
          )
        : '';
      setOk(t(
        `Campagne créée : ${res.recipientCount} destinataire(s).${skippedMsg} Clique « Lancer » pour envoyer.`,
        `Campaign created: ${res.recipientCount} recipient(s).${skippedMsg} Click "Launch" to send.`,
      ));
      setName('');
      setTemplateName('');
      setVars([]);
      setWorkflowId('');
      setWfError(null);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  // Créer PUIS lancer sur place (étape 2), sans repasser par la liste. Mini-polling inline (6 tours / 2s) pour
  // voir les statuts évoluer, comme CampaignsInner.run(). L'utilisateur reste sur l'écran pour voir le résultat.
  async function createAndLaunch() {
    setError(null);
    setOk(null);
    setLaunch({ phase: 'creating' });
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = tous sautés : même avertissement ROUGE que le brouillon, on NE lance PAS et on reste.
      if (res.recipientCount === 0) {
        setError(t(
          `Aucun destinataire : les ${res.skipped.length} contact(s) sélectionné(s) ont été sautés car la variable du template n'a pas de valeur sur leur fiche. Choisis une autre source pour la variable (ex. « Nom ») ou complète les fiches.`,
          `No recipients: the ${res.skipped.length} selected contact(s) were skipped because the template variable has no value on their record. Choose another source for the variable (e.g. "Name") or complete the records.`,
        ));
        setLaunch({ phase: 'idle' });
        return;
      }
      setLaunch({ phase: 'launching', campaignId: res.campaignId });
      await runCampaign(res.campaignId);
      let detail: CampaignDetail | undefined;
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!mountedRef.current) return; // écran quitté pendant le polling -> on cesse tout (fetch + setState)
        detail = await getCampaign(tenantId, res.campaignId);
        if (!mountedRef.current) return;
        setLaunch({ phase: 'launching', campaignId: res.campaignId, detail });
      }
      const sent = detail?.counts.sent ?? 0;
      const failed = detail?.counts.failed ?? 0;
      setLaunch({
        phase: 'done',
        campaignId: res.campaignId,
        detail,
        message: t(`Campagne lancée : ${sent} envoyés / ${failed} échecs.`, `Campaign launched: ${sent} sent / ${failed} failures.`),
      });
    } catch (err) {
      setLaunch({ phase: 'error', message: err instanceof Error ? err.message : t('Lancement impossible', 'Launch failed') });
    }
  }

  // Le sélecteur garantit une source valide (champ de base ou champ perso réel) : seul « Texte fixe » exige
  // une valeur saisie. On bloque l'envoi tant qu'un texte fixe est vide (sinon 400 côté backend).
  const varsComplete = vars.every((v) => (v.sel === 'literal' ? v.value.trim() !== '' : true));
  // Workflow : prêt si un workflow valide est choisi (1er bloc = template, donc pas de wfError) ET le mapping de ses
  // variables est complet. Le 1er template sans variable a vars=[] -> varsComplete=true.
  const contentReady = mode === 'workflow'
    ? (workflowId !== '' && wfError === null && varsComplete)
    : (templateName !== '' && varsComplete);
  // Étape 1 prête = ce qui active l'étape 2 (indépendant du busy/launch en cours).
  const step1Ready = phoneNumberId !== '' && name.trim() !== '' && contentReady && selected.size > 0;
  const canSubmit = step1Ready && !busy;
  // Lancement en cours (création + polling) : verrouille les boutons des deux étapes.
  const launching = launch.phase === 'creating' || launch.phase === 'launching';
  // Remonte l'état « lancement en cours » au parent (fige le retour liste pendant creating/launching).
  useEffect(() => { onBusyChange?.(launching); }, [launching, onBusyChange]);

  return (
    <div className="space-y-6">
      {/* ÉTAPE 1 : Préparation : nom + les 3 zones existantes (contenu inchangé, juste déplacé ici). */}
      <section className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Étape 1', 'Step 1')}</p>
        <h2 className="mt-0.5 text-base font-semibold tracking-tight text-ink-900">{t('Préparation', 'Preparation')}</h2>
        <p className="mt-1 text-xs text-ink-500">{t('Choisis un template approuvé et les contacts.', 'Choose an approved template and contacts.')}</p>

      {/* Nom de la campagne : au-dessus des 3 zones */}
      <div className="mt-4">
        <label className="mb-1 block text-sm font-medium text-ink-700">{t('Nom de la campagne (interne)', 'Campaign name (internal)')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} max-w-md`} placeholder={t('Promo été', 'Summer promo')} />
      </div>

      {/* 3 zones côte à côte (empilées sur mobile) : Expéditeur | Destinataires | Message. Grille élargie en xl
          car l'écran est désormais pleine largeur. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)]">
        {/* ZONE 1 : Expéditeur (un seul numéro en général) */}
        <div className="rounded-xl border border-ink-200 bg-ink-50/30 p-4">
          <h3 className="text-sm font-semibold text-ink-800">{t('Expéditeur', 'Sender')}</h3>
          <div className="mt-2">
            {numbers.length === 0 ? (
              <p className="text-xs text-amber-700">{t('Aucun numéro provisionné pour ce tenant.', 'No number provisioned for this tenant.')}</p>
            ) : numbers.length === 1 ? (
              <div className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-800">
                <div className="font-medium">{numbers[0]!.displayPhoneNumber ?? numbers[0]!.id}</div>
                {numbers[0]!.verifiedName && <div className="text-xs text-ink-400">{numbers[0]!.verifiedName}</div>}
              </div>
            ) : (
              <select value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className={inputCls}>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.displayPhoneNumber ?? n.id} {n.verifiedName ? `(${n.verifiedName})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* ZONE 2 : Destinataires */}
        <div className="rounded-xl border border-ink-200 p-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-ink-700">{t('Destinataires', 'Recipients')}</label>
          {contacts.length > 0 && (
            <span className="text-xs text-ink-400">{selected.size} / {contacts.length} {t('sélectionnés', 'selected')}</span>
          )}
        </div>
        {loadingRefs ? (
          <p className="text-xs text-ink-400">{t('Chargement des contacts...', 'Loading contacts...')}</p>
        ) : contacts.length === 0 ? (
          <p className="text-xs text-amber-700">{t("Aucun contact joignable. Importe des contacts dans l'onglet Contacts.", 'No reachable contact. Import contacts in the Contacts tab.')}</p>
        ) : (
          <div>
            {allTags.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-ink-400">{t('Tags :', 'Tags:')}</span>
                {allTags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={`rounded-full px-2 py-0.5 text-xs transition ${
                      tagFilter.has(tag) ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
                {tagFilter.size > 0 && (
                  <button type="button" onClick={() => setTagFilter(new Set())} className="text-[11px] text-brand-600 hover:underline">
                    {t('réinitialiser', 'reset')}
                  </button>
                )}
              </div>
            )}
            <div className="mb-2 flex items-center gap-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} flex-1`} placeholder={t('Rechercher (nom, numéro, tag, champ)', 'Search (name, number, tag, field)')} />
              <button type="button" onClick={toggleAllFiltered} className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-xs text-ink-600 hover:bg-ink-50">
                {filteredAllSelected ? t('Vider', 'Clear') : t('Tout', 'All')}
              </button>
              {(tagFilter.size > 0 || search.trim() !== '') && (
                <button type="button" onClick={() => setSelected(new Set(filteredContacts.map((c) => c.id)))} className="shrink-0 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-2 text-xs font-medium text-brand-700 hover:bg-brand-100">
                  {t('Uniquement ceux-ci', 'Only these')}
                </button>
              )}
            </div>
            <div className="max-h-[22rem] divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
              {filteredContacts.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-ink-50">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleContact(c.id)} className="accent-brand-500" />
                  <span className="truncate text-sm">{c.profileName ?? contactIdentity(c)}</span>
                  {(c.tags ?? []).slice(0, 3).map((tag) => (
                    <span key={tag} className="shrink-0 rounded bg-brand-50 px-1 text-[10px] text-brand-700">{tag}</span>
                  ))}
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-400">{c.phoneE164 ?? <span title={t('Compte WhatsApp (sans numéro)', 'WhatsApp account (no number)')}>{c.bsuid}</span>}</span>
                  {c.optInStatus === 'opted_out' && <span className="shrink-0 rounded bg-red-50 px-1 text-[10px] text-red-600">opt-out</span>}
                </label>
              ))}
              {filteredContacts.length === 0 && <p className="px-2.5 py-2 text-xs text-ink-400">{t('Aucun contact ne correspond.', 'No matching contact.')}</p>}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{filteredContacts.length} {t('affichés · les contacts opt-out sont ignorés automatiquement pour le marketing.', 'shown · opted-out contacts are automatically skipped for marketing.')}</p>
            {filterActive && selectedOutside > 0 && (
              <p className="mt-1 text-[11px] text-amber-600">
                ⚠️ {selectedOutside} {t('sélectionné(s) hors du filtre partiront aussi. « Uniquement ceux-ci » pour ne cibler que le segment affiché.', 'selected outside the filter will also be sent. Use "Only these" to target only the shown segment.')}
              </p>
            )}
          </div>
        )}
      </div>

        {/* ZONE 3 : Message : un template direct OU un scénario (bot builder) */}
        <div className="rounded-xl border border-ink-200 p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink-800">{t('Message', 'Message')}</h3>
          <div className="mt-1">
        <label className="mb-1 block text-sm font-medium text-ink-700">{t('Que veux-tu leur envoyer ?', 'What do you want to send them?')}</label>
        <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
          {([
            { m: 'template', label: t('Un template', 'A template'), tip: t('Privilégiez cela pour l’envoi d’un message simple avec un ou des boutons (CTA) qui pointent vers des URL.', 'Best for sending a simple message with one or more buttons (CTA) that point to URLs.') },
            { m: 'workflow', label: t('Un scénario', 'A scenario'), tip: t('Privilégiez cette méthode pour enchaîner plusieurs étapes : envoi d’un template PUIS d’autres éléments (ajout d’un tag, d’un champ, envoi d’un formulaire, ...).', 'Best for chaining several steps: sending a template THEN other elements (adding a tag, a field, sending a form, ...).') },
          ] as const).map(({ m, label, tip }) => (
            <span key={m} className="group relative">
              <button type="button" onClick={() => chooseMode(m)} className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>{label}</button>
              <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-64 -translate-x-1/2 rounded-lg bg-ink-900 px-3 py-2 text-xs font-normal leading-snug text-white shadow-lg group-hover:block">{tip}</span>
            </span>
          ))}
        </div>
      </div>

      {mode === 'template' ? (
        <>
          <Field label={t('Template', 'Template')}>
            {loadingRefs ? (
              <p className="text-xs text-ink-400">{t('Chargement des templates...', 'Loading templates...')}</p>
            ) : templates.length === 0 ? (
              <p className="text-xs text-amber-700">{t("Aucun template approuvé. Crée-en un dans l'onglet Templates et attends la validation Meta.", 'No approved template. Create one in the Templates tab and wait for Meta approval.')}</p>
            ) : (
              <select value={templateName} onChange={(e) => { void chooseTemplate(e.target.value); }} className={inputCls}>
                <option value="">{t('Choisir un template...', 'Choose a template...')}</option>
                {templates.map((tpl) => (
                  <option key={`${tpl.name}-${tpl.language}`} value={tpl.name}>
                    {tpl.name} ({tpl.language}, {tpl.category?.toLowerCase()})
                  </option>
                ))}
              </select>
            )}
            {selectedTemplate?.body && (
              <div className="mt-3">
                <WhatsAppPreview body={selectedTemplate.body} examples={previewExamples} buttons={selectedTemplate?.buttons ?? []} hideNote />
              </div>
            )}
          </Field>

          <VarsEditor vars={vars} setVars={setVars} fields={userFields} />
        </>
      ) : (
        <>
          <Field label={t("Catégorie (pour l'opt-in)", 'Category (for opt-in)')}>
            <select value={category} onChange={(e) => setCategory(e.target.value as 'marketing' | 'utility')} className={inputCls}>
              <option value="marketing">{t('Marketing (opt-in requis)', 'Marketing (opt-in required)')}</option>
              <option value="utility">{t('Utility', 'Utility')}</option>
            </select>
          </Field>
          <Field label={t('Scénario', 'Scenario')}>
            {workflows.length === 0 ? (
              <p className="text-xs text-amber-700">{t('Aucun scénario. Crée-en un dans le menu « Scénario » à gauche.', 'No scenario. Create one from the "Scenario" menu on the left.')}</p>
            ) : (
              <select value={workflowId} onChange={(e) => { void chooseWorkflow(e.target.value); }} className={inputCls}>
                <option value="">{t('Choisir un scénario…', 'Choose a scenario…')}</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.graph.nodes.length} {w.graph.nodes.length > 1 ? t('blocs', 'blocks') : t('bloc', 'block')})</option>
                ))}
              </select>
            )}
            {/* Le 1er bloc du workflow doit être un envoi de template : c'est lui qui porte les variables à associer. */}
            {wfError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{wfError}</p>}
            {!wfError && selectedTemplate?.body && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-ink-500">{t('1er template envoyé par le scénario :', 'First template sent by the scenario:')} <b>{templateName}</b></p>
                <WhatsAppPreview body={selectedTemplate.body} examples={previewExamples} buttons={selectedTemplate?.buttons ?? []} hideNote />
              </div>
            )}
          </Field>

          {/* Association des variables du 1er template du scénario (même sélecteur que pour un template direct). */}
          {!wfError && <VarsEditor vars={vars} setVars={setVars} fields={userFields} />}
        </>
      )}
        </div>
      </div>

      {/* Avertissements de préparation : restent en bas de l'étape 1 (variables incomplètes, erreur de création). */}
      {!varsComplete && <p className="mt-3 text-xs text-amber-600">{t('Complète les valeurs des variables (champ perso / texte fixe).', 'Complete the variable values (custom field / fixed text).')}</p>}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </section>

      {/* ÉTAPE 2 (Lancement) : grisée tant que l'étape 1 n'est pas prête. Le lancement « maintenant » s'exécute ici. */}
      <section className={`rounded-2xl border border-ink-200 bg-white p-6 shadow-sm transition ${step1Ready ? '' : 'opacity-60'}`} aria-disabled={!step1Ready}>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Étape 2', 'Step 2')}</p>
        <h2 className="mt-0.5 text-base font-semibold tracking-tight text-ink-900">{t('Lancement', 'Launch')}</h2>

        {!step1Ready ? (
          <p className="mt-1 text-xs text-ink-500">{t("Complète l'étape 1 pour activer le lancement.", 'Complete step 1 to enable launching.')}</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-700">{t(`Prêt à lancer à ${selected.size} destinataire(s).`, `Ready to launch to ${selected.size} recipient(s).`)}</p>

            {/* Timing : une seule option pour l'instant. Le calendrier et le slider de débit arrivent en phases suivantes. */}
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Quand ?', 'When?')}</label>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700">{t('Maintenant', 'Now')}</span>
                <span className="cursor-not-allowed rounded-lg border border-dashed border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-400" title={t('Bientôt disponible', 'Coming soon')}>
                  {t('Planifier plus tard (bientôt)', 'Schedule for later (soon)')}
                </span>
              </div>
            </div>

            {/* Progression / résultat du lancement inline (compteurs rafraîchis par le polling). */}
            {launch.phase !== 'idle' && (
              <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50/40 p-4 text-sm">
                {launch.phase === 'creating' && <p className="text-ink-600">{t('Création de la campagne...', 'Creating the campaign...')}</p>}
                {launch.phase === 'launching' && (
                  <div>
                    <div className="flex items-center gap-1.5 text-ink-600">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                      {t('Envoi en cours...', 'Sending...')}
                    </div>
                    {launch.detail && <LaunchCounts counts={launch.detail.counts} />}
                  </div>
                )}
                {launch.phase === 'done' && (
                  <div>
                    <p className="font-medium text-emerald-800">{launch.message}</p>
                    {launch.detail && <LaunchCounts counts={launch.detail.counts} />}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => onCreated()}
                        className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
                      >
                        {t('Voir dans les campagnes', 'View in campaigns')}
                      </button>
                      <button
                        type="button"
                        onClick={resetForm}
                        className="rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                      >
                        {t('Nouvelle campagne', 'New campaign')}
                      </button>
                    </div>
                  </div>
                )}
                {launch.phase === 'error' && <p className="text-red-700">{launch.message}</p>}
              </div>
            )}

            {/* Boutons d'action : masqués une fois le lancement terminé (les boutons de suite prennent le relais). */}
            {launch.phase !== 'done' && (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={createAndLaunch}
                  disabled={!canSubmit || launching}
                  className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {launch.phase === 'creating' ? t('Création...', 'Creating...') : launch.phase === 'launching' ? t('Lancement...', 'Launching...') : t('Créer et lancer', 'Create and launch')}
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSubmit || launching}
                  className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
                >
                  {busy ? t('Création...', 'Creating...') : t('Créer le brouillon (lancer plus tard)', 'Create draft (launch later)')}
                </button>
              </div>
            )}
            {ok && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}
          </>
        )}
      </section>
    </div>
  );
}

/** Compteurs sent/failed/pending/skipped du lancement inline (étape 2). Réutilise le même style que la liste. */
function LaunchCounts({ counts }: { counts: RecipientCounts }) {
  const t = useT();
  return (
    <p className="mt-2 text-xs text-ink-600">
      <b className="text-emerald-700">{counts.sent}</b> {t('envoyés', 'sent')}
      {counts.failed > 0 && <> · <b className="text-red-700">{counts.failed}</b> {t('échecs', 'failures')}</>}
      {counts.pending > 0 && <> · {counts.pending} {t('en attente', 'pending')}</>}
      {counts.skipped > 0 && <> · {counts.skipped} {t('ignorés', 'skipped')}</>}
    </p>
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

/** Sélecteur d'association des variables d'un template : chaque variable pointe vers un champ de BASE (Nom, Prénom,
 *  Téléphone, BSUID, WhatsApp ID, Email), un CHAMP PERSO réel (Contenu > Champs) ou un TEXTE FIXE. Plus de clé tapée
 *  à la main -> plus de mapping vers un champ inexistant. Partagé par le mode template direct et le 1er template d'un
 *  workflow. Rien à afficher si le template n'a pas de variable. */
function VarsEditor({ vars, setVars, fields }: { vars: VarRow[]; setVars: React.Dispatch<React.SetStateAction<VarRow[]>>; fields: UserFieldDef[] }) {
  const t = useT();
  if (vars.length === 0) return null;
  const custom = customFieldsOnly(fields);
  // Ids d'options valides : sert de filet -> si un `sel` n'y est pas (ex. champ perso supprimé), on l'affiche
  // explicitement (« à re-sélectionner ») au lieu de laisser le <select> montrer la 1re option en douce.
  const validIds = new Set<string>([...SYSTEM_FIELDS.map((f) => `sys:${f.key}`), ...custom.map((f) => `field:${f.key}`), 'literal']);
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-ink-700">{t('Variables', 'Variables')} ({vars.length})</label>
      <div className="space-y-2">
        {vars.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-8 shrink-0 text-xs text-ink-400">{`{{${i + 1}}}`}</span>
            <select
              value={v.sel}
              onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, sel: e.target.value } : x)))}
              className={`${inputCls} flex-1`}
            >
              {!validIds.has(v.sel) && <option value={v.sel}>{t('⚠ champ à re-sélectionner', '⚠ field to re-select')}</option>}
              <optgroup label={t('Champs de base', 'Base fields')}>
                {SYSTEM_FIELDS.map((f) => <option key={f.key} value={`sys:${f.key}`}>{f.label}</option>)}
              </optgroup>
              {custom.length > 0 && (
                <optgroup label={t('Mes champs', 'My fields')}>
                  {custom.map((f) => <option key={f.key} value={`field:${f.key}`}>{f.label}</option>)}
                </optgroup>
              )}
              <optgroup label={t('Autre', 'Other')}>
                <option value="literal">{t('Texte fixe', 'Fixed text')}</option>
              </optgroup>
            </select>
            {v.sel === 'literal' && (
              <input
                value={v.value}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                className={`${inputCls} w-32`}
                placeholder={t('valeur', 'value')}
              />
            )}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-ink-400">
        {t("D'où vient chaque variable. « Mes champs » = tes champs de Contenu > Champs. Un contact sans la valeur choisie est sauté (et signalé).", 'Where each variable comes from. "My fields" = your fields from Content > Fields. A contact without the chosen value is skipped (and flagged).')}
      </p>
    </div>
  );
}
