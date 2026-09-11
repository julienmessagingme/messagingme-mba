'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useT, useLocale } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { demanderAide, type ReponseAide } from '@/lib/api-aide';

/**
 * LE BOUTON D'AIDE DE LA CONSOLE : posé UNE SEULE FOIS dans `AppShell`, donc présent sur les 36 écrans
 * authentifiés et sur aucun des écrans de connexion.
 *
 * 🔴 IL EXPLIQUE ET IL EMMÈNE, IL N'ÉCRIT JAMAIS RIEN. Aucune action, aucun brouillon, aucun réglage. C'est
 * le périmètre tranché par Julien le 2026-09-11.
 *
 * 🔴 QUAND IL NE SAIT PAS, IL LE DIT ET IL OUVRE `/support`. Inventer une réponse plausible est la seule
 * chose qu'on ne tolère pas : un bot qui annonce un bouton qui n'existe pas fait perdre confiance dans le
 * PRODUIT, pas dans le bot. L'écran de recours existe déjà et part par e-mail vers l'équipe.
 *
 * ⚠️ L'historique vit dans le composant, pas sur le serveur. Une question d'aide n'a pas de suite : on
 * demande, on lit, on va sur l'écran. Persister la conversation aurait été du travail pour un besoin que
 * personne n'a exprimé.
 */
export function BoutonAide({ tenantId, ecranCourant }: { tenantId: string; ecranCourant: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [ouvert, setOuvert] = useState(false);
  const [question, setQuestion] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [reponse, setReponse] = useState<ReponseAide | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // Une question en vol quand on en pose une autre est ABANDONNÉE : sans ça, la réponse à l'ancienne
  // pourrait arriver après la nouvelle et s'afficher à sa place.
  const enCours = useRef<AbortController | null>(null);

  async function envoyer(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const q = question.trim();
    if (q === '' || occupe) return;
    enCours.current?.abort();
    const abandon = new AbortController();
    enCours.current = abandon;
    setOccupe(true);
    setErreur(null);
    setReponse(null);
    try {
      const r = await demanderAide(tenantId, {
        question: q,
        ecranCourant: ecranCourant === '' ? null : ecranCourant,
        langue: locale === 'en' ? 'en' : 'fr',
      }, abandon.signal);
      setReponse(r);
    } catch {
      // Une panne n'affiche pas de trace technique : elle propose la même issue que « je ne sais pas », qui
      // est une issue, là où un message d'erreur n'en est pas une.
      setErreur(t('L’aide est indisponible pour le moment.', 'Help is unavailable right now.'));
    } finally {
      setOccupe(false);
    }
  }

  const recours = (
    <p className="mt-2 text-xs text-ink-500">
      {t('Écrivez-nous depuis ', 'Write to us from ')}
      <Link href="/support" className="font-medium text-brand-600 hover:underline" data-testid="aide-recours">
        {t('la page Support', 'the Support page')}
      </Link>
      {t(', une personne vous répondra.', ', someone will get back to you.')}
    </p>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOuvert((o) => !o)}
        data-testid="aide-bouton"
        aria-expanded={ouvert}
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg transition hover:bg-brand-700"
        title={t('Aide', 'Help')}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01" />
        </svg>
      </button>

      {ouvert && (
        <div
          data-testid="aide-panneau"
          className="fixed bottom-20 right-5 z-40 flex max-h-[70vh] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <span className="text-sm font-semibold text-ink-900">{t('Aide', 'Help')}</span>
            <button type="button" onClick={() => setOuvert(false)} className="text-ink-400 hover:text-ink-700" aria-label={t('Fermer', 'Close')}>×</button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {reponse === null && erreur === null && !occupe && (
              <p className="text-sm text-ink-500">
                {t('Posez votre question sur la console, par exemple « comment je lance une campagne ? ».',
                  'Ask your question about the console, for example "how do I launch a campaign?".')}
              </p>
            )}
            {occupe && <p className="text-sm text-ink-500" data-testid="aide-attente">{t('Je cherche…', 'Looking…')}</p>}
            {erreur !== null && (
              <div data-testid="aide-erreur">
                <p className="text-sm text-ink-700">{erreur}</p>
                {recours}
              </div>
            )}
            {reponse !== null && !reponse.sait && (
              <div data-testid="aide-je-ne-sais-pas">
                <p className="text-sm text-ink-700">
                  {t('Je ne trouve pas la réponse dans le mode d’emploi.', 'I cannot find the answer in the user guide.')}
                </p>
                {recours}
              </div>
            )}
            {reponse !== null && reponse.sait && (
              <div data-testid="aide-reponse">
                <p className="whitespace-pre-wrap text-sm text-ink-800">{reponse.texte}</p>
                {reponse.ecrans.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {reponse.ecrans.map((e) => (
                      <Link
                        key={e.cle}
                        href={e.href}
                        data-testid={`aide-lien-${e.cle}`}
                        onClick={() => setOuvert(false)}
                        className="block rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
                      >
                        {t('Ouvrir ', 'Open ')}
                        {locale === 'en' ? e.en : e.fr}
                        {e.chemin.length > 0 && (
                          <span className="font-normal text-brand-500"> ({e.chemin.join(' > ')})</span>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
                {/* La SOURCE est montrée, et ce n'est pas décoratif : le client voit d'où sort la réponse, et
                    peut juger si elle parle bien de ce qu'il cherche. */}
                {reponse.sources.length > 0 && (
                  <p className="mt-3 text-[11px] text-ink-400" data-testid="aide-sources">
                    {t('D’après : ', 'Based on: ')}{reponse.sources.join(', ')}
                  </p>
                )}
              </div>
            )}
          </div>

          <form onSubmit={envoyer} className="flex gap-2 border-t border-ink-100 px-4 py-3">
            <input
              value={question}
              onChange={(ev) => setQuestion(ev.target.value)}
              maxLength={500}
              data-testid="aide-question"
              placeholder={t('Votre question…', 'Your question…')}
              className={inputCls}
            />
            <button
              type="submit"
              disabled={occupe || question.trim() === ''}
              data-testid="aide-envoyer"
              className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-40"
            >
              {t('Demander', 'Ask')}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
