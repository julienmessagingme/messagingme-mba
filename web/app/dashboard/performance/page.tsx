'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { PerformanceCourbe } from '@/components/analytics/PerformanceCourbe';
import type { Session } from '@/lib/session';
import { getPerformance, type StatsRange } from '@/lib/api';
import { ApiError, erreurDeChargement } from '@/lib/http';
import { useT, useLocale } from '@/lib/i18n';
import { presetRange } from '@/lib/range';
import { fmtNum } from '@/lib/format';
import type { Locale } from '@/lib/locale';
import { dateHeure } from '@/lib/day';
import { fmtDuree, lirePerformance, nomDeQui, type Performance, type Qui } from '@/lib/performance';

/**
 * Analytics > Quantitatif > **Performance** : le temps de réponse et le temps de résolution de l'équipe, sur les
 * seules conversations qu'un robot lui a passées (cadrage du 2026-09-29). Ce qu'est une demande, et comment ses
 * durées se comptent : `src/stats/performance.ts`.
 *
 * 🔴 UN CHIFFRE INCONNU S'ÉCRIT « NON DISPONIBLE », JAMAIS 0 (la règle de l'écran des publicités). Une médiane sans
 * aucune demande affichée à zéro dirait que l'équipe répond instantanément.
 *
 * ⚠️ LA CONSOLE PART SUR VERCEL AVANT L'API : tant que la route n'est pas déployée, elle rend 404, et l'écran dit
 * « pas encore disponible » au lieu d'une erreur brute.
 */
export default function PerformanceQuantiPage() {
  return <AppShell active="quanti-performance">{(session) => <PerformanceInner session={session} />}</AppShell>;
}

type Etat =
  | { etat: 'chargement' }
  | { etat: 'pret'; perf: Performance }
  | { etat: 'indisponible' }
  | { etat: 'illisible' }
  | { etat: 'erreur'; message: string };

function PerformanceInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  // La même période par défaut que les sous-onglets voisins : passer de l'un à l'autre ne change pas la fenêtre.
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [etat, setEtat] = useState<Etat>({ etat: 'chargement' });

  useEffect(() => {
    // Une réponse arrivée après un changement de période ne doit pas écraser celle de la période affichée.
    let actif = true;
    setEtat({ etat: 'chargement' });
    getPerformance(session.tenantId, range)
      .then((brut) => {
        if (!actif) return;
        const perf = lirePerformance(brut);
        setEtat(perf ? { etat: 'pret', perf } : { etat: 'illisible' });
      })
      .catch((err: unknown) => {
        if (!actif) return;
        setEtat(err instanceof ApiError && err.status === 404 ? { etat: 'indisponible' } : { etat: 'erreur', message: erreurDeChargement(err, t) });
      });
    return () => { actif = false; };
  }, [session.tenantId, range, t]);

  return (
    <div className="space-y-4">
      {/* La barre reste un enfant DIRECT de la page : elle est collante, et un conteneur à sa mesure la bornerait. */}
      <RangeBar title={<TitrePage>{t('Performance', 'Performance')}</TitrePage>} range={range} onChange={setRange} />
      <IntroPage>
        {t(
          'Le temps de réponse et de résolution de votre équipe, sur les conversations qu’un scénario, un agent IA, l’agent de Meta ou une campagne lui a passées.',
          'How fast your team replies and resolves, on the conversations a scenario, an AI agent, Meta’s agent or a campaign handed over.',
        )}
      </IntroPage>
      {etat.etat === 'chargement' && <p className="text-sm text-ink-500">{t('Chargement des statistiques…', 'Loading statistics…')}</p>}
      {etat.etat === 'indisponible' && (
        <p data-testid="perf-indisponible" className="rounded-controle bg-ink-50 px-3 py-2 text-sm text-ink-500">
          {t('Ces indicateurs ne sont pas encore disponibles.', 'These metrics are not available yet.')}
        </p>
      )}
      {etat.etat === 'illisible' && (
        <p data-testid="perf-illisible" className="rounded-controle bg-ink-50 px-3 py-2 text-sm text-ink-500">
          {t('Ces indicateurs ne sont pas lisibles pour le moment. Réessayez dans quelques minutes.', 'These metrics cannot be read right now. Try again in a few minutes.')}
        </p>
      )}
      {etat.etat === 'erreur' && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{etat.message}</p>}
      {etat.etat === 'pret' && <Tableau perf={etat.perf} range={range} locale={locale} t={t} />}
    </div>
  );
}

type T = (fr: string, en?: string) => string;

function Tableau({ perf, range, locale, t }: { perf: Performance; range: StatsRange; locale: Locale; t: T }) {
  // Le mode décide de l'écriture : en heures d'ouverture, jamais de jours (`fmtDuree`).
  const duree = (ms: number | null): string => fmtDuree(ms, locale, perf.mode);
  return (
    <>
      {/* Comment on compte, et depuis quand : dit AVANT les chiffres, pas dans une infobulle. */}
      <div className="space-y-1 text-xs text-ink-500">
        <p data-testid="perf-mode">
          {perf.mode === 'ouvre'
            ? t(
              `Durées comptées en heures d’ouverture de votre espace (Paramètres, fuseau ${perf.fuseau}) : les nuits, les week-ends et les jours fermés ne comptent pas.`,
              `Times are counted in your workspace’s opening hours (Settings, ${perf.fuseau} time zone): nights, weekends and closed days do not count.`,
            )
            : t(
              'Votre espace n’a pas d’heures d’ouverture exploitables : les durées sont comptées en temps brut, nuits et week-ends compris.',
              'Your workspace has no usable opening hours: times are counted in raw time, nights and weekends included.',
            )}
        </p>
        <p data-testid="perf-mesure-depuis">
          {perf.mesureDepuis
            ? t(`Mesuré depuis le ${dateHeure(perf.mesureDepuis, locale)}. Rien avant cette date n’est compté.`,
              `Measured since ${dateHeure(perf.mesureDepuis, locale)}. Nothing before that date is counted.`)
            : t('Début de la mesure : non disponible.', 'Measurement start: not available.')}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Chiffre testid="perf-kpi-reponse-mediane" libelle={t('Réponse, médiane', 'Response, median')} valeur={duree(perf.reponse.mediane)} vide={perf.reponse.mediane === null} />
        <Chiffre testid="perf-kpi-reponse-p90" libelle={t('Réponse, 90 % en moins de', 'Response, 90% within')} valeur={duree(perf.reponse.p90)} vide={perf.reponse.p90 === null} />
        <Chiffre testid="perf-kpi-resolution-mediane" libelle={t('Résolution, médiane', 'Resolution, median')} valeur={duree(perf.resolution.mediane)} vide={perf.resolution.mediane === null} />
        <Chiffre testid="perf-kpi-resolution-p90" libelle={t('Résolution, 90 % en moins de', 'Resolution, 90% within')} valeur={duree(perf.resolution.p90)} vide={perf.resolution.p90 === null} />
      </div>

      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Demandes', 'Requests')}</h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <Compteur testid="perf-demandes" libelle={t('Commencées sur la période', 'Started in the period')} valeur={fmtNum(perf.demandes, locale)} />
          <Compteur testid="perf-resolues" libelle={t('Résolues', 'Resolved')} valeur={fmtNum(perf.resolues, locale)} />
          <Compteur testid="perf-sans-reponse" libelle={t('Résolues sans réponse', 'Resolved without a reply')} valeur={fmtNum(perf.resoluesSansReponse, locale)} />
          {/* Toutes les demandes ouvertes EN CE MOMENT, pas celles de la période : l'étiquette le dit. */}
          <Compteur testid="perf-ouvertes" libelle={t('Encore ouvertes, toutes dates', 'Still open, any date')} valeur={fmtNum(perf.ouvertes, locale)} />
        </dl>
        {/* Une demande déjà répondue mais pas close est ouverte, pas « en attente » : la phrase dit ce qui est vrai. */}
        {perf.plusAncienneOuverte && (
          <p data-testid="perf-plus-ancienne" className="mt-3 text-xs text-ink-500">
            {t(`La plus ancienne est ouverte depuis le ${dateHeure(perf.plusAncienneOuverte, locale)}.`,
              `The oldest has been open since ${dateHeure(perf.plusAncienneOuverte, locale)}.`)}
          </p>
        )}
        <p className="mt-3 border-t border-ink-100 pt-2 text-xs text-ink-500">
          {t(
            'Une demande s’ouvre quand un robot passe la main à l’équipe, ou quand un client réécrit dans une conversation « Traité » ou archivée que l’équipe tient encore, et son chrono part quand le client a écrit : un modèle envoyé juste avant le passage n’a encore fait attendre personne. Elle se termine au premier « Traité », archivage ou retour à un robot ; quand ce retour est un geste sans auteur connu (délai de reprise écoulé, scénario qui reprend la conversation), la résolution s’arrête à la dernière réponse de l’équipe. La réponse est le premier message écrit dans l’Inbox par un collaborateur. Les demandes résolues sans aucune réponse sont comptées à part et n’entrent pas dans le temps de résolution. « Encore ouvertes » compte toutes les demandes ouvertes en ce moment, quelle que soit la période.',
            'A request opens when a bot hands over to the team, or when a customer writes again in a “Done” or archived conversation the team still holds, and its clock starts once the customer has written: a template sent just before the handover has not kept anyone waiting yet. It ends at the first “Done”, archive or handback to a bot; when that handback has no known author (handback delay elapsed, scenario taking the conversation back), the resolution stops at the team’s last reply. The reply is the first message a teammate writes in the Inbox. Requests resolved without any reply are counted apart and left out of the resolution time. “Still open” counts every request open right now, whatever the period.',
          )}
        </p>
      </div>

      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Évolution par jour', 'Day by day')}</h3>
        {perf.parJour.length === 0
          ? <p data-testid="perf-courbe-vide" className="text-sm text-ink-500">{t('Aucune demande sur la période.', 'No request in the period.')}</p>
          : <PerformanceCourbe parJour={perf.parJour} from={range.from} to={range.to} mode={perf.mode} />}
      </div>

      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Par collaborateur', 'By teammate')}</h3>
        {perf.parCollaborateur.length === 0 ? (
          <p className="text-sm text-ink-500">{t('Personne n’a encore répondu ni clos de demande sur la période.', 'Nobody has replied to or closed a request in the period yet.')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-xs" data-testid="perf-collaborateurs">
              <thead>
                <tr className="text-ink-500">
                  <th className="py-1 pr-2 font-medium">{t('Collaborateur', 'Teammate')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('Premières réponses', 'First replies')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('Réponse, médiane', 'Response, median')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('Demandes closes', 'Requests closed')}</th>
                  <th className="py-1 text-right font-medium">{t('Résolution, médiane', 'Resolution, median')}</th>
                </tr>
              </thead>
              <tbody>
                {perf.parCollaborateur.map((l) => (
                  <tr key={cleDe(l.qui)} data-testid={`perf-collab-${cleDe(l.qui)}`} className="border-t border-ink-100">
                    <td className="py-1 pr-2 text-ink-900">{nomDeQui(l.qui, t)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-ink-900">{fmtNum(l.reponses, locale)}</td>
                    <td className={`py-1 pr-2 text-right tabular-nums ${l.reponseMediane === null ? 'text-ink-400' : 'text-ink-900'}`}>{duree(l.reponseMediane)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-ink-900">{fmtNum(l.closes, locale)}</td>
                    <td className={`py-1 text-right tabular-nums ${l.resolutionMediane === null ? 'text-ink-400' : 'text-ink-900'}`}>{duree(l.resolutionMediane)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500">
          {t(
            'La réponse revient à celui qui a répondu le premier, la résolution à celui qui a clos. « Demandes closes » compte toutes celles qu’il a closes, avec ou sans réponse ; la médiane de résolution ne porte que sur celles qui ont eu une réponse. Un geste sans auteur connu (délai de reprise écoulé, scénario qui reprend la conversation, appel d’API) va dans « Automatique ».',
            'The reply goes to whoever replied first, the resolution to whoever closed. “Requests closed” counts every request they closed, with or without a reply; the resolution median only covers those that got a reply. A gesture with no known author (handback delay elapsed, scenario taking the conversation back, API call) goes to “Automatic”.',
          )}
        </p>
      </div>
    </>
  );
}

const cleDe = (q: Qui): string => (q.genre === 'collaborateur' ? q.userId : q.genre);

function Chiffre({ testid, libelle, valeur, vide }: { testid: string; libelle: string; valeur: string; vide: boolean }) {
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5">
      <div className="text-xs font-medium text-ink-500">{libelle}</div>
      <div data-testid={testid} className={`mt-1.5 font-semibold tabular-nums ${vide ? 'text-base text-ink-400' : 'text-3xl tracking-tight text-ink-900'}`}>
        {valeur}
      </div>
    </div>
  );
}

function Compteur({ testid, libelle, valeur }: { testid: string; libelle: string; valeur: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{libelle}</dt>
      <dd data-testid={testid} className="text-xl font-semibold tabular-nums text-ink-900">{valeur}</dd>
    </div>
  );
}
