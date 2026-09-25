'use client';

import { fmtNum, fmtCost } from '@/lib/format';
import type { EtapeCoutCampagne } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import type { Locale } from '@/lib/locale';

/**
 * LE PARCOURS D'UN SCENARIO, BLOC PAR BLOC, EN BARRES VERTICALES.
 *
 * 🔴 LA DEMANDE DE JULIEN (2026-09-17), qui trouvait le tableau precedent illisible : « je veux voir le
 * tableau qu'on va retrouver dans quantitatif > funnel [...] chaque etape qui a ete cliquee (chaque node)
 * [...] un tableau avec des barres verticales envoyes / reponses sans clic / clics sur bouton / clics sur
 * 2e node / reponse suite a 2e node ». Les memes chiffres, lus comme un entonnoir plutot que comme une
 * grille : ce qui se perd d'un bloc au suivant se VOIT, alors qu'il fallait le calculer de tete.
 *
 * 🔴 ON COMPTE DES PERSONNES, ET LES GESTES SONT AU SURVOL. Coherent avec la regle de Julien (« un clic ou
 * un engage = 1 ») et avec le cout par engage de la synthese. Une personne qui clique trois fois ne doit
 * pas gonfler l'entonnoir, sinon un bloc peut paraitre plus fort que celui qui le precede, ce qui n'a
 * aucun sens dans un entonnoir.
 *
 * 🔴 SAUF LES LIENS, QUI COMPTENT DES GESTES ET LE DISENT. `EtapeCoutCampagne.liens` n'a PAS de compte de
 * personnes et n'en aura jamais : les clics s'agregent par CODE de lien, pas par contact. Afficher un
 * nombre de personnes y serait une invention, et aligner silencieusement deux unites dans le meme graphe
 * est exactement le genre de chiffre plausible et faux que cet ecran doit eviter.
 *
 * ⚠️ UNE ECHELLE COMMUNE A TOUS LES BLOCS, sinon chaque bloc serait dessine a sa propre echelle et les
 * hauteurs ne se compareraient plus d'une colonne a l'autre, ce qui est precisement ce qu'on vient y lire.
 */

/** Hauteur de la zone dessinee, en pixels. Fixe : c'est une comparaison de hauteurs, pas une mesure. */
const H = 96;

type Nature = 'envoyes' | 'boutons' | 'reponses' | 'liens';

/** Ce qu'une barre montre, et dans quelle unite. L'ordre est celui de la lecture d'un entonnoir. */
const NATURES: { cle: Nature; fr: string; en: string; couleur: string; gestesSeuls?: boolean }[] = [
  { cle: 'envoyes', fr: 'Envoyés', en: 'Sent', couleur: 'bg-brand-400' },
  { cle: 'liens', fr: 'Clics lien', en: 'Link clicks', couleur: 'bg-ink-300', gestesSeuls: true },
  { cle: 'boutons', fr: 'Boutons', en: 'Buttons', couleur: 'bg-succes-400' },
  { cle: 'reponses', fr: 'Réponses', en: 'Replies', couleur: 'bg-alerte-500' },
];

/**
 * La valeur d'une nature, dans l'unite qui lui convient.
 *
 * ⚠️ `liens` N'A QUE DES GESTES, et ce n'est pas un defaut a contourner : c'est ce que la donnee sait dire.
 * Les trois autres rendent des PERSONNES.
 */
function valeur(e: EtapeCoutCampagne, n: Nature): number {
  if (n === 'liens') return e.liens?.gestes ?? 0;
  if (n === 'envoyes') return e.envoyes?.personnes ?? 0;
  if (n === 'boutons') return e.boutons?.personnes ?? 0;
  return e.reponses?.personnes ?? 0;
}

/** Les GESTES de la meme nature, pour l'infobulle. `null` quand la nature ne compte que des gestes. */
function gestes(e: EtapeCoutCampagne, n: Nature): number | null {
  if (n === 'liens') return null;
  if (n === 'envoyes') return e.envoyes?.gestes ?? 0;
  if (n === 'boutons') return e.boutons?.gestes ?? 0;
  return e.reponses?.gestes ?? 0;
}

export function FunnelNodes({ etapes, titres, devise }: {
  etapes: readonly EtapeCoutCampagne[];
  /** Le NOM lisible de chaque bloc, lu dans le graphe du scenario. Absent -> l'identifiant, jamais un vide. */
  titres: Map<string, string>;
  devise: string | null;
}) {
  const t = useT();
  const { locale } = useLocale();

  /**
   * 🔴 L'ECHELLE EST COMMUNE, ET ELLE IGNORE LES LIENS. Les liens comptent des GESTES : une personne qui
   * clique dix fois produirait une barre dix fois plus haute que l'envoi qui l'a touchee, ecrasant tout le
   * reste du graphe. Ils gardent leur barre, a leur propre echelle, et l'ecran le dit.
   */
  const maxPersonnes = etapes.reduce(
    (m, e) => Math.max(m, valeur(e, 'envoyes'), valeur(e, 'boutons'), valeur(e, 'reponses')),
    0,
  );
  const maxLiens = etapes.reduce((m, e) => Math.max(m, valeur(e, 'liens')), 0);

  const hauteur = (e: EtapeCoutCampagne, n: Nature): number => {
    const v = valeur(e, n);
    const max = n === 'liens' ? maxLiens : maxPersonnes;
    if (max <= 0 || v <= 0) return 0;
    // Plancher de 2 px : une valeur non nulle ne doit jamais etre dessinee comme un zero.
    return Math.max(2, Math.round((v / max) * H));
  };

  return (
    <div className="mt-3" data-testid="funnel-nodes">
      <div className="flex gap-4 overflow-x-auto pb-1">
        {etapes.map((e) => (
          <div key={e.nodeId} className="min-w-[8rem] shrink-0" data-testid={`funnel-node-${e.nodeId}`}>
            <div className="flex items-end gap-1.5" style={{ height: H }}>
              {NATURES.map((n) => {
                const v = valeur(e, n.cle);
                const g = gestes(e, n.cle);
                const titre = n.gestesSeuls
                  ? t(`${fmtNum(v, locale)} clic(s) sur un lien. Le comptage se fait par LIEN, pas par contact : cette barre ne compte pas des personnes.`,
                    `${fmtNum(v, locale)} link click(s). Counted per LINK, not per contact: this bar does not count people.`)
                  : t(`${fmtNum(v, locale)} personne(s), ${fmtNum(g ?? 0, locale)} geste(s).`,
                    `${fmtNum(v, locale)} person(s), ${fmtNum(g ?? 0, locale)} gesture(s).`);
                return (
                  <div key={n.cle} className="flex flex-1 flex-col items-center justify-end" title={titre}>
                    <span className="mb-0.5 text-[10px] tabular-nums text-ink-500" data-testid={`funnel-${n.cle}-${e.nodeId}`}>
                      {fmtNum(v, locale)}
                    </span>
                    <span
                      className={`w-full rounded-t ${n.couleur} ${n.gestesSeuls ? 'opacity-70' : ''}`}
                      style={{ height: hauteur(e, n.cle) }}
                      aria-hidden="true"
                    />
                  </div>
                );
              })}
            </div>
            {/* Le nom du bloc SOUS ses barres, tronque : un nom long ne doit pas elargir la colonne et
                desaligner les hauteurs d'un bloc a l'autre. */}
            <p className="mt-1.5 truncate border-t border-ink-100 pt-1 text-center text-[11px] font-medium text-ink-900"
              title={titres.get(e.nodeId) ?? e.nodeId}>
              {titres.get(e.nodeId) ?? e.nodeId}
            </p>
            <p className="text-center text-[10px] text-ink-400" data-testid={`funnel-ratio-${e.nodeId}`}>
              {e.coutParInteraction === null
                ? t('coût/interaction inconnu', 'cost/interaction unknown')
                : `${fmtCost(e.coutParInteraction, locale, devise)} ${t('/ interaction', '/ interaction')}`}
            </p>
          </div>
        ))}
      </div>

      {/* La legende, qui porte la seule reserve du graphe. Sans elle, les quatre couleurs se lisent comme
          quatre mesures de meme nature, et la barre des liens passerait pour un compte de personnes. */}
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500" data-testid="funnel-legende">
        {NATURES.map((n) => (
          <li key={n.cle} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${n.couleur} ${n.gestesSeuls ? 'opacity-70' : ''}`} aria-hidden="true" />
            {t(n.fr, n.en)}
            {n.gestesSeuls && <span className="text-ink-400">{t('(gestes)', '(gestures)')}</span>}
          </li>
        ))}
        <li className="text-ink-400">{t('Les trois autres comptent des personnes.', 'The other three count people.')}</li>
      </ul>
    </div>
  );
}
