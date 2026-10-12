'use client';

import { useT } from '@/lib/i18n';
import { IconeOutil } from '@/components/IconeOutil';
import { signeDuHandler } from '@/lib/signes-outils';
import { TOUJOURS_LA, type HandlerToujoursLa } from '@/lib/agent-outils';
import { raisonInappelable, type ModeleOutil, type OutilAgent } from '@/lib/api-agent-tools';
import { Bilingue, Risque } from './ReglagesOutil';
import { ActionsOutil } from './LigneOutilAgent';

/**
 * « TOUJOURS LÀ » (RC4, décision de Julien du 2026-10-06) : les outils propres à l'agent IA, qui n'ont pas d'équivalent
 * chez l'agent de Meta et rien à viser. Chaque ligne porte le MÊME bloc d'actions que la liste des outils posés
 * (`ActionsOutil`, décision de Julien du 2026-10-12) : « Activer » pose l'outil s'il manque, puis l'active ;
 * « Désactiver » le désactive (il reste posé, avec ses réglages) ; « Modifier » ouvre ses réglages (nom vu par le
 * modèle, quand l'appeler) ; la croix le supprime, réglages compris, et sa ligne revient à « Inactif ».
 *
 * ⚠️ L'ACTIVATION RESTE LE CONSENTEMENT HUMAIN, porté par le nom de qui active (le serveur le prend sur le jeton) :
 * « Activer » n'est qu'un raccourci des deux gestes « poser » puis « activer ».
 */
export function ToujoursLa({ outils, catalogue, busy, ouvert, onBasculer, onModifier, onRetirer, reglages }: {
  outils: OutilAgent[];
  catalogue: ModeleOutil[];
  busy: boolean;
  /** L'outil dont les réglages sont ouverts, s'il est de cette section. */
  ouvert: string | null;
  onBasculer: (handler: HandlerToujoursLa, outil: OutilAgent | undefined, valeur: boolean) => void;
  onModifier: (outil: OutilAgent) => void;
  onRetirer: (outil: OutilAgent) => void;
  /** Le panneau des réglages d'un outil de la section, rendu sous sa ligne quand il est ouvert. */
  reglages: (outil: OutilAgent) => React.ReactNode;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2" data-testid="outils-toujours-la">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{t('Toujours là', 'Always there')}</h3>
        <p className="text-xs text-ink-500">
          {t('Les gestes propres à l’agent IA. Activez ceux dont il a besoin : il ne s’en sert qu’une fois actifs.',
            'The AI agent’s own moves. Activate the ones it needs: it only uses them once active.')}
        </p>
      </div>
      <ul className="divide-y divide-ink-100 rounded-carte border border-ink-200 bg-white">
        {TOUJOURS_LA.map((handler) => {
          const modele = catalogue.find((m) => m.handler === handler);
          // Un seul outil par geste ici : le premier posé. Un doublon éventuel (posé par une version antérieure) se règle
          // depuis la liste du dessous, où il apparaît comme les autres.
          const outil = outils.find((o) => o.origin === 'mba' && String(o.binding.handler ?? '') === handler);
          const mort = outil ? raisonInappelable(outil) : null;
          const signe = signeDuHandler(handler);
          return (
            <li key={handler} data-testid={`toujours-ligne-${handler}`} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                    {signe !== null && <IconeOutil signe={signe} className="text-ink-400" />}
                    <span className="min-w-0">
                      {modele ? <Bilingue texte={modele.titre} /> : (outil?.title ?? handler)}
                      {modele && <Risque risk={modele.risk} handler={handler} />}
                    </span>
                  </p>
                  {modele && <p className="mt-0.5 text-xs leading-relaxed text-ink-500"><Bilingue texte={modele.description} /></p>}
                  {mort !== null && <p className="text-xs text-danger" data-testid={`outil-mort-${outil!.id}`}>{t(mort.fr, mort.en)}</p>}
                  {/* « terminer » sans règle d'arrêt : actif, mais le modèle n'en voit rien. Sans ce message, le client croit
                      son agent réglé et ne comprend pas pourquoi il ne termine jamais. */}
                  {outil?.actif && outil.expose === null && (
                    <p className="text-xs text-alerte-800" data-testid={`toujours-muet-${handler}`}>
                      {t(
                        'Cet outil est actif mais le modèle n’en voit rien : il n’a aucune valeur possible. Déclarez au moins une règle d’arrêt dans l’onglet « Objectif et transferts ».',
                        'This tool is active but the model sees nothing of it: it has no possible value. Declare at least one stop rule in the “Objective and handovers” tab.',
                      )}
                    </p>
                  )}
                </div>
                {/* Les deux mêmes colonnes que la liste des outils posés (`LigneOutilAgent`) : les boutons s'alignent d'une
                    ligne à l'autre et d'une section à l'autre, posé ou non. */}
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:grid sm:grid-cols-[9rem_9rem]">
                  <ActionsOutil
                    prefixe="toujours" cle={handler} nom={modele ? t(modele.titre.fr, modele.titre.en) : (outil?.title ?? handler)}
                    pose={outil !== undefined} actif={outil?.actif === true}
                    activable={mort === null} busy={busy} ouvert={outil !== undefined && ouvert === outil.id}
                    onActiver={(v) => onBasculer(handler, outil, v)}
                    onModifier={() => { if (outil) onModifier(outil); }}
                    onRetirer={() => { if (outil) onRetirer(outil); }}
                  />
                </div>
              </div>
              {outil && ouvert === outil.id && reglages(outil)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
