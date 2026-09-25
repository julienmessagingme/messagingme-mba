'use client';

import { useEffect, useState } from 'react';
import { getJoursAnalyse, type StatsRange } from '@/lib/api';
import { fmtNum, fmtNote } from '@/lib/format';
import { formatDate } from '@/lib/day';
import { granularite, regrouper, SEUIL_SEMAINE_JOURS, type Granularite, type LignePeriode } from '@/lib/jours-analyse';
import { useT, useLocale } from '@/lib/i18n';
import { Bouton } from '@/components/Bouton';

/**
 * UNE LIGNE PAR JOUR, PAS PAR CONVERSATION.
 *
 * 🔴 LA DEMANDE DE JULIEN, MOT POUR MOT (2026-09-17). « Si un moment il y a 1000 conversations en stock, tu
 * vas pas afficher 1000 conversations dans le tableau [...] ce qui serait bien c'est d'avoir une ligne par
 * jour avec le nombre de conversations, le degré de sentiment moyen, le degré d'urgence moyen. Et si la
 * personne clique sur cette journée, là elle peut avoir le détail tel que tu l'affiches aujourd'hui. »
 *
 * ⚠️ CE N'ETAIT PAS UN CORRECTIF DE PANNE, ET C'EST DIT POUR QUE PERSONNE NE LE CROIE. La table du dessous
 * plafonnait DEJA à 50 lignes : elle n'allait rien faire tomber. Ce que cet écran gagne, c'est une lecture
 * qui tient quand le volume monte, et un point d'entrée par date plutôt qu'un défilement.
 *
 * 🔴 LA GRANULARITE EST AFFICHEE ET REGLABLE, ET C'EST LA PARADE A L'OBJECTION DU CHOIX. Julien a demandé
 * les deux à la fois : journées vides masquées ET regroupement hebdomadaire au-delà de 90 jours. Une
 * granularité qui change toute seule fait que deux captures de la même page cessent de se comparer ; la
 * dire, et laisser la main, coûte une ligne et referme le défaut.
 */

const TH = 'px-2 py-1.5 text-left text-xs font-medium text-ink-500';
const TD = 'px-2 py-1.5 text-sm text-ink-900';

/** Combien de jours la période couvre, bornes comprises. Pur, et sans « aujourd'hui » caché. */
function joursDeLaPeriode(range: StatsRange): number {
  const [fa, fm, fj] = range.from.split('-').map(Number) as [number, number, number];
  const [ta, tm, tj] = range.to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ta, tm - 1, tj) - Date.UTC(fa, fm - 1, fj)) / 86_400_000) + 1;
}

export function TableJoursAnalyse({ tenantId, range, choisie, onChoisir }: {
  tenantId: string;
  range: StatsRange;
  /** La ligne dépliée, `null` quand on regarde toute la période. */
  choisie: LignePeriode | null;
  onChoisir: (ligne: LignePeriode | null) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [jours, setJours] = useState<LignePeriode[] | null | 'erreur'>(null);
  const [brut, setBrut] = useState<Parameters<typeof regrouper>[0]>([]);
  /** `undefined` = on laisse la période décider. Une valeur = l'utilisateur a tranché, et il gagne. */
  const [force, setForce] = useState<Granularite | undefined>(undefined);

  const mode = granularite(joursDeLaPeriode(range), force);

  useEffect(() => {
    let vivant = true;
    setJours(null);
    getJoursAnalyse(tenantId, range)
      // 🔴 Le type ment sur une donnée de réseau : sans cette garde, un corps sans `jours` fait jeter le
      // rendu, et c'est la PAGE qui tombe, pas la table.
      .then((d) => { if (vivant) setBrut(Array.isArray(d?.jours) ? d.jours : []); })
      .then(() => { if (vivant) setJours([]); })
      .catch(() => { if (vivant) setJours('erreur'); });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to]);

  // Le regroupement est PUR et se refait au rendu : il dépend du mode, qui change sans nouvel appel.
  const lignes = jours === 'erreur' || jours === null ? null : regrouper(brut, mode);

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5" data-testid="jours-analyse">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            {mode === 'jour' ? t('Par jour', 'By day') : t('Par semaine', 'By week')}
          </h3>
          {/* 🔴 LA GRANULARITE EST DITE, TOUJOURS. Sans cette phrase, deux captures de la même page en
              jours et en semaines se compareraient comme si elles disaient la même chose. */}
          <p className="text-xs text-ink-400" data-testid="jours-granularite">
            {mode === 'jour'
              ? t('Une ligne par journée ayant eu au moins une conversation.', 'One row per day with at least one conversation.')
              : t(`Regroupé par semaine : la période dépasse ${SEUIL_SEMAINE_JOURS} jours.`, `Grouped by week: the period exceeds ${SEUIL_SEMAINE_JOURS} days.`)}
          </p>
        </div>
        <Bouton variante="secondaire" taille="petite"
          type="button"
          onClick={() => { setForce(mode === 'jour' ? 'semaine' : 'jour'); onChoisir(null); }}
          data-testid="jours-bascule"
        >
          {mode === 'jour' ? t('Voir par semaine', 'Show by week') : t('Voir par jour', 'Show by day')}
        </Bouton>
      </header>

      {jours === 'erreur' && (
        <p className="rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger" data-testid="jours-erreur">
          {t('Les journées n’ont pas pu être chargées.', 'Days could not be loaded.')}
        </p>
      )}
      {jours === null && <p className="text-xs text-ink-400">{t('Chargement…', 'Loading…')}</p>}

      {lignes !== null && lignes.length === 0 && (
        <p className="text-xs text-ink-500" data-testid="jours-vide">
          {t('Aucune conversation analysée sur cette période.', 'No analysed conversation over this period.')}
        </p>
      )}

      {lignes !== null && lignes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] border-collapse">
            <thead>
              <tr className="border-b border-ink-100">
                <th className={TH}>{mode === 'jour' ? t('Jour', 'Day') : t('Semaine du', 'Week of')}</th>
                <th className={`${TH} text-right`}>{t('Conversations', 'Conversations')}</th>
                <th className={`${TH} text-right`}>{t('Satisfaction', 'Satisfaction')}</th>
                <th className={`${TH} text-right`}>{t('Urgence', 'Urgency')}</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => {
                const active = choisie !== null && choisie.debut === l.debut;
                return (
                  <tr
                    key={l.debut}
                    onClick={() => onChoisir(active ? null : l)}
                    data-testid={`jour-ligne-${l.debut}`}
                    aria-selected={active}
                    className={`cursor-pointer border-b border-ink-50 transition-colors duration-150 ${active ? 'bg-brand-50' : 'hover:bg-ink-50'}`}
                  >
                    <td className={`${TD} font-medium text-ink-900`}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onChoisir(active ? null : l); }}
                        data-testid={`jour-ouvrir-${l.debut}`}
                        className="text-left hover:text-brand-700"
                      >
                        {formatDate(l.debut, locale)}
                      </button>
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{fmtNum(l.conversations, locale)}</td>
                    {/* 🔴 UNE CASE VIDE, PAS UN ZERO : zéro est une note VALIDE et la pire de toutes. Les
                        analyses d'avant la migration 0121 n'ont aucune note, et les placer à zéro rangerait
                        tout l'historique dans le coin « clients furieux ». */}
                    <td className={`${TD} text-right tabular-nums`} data-testid={`jour-satisfaction-${l.debut}`}>
                      {l.satisfaction === null
                        ? <span className="text-ink-400" title={t('Aucune analyse de cette période ne porte cette note.', 'No analysis over this period carries this score.')}>—</span>
                        : fmtNote(l.satisfaction, locale)}
                    </td>
                    <td className={`${TD} text-right tabular-nums`} data-testid={`jour-urgence-${l.debut}`}>
                      {l.urgence === null
                        ? <span className="text-ink-400" title={t('Aucune analyse de cette période ne porte cette note.', 'No analysis over this period carries this score.')}>—</span>
                        : fmtNote(l.urgence, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {choisie !== null && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-500" data-testid="jour-choisi">
          {t(
            `Le détail ci-dessous ne montre que ${formatDate(choisie.debut, locale)}.`,
            `The detail below shows only ${formatDate(choisie.debut, locale)}.`,
          )}
          <button
            type="button"
            onClick={() => onChoisir(null)}
            data-testid="jour-retirer"
            className="font-medium text-brand-600 underline decoration-dotted underline-offset-2 hover:text-brand-700"
          >
            {t('Revenir à toute la période', 'Back to the whole period')}
          </button>
        </p>
      )}
    </section>
  );
}
