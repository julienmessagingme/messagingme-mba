'use client';

import { useT } from '@/lib/i18n';
import type { CompteursInbox } from '@/lib/api/inbox';

/**
 * Le menu de dossiers de l'Inbox, façon boîte mail.
 *
 * 🔴 CE N'EST PAS UNE BARRE DE NAVIGATION. L'onglet Inbox n'en a plus depuis le lot A : ce menu vit DANS
 * l'écran et change ce que la liste montre, pas la page où l'on est. Il remplace trois boutons de filtre
 * alignés en haut de la liste, qui ne portaient qu'un compteur sur trois et aucune notion de rangement.
 *
 * 🔴 LE COMPTEUR EST TOUJOURS AFFICHÉ, Y COMPRIS À ZÉRO, contrairement aux boutons qu'il remplace. Dans une
 * boîte mail, « Signalé (0) » est une information (« rien à relire ») ; un libellé nu laisse croire que le
 * chiffre n'a pas chargé, et on va vérifier pour rien.
 *
 * ⚠️ Les compteurs portent sur TOUTE la base, pas sur la page affichée : ils viennent du serveur, en une
 * lecture. Un compteur calculé sur les lignes chargées descendrait à mesure qu'on pagine.
 */

/**
 * Le dossier affiché. Un membre est porté par un objet et non par une chaîne : sans ça, un identifiant
 * d'utilisateur qui vaudrait « archivees » changerait de dossier, et rien ne le signalerait.
 */
export type DossierInbox =
  | 'toutes' | 'aTraiter' | 'signalees' | 'archivees' | 'nonAffectees'
  | { membre: string };

/** Deux dossiers sont-ils le même ? Les objets ne se comparent pas avec `===`. */
export function memeDossier(a: DossierInbox, b: DossierInbox): boolean {
  if (typeof a === 'object' && typeof b === 'object') return a.membre === b.membre;
  return a === b;
}

export function InboxDossiers({ dossier, compteurs, peutVoirAffectation, onChange }: {
  dossier: DossierInbox;
  compteurs: CompteursInbox;
  /**
   * La section « Affectation » est-elle visible ?
   *
   * ⚠️ Admins ET managers, pas les admins seuls : c'est déjà cette règle qui décide qui peut AFFECTER une
   * conversation. Montrer le geste sans montrer la charge serait incohérent, et c'est le manager que Julien
   * nomme quand il demande cette section.
   */
  peutVoirAffectation: boolean;
  onChange: (d: DossierInbox) => void;
}) {
  const t = useT();

  /** Une ligne du menu. `cible` est le dossier qu'elle ouvre, `cle` sert aux tests et à rien d'autre. */
  const Entree = ({ cle, label, n, cible }: { cle: string; label: string; n: number; cible: DossierInbox }) => (
    <button
      type="button"
      data-testid={`dossier-${cle}`}
      aria-current={memeDossier(dossier, cible) ? 'true' : undefined}
      onClick={() => onChange(cible)}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
        memeDossier(dossier, cible) ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
      }`}
    >
      <span className="truncate">{label}</span>
      <span data-testid={`dossier-n-${cle}`} className="ml-auto shrink-0 text-xs tabular-nums text-ink-400">({n})</span>
    </button>
  );

  return (
    <nav data-testid="inbox-dossiers" aria-label={t('Dossiers', 'Folders')} className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          {t('Conversations', 'Conversations')}
        </p>
        {([
          ['toutes', t('Tout', 'All'), compteurs.tout],
          ['aTraiter', t('À traiter', 'To handle'), compteurs.aTraiter],
          ['signalees', t('Signalé', 'Flagged'), compteurs.signalees],
          ['archivees', t('Archivé', 'Archived'), compteurs.archivees],
        ] as const).map(([cle, label, n]) => (
          <Entree key={cle} cle={cle} label={label} n={n} cible={cle} />
        ))}
      </div>

      {peutVoirAffectation && (
        <div className="flex flex-col gap-0.5">
          <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            {t('Affectation', 'Assignment')}
          </p>
          <Entree cle="nonAffectees" label={t('Non affecté', 'Unassigned')} n={compteurs.nonAffectees} cible="nonAffectees" />
          {/* TOUS les membres, y compris à ZÉRO : un collaborateur sans conversation est une information pour
              un manager, et ne le montrer que lorsqu'il a du travail le rendrait invisible au moment précis
              où on le cherche. */}
          {compteurs.parMembre.map((m) => (
            <Entree key={m.userId} cle={`membre-${m.userId}`} label={m.nom} n={m.n} cible={{ membre: m.userId }} />
          ))}
        </div>
      )}
    </nav>
  );
}
