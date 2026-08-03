'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { WorkflowBuilder } from '@/components/WorkflowBuilder';
import type { Session } from '@/lib/session';
import { listWorkflows, createWorkflow, getWorkflow, deleteWorkflow, updateWorkflow, duplicateWorkflow, getSettings, createWorkflowTestLink, type WorkflowSummary, type WorkflowTestLink } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';

export default function WorkflowsPage() {
  // Suspense : useSearchParams (deep-link ?open=) exige une frontière Suspense au build (Next 15).
  return (
    <AppShell active="workflows" fullBleed>
      {(session) => (
        <Suspense fallback={null}>
          <WorkflowsInner session={session} />
        </Suspense>
      )}
    </AppShell>
  );
}

function WorkflowsInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  // MBA actif chez le tenant ? Gouverne l'activation des blocs MBA (grisés sinon) dans le builder. Défaut prudent : false.
  const [mbaEnabled, setMbaEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<WorkflowSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Menu « 3 points » ouvert (id de la ligne) + renommage en cours.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WorkflowSummary | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // Lien de test (Lot F) : jeton stable + lien wa.me + QR (rendu en data-URL par la lib, aucun appel réseau).
  const [testing, setTesting] = useState<{ wf: WorkflowSummary; link: WorkflowTestLink; qr: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  // Date + heure de création (fuseau Paris). Vide/invalide (objet transitoire juste après création) -> '-'.
  const createdLabel = (iso: string): string =>
    iso && !Number.isNaN(Date.parse(iso)) ? `${formatDate(iso, locale)} ${hourMin(iso, locale)}` : '-';
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('open');
  const deepLinkApplied = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setWorkflows((await listWorkflows(session.tenantId)).workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  // MBA actif ? Best-effort, non bloquant : un échec laisse les blocs MBA grisés (défaut prudent).
  useEffect(() => {
    void getSettings(session.tenantId).then((s) => setMbaEnabled(s.mbaEnabled)).catch(() => {});
  }, [session.tenantId]);

  useEffect(() => { void load(); }, [load]);

  // Deep-link ?open=<id> (depuis Contenu > Blocs) : ouvre le scénario correspondant une fois la liste chargée,
  // une seule fois (pas de ré-ouverture après un retour manuel à la liste). Scénario absent -> ignoré.
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId || editing || workflows.length === 0) return;
    const match = workflows.find((w) => w.id === deepLinkId);
    if (match) {
      deepLinkApplied.current = true;
      void open(match);
    }
  }, [deepLinkId, workflows, editing]);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await createWorkflow(session.tenantId, name);
      setNewName('');
      setEditing({ id: res.id, name: res.name, graph: res.graph, createdAt: '', updatedAt: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Unable to create'));
    }
  }
  async function open(w: WorkflowSummary) {
    setError(null);
    try {
      const { workflow } = await getWorkflow(session.tenantId, w.id);
      setEditing(workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Ouverture impossible', 'Unable to open'));
    }
  }
  async function remove(w: WorkflowSummary) {
    setMenuFor(null);
    if (!window.confirm(t(`Supprimer le scénario « ${w.name} » ?`, `Delete the scenario "${w.name}"?`))) return;
    setError(null);
    setBusy(true);
    try {
      await deleteWorkflow(session.tenantId, w.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    } finally {
      setBusy(false);
    }
  }
  /**
   * Ouvre le panneau « Tester le scénario » : demande (ou récupère) le jeton stable du scénario, puis rend le
   * QR du lien wa.me. Le QR est calculé DANS le navigateur (data-URL), aucun service externe n'est appelé :
   * un lien de test ne doit pas transiter par un tiers.
   */
  async function openTest(w: WorkflowSummary) {
    setMenuFor(null);
    setError(null);
    setBusy(true);
    setCopied(false);
    try {
      const link = await createWorkflowTestLink(session.tenantId, w.id);
      let qr: string | null = null;
      if (link.link) {
        const QRCode = (await import('qrcode')).default;
        qr = await QRCode.toDataURL(link.link, { width: 220, margin: 1 });
      }
      setTesting({ wf: w, link, qr });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Lien de test indisponible', 'Test link unavailable'));
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(w: WorkflowSummary) {
    setMenuFor(null);
    setError(null);
    setBusy(true);
    try {
      await duplicateWorkflow(session.tenantId, w.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Duplication impossible', 'Unable to duplicate'));
    } finally {
      setBusy(false);
    }
  }
  function startRename(w: WorkflowSummary) {
    setMenuFor(null);
    setRenaming(w);
    setRenameVal(w.name);
  }
  async function submitRename() {
    if (busy || !renaming) return;
    const name = renameVal.trim();
    if (name === '' || name === renaming.name) { setRenaming(null); return; }
    setError(null);
    setBusy(true);
    try {
      await updateWorkflow(session.tenantId, renaming.id, { name });
      setRenaming(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Renommage impossible', 'Unable to rename'));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-3 p-3 lg:h-full">
        <div className="flex items-center justify-between">
          <button onClick={() => { setEditing(null); void load(); }} className="text-sm text-brand-600 hover:underline">← {t('Retour aux scénarios', 'Back to scenarios')}</button>
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{editing.name}</h2>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="min-h-0 flex-1">
          <WorkflowBuilder key={editing.id} tenantId={session.tenantId} workflowId={editing.id} initialGraph={editing.graph} mbaEnabled={mbaEnabled} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6 lg:h-full lg:overflow-y-auto">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Scénarios', 'Scenarios')}</h2>
        <p className="mt-1 text-sm text-ink-500">{t("Construis des automatisations en blocs : ajout de tag, envoi d'un template, formulaire, arrivée en inbox. Un scénario s'attache à une campagne et s'exécute pour chaque contact.", 'Build automations in blocks: add a tag, send a template, form, arrival in the inbox. A scenario attaches to a campaign and runs for each contact.')}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('Nom du scénario…', 'Scenario name…')}
          className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button onClick={create} disabled={newName.trim() === ''} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">{t('Créer un scénario', 'Create a scenario')}</button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Scénarios', 'Scenarios')} ({workflows.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : workflows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun scénario. Crée-en un ci-dessus.', 'No scenarios yet. Create one above.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Blocs', 'Blocks')}</th>
                <th className="px-5 py-2 font-medium">{t('Créé le', 'Created')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3">
                    <button onClick={() => open(w)} className="font-medium text-brand-600 hover:underline">{w.name}</button>
                    {w.code && <div className="font-mono text-[10px] text-ink-300" title={t('Code public (API)', 'Public code (API)')}>{w.code}</div>}
                  </td>
                  <td className="px-5 py-3 text-ink-500">{w.graph.nodes.length}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-ink-500">{createdLabel(w.createdAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => open(w)} className="font-medium text-brand-600 hover:text-brand-700">{t('Ouvrir', 'Open')}</button>
                      <div className="relative">
                        <button
                          onClick={() => setMenuFor((m) => (m === w.id ? null : w.id))}
                          disabled={busy}
                          className="rounded px-1.5 py-0.5 text-lg leading-none text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-50"
                          aria-label={t('Plus d\'actions', 'More actions')}
                          data-testid={`workflow-menu-${w.id}`}
                        >
                          ⋯
                        </button>
                        {menuFor === w.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                            <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-ink-200 bg-white py-1 text-left text-sm shadow-lg">
                              <button onClick={() => { void openTest(w); }} data-testid={`workflow-test-${w.id}`} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Tester le scénario', 'Test scenario')}</button>
                              <button onClick={() => startRename(w)} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Renommer', 'Rename')}</button>
                              <button onClick={() => duplicate(w)} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Dupliquer', 'Duplicate')}</button>
                              <div className="my-1 border-t border-ink-100" />
                              <button onClick={() => remove(w)} className="block w-full px-4 py-2 text-left text-coral hover:bg-red-50">{t('Supprimer', 'Delete')}</button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {testing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={() => setTesting(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="workflow-test-panel">
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{t('Tester « ', 'Test "')}{testing.wf.name}{t(' »', '"')}</h3>
            <p className="mt-1 text-sm text-ink-500">
              {t(
                'Scanne ce QR code avec ton téléphone, ou ouvre le lien. WhatsApp s’ouvre avec le mot déjà écrit : appuie sur Envoyer et le scénario démarre sur ton propre numéro.',
                'Scan this QR code with your phone, or open the link. WhatsApp opens with the word already typed: press Send and the scenario starts on your own number.',
              )}
            </p>

            {testing.link.link ? (
              <>
                {testing.qr && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={testing.qr} alt={t('QR code du lien de test', 'Test link QR code')} className="mx-auto my-4 h-[220px] w-[220px] rounded-lg border border-ink-200" />
                )}
                <div className="flex items-center gap-2">
                  <input readOnly value={testing.link.link} className="w-full rounded-lg border border-ink-300 bg-ink-50 px-3 py-1.5 text-xs text-ink-600" />
                  <button
                    onClick={() => { void navigator.clipboard.writeText(testing.link.link ?? '').then(() => setCopied(true)); }}
                    className="shrink-0 rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                  >
                    {copied ? t('Copié', 'Copied') : t('Copier', 'Copy')}
                  </button>
                </div>
              </>
            ) : (
              <p className="my-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t(
                  'Aucun numéro WhatsApp connecté : envoie le mot ci-dessous à ton numéro professionnel pour lancer le test.',
                  'No WhatsApp number connected: send the word below to your business number to start the test.',
                )}
              </p>
            )}

            <p className="mt-3 text-xs text-ink-500">
              {t('Mot à envoyer : ', 'Word to send: ')}
              <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-ink-800">{testing.link.token}</code>
            </p>
            <p className="mt-2 text-xs text-ink-400">
              {t(
                'Ce lien est permanent pour ce scénario. La conversation de test est marquée comme telle : ses messages ne comptent ni dans les statistiques, ni dans l’analyse. Le numéro qui teste apparaît en revanche comme un contact du mini-CRM, comme n’importe quel numéro qui écrit.',
                'This link is permanent for this scenario. The test conversation is flagged as such: its messages count neither in statistics nor in analysis. The testing number does appear as a mini-CRM contact, like any number that writes in.',
              )}
            </p>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setTesting(null)} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600">{t('Fermer', 'Close')}</button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={() => setRenaming(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{t('Renommer le scénario', 'Rename scenario')}</h3>
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); if (e.key === 'Escape') setRenaming(null); }}
              className="mt-4 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder={t('Nom du scénario', 'Scenario name')}
              data-testid="workflow-rename-input"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setRenaming(null)} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-ink-500 hover:text-ink-800 disabled:opacity-50">{t('Annuler', 'Cancel')}</button>
              <button onClick={() => void submitRename()} disabled={busy || renameVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">{t('Renommer', 'Rename')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
