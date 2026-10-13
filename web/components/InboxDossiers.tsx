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
  | 'toutes' | 'aTraiter' | 'urgentes' | 'traitees' | 'signalees' | 'archivees' | 'nonAffectees'
  | { membre: string };

/** Deux dossiers sont-ils le même ? Les objets ne se comparent pas avec `===`. */
export function memeDossier(a: DossierInbox, b: DossierInbox): boolean {
  if (typeof a === 'object' && typeof b === 'object') return a.membre === b.membre;
  return a === b;
}

/**
 * Le libellé d'un dossier. Sert au MENU et au titre de la liste, qui vivent maintenant dans deux colonnes
 * voisines : deux libellés écrits séparément pour le même dossier finiraient par diverger, et l'écran dirait
 * deux choses du même endroit, côte à côte.
 *
 * Un membre inconnu des compteurs (il vient d'être retiré de l'espace, la conversation lui reste affectée)
 * rend un libellé neutre plutôt que son identifiant technique.
 */
export function libelleDossier(d: DossierInbox, compteurs: CompteursInbox, t: (fr: string, en?: string) => string): string {
  if (typeof d === 'object') {
    return compteurs.parMembre.find((m) => m.userId === d.membre)?.nom ?? t('Collaborateur', 'Teammate');
  }
  const table: Record<Exclude<DossierInbox, { membre: string }>, string> = {
    toutes: t('Tout', 'All'),
    aTraiter: t('À traiter', 'To handle'),
    urgentes: t('Urgent', 'Urgent'),
    traitees: t('Traité', 'Done'),
    signalees: t('Signalé', 'Flagged'),
    archivees: t('Archivé', 'Archived'),
    nonAffectees: t('Non affecté', 'Unassigned'),
  };
  return table[d];
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

  /**
   * Une ligne du menu. `cible` est le dossier qu'elle ouvre, `cle` sert aux tests et à rien d'autre.
   *
   * `nonLues` : comme dans une boîte mail, la ligne passe en GRAS tant que le dossier contient une conversation au
   * message entrant pas encore ouvert (décision de Julien du 2026-10-13, pour « À traiter » et les collaborateurs).
   * Le gras s'éteint quand quelqu'un de l'équipe a ouvert le fil : le « lu » est celui de la pastille, commun à tous.
   */
  const Entree = ({ cle, label, n, cible, nonLues = 0 }: { cle: string; label: string; n: number; cible: DossierInbox; nonLues?: number }) => {
    const actif = memeDossier(dossier, cible);
    const gras = nonLues > 0;
    return (
      <button
        type="button"
        data-testid={`dossier-${cle}`}
        data-non-lues={gras ? 'true' : undefined}
        aria-current={actif ? 'true' : undefined}
        aria-label={gras ? `${label} (${n}), ${t(`${nonLues} non lue${nonLues > 1 ? 's' : ''}`, `${nonLues} unread`)}` : undefined}
        onClick={() => onChange(cible)}
        className={`flex w-full items-center gap-2 rounded-controle px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ${
          actif ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900'
        } ${gras ? `font-bold ${actif ? '' : 'text-ink-900'}` : ''}`}
      >
        <span className="truncate">{label}</span>
        <span data-testid={`dossier-n-${cle}`} className={`ml-auto shrink-0 text-xs tabular-nums ${gras ? 'font-bold text-ink-900' : 'text-ink-500'}`}>({n})</span>
      </button>
    );
  };

  /**
   * Les titres des deux sections. 🔴 PLUS GROS ET PLUS GRAS QUE LES LIGNES (Julien, 2026-10-13) : en petit gris, on
   * ne distinguait pas « Affectation » de « Conversations », et ils se lisaient comme deux lignes de plus.
   */
  const titreSection = 'px-2.5 pb-1 text-base font-bold text-ink-900';

  return (
    <nav data-testid="inbox-dossiers" aria-label={t('Dossiers', 'Folders')} className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <p className={titreSection} data-testid="inbox-titre-conversations">
          {t('Conversations', 'Conversations')}
        </p>
        {/* Les libellés viennent de `libelleDossier`, jamais réécrits ici : c'est la même phrase que le titre
            de la colonne voisine, et deux copies auraient divergé au premier renommage. */}
        {([
          ['toutes', compteurs.tout],
          ['aTraiter', compteurs.aTraiter],
          // « Urgent » juste sous « À traiter » (RC2, décision de Julien du 2026-10-06) : ce qui presse se lit en premier.
          ['urgentes', compteurs.urgentes],
          // Puis « Traité », le contraire de « À traiter », qu'on lit avec lui.
          ['traitees', compteurs.traitees],
          ['signalees', compteurs.signalees],
          ['archivees', compteurs.archivees],
        ] as const).map(([cle, n]) => (
          <Entree key={cle} cle={cle} label={libelleDossier(cle, compteurs, t)} n={n} cible={cle}
            nonLues={cle === 'aTraiter' ? compteurs.aTraiterNonLues : 0} />
        ))}
      </div>

      {peutVoirAffectation && (
        <div className="flex flex-col gap-0.5">
          <p className={titreSection} data-testid="inbox-titre-affectation">
            {t('Affectation', 'Assignment')}
          </p>
          <Entree cle="nonAffectees" label={libelleDossier('nonAffectees', compteurs, t)} n={compteurs.nonAffectees} cible="nonAffectees" />
          {/* TOUS les membres, y compris à ZÉRO : un collaborateur sans conversation est une information pour
              un manager, et ne le montrer que lorsqu'il a du travail le rendrait invisible au moment précis
              où on le cherche. */}
          {compteurs.parMembre.map((m) => (
            <Entree key={m.userId} cle={`membre-${m.userId}`} label={m.nom} n={m.n} cible={{ membre: m.userId }} nonLues={m.nonLues} />
          ))}
        </div>
      )}
    </nav>
  );
}
