'use client';

import { useT } from '@/lib/i18n';
import { IconeOutil } from '@/components/IconeOutil';
import { textesDuType } from '@/lib/mba-outils';
import { signeDuHandler, type SigneOutil } from '@/lib/signes-outils';
import { typeDuHandler } from '@/lib/agent-outils';
import { raisonInappelable, type OutilAgent } from '@/lib/api-agent-tools';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { Risque } from './ReglagesOutil';

/** Le badge d'un outil posé : le même dessin et le même mot que la carte de « Quel outil ajouter ? » qui l'a posé. */
export function badgeDeLOutil(o: OutilAgent): { signe: SigneOutil | null; mot: readonly [string, string] } {
  if (o.origin === 'http') return { signe: 'connecteur', mot: textesDuType('connecteur', 'agent').badge };
  if (o.origin === 'mcp') return { signe: 'connecteur', mot: ['MCP', 'MCP'] };
  const handler = String(o.binding.handler ?? '');
  const type = typeDuHandler(handler);
  // L'action est propre à l'agent IA : son badge n'est pas dans la grille de l'agent de Meta.
  if (type === 'action') return { signe: signeDuHandler(handler), mot: ['Action', 'Action'] };
  if (type === 'enchainement') return { signe: signeDuHandler(handler), mot: ['Étapes', 'Steps'] };
  if (type === 'qualification') return { signe: signeDuHandler(handler), mot: ['Qualifier', 'Qualify'] };
  if (type !== null) return { signe: textesDuType(type, 'agent').signe, mot: textesDuType(type, 'agent').badge };
  // Un handler que cette console ne connaît pas : aucun dessin plutôt qu'un dessin qui affirmerait une nature.
  return { signe: signeDuHandler(handler), mot: ['Inconnu', 'Unknown'] };
}

/**
 * UNE LIGNE DE LA LISTE DES OUTILS D'UN AGENT IA (RC4), au format des lignes de l'agent de Meta (`LigneOutil`) : titre et
 * cible, badge de type, état, Modifier, Supprimer. L'état est « actif / inactif » à la place de « chez Meta » : un outil
 * d'agent IA n'est publié nulle part, il est exposé au modèle quand il est actif.
 *
 * 🔴 TROIS CHOSES SE DISENT SUR LA LIGNE, parce qu'un outil qui ne sert pas ne se voit pas autrement : la raison du
 * catalogue quand il n'est plus appelable (son système éteint, disparu de son serveur MCP) ; une action irréversible sans
 * autonomie, que le tronc commun refuse à chaque appel ; un outil actif dont le modèle ne voit rien (une cible illisible).
 */
export function LigneOutilAgent({ o, cible, busy, ouvert, onActiver, onModifier, onRetirer, children }: {
  o: OutilAgent;
  /** Ce que l'outil vise, déjà mis en mots par le parent (il a les noms des scénarios, des blocs et des appels). */
  cible: string;
  busy: boolean;
  ouvert: boolean;
  onActiver: (v: boolean) => void;
  onModifier: () => void;
  onRetirer: () => void;
  /** Le panneau de modification, montré sous la ligne quand elle est ouverte. */
  children?: React.ReactNode;
}) {
  const t = useT();
  const badge = badgeDeLOutil(o);
  const mort = raisonInappelable(o);
  const handler = String(o.binding.handler ?? '');
  return (
    <li data-testid={`outil-ligne-${o.id}`} className="flex flex-col gap-2 px-4 py-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_9rem_9rem] sm:items-center">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-900">{o.title}</p>
          <p className="truncate text-xs text-ink-500" data-testid={`outil-cible-${o.id}`}>{cible}</p>
          {mort !== null && <p className="text-xs text-danger" data-testid={`outil-mort-${o.id}`}>{t(mort.fr, mort.en)}</p>}
          {o.risk === 'irreversible' && !o.autonome && (
            <p className="text-xs text-alerte-800" data-testid={`outil-sans-autonomie-${o.id}`}>
              {t('Refusé à chaque appel tant que l’autonomie n’est pas accordée : « Modifier ».',
                'Refused on every call until autonomy is granted: “Edit”.')}
            </p>
          )}
          {o.actif && o.expose === null && mort === null && (
            <p className="text-xs text-alerte-800" data-testid={`outil-invisible-${o.id}`}>
              {t('Actif, mais le modèle n’en voit rien : ce qu’il vise ne se lit plus. Modifiez-le, ou retirez-le.',
                'Active, but the model sees nothing of it: what it targets can no longer be read. Edit it, or remove it.')}
            </p>
          )}
        </div>
        <span className="flex flex-wrap items-center gap-1 justify-self-start">
          <span className="flex items-center gap-1.5 rounded-controle bg-ink-100 px-2 py-0.5 text-xs text-ink-900" data-testid={`outil-type-${o.id}`}>
            {badge.signe !== null && <IconeOutil signe={badge.signe} taille="petite" className="text-ink-500" />}
            {t(badge.mot[0], badge.mot[1])}
          </span>
          {o.risk === 'irreversible' && <Risque risk={o.risk} handler={handler} />}
        </span>
        <ActionsOutil
          prefixe="outil" cle={o.id} nom={o.title} pose actif={o.actif} activable={mort === null} busy={busy} ouvert={ouvert}
          onActiver={onActiver} onModifier={onModifier} onRetirer={onRetirer}
        />
      </div>
      {ouvert && children}
    </li>
  );
}

/**
 * LE MÊME BLOC D'ACTIONS POUR TOUT OUTIL D'UN AGENT IA (décision de Julien du 2026-10-12), « Toujours là » comme la liste
 * des outils posés : une pastille « Actif » ou « Inactif », le bouton qui fait l'inverse (« Désactiver » ou
 * « Activer »), « Modifier », et une croix qui supprime. Deux cases, pour tenir les deux dernières colonnes de la ligne.
 * Un geste de « Toujours là » jamais posé (`pose` faux) n'a que « Activer » : il n'y a encore rien à modifier ni à
 * supprimer. Les identifiants de test se forment sur `prefixe` et `cle` (`outil-activer-<id>`, `toujours-activer-<geste>`).
 */
export function ActionsOutil({ prefixe, cle, nom, pose, actif, activable, busy, ouvert, onActiver, onModifier, onRetirer }: {
  prefixe: string;
  cle: string;
  /** Le nom lisible de l'outil : un lecteur d'écran entend « Activer « Marquer urgent » », pas cinq « Activer ». */
  nom: string;
  pose: boolean;
  actif: boolean;
  /** Faux pour un outil que sa ligne déclare mort : on ne l'active pas, on peut toujours le désactiver. */
  activable: boolean;
  busy: boolean;
  ouvert: boolean;
  onActiver: (v: boolean) => void;
  onModifier: () => void;
  onRetirer: () => void;
}) {
  const t = useT();
  return (
    <>
      <span className="flex items-center justify-between gap-2" data-testid={`${prefixe}-etat-${cle}`}>
        <span className={`rounded-controle px-1.5 py-0.5 text-xs ${actif ? 'bg-succes-100 text-succes-700' : 'bg-ink-100 text-ink-500'}`}>
          {actif ? t('Actif', 'Active') : t('Inactif', 'Inactive')}
        </span>
        {/* ⚠️ PAS D'ACTIVATION D'UN OUTIL QUE LA LIGNE DÉCLARE MORT : le serveur la refuse déjà (409), et proposer un
            geste dont on vient d'écrire qu'il est impossible est le motif « offert-et-inerte ». La désactivation reste. */}
        <Bouton variante={actif ? 'secondaire' : 'principal'} taille="petite" data-testid={`${prefixe}-activer-${cle}`}
          aria-label={actif ? t(`Désactiver « ${nom} »`, `Deactivate “${nom}”`) : t(`Activer « ${nom} »`, `Activate “${nom}”`)}
          disabled={busy || (!actif && !activable)} onClick={() => onActiver(!actif)}>
          {actif ? t('Désactiver', 'Deactivate') : t('Activer', 'Activate')}
        </Bouton>
      </span>
      <span className="flex items-center gap-3 text-xs">
        {pose && (
          <>
            <button type="button" data-testid={`${prefixe}-modifier-${cle}`} disabled={busy} onClick={onModifier}
              className="text-ink-500 hover:underline disabled:opacity-40">
              {ouvert ? t('Fermer', 'Close') : t('Modifier', 'Edit')}
            </button>
            <button type="button" data-testid={`${prefixe}-retirer-${cle}`} disabled={busy} onClick={onRetirer}
              title={t('Supprimer', 'Delete')} aria-label={t(`Supprimer « ${nom} »`, `Delete “${nom}”`)}
              className="rounded-controle px-1.5 text-sm text-danger hover:bg-danger-50 disabled:opacity-40">
              <Icone nom="fermer" taille="petite" />
            </button>
          </>
        )}
      </span>
    </>
  );
}
