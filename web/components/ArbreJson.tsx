'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { arbreDuPayload, type NoeudJson } from '@/lib/chemin-json';

/**
 * Affiche un payload JSON reçu d'un outil tiers, et rend chaque FEUILLE attachable à un champ de contact.
 *
 * C'est le seul morceau vraiment neuf de la fonction webhooks : aucun composant d'affichage de JSON n'existait
 * dans la console. Il reste volontairement mince, toute la logique de chemin vivant dans `lib/chemin-json.ts`
 * (module pur, testé).
 *
 * Un noeud non attachable (objet, tableau, `null`, clé contenant un point) reste AFFICHÉ : masquer ce qu'on a
 * reçu ferait chercher une clé qui est pourtant bien là.
 */
export function ArbreJson({
  payload,
  cheminsUtilises,
  onAttacher,
}: {
  payload: unknown;
  /** Chemins déjà présents dans le mapping : la ligne le dit au lieu de proposer un doublon. */
  cheminsUtilises: readonly string[];
  onAttacher: (chemin: string) => void;
}) {
  const t = useT();
  const racine = arbreDuPayload(payload);

  if (racine.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {t('Le dernier appel ne contenait pas d’objet JSON exploitable.', 'The last call did not contain a usable JSON object.')}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-2 font-mono text-xs" data-testid="arbre-json">
      {racine.map((n) => (
        <Ligne key={n.cle} noeud={n} profondeur={0} cheminsUtilises={cheminsUtilises} onAttacher={onAttacher} />
      ))}
    </div>
  );
}

function Ligne({
  noeud,
  profondeur,
  cheminsUtilises,
  onAttacher,
}: {
  noeud: NoeudJson;
  profondeur: number;
  cheminsUtilises: readonly string[];
  onAttacher: (chemin: string) => void;
}) {
  const t = useT();
  // Les deux premiers niveaux sont ouverts : c'est là que se trouvent presque toujours le téléphone et le nom.
  const [ouvert, setOuvert] = useState(profondeur < 2);
  const branche = noeud.enfants.length > 0;
  const deja = noeud.chemin !== '' && cheminsUtilises.includes(noeud.chemin);

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-white"
        style={{ paddingLeft: `${profondeur * 14 + 4}px` }}
        data-testid="noeud-json"
        data-cle={noeud.cle}
      >
        {branche ? (
          <button type="button" onClick={() => setOuvert((v) => !v)} className="w-3 text-ink-400 hover:text-ink-700" aria-label={ouvert ? t('Replier', 'Collapse') : t('Déplier', 'Expand')}>
            {ouvert ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span className="text-ink-700">{noeud.cle}</span>
        <span className="truncate text-ink-400">{noeud.apercu}</span>
        <span className="ml-auto shrink-0">
          {noeud.attachable && !deja && (
            <button
              type="button"
              onClick={() => onAttacher(noeud.chemin)}
              className="rounded border border-brand-200 bg-white px-1.5 py-0.5 text-[11px] font-sans font-medium text-brand-600 hover:bg-brand-50"
            >
              {t('Attacher…', 'Attach…')}
            </button>
          )}
          {deja && <span className="text-[11px] font-sans text-ink-400">{t('déjà attaché', 'already attached')}</span>}
          {/* Une clé inadressable est signalée : sans ça, l'utilisateur cherche pourquoi elle n'est pas cliquable. */}
          {!noeud.attachable && noeud.chemin === '' && noeud.type === 'valeur' && (
            <span className="text-[11px] font-sans text-ink-400" title={t('Le nom de cette clé contient un point ou un crochet : elle ne peut pas être désignée.', 'This key name contains a dot or bracket: it cannot be addressed.')}>
              {t('non adressable', 'not addressable')}
            </span>
          )}
        </span>
      </div>
      {ouvert && noeud.enfants.map((e, i) => (
        <Ligne key={`${e.cle}-${i}`} noeud={e} profondeur={profondeur + 1} cheminsUtilises={cheminsUtilises} onAttacher={onAttacher} />
      ))}
    </div>
  );
}
