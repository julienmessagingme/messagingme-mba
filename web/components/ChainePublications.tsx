'use client';

import { useT, useLocale } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { formatDate } from '@/lib/day';
import { classesPastille, etatPublication } from '@/lib/chaine-statut';
import type { EtatDistant, LienChaine, PostChaine } from '@/lib/api-chaine';

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
  distant: EtatDistant;
  erreur: string | null;
  /** `null` = aucun rallumage en cours. Sinon, l'id du lien qu'on rallume. */
  rallumage: string | null;
  onRallumer: (linkId: string) => Promise<void>;
}

export function ChainePublications(props: ChainePublicationsProps) {
  const t = useT();
  const { locale } = useLocale();
  const { posts, liens, distant, erreur, rallumage } = props;

  if (erreur !== null) {
    return (
      <div className={cardCls} data-testid="chaine-publications-erreur">
        <p className="text-sm text-coral">{erreur}</p>
      </div>
    );
  }

  const parLien = new Map(liens.map((l) => [l.id, l]));

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

            return (
              <li key={p.id} className="py-3" data-testid={`chaine-publication-${p.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink-800">
                      {p.message?.text?.trim() || t('(sans texte)', '(no text)')}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {formatDate(p.createdAt, locale)}
                      {lien !== null ? ` · ${lien.phrase}` : ` · ${t('sans bouton', 'no button')}`}
                    </p>
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
