'use client';

import { useEffect, useState } from 'react';
import { getNuageQualitatif, type NuageQualitatif as Nuage, type StatsRange } from '@/lib/api';
import { fmtNum, fmtNote } from '@/lib/format';
import { useT, useLocale } from '@/lib/i18n';
import type { Locale } from '@/lib/locale';
import { NOTE_MIN, NOTE_MAX, MILIEU_ECHELLE, positionPct, rayonPoint, estAlerte } from '@/lib/nuage';
import { brand, danger, ink } from '@/lib/couleurs';
import { Squelette } from '@/components/Squelette';
import { Nd, useErreurRegroupee } from '@/components/Nd';

/**
 * Le nuage « satisfaction x urgence » de la page de synthèse (lot F du 2026-09-08).
 *
 * 🔴 CE GRAPHE DÉMARRE VIDE, ET C'EST NORMAL. Les deux mesures n'existent que depuis la migration 0121 :
 * seules les conversations analysées APRÈS son déploiement en portent, et on ne réanalyse pas l'historique
 * (décision de Julien : réanalyser change des analyses que des humains ont peut-être déjà lues). Un graphe
 * vide sans un mot se lirait comme un graphe cassé, donc l'écran DIT ce qui se passe, dans les deux cas :
 * « aucune conversation mesurée » et « N analyses sans mesure ».
 *
 * ⚠️ Abscisse = satisfaction, ordonnée = urgence. L'abscisse se lit de gauche à droite comme un progrès,
 * l'ordonnée de bas en haut comme une montée en tension : le coin qui alarme, « très urgent et très
 * mécontent », tombe alors en haut à gauche, là où l'œil va en premier. Inverser les axes n'est pas un
 * détail de goût, ça déplace ce coin hors du premier regard.
 */

/** Repère du dessin (viewBox). La zone utile est le carré intérieur, les marges portent les graduations. */
const W = 420;
const H = 300;
const PAD = { top: 14, right: 16, bottom: 30, left: 34 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

/** Coordonnées d'une note dans le viewBox. `y` est INVERSÉ : 10 en urgence doit monter, pas descendre. */
const cx = (satisfaction: number): number => PAD.left + (positionPct(satisfaction) / 100) * INNER_W;
const cy = (urgence: number): number => PAD.top + INNER_H - (positionPct(urgence) / 100) * INNER_H;

const CARD = 'rounded-carte border border-ink-200 bg-white p-5';

export function NuageQualitatifCard({ tenantId, range }: { tenantId: string; range: StatsRange }) {
  const t = useT();
  const { locale } = useLocale();
  const [nuage, setNuage] = useState<Nuage | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    setNuage(null);
    setErreur(false);
    getNuageQualitatif(tenantId, range)
      .then((n) => {
        if (!vivant) return;
        // Même garde que la carte du coût, et pour la même raison : le type est une promesse, pas une
        // preuve. Un corps sans `points` ferait jeter le rendu, et emporterait la page entière.
        if (!n || !Array.isArray(n.points)) { setErreur(true); return; }
        setNuage(n);
      })
      .catch(() => { if (vivant) setErreur(true); });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to]);
  const regroupee = useErreurRegroupee('nuage', erreur);

  return (
    <section className={CARD} data-testid="nuage-quali">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-ink-900">{t('Urgence et satisfaction', 'Urgency and satisfaction')}</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          {t(
            'Notes de 0 à 10 données par l’analyse ; la taille d’un point dit combien de conversations il porte.',
            'Scores from 0 to 10 given by the analysis; a dot’s size tells how many conversations it holds.',
          )}
        </p>
      </header>

      {erreur && regroupee && <Nd testId="nuage-erreur" className="text-sm" />}
      {erreur && !regroupee && (
        <p className="rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700" data-testid="nuage-erreur">
          {t('Les mesures n’ont pas pu être chargées.', 'Scores could not be loaded.')}
        </p>
      )}
      {!erreur && nuage === null && (
        <Squelette forme="carte" />
      )}
      {!erreur && nuage !== null && <Graphe nuage={nuage} t={t} locale={locale} />}
    </section>
  );
}

function Graphe({ nuage, t, locale }: { nuage: Nuage; t: (fr: string, en?: string) => string; locale: Locale }) {
  const nMax = Math.max(1, ...nuage.points.map((p) => p.n));
  const graduations = [NOTE_MIN, MILIEU_ECHELLE, NOTE_MAX];

  return (
    <>
      {/* 🔴 LARGEUR PLAFONNEE, ET CE N'EST PAS DU GOUT. Un SVG en `w-full` etire son viewBox a la largeur
          de la carte : sur un ecran large, le dessin passe a 2,7 fois sa taille et les textes de 10 px
          rendus a 27 px viennent recouvrir les points. Mesure faite le 2026-09-08 sur une capture reelle,
          pas devinee. On borne donc la largeur au voisinage du viewBox (echelle ~1,3) et on centre. */}
      <div className="relative mx-auto w-full max-w-[560px]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
          aria-label={t('Nuage de points : satisfaction en abscisse, urgence en ordonnée', 'Scatter plot: satisfaction on the x axis, urgency on the y axis')}>
          {/* Le quart qui alarme (mécontent ET pressé), teinté très légèrement : il donne au graphe un sens
              de lecture immédiat. C'est un repère, pas un classement : rien n'est calculé dessus. */}
          <rect
            x={PAD.left} y={PAD.top}
            width={INNER_W / 2} height={INNER_H / 2}
            fill={danger[500]} opacity="0.05"
          />
          <text x={PAD.left + 6} y={PAD.top + 14} className="fill-danger-500 text-[9px]">
            {t('Urgent et mécontent', 'Urgent and unhappy')}
          </text>

          {/* Grille : une ligne par graduation, dans les deux sens. */}
          {graduations.map((g) => (
            <g key={`g-${g}`}>
              <line x1={cx(g)} x2={cx(g)} y1={PAD.top} y2={PAD.top + INNER_H} stroke={ink[100]} strokeWidth="1" />
              <line x1={PAD.left} x2={PAD.left + INNER_W} y1={cy(g)} y2={cy(g)} stroke={ink[100]} strokeWidth="1" />
              <text x={cx(g)} y={H - 16} textAnchor="middle" className="fill-ink-300 text-[10px] tabular-nums">{g}</text>
              <text x={PAD.left - 8} y={cy(g) + 3} textAnchor="end" className="fill-ink-300 text-[10px] tabular-nums">{g}</text>
            </g>
          ))}

          {/* Axes (les deux bords bas et gauche du carré utile). */}
          <line x1={PAD.left} x2={PAD.left + INNER_W} y1={PAD.top + INNER_H} y2={PAD.top + INNER_H} stroke={ink[200]} strokeWidth="1" />
          <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + INNER_H} stroke={ink[200]} strokeWidth="1" />

          {/* Les cases occupées. Le `<title>` donne l'infobulle native : aucune JS d'un survol à écrire, et
              elle reste lisible au clavier et par un lecteur d'écran. */}
          {nuage.points.map((p) => (
            <circle
              key={`${p.satisfaction}-${p.urgence}`}
              data-testid={`nuage-point-${p.satisfaction}-${p.urgence}`}
              cx={cx(p.satisfaction)} cy={cy(p.urgence)} r={rayonPoint(p.n, nMax)}
              fill={estAlerte(p.satisfaction, p.urgence) ? danger[500] : brand[500]}
              fillOpacity="0.55"
              stroke={estAlerte(p.satisfaction, p.urgence) ? danger[500] : brand[500]}
              strokeWidth="1"
            >
              <title>{t(
                `${p.n} conversation(s) · satisfaction ${p.satisfaction}, urgence ${p.urgence}`,
                `${p.n} conversation(s) · satisfaction ${p.satisfaction}, urgency ${p.urgence}`,
              )}</title>
            </circle>
          ))}

          {/* La moyenne : une croix cerclée, jamais un rond de plus. Un point moyen dessiné comme les autres
              serait pris pour une conversation, et c'est le seul point du graphe qui n'en est pas une. */}
          {nuage.moyenne && (
            <g data-testid="nuage-moyenne">
              <circle cx={cx(nuage.moyenne.satisfaction)} cy={cy(nuage.moyenne.urgence)} r="8" fill="none" stroke={ink[800]} strokeWidth="1.5" />
              <line x1={cx(nuage.moyenne.satisfaction) - 11} x2={cx(nuage.moyenne.satisfaction) + 11} y1={cy(nuage.moyenne.urgence)} y2={cy(nuage.moyenne.urgence)} stroke={ink[800]} strokeWidth="1.5" />
              <line x1={cx(nuage.moyenne.satisfaction)} x2={cx(nuage.moyenne.satisfaction)} y1={cy(nuage.moyenne.urgence) - 11} y2={cy(nuage.moyenne.urgence) + 11} stroke={ink[800]} strokeWidth="1.5" />
              <title>{t(
                `Moyenne : satisfaction ${fmtNote(nuage.moyenne.satisfaction, locale)}, urgence ${fmtNote(nuage.moyenne.urgence, locale)}`,
                `Average: satisfaction ${fmtNote(nuage.moyenne.satisfaction, locale)}, urgency ${fmtNote(nuage.moyenne.urgence, locale)}`,
              )}</title>
            </g>
          )}

          {/* Libellés d'axe : les bornes ont un SENS, et un axe gradué 0-10 sans ce sens se lit à l'envers
              une fois sur deux. */}
          <text x={PAD.left + INNER_W / 2} y={H - 3} textAnchor="middle" className="fill-ink-400 text-[10px]">
            {t('Satisfaction : mécontent → satisfait', 'Satisfaction: unhappy → happy')}
          </text>
          <text x={10} y={PAD.top + INNER_H / 2} textAnchor="middle" transform={`rotate(-90 10 ${PAD.top + INNER_H / 2})`} className="fill-ink-400 text-[10px]">
            {t('Urgence : calme → pressant', 'Urgency: calm → pressing')}
          </text>
        </svg>
      </div>

      <div className="mt-3 space-y-1 text-xs">
        {nuage.moyenne ? (
          <p className="text-ink-500" data-testid="nuage-resume">
            {t(
              `${fmtNum(nuage.mesurees, locale)} conversation(s) mesurée(s) · moyenne : satisfaction ${fmtNote(nuage.moyenne.satisfaction, locale)}, urgence ${fmtNote(nuage.moyenne.urgence, locale)}`,
              `${fmtNum(nuage.mesurees, locale)} measured conversation(s) · average: satisfaction ${fmtNote(nuage.moyenne.satisfaction, locale)}, urgency ${fmtNote(nuage.moyenne.urgence, locale)}`,
            )}
          </p>
        ) : (
          <p className="text-ink-500" data-testid="nuage-vide">
            {t(
              'Aucune conversation mesurée sur cette période.',
              'No measured conversation over this period.',
            )}
          </p>
        )}
        {/**
          * 🔴 LE PARAGRAPHE DES ANALYSES SANS MESURE A ETE RETIRE LE 2026-09-17, SUR DECISION DE JULIEN, ET
          * C'EST UN RISQUE ASSUME QU'ON ECRIT PLUTOT QUE DE LE TAIRE.
          *
          * Il disait : « N analyse(s) de la période n'ont pas ces deux notes et ne figurent pas sur le
          * graphe [...] Elles ne valent pas zéro. » Julien, le 2026-09-17 : « tu peux enlever le blabla en
          * dessous du tableau », puis « rien du tout, on enlève » quand la question lui a été reposée avec
          * la mesure ci-dessous.
          *
          * ⚠️ CE QUE CA COUTE, MESURE LE JOUR MEME EN PRODUCTION : 2 analyses sur 14 portent les deux
          * notes. Le nuage montre donc DEUX points sur quatorze conversations, et plus rien à l'écran ne
          * permet de s'en douter. Le risque est REEL mais TEMPORAIRE : chaque nouvelle analyse porte les
          * deux notes depuis la migration 0121, et la proportion se redresse d'elle-même.
          *
          * ⚠️ `sansMesure` RESTE DANS LE CONTRAT et continue d'être calculé : ce n'est pas la mesure qu'on
          * retire, c'est son affichage. Le jour où l'on veut la remontrer, il n'y a rien à recâbler.
          * `performance-synthese.spec.ts` garde désormais l'ABSENCE de ce paragraphe, pour que personne ne
          * le remette sans le vouloir.
          */}
      </div>
    </>
  );
}
