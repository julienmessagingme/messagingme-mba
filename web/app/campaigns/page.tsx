'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { explainMetaError } from '@/lib/meta-errors';
import { fmtCost, campaignSendLabel } from '@/lib/format';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import {
  listCampaigns,
  listCampaignDrafts,
  deleteCampaignDraft,
  type CampaignDraft,
  getCampaign,
  listPhoneNumbers,
  getSettings,
  runCampaign,
  retryRecipient,
  updateContact,
  cancelSchedule,
  archiveCampaign,
  unarchiveCampaign,
  deleteCampaign,
  getTemplateStats,
  type CampaignSummary,
  type CampaignDetail,
  type CampaignRecipient,
  type CampaignCategory,
  type PhoneNumber,
  type PricingSummary,
} from '@/lib/api';
import { CampaignCreateForm, LaunchCounts } from '@/components/CampaignCreateForm';

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
  const { locale } = useLocale();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [rcsEnabled, setRcsEnabled] = useState(false);
  // Corbeille : la liste montre SOIT les campagnes actives SOIT les archivées, jamais les deux mélangées.
  const [showArchived, setShowArchived] = useState(false);
  // Un lancement inline (étape 2) est en cours dans CreateForm -> on gèle le retour liste (remonté par callback).
  const [createBusy, setCreateBusy] = useState(false);
  // Tarifs Meta chargés UNE fois au montage (hors reload() pollé 6×/2s pendant l'envoi -> pas de martèlement).
  const [pricing, setPricing] = useState<PricingSummary | null>(null);
  /**
   * Brouillons de COMPOSITION : des campagnes qu'on a commencé à écrire. Chargés à part de `reload()`, qui
   * est pollé pendant un envoi : un brouillon ne bouge pas six fois en douze secondes.
   */
  const [brouillons, setBrouillons] = useState<CampaignDraft[]>([]);
  /** Le brouillon qu'on vient de rouvrir, passé au formulaire. `null` = création neuve. */
  const [brouillonRepris, setBrouillonRepris] = useState<CampaignDraft | null>(null);

  const rechargerBrouillons = useCallback(async () => {
    // Silencieux : l'absence de brouillons ne doit jamais masquer la liste des campagnes, qui est l'essentiel
    // de l'écran. Un backend plus ancien que ce front n'a pas la route, et la section reste simplement vide.
    //
    // 🔴 `Array.isArray` et pas seulement le try/catch : une réponse 200 sans `drafts` (backend antérieur,
    // proxy qui renvoie un objet vide) passerait le catch et poserait `undefined` dans un état typé tableau.
    // Le rendu suivant lit `.length` dessus et TOUTE la page casse, pas seulement cette section.
    try {
      const r = await listCampaignDrafts(session.tenantId);
      setBrouillons(Array.isArray(r?.drafts) ? r.drafts : []);
    } catch {
      setBrouillons([]);
    }
  }, [session.tenantId]);

  useEffect(() => { void rechargerBrouillons(); }, [rechargerBrouillons]);

  useEffect(() => {
    getTemplateStats(session.tenantId).then((ts) => setPricing(ts.pricing)).catch(() => setPricing(null));
  }, [session.tenantId]);

  // Canal RCS : lecture DÉCOUPLÉE des référentiels (jamais dans le Promise.all all-or-nothing), même patron
  // que la page Scénarios. Un hoquet ici ne doit pas vider la liste des campagnes ; le canal reste éteint.
  useEffect(() => {
    void getSettings(session.tenantId).then((s) => setRcsEnabled(s.rcsEnabled === true)).catch(() => {});
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
        <CampaignCreateForm
          tenantId={session.tenantId}
          numbers={numbers}
          onBusyChange={setCreateBusy}
          onCreated={() => { void reload(); void rechargerBrouillons(); setMode('list'); }}
          rcsEnabled={rcsEnabled}
          {...(brouillonRepris ? { draft: brouillonRepris } : {})}
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
              {t('coût estimé des campagnes affichées', 'estimated cost of listed campaigns')} ≈ <span className="font-semibold text-ink-800">{fmtCost(campaigns.reduce((acc, c) => acc + (estimateCampaignCost(c.counts.sent, c.category, pricing) ?? 0), 0), locale, pricing?.currency)}</span>{!pricing?.currency && <span className="text-ink-400"> ({t('devise du compte', 'account currency')})</span>}
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
            onClick={() => { setDetail(null); setBrouillonRepris(null); setMode('create'); }}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            + {t('Ajouter une campagne', 'Add a campaign')}
          </button>
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Campagnes COMMENCÉES mais pas encore créées. Volontairement au-dessus de la liste et visuellement
          distinctes : ce ne sont pas des campagnes, elles n'ont ni destinataire ni envoi possible. Masquées
          dans la corbeille, qui ne parle que de campagnes archivées. */}
      {!showArchived && brouillons.length > 0 && (
        <section className="mb-4" data-testid="campaign-drafts">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {t('Brouillons en cours', 'Drafts in progress')}
          </h3>
          <ul className="space-y-2">
            {brouillons.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-ink-300 bg-white px-4 py-2.5">
                <div className="min-w-0">
                  <span className="truncate text-sm font-medium text-ink-800">{d.name}</span>
                  <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">{t('brouillon', 'draft')}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    data-testid={`draft-resume-${d.id}`}
                    onClick={() => { setDetail(null); setBrouillonRepris(d); setMode('create'); }}
                    className="text-sm font-medium text-brand-600 hover:underline"
                  >
                    {t('Reprendre', 'Resume')}
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm(t(`Supprimer le brouillon « ${d.name} » ?`, `Delete draft "${d.name}"?`))) return;
                      void deleteCampaignDraft(session.tenantId, d.id).then(rechargerBrouillons).catch(() => {});
                    }}
                    className="text-sm text-ink-400 hover:text-red-600"
                  >
                    {t('Supprimer', 'Delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
                      {campaignSendLabel(c, locale)} · {c.counts.total} {t('destinataires', 'recipients')}
                    </p>
                    <LaunchCounts counts={c.counts} className="mt-1 text-xs text-ink-500" />
                    {(() => {
                      const cost = estimateCampaignCost(c.counts.sent, c.category, pricing);
                      return (
                        <p className="mt-1 text-xs text-ink-400">
                          {t('coût estimé', 'estimated cost')} {cost != null ? <>≈ <span className="font-medium text-ink-700">{fmtCost(cost, locale, pricing?.currency)}</span>{!pricing?.currency && ` (${t('devise du compte', 'account currency')})`}</> : t('indisponible', 'unavailable')}
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
                    <DetailPanel detail={detail} pricing={pricing} tenantId={session.tenantId} onClose={() => setDetail(null)} onRetried={() => void openDetail(detail.id)} />
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

/** Codes d'erreur Meta « variable de template » renvoyables après correction (F7). Aligné sur le back. */
const RETRYABLE_VAR_CODES = new Set([131009, 132012, 132000]);

function DetailPanel({ detail, pricing, tenantId, onClose, onRetried }: { detail: CampaignDetail; pricing: PricingSummary | null; tenantId: string; onClose: () => void; onRetried: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  // Date d'envoi d'un destinataire, même format que l'historique de la fiche contact (fuseau imposé par day.ts).
  const stamp = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;
  const cost = estimateCampaignCost(detail.counts.sent, detail.category, pricing);
  // Champs (source:field) du template : ce que l'admin peut corriger sur le contact avant de renvoyer (F7).
  const fieldKeys = detail.paramMapping.filter((p) => p.source.type === 'field' && p.source.key).map((p) => p.source.key as string);
  const [retryFor, setRetryFor] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ rid: string; text: string; ok: boolean } | null>(null);

  function openRetry(rid: string) {
    setRetryFor(rid);
    setVals(Object.fromEntries(fieldKeys.map((k) => [k, ''])));
    setMsg(null);
  }
  async function submitRetry(r: CampaignRecipient) {
    setBusy(true);
    setMsg(null);
    try {
      // Ne PATCH que les champs réellement saisis (MERGE côté serveur, n'écrase pas les autres).
      const fields = Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim() !== ''));
      if (Object.keys(fields).length > 0) await updateContact(tenantId, r.contactId, { fields });
      await retryRecipient(detail.id, r.id);
      setRetryFor(null);
      setMsg({ rid: r.id, text: t('Renvoi en file. Le statut se met à jour au rafraîchissement.', 'Resend queued. Status updates on refresh.'), ok: true });
      onRetried();
    } catch (err) {
      setMsg({ rid: r.id, text: err instanceof Error ? err.message : t('Renvoi impossible', 'Resend failed'), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{detail.name}</span>
          <Badge status={detail.status} />
          <span className="text-xs text-ink-500">{campaignSendLabel(detail, locale)}</span>
          <span className="text-xs text-ink-400">{t('coût estimé', 'estimated cost')} {cost != null ? `≈ ${fmtCost(cost, locale, pricing?.currency)}${pricing?.currency ? '' : ` (${t('devise du compte', 'account currency')})`}` : t('indisponible', 'unavailable')}</span>
        </div>
        <button onClick={onClose} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
      </div>
      {detail.recipients.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-500">{t('Aucun destinataire.', 'No recipients.')}</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">{t('Destinataire', 'Recipient')}</th>
              <th className="px-4 py-2 font-medium">{t('Envoi', 'Sending')}</th>
              <th className="px-4 py-2 font-medium">{t('Envoyé le', 'Sent on')}</th>
              <th className="px-4 py-2 font-medium">{t('Livraison', 'Delivery')}</th>
              <th className="px-4 py-2 font-medium">{t('Détail', 'Detail')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {detail.recipients.map((r) => {
              const retryable = r.status === 'failed' && r.errorCode !== null && RETRYABLE_VAR_CODES.has(r.errorCode);
              return [
                <tr key={r.id}>
                  <td className="px-4 py-2 font-mono text-xs">{r.toE164}</td>
                  <td className="px-4 py-2"><Badge status={r.status} /></td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-ink-500">{r.sentAt ? stamp(r.sentAt) : <span className="text-ink-400">{t('non envoyé', 'not sent')}</span>}</td>
                  <td className="px-4 py-2">{r.deliveryStatus ? <Badge status={r.deliveryStatus} /> : <span className="text-xs text-ink-400">-</span>}</td>
                  <td className="px-4 py-2 text-xs text-ink-500" title={r.deliveryError ?? r.error ?? undefined}>
                    <div>{explainMetaError(r.deliveryError ?? r.error, locale) ?? r.messageId ?? '-'}</div>
                    {retryable && retryFor !== r.id && (
                      <button
                        type="button"
                        onClick={() => openRetry(r.id)}
                        data-testid={`retry-${r.id}`}
                        className="mt-1 rounded-md border border-brand-200 px-2 py-0.5 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
                      >
                        {/* Sans variable de champ à corriger, il n'y a RIEN à corriger : promettre l'inverse
                            envoie chercher une faute de saisie qui n'existe pas (cas d'un template dont
                            l'en-tête média manquait à l'envoi). Le renvoi, lui, reste utile : il repart avec
                            l'envoi corrigé, ou avec un contact mis à jour ailleurs. */}
                        {fieldKeys.length === 0 ? t('Renvoyer', 'Resend') : t('Corriger + renvoyer', 'Fix + resend')}
                      </button>
                    )}
                    {msg?.rid === r.id && (
                      <p className={`mt-1 ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>
                    )}
                  </td>
                </tr>,
                retryFor === r.id ? (
                  <tr key={`${r.id}-form`} className="bg-ink-50/60">
                    <td colSpan={5} className="px-4 py-3">
                      <p className="mb-2 text-xs text-ink-600">
                        {t("Corrige la ou les variables de template, puis renvoie ce message. La valeur est enregistrée sur le contact.", 'Fix the template variable(s), then resend this message. The value is saved on the contact.')}
                      </p>
                      {fieldKeys.length === 0 ? (
                        <p className="mb-2 text-xs text-ink-500">{t('Aucune variable de champ à corriger : renvoi tel quel (le contact a peut-être été mis à jour ailleurs).', 'No field variable to fix: resend as-is (the contact may have been updated elsewhere).')}</p>
                      ) : (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {fieldKeys.map((k) => (
                            <label key={k} className="text-xs text-ink-700">
                              <span className="mr-1 font-medium">{k}</span>
                              <input
                                value={vals[k] ?? ''}
                                onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
                                data-testid={`retry-field-${k}`}
                                placeholder={t('nouvelle valeur', 'new value')}
                                className="rounded border border-ink-300 px-2 py-1 text-sm outline-none focus:border-brand-500"
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void submitRetry(r)}
                          disabled={busy}
                          data-testid={`retry-submit-${r.id}`}
                          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
                        >
                          {busy ? t('Renvoi...', 'Resending...') : t('Renvoyer', 'Resend')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setRetryFor(null); setMsg(null); }}
                          className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-50"
                        >
                          {t('Annuler', 'Cancel')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
