'use client';

import { useT, useLocale } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { formatDate } from '@/lib/day';
import { classesPastille, etatPublication } from '@/lib/chaine-statut';
import type { ConversationsDunLien, EtatDistant, LienChaine, PostChaine } from '@/lib/api-chaine';
import type { WorkflowSummary } from '@/lib/api';
import { TexteMisEnForme } from '@/components/TexteMisEnForme';

/**
 * Les publications déjà parties, et l'état de leur bouton.
 *
 * 🔴 CE QUE CET ÉCRAN AJOUTE DE PLUS QU'UNE LISTE : il est le seul endroit où un bouton MORT devient
 * visible. Quand l'allumage d'un lien échoue après une publication réussie, le post circule avec un bouton
 * qui ne démarre rien, et jusqu'ici cela ne se voyait que dans les journaux du serveur. Ici, la publication
 * porte la marque, et le bouton de réparation est à côté.
 *
 * ⚠️ Le statut est LU EN DIRECT chez le fournisseur : rien n'en est stocké chez nous. Quand il est muet
 * (`distant === 'injoignable'`), les publications restent affichées SANS statut, ce qui est honnête. Les
 * masquer laisserait croire qu'il n'y a rien eu.
 */

export interface ChainePublicationsProps {
  posts: PostChaine[];
  liens: LienChaine[];
  /** Pour nommer le scénario vers lequel chaque publication renvoie. */
  scenarios: WorkflowSummary[];
  /**
   * Ce que chaque BOUTON a démarré. `null` = mesure non chargée (elle a échoué, ou elle arrive) : l'écran
   * n'affiche alors rien du tout, plutôt qu'un zéro qui se lirait comme « ce bouton n'a rien produit ».
   */
  conversations: { parLien: ConversationsDunLien[]; partiel: boolean } | null;
  distant: EtatDistant;
  erreur: string | null;
  /** `null` = aucun rallumage en cours. Sinon, l'id du lien qu'on rallume. */
  rallumage: string | null;
  onRallumer: (linkId: string) => Promise<void>;
}

export function ChainePublications(props: ChainePublicationsProps) {
  const t = useT();
  const { locale } = useLocale();
  const { posts, liens, scenarios, conversations, distant, erreur, rallumage } = props;

  if (erreur !== null) {
    return (
      <div className={cardCls} data-testid="chaine-publications-erreur">
        <p className="text-sm text-coral">{erreur}</p>
      </div>
    );
  }

  const parLien = new Map(liens.map((l) => [l.id, l]));
  const parScenario = new Map(scenarios.map((w) => [w.id, w]));
  const parConversations = new Map((conversations?.parLien ?? []).map((c) => [c.linkId, c]));

  return (
    <div className={cardCls} data-testid="chaine-publications">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink-800">{t('Publications', 'Posts')}</h2>
        {distant === 'injoignable' ? (
          <span className="text-xs text-gold" data-testid="chaine-publications-injoignable">
            {t('Statuts indisponibles : Channels Me ne répond pas', 'Statuses unavailable: Channels Me is not answering')}
          </span>
        ) : null}
      </div>

      {posts.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400" data-testid="chaine-publications-vide">
          {t('Aucune publication pour le moment.', 'No posts yet.')}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {posts.map((p) => {
            const etat = etatPublication(p.message?.status, locale);
            const lien = p.linkId === null ? null : parLien.get(p.linkId) ?? null;
            // 🔴 Le bouton est MORT quand le lien existe mais que son automation est éteinte. `null` veut
            // dire « plus d'automation compagnon », ce qui est un autre cas, tout aussi mort mais non
            // réparable : le serveur refuse alors `/enable` en 409.
            const boutonMort = lien !== null && lien.enabled !== true;
            const reparable = lien !== null && lien.enabled === false;
            const conv = lien === null ? null : parConversations.get(lien.id) ?? null;

            return (
              <li key={p.id} className="py-3" data-testid={`chaine-publication-${p.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {/* 🔴 LE MÊME RENDU QUE L'APERÇU, juste au-dessus. Cette liste montrait `*promo*` avec
                        ses étoiles pendant que l'aperçu affichait « promo » en gras : deux moitiés du même
                        écran qui ne montraient pas la même chose du même post. */}
                    <p className="truncate text-sm text-ink-800">
                      {(p.message?.text?.trim() ?? '') === ''
                        ? t('(sans texte)', '(no text)')
                        : <TexteMisEnForme texte={p.message!.text!.trim()} />}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {formatDate(p.createdAt, locale)}
                      {lien !== null ? ` · ${lien.phrase}` : ` · ${t('sans bouton', 'no button')}`}
                    </p>
                    {/* 🔴 VERS QUEL SCÉNARIO, ET CE QUE LE BOUTON A PRODUIT. Julien demandait « combien de
                        clics sur le bouton » : ce nombre n'existe pas et ne peut pas exister, un appui sur
                        un lien wa.me ouvre WhatsApp sur le téléphone de l'abonné sans jamais nous
                        traverser. On affiche donc ce qu'on VOIT, le message qui arrive ensuite, et on le
                        NOMME pour ce que c'est. */}
                    {lien !== null && (
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="text-ink-500" data-testid={`chaine-publication-scenario-${p.id}`}>
                          {'→ '}
                          {parScenario.get(lien.workflowId)?.name
                            ?? t('scénario introuvable', 'scenario not found')}
                        </span>
                        {conv !== null && (
                          <span
                            className="text-ink-500 tabular-nums"
                            data-testid={`chaine-publication-conversations-${p.id}`}
                            // ⚠️ Le titre porte les deux limites que le chiffre ne peut pas montrer seul :
                            // il vaut pour TOUTES les publications de ce bouton, et il compte des messages
                            // reçus, jamais des appuis (un appui ne nous est pas visible).
                            title={t(
                              'Conversations démarrées depuis ce bouton, toutes publications confondues. Un appui sur le lien n’est pas visible de nous : on compte les messages reçus.',
                              'Conversations started from this button, across all its posts. A tap on the link is invisible to us: we count the messages received.',
                            )}
                          >
                            {conv.contacts === 0
                              ? t('aucune conversation démarrée', 'no conversation started')
                              : conversations?.partiel === true
                                ? t(
                                    `au moins ${conv.contacts} conversation${conv.contacts > 1 ? 's' : ''} démarrée${conv.contacts > 1 ? 's' : ''}`,
                                    `at least ${conv.contacts} conversation${conv.contacts > 1 ? 's' : ''} started`,
                                  )
                                : t(
                                    `${conv.contacts} conversation${conv.contacts > 1 ? 's' : ''} démarrée${conv.contacts > 1 ? 's' : ''}`,
                                    `${conv.contacts} conversation${conv.contacts > 1 ? 's' : ''} started`,
                                  )}
                            {' '}
                            <span className="text-ink-300">
                              {t('(ce bouton, tous posts)', '(this button, all posts)')}
                            </span>
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <span
                    className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${classesPastille(etat.ton)}`}
                    data-testid={`chaine-publication-etat-${p.id}`}
                  >
                    {etat.libelle}
                  </span>
                </div>

                {boutonMort ? (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-coral/10 px-3 py-2"
                    data-testid={`chaine-publication-bouton-mort-${p.id}`}
                  >
                    <span className="text-xs text-ink-700">
                      {t(
                        'Le bouton de cette publication ne démarre rien : son lien est éteint.',
                        'This post’s button starts nothing: its link is switched off.',
                      )}
                    </span>
                    {reparable ? (
                      <button
                        type="button"
                        onClick={() => void props.onRallumer(lien.id)}
                        disabled={rallumage === lien.id}
                        className="rounded-md border border-coral px-2.5 py-1 text-xs font-medium text-coral hover:bg-coral/10 disabled:opacity-50"
                        data-testid={`chaine-publication-rallumer-${p.id}`}
                      >
                        {rallumage === lien.id ? t('Allumage…', 'Turning on…') : t('Rallumer le lien', 'Turn link back on')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
