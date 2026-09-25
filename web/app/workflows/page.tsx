'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { WorkflowBuilder } from '@/components/WorkflowBuilder';
import type { Session } from '@/lib/session';
import { listWorkflows, createWorkflow, getWorkflow, deleteWorkflow, updateWorkflow, duplicateWorkflow, getSettings, createWorkflowTestLink, listEmailAccounts, grapheEditable, type WorkflowSummary, type WorkflowTestLink } from '@/lib/api';
import { listAgents, type AgentResume } from '@/lib/api-agent';
import { listUsers, type AdminUser } from '@/lib/api/compte';
import { listRequetes, type RequeteApi } from '@/lib/api-agent-requetes';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';

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
  const [rcsEnabled, setRcsEnabled] = useState(false);
  // Au moins une boîte SMTP connectée ? Gouverne le bloc « Envoi de mail » (grisé sinon), même doctrine que RCS.
  // Dérivé de `listEmailAccounts` (pas de `getSettings`, contrairement à rcsEnabled) : contrairement à l'agent
  // RCS, une boîte email n'a pas de réglage tenant dédié, sa seule preuve d'existence est la liste elle-même.
  const [emailEnabled, setEmailEnabled] = useState(false);
  // Agents IA ACTIFS : gouverne la brique « Agent IA » (grisée tant que la liste est vide) et alimente son
  // sélecteur. `null` tant que la lecture n'a pas abouti, pour ne pas affirmer qu'un agent a disparu.
  const [agents, setAgents] = useState<AgentResume[] | null>(null);
  /**
   * Les MEMBRES de l'équipe, pour le sélecteur du bloc « passer à un humain ».
   *
   * ⚠️ Les comptes RÉVOQUÉS et les invitations EN ATTENTE sont retirés : affecter une conversation à
   * quelqu'un qui ne peut pas se connecter la rendrait invisible de tous les autres, ce qui est exactement
   * la conversation qu'on ne veut pas perdre. Le serveur refuse de toute façon, mais proposer un nom qu'il
   * refusera est une invitation à l'échec.
   */
  const [membres, setMembres] = useState<AdminUser[] | null>(null);
  /** Les appels de Tools > Connecteurs API : ils GATENT le bloc « Appel API » et alimentent son sélecteur. */
  const [requetes, setRequetes] = useState<RequeteApi[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<WorkflowSummary | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * LES SCÉNARIOS COCHÉS, pour l'action groupée.
   *
   * 🔴 DEMANDÉ PAR JULIEN LE 2026-09-14 : « il faut que je puisse sélectionner plusieurs scénarios avec des
   * petites cases à cocher à côté et que je puisse appliquer une bulk action (pour l'instant "supprimer"
   * juste) ». Supprimer dix scénarios d'essai demandait dix ouvertures de menu et dix confirmations.
   *
   * ⚠️ UN `Set` RECOPIÉ À CHAQUE CHANGEMENT, jamais muté en place : muter garderait la même référence et
   * React ne rendrait rien, ce qui donnerait une case qui ne se coche qu'une fois sur deux.
   */
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  // Menu « 3 points » ouvert (id de la ligne) + renommage en cours.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<WorkflowSummary | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // Lien de test (Lot F) : jeton stable + lien wa.me + QR (rendu en data-URL par la lib, aucun appel réseau).
  const [testing, setTesting] = useState<{
    wf: WorkflowSummary;
    /** Le MOT à envoyer : le jeton seul, ou `jeton.<identifiant du bloc>` quand on teste à partir d'un bloc. */
    mot: string;
    /** Le lien wa.me pré-rempli avec ce mot. `null` = aucun numéro WhatsApp connecté. */
    lien: string | null;
    qr: string | null;
  } | null>(null);
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
    void getSettings(session.tenantId).then((s) => { setMbaEnabled(s.mbaEnabled); setRcsEnabled(s.rcsEnabled === true); }).catch(() => {});
  }, [session.tenantId]);

  // Une boîte email existe-t-elle ? Best-effort, non bloquant : un échec laisse le bloc Email grisé (défaut prudent).
  useEffect(() => {
    void listEmailAccounts(session.tenantId).then((r) => setEmailEnabled(r.accounts.length > 0)).catch(() => {});
  }, [session.tenantId]);

  // Best-effort, non bloquant : un échec laisse la brique grisée, défaut prudent, comme pour le bloc Email.
  useEffect(() => {
    void listAgents(session.tenantId).then(setAgents).catch(() => {});
    // Échec silencieux comme pour les agents : le sélecteur s'affiche vide, l'éditeur reste utilisable.
    void listUsers(session.tenantId)
      .then((r) => setMembres(r.users.filter((u) => !u.disabled && !u.pending)))
      .catch(() => {});
    void listRequetes(session.tenantId).then((r) => setRequetes(r.requetes)).catch(() => {});
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
  /**
   * SUPPRIME TOUS LES SCÉNARIOS COCHÉS.
   *
   * ⚠️ UN PAR UN, EN SÉRIE, ET PAS EN PARALLÈLE. Il n'existe pas de route de suppression groupée : dix
   * appels simultanés sur un plafond de débit partagé avec toute la console se feraient refuser au milieu,
   * et l'écran annoncerait un échec sur des scénarios pourtant supprimés.
   *
   * ⚠️ ON S'ARRÊTE À LA PREMIÈRE ERREUR et on recharge : la liste dit alors exactement ce qui reste, plutôt
   * que de laisser croire que tout est parti.
   */
  async function removeSelection() {
    const ids = [...selection];
    if (ids.length === 0) return;
    const noms = workflows.filter((w) => selection.has(w.id)).map((w) => w.name);
    // 🔴 LA CONFIRMATION NOMME CE QU'ELLE DÉTRUIT, comme la suppression unitaire : « Supprimer 7 éléments ? »
    // ne permet pas de vérifier qu'on n'a pas coché une ligne de trop.
    const liste = noms.slice(0, 5).join(', ') + (noms.length > 5 ? `, … (+${noms.length - 5})` : '');
    if (!window.confirm(t(
      `Supprimer ${ids.length} scénario(s) ? ${liste}`,
      `Delete ${ids.length} scenario(s)? ${liste}`,
    ))) return;
    setError(null);
    setBusy(true);
    try {
      for (const id of ids) await deleteWorkflow(session.tenantId, id);
      setSelection(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    } finally {
      setBusy(false);
      await load();
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
  async function openTest(w: WorkflowSummary, nodeId?: string) {
    setMenuFor(null);
    setError(null);
    setBusy(true);
    setCopied(false);
    try {
      const link = await createWorkflowTestLink(session.tenantId, w.id);
      // 🔴 L'IDENTIFIANT DU BLOC EST COLLÉ TEL QUEL, sans aucune transformation. Le serveur compare par
      // ÉGALITÉ (`lireJetonDeTest`, côté `src/`). Normaliser ici (retirer les tirets, tronquer) créerait un
      // invariant partagé de part et d'autre d'une frontière que ce dépôt interdit de franchir (aucun fichier
      // de `web/` n'importe `src/`), donc recopié à la main des deux côtés, donc voué à diverger en silence.
      const mot = nodeId ? `${link.token}.${nodeId}` : link.token;
      // ⚠️ ON RÉÉCRIT LE PARAMÈTRE `text` DU LIEN RENDU PAR LE SERVEUR, on ne refabrique pas l'adresse : le
      // format de `wa.me` (le numéro sans `+` ni espaces) vit dans `src/lib/wa-me.ts` et doit y rester.
      //
      // ⚠️ MAIS L'ENCODAGE DU TEXTE, LUI, EST CELUI DU NAVIGATEUR, PAS LE NÔTRE (précisé en revue finale) :
      // `searchParams.set` puis `toString()` RE-SÉRIALISENT toute la requête, donc `encodeTexteWaMe`
      // (`src/lib/wa-me.ts`) est contourné, pas réutilisé. Les deux diffèrent sur `!'()*` et sur l'espace.
      // Sans conséquence ici, et c'est mesurable : le mot vaut `test-` + 8 caractères Crockford, plus un
      // identifiant de bloc dont les espaces ont déjà été retirés. Si un jour ce mot pouvait porter autre
      // chose, c'est cette ligne qu'il faudrait reprendre, pas le module serveur.
      let lien = link.link;
      if (lien !== null && nodeId) {
        const u = new URL(lien);
        u.searchParams.set('text', mot);
        lien = u.toString();
      }
      let qr: string | null = null;
      if (lien) {
        const QRCode = (await import('qrcode')).default;
        qr = await QRCode.toDataURL(lien, { width: 220, margin: 1 });
      }
      setTesting({ wf: w, mot, lien, qr });
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

  /**
   * LE PANNEAU DE TEST, calculé AVANT la sortie anticipée du constructeur et rendu dans les DEUX vues.
   *
   * 🔴 IL NE VIVAIT QUE DANS LA LISTE, et c'est ce qui a cassé le bouton lecture des blocs : `if (editing)`
   * rend le constructeur et sort, donc le panneau n'était jamais monté depuis là. Le recopier dans les deux
   * branches aurait créé deux vérités à tenir alignées à la main, sur un écran qui porte un lien envoyé à de
   * vrais téléphones.
   */
  const panneauDeTest = testing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={() => setTesting(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-mm-lg" onClick={(e) => e.stopPropagation()} data-testid="workflow-test-panel">
            <h3 className="text-lg font-semibold text-ink-900">{t('Tester « ', 'Test "')}{testing.wf.name}{t(' »', '"')}</h3>
            <p className="mt-1 text-sm text-ink-500">
              {t(
                'Scanne ce QR code avec ton téléphone, ou ouvre le lien. WhatsApp s’ouvre avec le mot déjà écrit : appuie sur Envoyer et le scénario démarre sur ton propre numéro.',
                'Scan this QR code with your phone, or open the link. WhatsApp opens with the word already typed: press Send and the scenario starts on your own number.',
              )}
            </p>
            {/* ⚠️ AUCUN AVERTISSEMENT SUR LES ÉTAPES SAUTÉES, et c'est une DÉCISION, pas un oubli. Julien, le
                2026-09-16 : « si on saute des étapes parce que la personne a décidé de tester qu'un bout du
                scénario, et bien tant pis ! il ne se passe rien ». Un bandeau a été ajouté ici puis RETIRÉ le
                jour même, quand la revue finale a montré qu'il inversait cette décision en silence. */}

            {testing.lien ? (
              <>
                {testing.qr && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={testing.qr} alt={t('QR code du lien de test', 'Test link QR code')} className="mx-auto my-4 h-[220px] w-[220px] rounded-lg border border-ink-200" />
                )}
                <div className="flex items-center gap-2">
                  <input readOnly value={testing.lien} data-testid="workflow-test-lien" className="w-full rounded-lg border border-ink-300 bg-ink-50 px-3 py-1.5 text-xs text-ink-500" />
                  <Bouton variante="secondaire" taille="petite"
                    onClick={() => { void navigator.clipboard.writeText(testing.lien ?? '').then(() => setCopied(true)); }}
                    className="shrink-0"
                  >
                    {copied ? t('Copié', 'Copied') : t('Copier', 'Copy')}
                  </Bouton>
                </div>
              </>
            ) : (
              <p className="my-4 rounded-lg border border-alerte-300 bg-alerte-50 px-3 py-2 text-xs text-alerte-800">
                {t(
                  'Aucun numéro WhatsApp connecté : envoie le mot ci-dessous à ton numéro professionnel pour lancer le test.',
                  'No WhatsApp number connected: send the word below to your business number to start the test.',
                )}
              </p>
            )}

            <p className="mt-3 text-xs text-ink-500">
              {t('Mot à envoyer : ', 'Word to send: ')}
              <code data-testid="workflow-test-mot" className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-ink-900">{testing.mot}</code>
            </p>
            <p className="mt-2 text-xs text-ink-400">
              {t(
                'Ce lien est permanent pour ce scénario. La conversation de test est marquée comme telle : ses messages ne comptent ni dans les statistiques, ni dans l’analyse. Le numéro qui teste apparaît en revanche comme un contact du mini-CRM, comme n’importe quel numéro qui écrit.',
                'This link is permanent for this scenario. The test conversation is flagged as such: its messages count neither in statistics nor in analysis. The testing number does appear as a mini-CRM contact, like any number that writes in.',
              )}
            </p>
            <div className="mt-5 flex justify-end">
              <Bouton onClick={() => setTesting(null)}>{t('Fermer', 'Close')}</Bouton>
            </div>
          </div>
        </div>
  );

  /**
   * ⚠️ STABLE, ET C'EST LA MOITIÉ QUI VIT ICI (seconde passe de revue finale, 2026-09-16). Le constructeur
   * mémoïse la valeur du contexte que TOUS ses blocs consomment ; une flèche écrite en ligne dans le JSX
   * ci-dessous changeait d'identité à chaque rendu de cette page, ce qui rendait cette mémoïsation inerte
   * et faisait re-rendre le canevas entier. Les deux moitiés doivent tenir.
   */
  const ouvrirTestDepuisBloc = useCallback((nodeId: string) => {
    if (editing) void openTest(editing, nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    return (
      <div className="flex flex-col gap-3 p-3 lg:h-full">
        <div className="flex items-center justify-between">
          <button onClick={() => { setEditing(null); void load(); }} className="text-sm text-brand-600 hover:underline">← {t('Retour aux scénarios', 'Back to scenarios')}</button>
          <TitrePage>{editing.name}</TitrePage>
        </div>
        {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        <div className="min-h-0 flex-1">
          {/* L'éditeur ouvre le BROUILLON s'il y en a un (lot 7) : c'est le travail en cours de l'auteur, pas
              forcément ce qui tourne. `brouillonInitial` allume le bouton « Publier » dès l'ouverture. */}
          <WorkflowBuilder key={editing.id} tenantId={session.tenantId} workflowId={editing.id} initialGraph={grapheEditable(editing)} brouillonInitial={Boolean(editing.draftGraph)} publieLe={editing.publishedAt ?? null} mbaEnabled={mbaEnabled} rcsEnabled={rcsEnabled} emailEnabled={emailEnabled} agents={agents} membres={membres} requetes={requetes} onTesterBloc={ouvrirTestDepuisBloc} />
        </div>
        {panneauDeTest}
      </div>
    );
  }

  // ⚠️ `max-w-6xl` ET NON `3xl` (demandé par Julien le 2026-09-14, même raison que l'écran MBA le
  // 2026-09-10) : la liste porte quatre colonnes plus une case à cocher, et une ligne de scénario au nom
  // long y passait à la ligne dans une colonne étroite au milieu d'un écran vide.
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:h-full lg:overflow-y-auto">
      <div>
        <TitrePage>{t('Scénarios', 'Scenarios')}</TitrePage>
        <IntroPage>{t("Construis des automatisations en blocs : ajout d’étiquette, envoi d'un template, formulaire, arrivée en inbox. Un scénario s'attache à une campagne et s'exécute pour chaque contact.", 'Build automations in blocks: add a tag, send a template, form, arrival in the inbox. A scenario attaches to a campaign and runs for each contact.')}</IntroPage>
      </div>
      {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('Nom du scénario…', 'Scenario name…')}
          className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <Bouton onClick={create} disabled={newName.trim() === ''}>{t('Créer un scénario', 'Create a scenario')}</Bouton>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Scénarios', 'Scenarios')} ({workflows.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : workflows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun scénario. Crée-en un ci-dessus.', 'No scenarios yet. Create one above.')}</p>
        ) : (
          <>
          {/*
            🔴 LA BARRE N'APPARAÎT QUE QUAND QUELQUE CHOSE EST COCHÉ. Un bouton « Supprimer » toujours
            visible et grisé occuperait la place et ferait chercher pourquoi il ne réagit pas ; ici, il
            n'existe que lorsqu'il a un objet.
          */}
          {selection.size > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-lg bg-ink-50 px-4 py-2" data-testid="workflows-barre-selection">
              <span className="text-sm text-ink-900">
                {selection.size === 1
                  ? t('1 scénario sélectionné', '1 scenario selected')
                  : t(`${selection.size} scénarios sélectionnés`, `${selection.size} scenarios selected`)}
              </span>
              <div className="flex items-center gap-3">
                <button onClick={() => setSelection(new Set())} className="text-sm text-ink-500 hover:text-ink-900">
                  {t('Annuler', 'Cancel')}
                </button>
                <button
                  onClick={() => { void removeSelection(); }}
                  disabled={busy}
                  data-testid="workflows-supprimer-selection"
                  className="rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {t('Supprimer', 'Delete')}
                </button>
              </div>
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="w-10 px-3 py-2">
                  {/* ⚠️ « Tout cocher » porte sur la LISTE AFFICHÉE, ce qui est la seule promesse tenable :
                      une liste filtrée un jour ne devrait pas cocher ce qu'elle ne montre pas. */}
                  <input
                    type="checkbox"
                    aria-label={t('Tout sélectionner', 'Select all')}
                    data-testid="workflows-tout-cocher"
                    checked={workflows.length > 0 && selection.size === workflows.length}
                    onChange={(e) => setSelection(e.target.checked ? new Set(workflows.map((w) => w.id)) : new Set())}
                  />
                </th>
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Blocs', 'Blocks')}</th>
                <th className="px-5 py-2 font-medium">{t('Créé le', 'Created')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w, i) => (
                <tr key={w.id} className="border-b border-ink-50 last:border-0">
                  <td className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={t(`Sélectionner ${w.name}`, `Select ${w.name}`)}
                      data-testid={`workflow-cocher-${w.id}`}
                      checked={selection.has(w.id)}
                      onChange={() => setSelection((s) => {
                        // Une COPIE, jamais une mutation : muter garderait la même référence et React ne
                        // rendrait rien.
                        const suivant = new Set(s);
                        if (suivant.has(w.id)) suivant.delete(w.id); else suivant.add(w.id);
                        return suivant;
                      })}
                    />
                  </td>
                  <td className="px-5 py-3">
                    <button onClick={() => open(w)} className="font-medium text-brand-600 hover:underline">{w.name}</button>
                    {w.code && <div className="font-mono text-xs text-ink-400" title={t('Code public (API)', 'Public code (API)')}>{w.code}</div>}
                    {/* Un brouillon en attente se voit DEPUIS LA LISTE : sans ça, un scénario modifié mais
                        jamais publié aurait l'air en ligne, et c'est précisément l'erreur que le bouton
                        « Publier » peut faire commettre. */}
                    {(w.hasDraft ?? Boolean(w.draftGraph)) && (
                      <div className="mt-0.5 inline-block rounded bg-alerte-100 px-1.5 py-0.5 text-xs font-medium text-alerte-800" data-testid={`workflow-brouillon-${w.id}`}>
                        {t('brouillon non publié', 'unpublished draft')}
                      </div>
                    )}
                  </td>
                  {/* Le nombre de blocs de ce que l'auteur ÉDITE (brouillon s'il existe) : la liste sert à
                      retrouver son travail, pas à auditer la production. */}
                  <td className="px-5 py-3 text-ink-500">{w.nodeCount ?? grapheEditable(w).nodes.length}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-ink-500">{createdLabel(w.createdAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => open(w)} className="font-medium text-brand-600 hover:text-brand-700">{t('Ouvrir', 'Open')}</button>
                      <div className="relative">
                        <button
                          onClick={() => setMenuFor((m) => (m === w.id ? null : w.id))}
                          disabled={busy}
                          className="rounded px-1.5 py-0.5 text-lg leading-none text-ink-400 hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
                          aria-label={t('Plus d\'actions', 'More actions')}
                          data-testid={`workflow-menu-${w.id}`}
                        >
                          ⋯
                        </button>
                        {menuFor === w.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                            {/*
                              🔴 LE MENU S'OUVRE VERS LE HAUT SUR LES DERNIÈRES LIGNES (2026-09-14). Julien :
                              « quand je clique sur les 3 petits points, sur le dernier scénario, la fenêtre
                              s'ouvre vers le bas donc on ne voit rien ». Le menu fait cinq entrées, soit
                              environ quatre lignes de tableau : les DEUX dernières suffisent à le couvrir.

                              ⚠️ Et seulement si la liste est assez longue : sur trois scénarios, ouvrir vers
                              le haut ferait sortir le menu par le haut du tableau, ce qui déplace le défaut
                              au lieu de le corriger.
                            */}
                            <div className={`absolute right-0 z-20 w-44 overflow-hidden rounded-lg border border-ink-200 bg-white py-1 text-left text-sm shadow-mm-md ${
                              workflows.length > 3 && i >= workflows.length - 2 ? 'bottom-full mb-1' : 'mt-1'
                            }`}>
                              <button onClick={() => { void openTest(w); }} data-testid={`workflow-test-${w.id}`} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Tester le scénario', 'Test scenario')}</button>
                              <button onClick={() => startRename(w)} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Renommer', 'Rename')}</button>
                              <button onClick={() => duplicate(w)} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Dupliquer', 'Duplicate')}</button>
                              <div className="my-1 border-t border-ink-100" />
                              <button onClick={() => remove(w)} className="block w-full px-4 py-2 text-left text-danger hover:bg-danger-50">{t('Supprimer', 'Delete')}</button>
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
          </>
        )}
      </div>

      {panneauDeTest}

      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={() => setRenaming(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-mm-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-ink-900">{t('Renommer le scénario', 'Rename scenario')}</h3>
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
              <button onClick={() => setRenaming(null)} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-ink-500 hover:text-ink-900 disabled:opacity-50">{t('Annuler', 'Cancel')}</button>
              <Bouton onClick={() => void submitRename()} disabled={busy || renameVal.trim() === ''}>{t('Renommer', 'Rename')}</Bouton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
