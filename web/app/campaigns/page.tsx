'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { CsvImport } from '@/components/CsvImport';
import { HubspotListImport } from '@/components/HubspotListImport';
import { TemplateForm, type CreatedTemplate } from '@/components/TemplateForm';
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
  cancelSchedule,
  archiveCampaign,
  unarchiveCampaign,
  deleteCampaign,
  listTemplates,
  listWorkflows,
  listUserFields,
  listTags,
  getSettings,
  queryContacts,
  countContacts,
  contactIdsForFilters,
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
  type ImportReport,
  type ContactFilters,
  type ContactFieldFilter,
  type TagCount,
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
  scheduled: { text: ['planifiée', 'scheduled'], cls: 'bg-violet-50 text-violet-700' },
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
  // Corbeille : la liste montre SOIT les campagnes actives SOIT les archivées, jamais les deux mélangées.
  const [showArchived, setShowArchived] = useState(false);
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
      const [c, n] = await Promise.all([
        listCampaigns(session.tenantId, { archived: showArchived }),
        listPhoneNumbers(session.tenantId),
      ]);
      setCampaigns(c.campaigns);
      setNumbers(n.phoneNumbers);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, showArchived, t]);

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

  // Annule la programmation d'une campagne « scheduled » : elle repasse en brouillon côté backend, puis on
  // rafraîchit la liste pour refléter le nouveau statut.
  async function cancelSched(id: string) {
    setError(null);
    try {
      await cancelSchedule(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Annulation impossible', 'Cancellation failed'));
    }
  }

  // Sort la campagne de la liste courante : son panneau de détail ouvert n'a plus de ligne à laquelle se
  // rattacher, on le referme d'abord pour ne pas laisser un détail orphelin à l'écran.
  async function mutateAndReload(id: string, action: () => Promise<unknown>, failure: string) {
    setError(null);
    try {
      await action();
      if (detail?.id === id) setDetail(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    }
  }

  async function archive(id: string) {
    await mutateAndReload(id, () => archiveCampaign(session.tenantId, id), t('Archivage impossible', 'Archiving failed'));
  }
  async function unarchive(id: string) {
    await mutateAndReload(id, () => unarchiveCampaign(session.tenantId, id), t('Restauration impossible', 'Restore failed'));
  }
  async function remove(c: CampaignSummary) {
    const ok = window.confirm(t(
      `Supprimer définitivement « ${c.name} » ? Cette campagne n'a jamais rien envoyé, elle sera effacée pour de bon.`,
      `Permanently delete “${c.name}”? This campaign never sent anything, it will be erased for good.`,
    ));
    if (!ok) return;
    await mutateAndReload(c.id, () => deleteCampaign(session.tenantId, c.id), t('Suppression impossible', 'Deletion failed'));
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
          <h2 className="text-base font-semibold tracking-tight text-ink-900">
            {showArchived ? t('Campagnes archivées', 'Archived campaigns') : t('Campagnes', 'Campaigns')} ({campaigns.length})
          </h2>
          {pricing ? (
            /* « des campagnes affichées », et non « total » : la somme porte sur la liste RENDUE, qui exclut
               désormais les archivées. Le dashboard, lui, compte tout. Deux chiffres différents sur deux écrans
               sont acceptables tant que chacun dit sur quoi il porte ; « total » ici serait un mensonge. */
            <p className="mt-0.5 text-xs text-ink-500">
              {t('coût estimé des campagnes affichées', 'estimated cost of listed campaigns')} ≈ <span className="font-semibold text-ink-800">{fmtCost(campaigns.reduce((acc, c) => acc + (estimateCampaignCost(c.counts.sent, c.category, pricing) ?? 0), 0))}</span> <span className="text-ink-400">({t('devise du compte', 'account currency')})</span>
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
          {/* Bascule actives / archivées. `reload` dépend de showArchived, donc l'effet de montage la rejoue
              tout seul au changement : pas d'appel manuel ici, sinon on chargerait deux fois. */}
          <button
            onClick={() => { setDetail(null); setShowArchived((v) => !v); }}
            className="text-xs text-ink-500 hover:text-ink-800 hover:underline"
          >
            {showArchived ? t('Voir les campagnes actives', 'View active campaigns') : t('Voir les archivées', 'View archived')}
          </button>
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
          {showArchived
            ? t('Aucune campagne archivée.', 'No archived campaigns.')
            : t('Aucune campagne. Clique « + Ajouter une campagne » pour en créer une.', 'No campaigns. Click "+ Add a campaign" to create one.')}
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
                    {c.status === 'scheduled' && c.scheduledAt && (
                      <p className="mt-0.5 text-xs font-medium text-violet-700">
                        {t('Planifiée le', 'Scheduled for')} {new Date(c.scheduledAt).toLocaleString()}
                      </p>
                    )}
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
                    {/* Une campagne programmée part seule à l'échéance : pas de « Lancer », mais on peut annuler
                        la programmation (retour brouillon). */}
                    {c.status === 'scheduled' && (
                      <button
                        onClick={() => cancelSched(c.id)}
                        className="rounded-lg border border-ink-300 px-3 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50"
                      >
                        {t('Annuler la planification', 'Cancel schedule')}
                      </button>
                    )}
                    <button
                      onClick={() => (detail?.id === c.id ? setDetail(null) : openDetail(c.id))}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {detail?.id === c.id ? t('Masquer', 'Hide') : t('Détails', 'Details')}
                    </button>
                    {/* Sortie de liste. Une campagne qui a envoyé ne peut QUE s'archiver : ses destinataires
                        portent l'historique lu par les analytics. Seul un brouillon dont aucun destinataire n'a
                        bougé se supprime pour de bon. Le serveur retient la même garde et répond 409 s'il
                        n'est pas d'accord : ce test local ne fait qu'éviter de proposer un bouton perdant. */}
                    {c.archivedAt ? (
                      <button onClick={() => unarchive(c.id)} className="text-xs text-ink-500 hover:text-ink-800 hover:underline">
                        {t('Restaurer', 'Restore')}
                      </button>
                    ) : c.status === 'draft' && c.counts.total === c.counts.pending ? (
                      <button onClick={() => remove(c)} className="text-xs text-red-600 hover:underline">
                        {t('Supprimer', 'Delete')}
                      </button>
                    ) : (
                      <button onClick={() => archive(c.id)} className="text-xs text-ink-500 hover:text-ink-800 hover:underline">
                        {t('Archiver', 'Archive')}
                      </button>
                    )}
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
  // Débit d'envoi (« vitesse du canon ») : null = débit maximum (aucun throttle, comportement par défaut).
  // Sinon 1..80 messages/min (plafond WhatsApp). Envoyé au backend seulement s'il est non-null.
  const [ratePerMinute, setRatePerMinute] = useState<number | null>(null);
  // Lancement rapatrié sur l'écran (étape 2) : idle -> creating -> launching (avec polling inline) -> done|error.
  // Programmation : idle -> creating -> scheduled (pas de polling, le worker déclenche l'envoi à l'échéance).
  const [launch, setLaunch] = useState<{
    phase: 'idle' | 'creating' | 'launching' | 'scheduled' | 'done' | 'error';
    campaignId?: string;
    detail?: CampaignDetail;
    message?: string;
  }>({ phase: 'idle' });
  // Timing du lancement (étape 2) : 'now' = envoi immédiat, 'later' = programmation à une date/heure future.
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  // Date/heure choisie pour la programmation, en HEURE LOCALE (valeur brute d'un <input datetime-local>).
  // Convertie en ISO UTC absolu (new Date(...).toISOString()) seulement au moment de l'action.
  const [scheduledLocal, setScheduledLocal] = useState('');
  // Anti-course : ne pas appliquer les indices d'un template si l'utilisateur en a choisi un autre entre-temps.
  const chooseSeq = useRef(0);
  // Garde de démontage : le mini-polling du lancement est une boucle async hors cycle React -> on l'arrête si
  // l'utilisateur quitte l'écran (retour liste) pour ne pas continuer à fetch/setState sur un composant démonté.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Références chargées une fois (indépendamment du polling des campagnes) : templates, scénarios, champs, tags.
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  // Création d'un template SANS quitter la campagne en cours. `submittedTemplate` retient ce qui vient d'être
  // soumis : le formulaire se referme, mais la confirmation doit survivre pour expliquer l'attente Meta.
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [submittedTemplate, setSubmittedTemplate] = useState<CreatedTemplate | null>(null);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(true);

  // --- Zone Destinataires : source + filtres du mini-CRM ---
  const [source, setSource] = useState<'crm' | 'file' | 'hubspot'>('crm');
  // Toggle « Campagnes via données HubSpot » (réglé sur l'accueil) : gate le 3e bouton de source.
  const [hubspotListsEnabled, setHubspotListsEnabled] = useState(false);
  // Filtres UI (alimentent ContactFilters). tagMode 'and' = tous, 'or' = au moins un.
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [tagMode, setTagMode] = useState<'and' | 'or'>('and');
  const [optIn, setOptIn] = useState<'' | 'opted_in' | 'opted_out' | 'unknown'>('');
  const [phonePrefix, setPhonePrefix] = useState('');
  const [phoneContains, setPhoneContains] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [fieldFilters, setFieldFilters] = useState<ContactFieldFilter[]>([]);
  // Résultats : liste affichée (<= 500), total réel (compteur), sélection ciblée.
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Récap non bloquant après un import fichier (N importés + tag posé) : affiché dans la zone Destinataires.
  const [importMsg, setImportMsg] = useState<{ n: number; tags: string[] } | null>(null);
  // Import CSV (source fichier) en vol : gèle les boutons de source (changer de source démonterait CsvImport).
  const [importBusy, setImportBusy] = useState(false);
  // Anti-course : n'appliquer qu'une réponse à jour (une plus récente peut la doubler entre-temps).
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!phoneNumberId && numbers[0]) setPhoneNumberId(numbers[0].id);
  }, [numbers, phoneNumberId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // getSettings lancé EN PARALLÈLE mais DÉCOUPLÉ du Promise.all (all-or-nothing) : un hoquet sur les réglages
      // ne doit pas vider templates/scénarios ; le toggle HubSpot reste false par défaut. `.catch(->null)` isole l'échec.
      const settingsPromise = getSettings(tenantId).catch(() => null);
      try {
        const [tpl, w, uf, tg] = await Promise.all([listTemplates(tenantId), listWorkflows(tenantId), listUserFields(tenantId), listTags(tenantId)]);
        if (!alive) return;
        setTemplates(tpl.templates.filter((x) => x.status === 'APPROVED'));
        setWorkflows(w.workflows);
        setUserFields(uf.fields);
        setTags(tg.tags);
      } catch {
        // silencieux : l'erreur de création reste affichée si l'envoi échoue
      } finally {
        if (alive) setLoadingRefs(false);
      }
      const cfg = await settingsPromise;
      if (alive && cfg) setHubspotListsEnabled(cfg.hubspotListsEnabled);
    })();
    return () => { alive = false; };
  }, [tenantId]);

  // Recharge la SEULE liste des templates (après une création inline, ou pour vérifier une approbation Meta).
  // Même filtre APPROVED que le chargement initial : le select ne doit jamais proposer un template inenvoyable.
  const reloadTemplates = useCallback(async () => {
    try {
      const tpl = await listTemplates(tenantId);
      setTemplates(tpl.templates.filter((x) => x.status === 'APPROVED'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rafraîchissement impossible');
    }
  }, [tenantId]);

  // Construit ContactFilters depuis l'UI : n'inclut une clé que si elle est renseignée (miroir de filtersToQuery).
  const buildFilters = useCallback((): ContactFilters => {
    const f: ContactFilters = {};
    if (tagFilter.size > 0) { f.tags = [...tagFilter]; f.tagMode = tagMode; }
    if (optIn) f.optIn = optIn;
    if (phonePrefix.trim()) f.phonePrefix = phonePrefix.trim();
    if (phoneContains.trim()) f.phoneContains = phoneContains.trim();
    if (nameSearch.trim()) f.nameSearch = nameSearch.trim();
    const ff = fieldFilters.filter((r) => r.key && r.value.trim()).map((r) => ({ key: r.key, op: r.op, value: r.value.trim() }));
    if (ff.length > 0) f.fieldFilters = ff;
    return f;
  }, [tagFilter, tagMode, optIn, phonePrefix, phoneContains, nameSearch, fieldFilters]);

  // Rechargement DEBOUNCÉ (350 ms) de la liste + du compteur quand les filtres changent (source 'crm' seulement).
  // Au rechargement, on re-coche tous les contacts chargés (comportement « tout ciblé » par défaut).
  useEffect(() => {
    if (source !== 'crm') { setCountLoading(false); return; }
    const f = buildFilters();
    setCountLoading(true);
    const timer = setTimeout(() => {
      const seq = ++reqSeq.current;
      void (async () => {
        try {
          const [q, c] = await Promise.all([queryContacts(tenantId, f, { limit: 500 }), countContacts(tenantId, f)]);
          if (seq !== reqSeq.current || !mountedRef.current) return; // réponse périmée ou écran quitté
          setContacts(q.contacts);
          setTotal(c.total);
          setSelected(new Set(q.contacts.map((x) => x.id)));
          setCountLoading(false);
        } catch {
          if (seq !== reqSeq.current || !mountedRef.current) return;
          setCountLoading(false); // erreur silencieuse : on garde l'affichage précédent
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [source, tenantId, buildFilters]);

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

  // Bascule de source. Pour les sources non implémentées, on vide la sélection (donc étape 2 désactivée).
  // Un changement manuel de source referme le récap d'import (il ne concerne plus l'écran affiché).
  function chooseSource(s: 'crm' | 'file' | 'hubspot') {
    setSource(s);
    setImportMsg(null);
    if (s !== 'crm') setSelected(new Set());
  }

  // Après un import fichier : les contacts sont dans le CRM, taggés. On CIBLE ces contacts en posant leur(s)
  // tag(s) comme seul filtre et en vidant tout le reste, pour que le compteur/liste (étape Destinataires) ne
  // montrent qu'eux. tagMode 'or' si plusieurs tags (au moins un), 'and' sinon.
  function applyImportedTags(tags: string[]) {
    setTagFilter(new Set(tags));
    setTagMode(tags.length > 1 ? 'or' : 'and');
    setOptIn('');
    setPhonePrefix('');
    setPhoneContains('');
    setNameSearch('');
    setFieldFilters([]);
  }

  // Callback de CsvImport (source fichier) : on pivote sur la source CRM filtrée par le(s) tag(s) de l'import.
  // L'effet debouncé de la liste se redéclenche (filtres changés) et re-coche les contacts chargés -> `selected`
  // contient les importés, l'étape 2 devient accessible. N = contacts réellement posés (créés + mis à jour).
  function handleImported({ report, tags }: { report: ImportReport; tags: string[] }) {
    applyImportedTags(tags);
    setSource('crm');
    setImportMsg({ n: report.created + report.updated, tags });
  }
  function toggleContact(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleTag(tag: string) {
    setTagFilter((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });
  }
  function addFieldFilter() {
    setFieldFilters((r) => (r.length >= 5 ? r : [...r, { key: '', op: 'eq', value: '' }]));
  }
  function updateFieldFilter(i: number, patch: Partial<ContactFieldFilter>) {
    setFieldFilters((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  function removeFieldFilter(i: number) {
    setFieldFilters((r) => r.filter((_, j) => j !== i));
  }
  // « Tout sélectionner (N) » : résout côté serveur TOUS les ids correspondants (au-delà des 500 affichés).
  async function selectAllMatching() {
    try {
      const { ids } = await contactIdsForFilters(tenantId, buildFilters());
      if (!mountedRef.current) return;
      setSelected(new Set(ids));
    } catch { /* silencieux */ }
  }
  const customFields = customFieldsOnly(userFields);
  // Un filtre est actif dès qu'une clé est posée -> distingue « aucun résultat » de « aucun contact du tout ».
  const hasActiveFilters = Object.keys(buildFilters()).length > 0;
  // Le récap d'import n'est PERTINENT que tant que le filtre affiché == exactement les tags importés (rien
  // d'autre). Dès que l'utilisateur touche un filtre, la sélection diverge des importés -> on masque le récap.
  const importMsgFresh = importMsg !== null
    && tagFilter.size === importMsg.tags.length
    && importMsg.tags.every((tg) => tagFilter.has(tg))
    && !optIn && !phonePrefix.trim() && !phoneContains.trim() && !nameSearch.trim()
    && fieldFilters.filter((r) => r.key && r.value.trim()).length === 0;

  function toParamMapping(): TemplateParam[] {
    return vars.map((v, i) => ({ position: i + 1, source: selToSource(v.sel, v.value) }));
  }

  // Payload de création partagé par le brouillon (submit) et le lancement direct (createAndLaunch).
  function buildCreateInput(): CreateCampaignInput {
    // ratePerMinute omis quand null (débit max) : on n'envoie la clé que si un plafond est choisi.
    const rate = ratePerMinute != null ? { ratePerMinute } : {};
    return mode === 'workflow'
      ? { phoneNumberId, name, category, workflowId, paramMapping: toParamMapping(), contactIds: [...selected], ...rate }
      : { phoneNumberId, name, category, templateName, templateLanguage, paramMapping: toParamMapping(), contactIds: [...selected], ...rate };
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
    setRatePerMinute(null); // retour au débit maximum (défaut)
    setTiming('now');
    setScheduledLocal('');
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

  // Créer PUIS programmer un lancement futur (étape 2, timing 'later'). Pas de polling : on confirme la
  // programmation et on laisse le worker déclencher l'envoi à l'échéance. La date locale saisie est convertie
  // en ISO UTC absolu ici, au moment de l'action.
  async function createAndSchedule() {
    const scheduledISO = new Date(scheduledLocal).toISOString();
    setError(null);
    setOk(null);
    setLaunch({ phase: 'creating' });
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = tous sautés : même avertissement ROUGE que le brouillon, on NE programme PAS et on reste.
      if (res.recipientCount === 0) {
        setError(t(
          `Aucun destinataire : les ${res.skipped.length} contact(s) sélectionné(s) ont été sautés car la variable du template n'a pas de valeur sur leur fiche. Choisis une autre source pour la variable (ex. « Nom ») ou complète les fiches.`,
          `No recipients: the ${res.skipped.length} selected contact(s) were skipped because the template variable has no value on their record. Choose another source for the variable (e.g. "Name") or complete the records.`,
        ));
        setLaunch({ phase: 'idle' });
        return;
      }
      const r = await runCampaign(res.campaignId, scheduledISO);
      if (!mountedRef.current) return; // écran quitté entre-temps -> on cesse tout setState
      const when = new Date(r.scheduledAt ?? scheduledISO).toLocaleString();
      setLaunch({
        phase: 'scheduled',
        campaignId: res.campaignId,
        message: t(`Campagne planifiée le ${when}.`, `Campaign scheduled for ${when}.`),
      });
    } catch (err) {
      setLaunch({ phase: 'error', message: err instanceof Error ? err.message : t('Programmation impossible', 'Scheduling failed') });
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
  // Lancement en cours (création + polling) : verrouille les boutons des deux étapes. Couvre aussi la phase
  // 'creating' de la programmation (créer + programmer), donc le retour liste est gelé pendant l'opération.
  const launching = launch.phase === 'creating' || launch.phase === 'launching';
  // Validation UI de la programmation : date renseignée, valide, et STRICTEMENT dans le futur (au rendu).
  const scheduledDate = timing === 'later' && scheduledLocal ? new Date(scheduledLocal) : null;
  const scheduledValid = scheduledDate !== null && !Number.isNaN(scheduledDate.getTime()) && scheduledDate.getTime() > Date.now();
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

        {/* ZONE 2 : Destinataires : source (liste CRM / fichier / HubSpot) + filtres du mini-CRM */}
        <div className="rounded-xl border border-ink-200 p-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium text-ink-700">{t('Destinataires', 'Recipients')}</label>
          {/* Y = total réel (compteur serveur), pas le nombre de contacts affichés. */}
          {source === 'crm' && total !== null && (
            <span className="text-xs text-ink-400">{selected.size} / {total} {t('sélectionnés', 'selected')}</span>
          )}
        </div>

        {/* Sélecteur de SOURCE des destinataires (segmenté, comme le toggle template/scénario). */}
        <div className="mb-3 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
          {/* Boutons de source gelés pendant un import en vol (changer de source démonterait CsvImport et sa
              requête, la sélection pivoterait sur un état obsolète). */}
          <button type="button" disabled={importBusy} onClick={() => chooseSource('crm')} className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${source === 'crm' ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>
            📇 {t('Liste de contacts', 'Contact list')}
          </button>
          <button type="button" disabled={importBusy} onClick={() => chooseSource('file')} className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${source === 'file' ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>
            📄 {t('Import fichier', 'File import')}
          </button>
          <button
            type="button"
            disabled={importBusy || !hubspotListsEnabled}
            onClick={() => chooseSource('hubspot')}
            title={hubspotListsEnabled ? undefined : t('Active « Campagnes via données HubSpot » sur l\'accueil', 'Enable "Campaigns from HubSpot data" on the home page')}
            className={`rounded-md px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${source === 'hubspot' ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
          >
            🔗 {t('HubSpot', 'HubSpot')}
          </button>
        </div>

        {source === 'file' ? (
          <CsvImport tenantId={tenantId} requireTag onImported={handleImported} onBusyChange={setImportBusy} />
        ) : source === 'hubspot' ? (
          <HubspotListImport tenantId={tenantId} onImported={handleImported} onBusyChange={setImportBusy} />
        ) : loadingRefs ? (
          <p className="text-xs text-ink-400">{t('Chargement des contacts...', 'Loading contacts...')}</p>
        ) : (
          <div>
            {/* Récap d'import (non bloquant) : rappelle N importés + le(s) tag(s) posé(s), qui filtrent la liste.
                Masqué dès que l'utilisateur modifie un filtre (le récap ne décrit plus la sélection affichée). */}
            {importMsgFresh && importMsg && (
              <div className="mb-2 flex items-start justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <span>
                  <b>{importMsg.n}</b> {t('contact(s) importé(s) et taggé(s)', 'contact(s) imported and tagged')} « {importMsg.tags.join(', ')} ». {t('Ils sont sélectionnés ci-dessous.', 'They are selected below.')}
                </span>
                <button type="button" onClick={() => setImportMsg(null)} className="shrink-0 leading-none text-emerald-500 hover:text-emerald-800" aria-label={t('Fermer', 'Close')}>×</button>
              </div>
            )}
            {/* Tags : puces multi-sélection alimentées par listTags (pas dérivées des contacts chargés). */}
            {tags.length > 0 && (
              <div className="mb-2">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-ink-400">{t('Tags :', 'Tags:')}</span>
                  {tags.map((tc) => (
                    <button
                      type="button"
                      key={tc.tag}
                      onClick={() => toggleTag(tc.tag)}
                      className={`rounded-full px-2 py-0.5 text-xs transition ${tagFilter.has(tc.tag) ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}
                    >
                      {tc.tag} <span className="opacity-60">{tc.count}</span>
                    </button>
                  ))}
                  {tagFilter.size > 0 && (
                    <button type="button" onClick={() => setTagFilter(new Set())} className="text-[11px] text-brand-600 hover:underline">{t('réinitialiser', 'reset')}</button>
                  )}
                </div>
                {/* Combinaison des tags : « tous » (and) vs « au moins un » (or). N'a de sens qu'à partir de 2 tags. */}
                {tagFilter.size > 1 && (
                  <div className="mt-1 inline-flex gap-1 rounded-lg bg-ink-100 p-0.5 text-[11px]">
                    {([['and', t('tous', 'all')], ['or', t('au moins un', 'any')]] as const).map(([m, label]) => (
                      <button type="button" key={m} onClick={() => setTagMode(m)} className={`rounded-md px-2 py-0.5 ${tagMode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>{label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Opt-in / Nom / Téléphone (commence par + contient) */}
            <div className="mb-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-ink-500">{t('Opt-in', 'Opt-in')}</span>
                <select value={optIn} onChange={(e) => setOptIn(e.target.value as typeof optIn)} className={`${inputCls} py-1.5`}>
                  <option value="">{t('Tous', 'All')}</option>
                  <option value="opted_in">{t('Opté-in', 'Opted-in')}</option>
                  <option value="opted_out">{t('Opté-out', 'Opted-out')}</option>
                  <option value="unknown">{t('Inconnu', 'Unknown')}</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-ink-500">{t('Nom contient', 'Name contains')}</span>
                <input value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} className={`${inputCls} py-1.5`} placeholder={t('nom', 'name')} />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-ink-500">{t('Tél. commence par', 'Phone starts with')}</span>
                <input value={phonePrefix} onChange={(e) => setPhonePrefix(e.target.value)} className={`${inputCls} py-1.5`} placeholder="+336" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-ink-500">{t('Tél. contient', 'Phone contains')}</span>
                <input value={phoneContains} onChange={(e) => setPhoneContains(e.target.value)} className={`${inputCls} py-1.5`} placeholder="06" />
              </label>
            </div>

            {/* Filtres de champ perso (répétables, max 5). Une ligne ne compte que si champ ET valeur remplis. */}
            {customFields.length > 0 && (
              <div className="mb-2 space-y-1.5">
                {fieldFilters.map((r, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select value={r.key} onChange={(e) => updateFieldFilter(i, { key: e.target.value })} className={`${inputCls} flex-1 py-1.5`}>
                      <option value="">{t('Champ…', 'Field…')}</option>
                      {customFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <select value={r.op} onChange={(e) => updateFieldFilter(i, { op: e.target.value as ContactFieldFilter['op'] })} className={`${inputCls} w-24 py-1.5`}>
                      <option value="eq">{t('est', 'is')}</option>
                      <option value="contains">{t('contient', 'contains')}</option>
                    </select>
                    <input value={r.value} onChange={(e) => updateFieldFilter(i, { value: e.target.value })} className={`${inputCls} w-28 py-1.5`} placeholder={t('valeur', 'value')} />
                    <button type="button" onClick={() => removeFieldFilter(i)} className="shrink-0 rounded p-1 text-ink-400 hover:text-red-600" title={t('Retirer', 'Remove')}>✕</button>
                  </div>
                ))}
                {fieldFilters.length < 5 && (
                  <button type="button" onClick={addFieldFilter} className="text-[11px] text-brand-600 hover:underline">+ {t('filtre de champ', 'field filter')}</button>
                )}
              </div>
            )}

            {/* Compteur live (débounce) + contrôles de sélection sur gros volumes. */}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700">
                {countLoading || total === null ? t('… contacts', '… contacts') : t(`${total} contact(s) correspondent`, `${total} contact(s) match`)}
              </span>
              {total !== null && total > contacts.length && (
                <>
                  <span className="text-ink-400">{t(`${contacts.length} affichés sur ${total} au total`, `${contacts.length} shown of ${total} total`)}</span>
                  <button type="button" onClick={selectAllMatching} className="rounded-lg border border-brand-300 bg-brand-50 px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-100">
                    {t(`Tout sélectionner (${total})`, `Select all (${total})`)}
                  </button>
                </>
              )}
              <button type="button" onClick={() => setSelected(new Set())} className="rounded-lg border border-ink-300 px-2 py-0.5 text-ink-600 hover:bg-ink-50">{t('Vider', 'Clear')}</button>
            </div>

            {/* Liste des contacts correspondants (<= 500 affichés) : cocher/décocher affine la sélection. */}
            <div className="max-h-[22rem] divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
              {contacts.map((c) => (
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
              {contacts.length === 0 && (
                <p className="px-2.5 py-3 text-xs text-ink-400">
                  {countLoading ? t('Chargement…', 'Loading…')
                    : hasActiveFilters ? t('Aucun contact ne correspond aux filtres.', 'No contact matches the filters.')
                    : t("Aucun contact joignable. Importe des contacts dans l'onglet Contacts.", 'No reachable contact. Import contacts in the Contacts tab.')}
                </p>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{t('Les contacts opt-out sont ignorés automatiquement pour le marketing.', 'Opted-out contacts are automatically skipped for marketing.')}</p>
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

            {/* Créer un template sans quitter la campagne. Modèle : la création inline d'un formulaire depuis le
                sélecteur de bouton FLOW, écran Templates. Une différence CHANGE tout ici : un template neuf revient
                PENDING, or ce select ne liste que les APPROVED. On ne l'injecte donc PAS dans la liste (il serait
                sélectionnable et inenvoyable, l'échec arriverait plus tard chez Meta, illisible). On affiche à la
                place ce qui vient de se passer, et on NOMME l'attente : le bouton n'a jamais l'air cassé. */}
            {!loadingRefs && !creatingTemplate && !submittedTemplate && (
              <button type="button" onClick={() => setCreatingTemplate(true)} className="mt-2 text-xs text-brand-600 hover:underline">
                ＋ {t('Créer un nouveau template', 'Create a new template')}
              </button>
            )}
            {submittedTemplate && (
              <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
                <p className="text-sm font-medium text-ink-900">
                  {t('Template', 'Template')} « {submittedTemplate.name} » {t('soumis', 'submitted')} ({t('statut', 'status')} : {submittedTemplate.status}).
                </p>
                <p className="mt-1 text-xs text-ink-600">
                  {t(
                    "Il passe en revue chez Meta. Il apparaîtra dans cette liste une fois approuvé : une campagne ne peut partir qu'avec un template déjà approuvé.",
                    'It goes through Meta review. It will show up in this list once approved: a campaign can only run with an already-approved template.',
                  )}
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <button type="button" onClick={() => { void reloadTemplates(); }} className="text-xs text-brand-600 hover:underline">
                    {t('Rafraîchir la liste', 'Refresh the list')}
                  </button>
                  <button type="button" onClick={() => setSubmittedTemplate(null)} className="text-xs text-ink-500 hover:underline">
                    {t('Fermer', 'Close')}
                  </button>
                </div>
              </div>
            )}
            {creatingTemplate && (
              <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
                <TemplateForm
                  tenantId={tenantId}
                  onCreated={(created) => { setCreatingTemplate(false); if (created) setSubmittedTemplate(created); }}
                />
                <button type="button" onClick={() => setCreatingTemplate(false)} className="mt-2 text-xs text-ink-500 hover:underline">
                  {t('Annuler', 'Cancel')}
                </button>
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

      {/* Débit d'envoi (« vitesse du canon ») : placé après le grid pour disposer de la sélection (durée estimée
          sur selected.size). Défaut = maximum (ratePerMinute null). « Limiter » borne à 1..80 messages/min. */}
      <div className="mt-4 rounded-xl border border-ink-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-ink-700">{t("Débit d'envoi", 'Sending rate')}</h3>
            <p className="mt-0.5 text-xs text-ink-500">{t('Par défaut, envoi au débit maximum.', 'By default, sending at maximum speed.')}</p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={ratePerMinute != null}
              onChange={(e) => setRatePerMinute(e.target.checked ? 80 : null)}
              className="accent-brand-500"
            />
            {t("Limiter la vitesse d'envoi", 'Limit the sending speed')}
          </label>
        </div>

        {ratePerMinute != null && (
          <div className="mt-3">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={80}
                step={1}
                value={ratePerMinute}
                onChange={(e) => setRatePerMinute(Number(e.target.value))}
                className="flex-1 accent-brand-500"
              />
              <span className="w-32 shrink-0 text-right text-sm font-medium text-ink-800">{ratePerMinute} {t('messages / min', 'messages / min')}</span>
            </div>
            {selected.size > 0 && (
              <p className="mt-2 text-xs text-ink-500">
                {t(`~${Math.ceil(selected.size / ratePerMinute)} min pour envoyer ${selected.size} message(s)`, `~${Math.ceil(selected.size / ratePerMinute)} min to send ${selected.size} message(s)`)}
              </p>
            )}
            <p className="mt-2 text-[11px] text-ink-400">
              {t('Le plafond est 80/min (limite WhatsApp). Baisser le débit protège la réputation du numéro.', 'The cap is 80/min (WhatsApp limit). Lowering the rate protects the number reputation.')}
            </p>
          </div>
        )}
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

            {/* Timing : lancer maintenant OU programmer un envoi futur. 'later' révèle un sélecteur date/heure. */}
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Quand ?', 'When?')}</label>
              <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
                {([
                  ['now', t('Maintenant', 'Now')],
                  ['later', t('Plus tard', 'Later')],
                ] as const).map(([val, label]) => (
                  <button
                    type="button"
                    key={val}
                    onClick={() => setTiming(val)}
                    disabled={launching}
                    className={`rounded-md px-3 py-1 disabled:opacity-40 ${timing === val ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {timing === 'later' && (
                <div className="mt-3">
                  <input
                    type="datetime-local"
                    value={scheduledLocal}
                    onChange={(e) => setScheduledLocal(e.target.value)}
                    disabled={launching}
                    className={`${inputCls} max-w-xs disabled:opacity-40`}
                  />
                  <p className="mt-1 text-xs text-ink-500">{t('Le lancement partira automatiquement à cette date/heure.', 'The launch will go out automatically at this date/time.')}</p>
                  {scheduledLocal !== '' && !scheduledValid && (
                    <p className="mt-1 text-xs text-amber-600">{t('Choisis une date et une heure dans le futur.', 'Choose a date and time in the future.')}</p>
                  )}
                </div>
              )}
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
                {launch.phase === 'scheduled' && (
                  <div>
                    <p className="font-medium text-violet-800">{launch.message}</p>
                    <p className="mt-1 text-xs text-ink-500">{t('Elle partira automatiquement à la date prévue. Tu peux annuler la planification depuis la liste.', 'It will go out automatically at the scheduled time. You can cancel the schedule from the list.')}</p>
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

            {/* Boutons d'action : masqués une fois le lancement/programmation terminé (les boutons de suite prennent
                le relais). Le bouton primaire dépend du timing : « Créer et lancer » (now) ou « Créer et planifier »
                (later, actif seulement si la date est dans le futur). Le brouillon reste disponible dans les deux cas. */}
            {launch.phase !== 'done' && launch.phase !== 'scheduled' && (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                {timing === 'now' ? (
                  <button
                    type="button"
                    onClick={createAndLaunch}
                    disabled={!canSubmit || launching}
                    className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {launch.phase === 'creating' ? t('Création...', 'Creating...') : launch.phase === 'launching' ? t('Lancement...', 'Launching...') : t('Créer et lancer', 'Create and launch')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={createAndSchedule}
                    disabled={!canSubmit || launching || !scheduledValid}
                    className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {launch.phase === 'creating' ? t('Programmation...', 'Scheduling...') : t('Créer et planifier', 'Create and schedule')}
                  </button>
                )}
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
