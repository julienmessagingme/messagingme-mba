'use client';

import { useT } from '@/lib/i18n';
import type { GroupeTableau } from '@/lib/mesures-scenario';

/**
 * Le tableau, en HISTOGRAMME horizontal : des barres verticales groupées par bloc, posées sur une seule ligne
 * d'abscisse CONTINUE, avec un espace entre les groupes.
 *
 * La ligne continue n'est pas décorative : c'est elle qui dit que les groupes appartiennent au même parcours.
 * Des axes séparés par bloc auraient donné trois graphes côte à côte, et on ne compare pas trois graphes.
 *
 * Les hauteurs sont relatives au MAXIMUM DU TABLEAU, jamais à celui de chaque groupe : sinon un bloc à 12 et
 * un bloc à 240 afficheraient la même barre pleine hauteur, ce qui inverserait la lecture de l'entonnoir.
 */
export interface TableauHistogrammeProps {
  groupes: GroupeTableau[];
}

/** Géométrie du dessin, en unités du viewBox (le SVG se met ensuite à l'échelle de son conteneur). */
const H = 300;          // hauteur totale
const BAS = 64;         // place sous l'axe pour le nom du bloc
const HAUT = 26;        // place au-dessus des barres pour la valeur
const LARGEUR_BARRE = 34;
const ECART_BARRE = 10;
const ECART_GROUPE = 44; // l'espace entre blocs, demandé, qui sépare sans couper l'axe
const MARGE = 16;

export function TableauHistogramme({ groupes }: TableauHistogrammeProps) {
  const t = useT();

  const largeurGroupe = (g: GroupeTableau): number =>
    g.barres.length * LARGEUR_BARRE + Math.max(0, g.barres.length - 1) * ECART_BARRE;
  const largeur = MARGE * 2
    + groupes.reduce((acc, g) => acc + largeurGroupe(g), 0)
    + Math.max(0, groupes.length - 1) * ECART_GROUPE;

  const yAxe = H - BAS;
  const hauteurUtile = yAxe - HAUT;
  // Le maximum sert d'échelle. À zéro partout (mesures choisies mais rien mesuré), on garde 1 pour éviter une
  // division par zéro : toutes les barres restent alors plates, ce qui est la lecture juste.
  const max = Math.max(1, ...groupes.flatMap((g) => g.barres.map((b) => b.count)));

  // Légende : une entrée par mesure retenue, avec SA couleur. Elle remplace un libellé sous chaque barre, qui
  // aurait été illisible dès trois mesures par bloc.
  const legende = groupes.flatMap((g) => g.barres.map((b) => ({ cle: b.cle, label: b.label, couleur: b.couleur })));
  const legendeUnique = legende.filter((e, i) => legende.findIndex((x) => x.label === e.label && x.couleur === e.couleur) === i);

  let x = MARGE;

  return (
    <div data-testid="tableaux-graphe">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5" data-testid="tableau-legende">
        {legendeUnique.map((e) => (
          <span key={e.cle} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: e.couleur }} />
            {e.label}
          </span>
        ))}
      </div>

      {/* Centre : un petit tableau colle a gauche laisse un grand vide a droite, qui se lit comme un rendu
          inacheve. Le defilement horizontal reste la pour les tableaux qui depassent. */}
      <div className="flex justify-center overflow-x-auto">
        <svg viewBox={`0 0 ${largeur} ${H}`} width={largeur} height={H} role="img" className="max-w-full">
          {/* L'axe, d'un bout à l'autre : un seul parcours, donc une seule ligne. */}
          <line x1={MARGE / 2} y1={yAxe} x2={largeur - MARGE / 2} y2={yAxe} stroke="#b9c0cd" strokeWidth={1.5} />

          {groupes.map((g) => {
            const debut = x;
            const lg = largeurGroupe(g);
            x += lg + ECART_GROUPE;
            return (
              <g key={g.nodeId}>
                {g.barres.map((b, i) => {
                  const bx = debut + i * (LARGEUR_BARRE + ECART_BARRE);
                  // Une valeur NON NULLE garde 2px de hauteur : sinon « 1 envoyé » se dessine comme « aucun »,
                  // et une barre invisible se lit comme une mesure absente.
                  const h = b.count === 0 ? 0 : Math.max(2, Math.round((b.count / max) * hauteurUtile));
                  return (
                    <g key={b.cle} data-testid="barre">
                      <title>{`${b.label} : ${b.count}${b.contacts !== b.count ? ` (${b.contacts} ${t('personnes', 'people')})` : ''}`}</title>
                      <rect x={bx} y={yAxe - h} width={LARGEUR_BARRE} height={h} rx={3} fill={b.couleur} />
                      {/* Valeur et personnes sur UNE seule ligne. Empilés, les deux nombres se lisaient comme
                          un seul, et celui du dessus paraissait le plus important alors qu'il est secondaire.
                          Le nombre de personnes n'apparaît que s'il DIFFÈRE : partout, il ferait douter d'un
                          chiffre qui la plupart du temps dit la même chose. */}
                      <text x={bx + LARGEUR_BARRE / 2} y={yAxe - h - 8} textAnchor="middle" fontSize={11} fontWeight={600} fill="#2b3245">
                        {b.count}
                        {b.contacts !== b.count && <tspan fontSize={9} fontWeight={400} fill="#8a93a5">{` · ${b.contacts} p.`}</tspan>}
                      </text>
                    </g>
                  );
                })}
                {/* Nom du bloc sous son groupe, sur deux lignes au besoin : c'est ce qui ancre les barres à
                    une étape du parcours. */}
                <text x={debut + lg / 2} y={yAxe + 18} textAnchor="middle" fontSize={11} fontWeight={600} fill="#4a5265">
                  {g.titre.length > 18 ? `${g.titre.slice(0, 17)}…` : g.titre}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

    </div>
  );
}
