'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { listWorkflows, getWorkflow, getWorkflowNodeCounts, type StatsRange, type WorkflowSummary } from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';
import { cardCls, inputClsAuto } from '@/lib/ui';
import {
  blocsDuScenario, mesuresDisponibles, valeurDe, handlesMesuresParBloc,
  type BlocMesurable, type CompteurBrut, type MesureDispo,
} from '@/lib/mesures-scenario';

/**
 * Analytics > Mes tableaux : construire son propre tableau de mesures sur un scénario.
 *
 * ⚠️ Les mesures n'existent QUE depuis la mise en place de l'instrumentation : rien ne reliait auparavant un
 * message envoyé au bloc qui l'avait envoyé. Une période antérieure rend donc un tableau vide, et c'est le
 * comportement juste, pas une panne. L'écran le dit plutôt que de laisser chercher.
 *
 * Le scénario est présenté en LISTE ordonnée par le parcours, et non comme le graphe de l'éditeur. C'est
 * délibéré : le tableau final se lit en entonnoir, bloc après bloc, et une liste dit exactement cet ordre-là.
 * Rejouer l'éditeur en lecture seule aurait ajouté sa mécanique (auto-save, sélection, déplacement) pour une
 * information que la liste donne déjà.
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

  useEffect(() => {
    listWorkflows(session.tenantId).then((r) => setScenarios(r.workflows)).catch(() => setScenarios([]));
  }, [session.tenantId]);

  // Changer de scénario repart d'un tableau VIDE : les mesures retenues désignent des blocs de l'ancien, les
  // garder afficherait des barres à zéro sans rapport avec ce qu'on regarde.
  useEffect(() => {
    if (choisi === '') { setGraph(null); setCounts([]); setRetenues([]); return; }
    let vivant = true;
    setChargement(true);
    setErreur(null);
    setRetenues([]);
    Promise.all([getWorkflow(session.tenantId, choisi), getWorkflowNodeCounts(session.tenantId, choisi, range)])
      .then(([w, c]) => {
        if (!vivant) return;
        setGraph(w.workflow.graph as { nodes: unknown[]; edges: unknown[] });
        setCounts(c.counts);
      })
      .catch((err: unknown) => { if (vivant) setErreur(err instanceof Error ? err.message : t('Mesures illisibles', 'Measures unreadable')); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [session.tenantId, choisi, range, t]);

  const blocs = useMemo<BlocMesurable[]>(
    () => (graph ? blocsDuScenario(graph as never, handlesMesuresParBloc(counts)) : []),
    [graph, counts],
  );
  const titreDuBloc = useMemo(() => new Map(blocs.map((b) => [b.id, b.titre])), [blocs]);

  const basculer = (m: MesureDispo): void =>
    setRetenues((prev) => (prev.some((x) => x.cle === m.cle) ? prev.filter((x) => x.cle !== m.cle) : [...prev, m]));

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

      {choisi !== '' && !chargement && !erreur && (
        <>
          <section className={cardCls} data-testid="tableaux-blocs">
            <h3 className="mb-1 text-sm font-semibold text-ink-900">{t('Les blocs du scénario', 'Scenario blocks')}</h3>
            <p className="mb-3 text-xs text-ink-500">
              {t(
                'Dans l’ordre du parcours. Seuls les blocs qui envoient un message sont mesurables.',
                'In parcours order. Only blocks that send a message can be measured.',
              )}
            </p>
            <ul className="space-y-1.5">
              {blocs.map((b, i) => (
                <li key={b.id}>
                  <button
                    type="button"
                    disabled={!b.mesurable}
                    onClick={() => setOuvert((o) => (o === b.id ? null : b.id))}
                    data-testid={b.mesurable ? 'bloc-mesurable' : 'bloc-grise'}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition ${
                      b.mesurable
                        ? 'border-ink-200 bg-white text-ink-800 hover:border-brand-300 hover:bg-brand-50/40'
                        : 'cursor-not-allowed border-ink-100 bg-ink-50/60 text-ink-400'
                    }`}
                  >
                    <span className="w-6 shrink-0 text-xs tabular-nums text-ink-400">{i + 1}</span>
                    <span className="flex-1 truncate">{b.titre}</span>
                    <span className="shrink-0 text-xs text-ink-400">{b.type}</span>
                  </button>

                  {ouvert === b.id && b.mesurable && (
                    <div className="mt-1.5 rounded-xl border border-brand-200 bg-brand-50/30 px-3 py-2" data-testid="bloc-mesures">
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {mesuresDisponibles(b).map((m) => (
                          <label key={m.cle} className="flex items-center gap-1.5 text-sm text-ink-700">
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
                  )}
                </li>
              ))}
            </ul>
          </section>

          <TableauMesures retenues={retenues} counts={counts} titreDuBloc={titreDuBloc} onRetirer={basculer} />
        </>
      )}
    </div>
  );
}

/**
 * Le tableau : un groupe de barres PAR BLOC, dans l'ordre où les mesures ont été choisies.
 *
 * Barres en largeur relative au MAXIMUM du tableau, pas au maximum de chaque groupe : sinon deux blocs aux
 * volumes très différents afficheraient des barres de même longueur, ce qui inverserait la lecture.
 */
function TableauMesures({ retenues, counts, titreDuBloc, onRetirer }: {
  retenues: MesureDispo[];
  counts: CompteurBrut[];
  titreDuBloc: Map<string, string>;
  onRetirer: (m: MesureDispo) => void;
}) {
  const t = useT();
  const lignes = retenues.map((m) => {
    const nodeId = m.cle.split('|')[0]!;
    return { m, nodeId, ...valeurDe(counts, nodeId, m.kind, m.handle) };
  });
  const max = lignes.reduce((acc, l) => Math.max(acc, l.count), 0);

  if (retenues.length === 0) {
    return (
      <section className={cardCls}>
        <p className="text-sm text-ink-500">
          {t('Clique un bloc ci-dessus pour choisir ce que tu veux compter.', 'Click a block above to choose what to count.')}
        </p>
      </section>
    );
  }

  // Regroupé par bloc, en conservant l'ordre d'apparition des blocs dans la sélection.
  const parBloc = new Map<string, typeof lignes>();
  for (const l of lignes) {
    const liste = parBloc.get(l.nodeId) ?? [];
    liste.push(l);
    parBloc.set(l.nodeId, liste);
  }

  return (
    <section className={cardCls} data-testid="tableaux-graphe">
      <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Le tableau', 'The report')}</h3>
      <div className="space-y-4">
        {[...parBloc.entries()].map(([nodeId, groupe]) => (
          <div key={nodeId}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">{titreDuBloc.get(nodeId) ?? nodeId}</p>
            <div className="space-y-1.5">
              {groupe.map((l) => (
                <div key={l.m.cle} className="flex items-center gap-2 text-sm" data-testid="barre">
                  <span className="w-52 shrink-0 truncate text-ink-600">{l.m.label}</span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-ink-100">
                    <div className="h-full rounded bg-brand-500" style={{ width: max > 0 ? `${Math.round((l.count / max) * 100)}%` : '0%' }} />
                  </div>
                  <span className="w-28 shrink-0 text-right tabular-nums text-ink-900">
                    {l.count}
                    {/* Le nombre de PERSONNES n'est montré que s'il diffère : l'afficher partout ferait douter
                        d'un chiffre qui, la plupart du temps, dit exactement la même chose. */}
                    {l.contacts !== l.count && <span className="ml-1 text-xs text-ink-400">({l.contacts} {t('pers.', 'ppl')})</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRetirer(l.m)}
                    aria-label={t('Retirer', 'Remove')}
                    className="shrink-0 text-ink-300 transition hover:text-coral"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-400">
        {t(
          'Les mesures démarrent à la mise en service du suivi : une période antérieure reste à zéro.',
          'Measurement starts when tracking was switched on: an earlier period stays at zero.',
        )}
      </p>
    </section>
  );
}
