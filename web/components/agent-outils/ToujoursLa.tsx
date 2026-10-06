'use client';

import { useT } from '@/lib/i18n';
import { IconeOutil } from '@/components/IconeOutil';
import { signeDuHandler } from '@/lib/signes-outils';
import { TOUJOURS_LA, type HandlerToujoursLa } from '@/lib/agent-outils';
import { raisonInappelable, type ModeleOutil, type OutilAgent } from '@/lib/api-agent-tools';
import { Bilingue, Risque } from './ReglagesOutil';

/**
 * « TOUJOURS LÀ » (RC4, décision de Julien du 2026-10-06) : les outils propres à l'agent IA, qui n'ont pas d'équivalent
 * chez l'agent de Meta et rien à viser. Un interrupteur chacun : allumer pose l'outil s'il manque, puis l'active ;
 * éteindre le désactive (il reste posé, avec ses réglages). Ses réglages (nom vu par le modèle, quand l'appeler) restent
 * derrière « Régler ».
 *
 * ⚠️ L'ACTIVATION RESTE LE CONSENTEMENT HUMAIN, porté par le nom de qui allume (le serveur le prend sur le jeton) :
 * l'interrupteur n'est qu'un raccourci des deux gestes « poser » puis « activer ».
 */
export function ToujoursLa({ outils, catalogue, busy, ouvert, onBasculer, onRegler, reglages }: {
  outils: OutilAgent[];
  catalogue: ModeleOutil[];
  busy: boolean;
  /** L'outil dont les réglages sont ouverts, s'il est de cette section. */
  ouvert: string | null;
  onBasculer: (handler: HandlerToujoursLa, outil: OutilAgent | undefined, valeur: boolean) => void;
  onRegler: (outil: OutilAgent) => void;
  /** Le panneau des réglages d'un outil de la section, rendu sous sa ligne quand il est ouvert. */
  reglages: (outil: OutilAgent) => React.ReactNode;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2" data-testid="outils-toujours-la">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{t('Toujours là', 'Always there')}</h3>
        <p className="text-xs text-ink-500">
          {t('Les gestes propres à l’agent IA. Allumez ceux dont il a besoin : il ne s’en sert qu’une fois allumés.',
            'The AI agent’s own moves. Turn on the ones it needs: it only uses them once turned on.')}
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
                <div className="flex shrink-0 items-center gap-3">
                  {outil && (
                    <button type="button" data-testid={`toujours-regler-${handler}`} disabled={busy} onClick={() => onRegler(outil)}
                      className="text-xs text-ink-500 hover:underline disabled:opacity-40">
                      {ouvert === outil.id ? t('Fermer', 'Close') : t('Régler', 'Settings')}
                    </button>
                  )}
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-700">
                    <input
                      type="checkbox" role="switch" data-testid={`toujours-${handler}`}
                      aria-label={modele ? modele.titre.fr : handler}
                      checked={outil?.actif === true}
                      // Pas d'allumage d'un outil que la ligne déclare mort ; l'extinction reste possible.
                      disabled={busy || (outil?.actif !== true && mort !== null)}
                      onChange={(e) => onBasculer(handler, outil, e.target.checked)}
                    />
                    {outil?.actif ? t('Allumé', 'On') : t('Éteint', 'Off')}
                  </label>
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
