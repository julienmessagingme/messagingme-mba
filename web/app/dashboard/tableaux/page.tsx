'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import {
  listWorkflows, getWorkflow, getWorkflowNodeCounts, listWorkflowReports, saveWorkflowReport, deleteWorkflowReport,
  type StatsRange, type WorkflowSummary, type TableauEnregistre,
} from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';
import { cardCls, inputClsAuto } from '@/lib/ui';
import { ScenarioCanvas } from '@/components/ScenarioCanvas';
import { TableauHistogramme } from '@/components/TableauHistogramme';
import { BoutonPdf } from '@/components/BoutonPdf';
import {
  blocsDuScenario, mesuresDisponibles, handlesMesuresParBloc, groupesDuTableau,
  type BlocMesurable, type CompteurBrut, type MesureDispo,
} from '@/lib/mesures-scenario';

/**
 * Analytics > Mes tableaux : construire son propre tableau de mesures sur un scénario.
 *
 * ⚠️ Les mesures n'existent QUE depuis la mise en place de l'instrumentation : rien ne reliait auparavant un
 * message envoyé au bloc qui l'avait envoyé. Une période antérieure rend donc un tableau vide, et c'est le
 * comportement juste, pas une panne. L'écran le dit plutôt que de laisser chercher.
 *
 * Le scénario s'affiche TEL QU'IL EST DESSINÉ dans l'onglet Scénario (mêmes positions, mêmes flèches) : on
 * retrouve son parcours au lieu d'en lire une transcription. Le rendu vit dans `ScenarioCanvas`, un composant
 * SÉPARÉ du builder : celui-ci porte l'auto-save, et lui ajouter un mode « lecture seule » aurait mis un
 * enregistrement automatique à un clic d'un écran de consultation.
 *
 * L'ORDRE DU PARCOURS reste calculé (`blocsDuScenario`) : il ne sert plus à l'affichage du scénario, mais au
 * regroupement du tableau et à savoir quel bloc est le PREMIER message.
 */
export default function MesTableauxPage() {
  return <AppShell active="dashboard-tableaux">{(session) => <TableauxInner session={session} />}</AppShell>;
}

function TableauxInner({ session }: { session: Session }) {
  const t = useT();
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [scenarios, setScenarios] = useState<WorkflowSummary[]>([]);
  const [choisi, setChoisi] = useState('');
  const [graph, setGraph] = useState<{ nodes: unknown[]; edges: unknown[] } | null>(null);
  const [counts, setCounts] = useState<CompteurBrut[]>([]);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  /** Mesures retenues, par clé. L'ordre d'insertion est celui d'affichage : l'opérateur compose son tableau. */
  const [retenues, setRetenues] = useState<MesureDispo[]>([]);
  const [ouvert, setOuvert] = useState<string | null>(null);
  // Tableaux enregistrés de l'espace, et celui qui est ouvert (vide = un tableau neuf, pas encore enregistré).
  const [tableaux, setTableaux] = useState<TableauEnregistre[]>([]);
  const [ouvertId, setOuvertId] = useState('');
  const [nom, setNom] = useState('');
  const [etat, setEtat] = useState<string | null>(null);
  /**
   * Mesures à réappliquer APRÈS le chargement d'un scénario. Ouvrir un tableau change le scénario, ce qui
   * relance le chargement, lequel vide la sélection : sans ce relais, le tableau qu'on vient d'ouvrir
   * s'effacerait aussitôt.
   *
   * Une RÉFÉRENCE et non un état : c'est un passage de main ponctuel, que rien n'affiche. En état, il faudrait
   * le déclarer en dépendance de l'effet, et le remettre à null y relancerait le chargement, qui effacerait la
   * sélection qu'on vient tout juste de poser.
   */
  const aAppliquer = useRef<MesureDispo[] | null>(null);

  useEffect(() => {
    listWorkflows(session.tenantId).then((r) => setScenarios(r.workflows)).catch(() => setScenarios([]));
    listWorkflowReports(session.tenantId).then((r) => setTableaux(r.reports)).catch(() => setTableaux([]));
  }, [session.tenantId]);

  // Changer de scénario repart d'un tableau VIDE : les mesures retenues désignent des blocs de l'ancien, les
  // garder afficherait des barres à zéro sans rapport avec ce qu'on regarde.
  useEffect(() => {
    if (choisi === '') { setGraph(null); setCounts([]); setRetenues([]); return; }
    let vivant = true;
    setChargement(true);
    setErreur(null);
    Promise.all([getWorkflow(session.tenantId, choisi), getWorkflowNodeCounts(session.tenantId, choisi, range)])
      .then(([w, c]) => {
        if (!vivant) return;
        setGraph(w.workflow.graph as { nodes: unknown[]; edges: unknown[] });
        setCounts(c.counts);
        // Une sélection en attente vient d'un tableau qu'on ouvre : elle remplace la sélection courante.
        // Sinon on repart d'un tableau vide, les mesures désignant des blocs de l'ancien scénario.
        setRetenues(aAppliquer.current ?? []);
        aAppliquer.current = null;
      })
      .catch((err: unknown) => { if (vivant) setErreur(err instanceof Error ? err.message : t('Mesures illisibles', 'Measures unreadable')); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [session.tenantId, choisi, range, t]);

  const blocs = useMemo<BlocMesurable[]>(
    () => (graph ? blocsDuScenario(graph as never, handlesMesuresParBloc(counts)) : []),
    [graph, counts],
  );
  // Le PREMIER bloc de message du parcours : lui seul propose « Échecs » et « Délivrés » (cf. mesuresDisponibles).
  const premierMessage = useMemo(() => blocs.find((b) => b.mesurable)?.id ?? '', [blocs]);
  const blocOuvert = useMemo(() => blocs.find((b) => b.id === ouvert && b.mesurable) ?? null, [blocs, ouvert]);
  /** Combien de mesures retenues par bloc : la pastille sur la carte dit d'un coup d'oeil ce qui compose le tableau. */
  const retenuesParBloc = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of retenues) {
      const id = m.cle.split('|')[0]!;
      out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }, [retenues]);

  /** Les groupes de barres, dans l'ordre du parcours. Recalcules a chaque changement de selection ou de periode. */
  const groupes = useMemo(() => groupesDuTableau(retenues, counts, blocs), [retenues, counts, blocs]);

  const basculer = (m: MesureDispo): void => {
    setEtat(null);
    setRetenues((prev) => (prev.some((x) => x.cle === m.cle) ? prev.filter((x) => x.cle !== m.cle) : [...prev, m]));
  };

  /** Ouvre un tableau enregistré : son scénario, puis sa sélection (via le relais `aAppliquer`). */
  function ouvrirTableau(id: string): void {
    setOuvertId(id);
    setEtat(null);
    const tb = tableaux.find((x) => x.id === id);
    if (!tb) { setNom(''); aAppliquer.current = null; setRetenues([]); return; }
    setNom(tb.name);
    // Scénario DÉJÀ chargé : le relais ne servirait à rien, l'effet de chargement ne se relancerait pas
    // (sa dépendance `choisi` ne change pas) et la sélection ne s'appliquerait jamais.
    if (tb.workflowId === choisi) { setRetenues(tb.mesures as MesureDispo[]); return; }
    aAppliquer.current = tb.mesures as MesureDispo[];
    setChoisi(tb.workflowId);
  }

  async function enregistrer(): Promise<void> {
    setEtat(null);
    try {
      const { report } = await saveWorkflowReport(session.tenantId, {
        ...(ouvertId ? { id: ouvertId } : {}),
        workflowId: choisi, name: nom.trim(), mesures: retenues,
      });
      setOuvertId(report.id);
      setTableaux((prev) => [report, ...prev.filter((x) => x.id !== report.id)]);
      setEtat(t('Tableau enregistré.', 'Report saved.'));
    } catch (err) {
      setEtat(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
    }
  }

  async function supprimer(): Promise<void> {
    if (!ouvertId) return;
    try {
      await deleteWorkflowReport(session.tenantId, ouvertId);
      setTableaux((prev) => prev.filter((x) => x.id !== ouvertId));
      setOuvertId('');
      setNom('');
      setRetenues([]);
      setEtat(t('Tableau supprimé.', 'Report deleted.'));
    } catch (err) {
      setEtat(err instanceof Error ? err.message : t('Suppression impossible', 'Could not delete'));
    }
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Mes tableaux', 'My reports')}</h2>
        <p className="text-sm text-ink-600">
          {t(
            'Choisis un scénario, puis les mesures que tu veux suivre bloc par bloc.',
            'Pick a scenario, then the measures you want to follow block by block.',
          )}
        </p>
      </header>

      <RangeBar title={t('Période', 'Period')} range={range} onChange={setRange} />

      {tableaux.length > 0 && (
        <section className={cardCls}>
          <label className="mb-1 block text-sm font-medium text-ink-700">{t('Ouvrir un tableau enregistré', 'Open a saved report')}</label>
          <select
            value={ouvertId}
            onChange={(e) => ouvrirTableau(e.target.value)}
            data-testid="tableaux-enregistres"
            className={`${inputClsAuto} w-full bg-white sm:w-96`}
          >
            <option value="">{t('Nouveau tableau', 'New report')}</option>
            {tableaux.map((tb) => <option key={tb.id} value={tb.id}>{tb.name}</option>)}
          </select>
        </section>
      )}

      <section className={cardCls}>
        <label className="mb-1 block text-sm font-medium text-ink-700">{t('Scénario', 'Scenario')}</label>
        <select
          value={choisi}
          onChange={(e) => setChoisi(e.target.value)}
          data-testid="tableaux-scenario"
          className={`${inputClsAuto} w-full bg-white sm:w-96`}
        >
          <option value="">{t('Choisir un scénario…', 'Choose a scenario…')}</option>
          {scenarios.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </section>

      {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
      {chargement && <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>}

      {/* `graph` conditionne le rendu, et pas seulement `chargement` : entre le choix du scenario et le premier
          passage de l'effet, l'ecran se rend une fois avec `chargement` encore a faux et le graphe encore nul. */}
      {choisi !== '' && graph !== null && !chargement && !erreur && (
        <>
          <section className={cardCls} data-testid="tableaux-blocs">
            <h3 className="mb-1 text-sm font-semibold text-ink-900">{t('Le scénario', 'The scenario')}</h3>
            <p className="mb-3 text-xs text-ink-500">
              {t(
                'Clique un bloc de message pour choisir ce que tu veux compter. Les blocs grisés n’envoient rien, il n’y a rien à y mesurer.',
                'Click a message block to choose what to count. Greyed blocks send nothing, there is nothing to measure there.',
              )}
            </p>
            <div className="flex flex-col gap-4 lg:flex-row">
              <div className="min-w-0 flex-1">
                <ScenarioCanvas
                  graph={graph as never}
                  blocs={blocs}
                  selectionne={ouvert}
                  onSelect={(id) => setOuvert((o) => (o === id ? null : id))}
                  retenuesParBloc={retenuesParBloc}
                />
              </div>

              {/* Panneau du bloc choisi, à droite du canevas comme dans l'éditeur : le même geste (cliquer un
                  bloc, régler à droite) évite de réapprendre l'écran. */}
              <aside className="w-full shrink-0 lg:w-72">
                {blocOuvert ? (
                  <div className="rounded-xl border border-brand-200 bg-brand-50/30 p-3" data-testid="bloc-mesures">
                    <p className="mb-2 truncate text-sm font-semibold text-ink-900">{blocOuvert.titre}</p>
                    <div className="space-y-1.5">
                      {mesuresDisponibles(blocOuvert, blocOuvert.id === premierMessage).map((m) => (
                        <label key={m.cle} className="flex items-center gap-2 text-sm text-ink-700">
                          <input
                            type="checkbox"
                            checked={retenues.some((x) => x.cle === m.cle)}
                            onChange={() => basculer(m)}
                            data-testid={`mesure-${m.kind}`}
                            className="h-4 w-4"
                          />
                          {m.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-ink-200 p-3 text-sm text-ink-400">
                    {t('Choisis un bloc dans le scénario.', 'Pick a block in the scenario.')}
                  </p>
                )}
              </aside>
            </div>
          </section>

          <section id="mes-tableaux-rendu" className={cardCls}>
            <div className="mb-3 flex items-center gap-2">
              {/* Le nom du tableau sur la feuille : sorti sans lui, un PDF de barres ne dit pas ce qu'il mesure. */}
              <h3 className="text-sm font-semibold text-ink-900">{nom.trim() === '' ? t('Le tableau', 'The report') : nom.trim()}</h3>
              {retenues.length > 0 && <BoutonPdf zone="mes-tableaux-rendu" />}
            </div>
            {retenues.length === 0 ? (
              <p className="text-sm text-ink-500">
                {t('Clique un bloc du scénario pour choisir ce que tu veux compter.', 'Click a block in the scenario to choose what to count.')}
              </p>
            ) : (
              <>
                <TableauHistogramme groupes={groupes} />
                <p className="mt-3 text-xs text-ink-400">
                  {t(
                    'Les mesures démarrent à la mise en service du suivi : une période antérieure reste à zéro.',
                    'Measurement starts when tracking was switched on: an earlier period stays at zero.',
                  )}
                </p>
              </>
            )}
          </section>

          {retenues.length > 0 && (
            <section className={cardCls}>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[12rem]">
                  <label className="mb-1 block text-sm font-medium text-ink-700">{t('Nom du tableau', 'Report name')}</label>
                  <input
                    value={nom}
                    onChange={(e) => { setNom(e.target.value); setEtat(null); }}
                    placeholder={t('Ex. Entonnoir Randstad', 'e.g. Randstad funnel')}
                    data-testid="tableau-nom"
                    className={`${inputClsAuto} w-full`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void enregistrer()}
                  disabled={nom.trim() === ''}
                  data-testid="tableau-enregistrer"
                  className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {ouvertId ? t('Mettre à jour', 'Update') : t('Enregistrer', 'Save')}
                </button>
                {ouvertId !== '' && (
                  <button
                    type="button"
                    onClick={() => void supprimer()}
                    data-testid="tableau-supprimer"
                    className="rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                  >
                    {t('Supprimer', 'Delete')}
                  </button>
                )}
              </div>
              {etat && <p className="mt-2 text-sm text-ink-600" data-testid="tableau-etat">{etat}</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
