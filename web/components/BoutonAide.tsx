'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useT, useLocale } from '@/lib/i18n';
import { Logo } from '@/components/Logo';
import { inputCls } from '@/lib/ui';
import { demanderAide, type ReponseAide } from '@/lib/api-aide';
import { lireFil, ecrireFil, MAX_ECHANGES_GARDES, type EchangeAide } from '@/lib/aide-fil';

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
 * 🔴 LE FIL EST GARDÉ TANT QUE LA PERSONNE EST CONNECTÉE (demande de Julien, 2026-09-11). La première
 * version ne gardait rien, au motif qu'« une question d'aide n'a pas de suite ». C'était faux : on enchaîne
 * toujours, et suivre le lien que le bot vient de donner REMONTE la coquille, donc effaçait la conversation
 * au moment précis où l'on voulait poser la question suivante. Le fil vit dans `sessionStorage`
 * (`lib/aide-fil.ts`), survit à la navigation, et part à la déconnexion.
 */
export function BoutonAide({ tenantId, ecranCourant }: { tenantId: string; ecranCourant: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [ouvert, setOuvert] = useState(false);
  const [question, setQuestion] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [fil, setFil] = useState<EchangeAide[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  // Une question en vol quand on en pose une autre est ABANDONNÉE : sans ça, la réponse à l'ancienne
  // pourrait arriver après la nouvelle et s'afficher à sa place.
  const enCours = useRef<AbortController | null>(null);
  const basDuFil = useRef<HTMLDivElement | null>(null);

  // Le fil est relu au MONTAGE, pas à l'ouverture du panneau : la coquille est remontée à chaque changement
  // d'écran, et c'est précisément là qu'il faut le retrouver intact.
  useEffect(() => { setFil(lireFil(tenantId)); }, [tenantId]);

  // On descend sur la dernière réponse. Sans ça, une réponse longue apparaît au-dessus de ce qu'on lit.
  useEffect(() => { basDuFil.current?.scrollIntoView({ block: 'end' }); }, [fil, occupe, ouvert]);

  async function envoyer(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const q = question.trim();
    if (q === '' || occupe) return;
    enCours.current?.abort();
    const abandon = new AbortController();
    enCours.current = abandon;
    // 🔴 LE CHAMP SE VIDE TOUT DE SUITE. Il restait rempli après l'envoi, et la question suivante venait se
    // coller à la précédente. Vidé AVANT l'appel, pas après : la personne n'a pas à attendre la réponse pour
    // que l'écran réagisse à sa touche Entrée.
    setQuestion('');
    setOccupe(true);
    setErreur(null);
    try {
      const r = await demanderAide(tenantId, {
        question: q,
        ecranCourant: ecranCourant === '' ? null : ecranCourant,
        langue: locale === 'en' ? 'en' : 'fr',
        // ⚠️ Seul le TEXTE des réponses passées part au serveur, pas les liens : le modèle n'a rien à faire
        // des écrans qu'il a proposés hier, et les renvoyer l'inciterait à les reproposer.
        historique: fil.filter((x) => x.reponse.sait).map((x) => ({ question: x.question, reponse: x.reponse.texte })),
      }, abandon.signal);
      const suite = [...fil, { question: q, reponse: r }].slice(-MAX_ECHANGES_GARDES);
      setFil(suite);
      ecrireFil(tenantId, suite);
    } catch {
      // Une panne n'affiche pas de trace technique : elle propose la même issue que « je ne sais pas », qui
      // est une issue, là où un message d'erreur n'en est pas une. La question n'entre PAS dans le fil :
      // sinon le modèle croirait avoir répondu quelque chose.
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
          <div className="flex items-center justify-between border-b border-ink-100 bg-gradient-to-r from-brand-50 via-white to-white px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <Logo className="h-5 w-5 shrink-0" />
              {t('Aide', 'Help')}
            </span>
            <button type="button" onClick={() => setOuvert(false)} className="text-ink-400 hover:text-ink-700" aria-label={t('Fermer', 'Close')}>×</button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3" data-testid="aide-fil">
            {/**
              * 🔴 UNE INVITATION, PAS UNE CONSIGNE (demande de Julien, 2026-09-11 : « là c'est hyper triste
              * [...] dis "Je suis là pour vous aider", pas un truc "posez votre question sur la console" »).
              * La première version donnait un ordre à quelqu'un qui vient chercher de l'aide, ce qui est
              * exactement le mauvais ton pour un écran de secours.
              *
              * ⚠️ L'EXEMPLE NE DISPARAÎT PAS, IL DEVIENT CLIQUABLE. Le supprimer laisserait un cadre vide
              * devant quelqu'un qui ne sait pas ce qu'on peut demander ; le laisser en consigne était le
              * défaut. Une suggestion qu'on clique est une porte, une phrase qui dit quoi faire est un mur.
              */}
            {fil.length === 0 && erreur === null && !occupe && (
              <div className="flex flex-col items-center gap-3 px-2 py-6 text-center" data-testid="aide-accueil">
                <span className="relative inline-flex h-14 w-14 items-center justify-center">
                  {/* Le halo : il pose la marque sur un fond, sinon le logo flotte. */}
                  <span aria-hidden="true" className="absolute inset-0 rounded-full bg-gradient-to-br from-brand-100 via-brand-50 to-white" />
                  <Logo className="relative h-8 w-8" />
                  {/* Trois étincelles, placées autour et pas dessus : elles disent « IA » sans masquer la
                      marque. `aria-hidden` parce qu'elles ne portent aucune information. */}
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute -right-1 -top-1 h-4 w-4 text-brand-400" fill="currentColor">
                    <path d="M12 2l1.5 3.5L17 7l-3.5 1.5L12 12l-1.5-3.5L7 7l3.5-1.5L12 2z" />
                  </svg>
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute -left-2 top-2 h-3 w-3 text-brand-300" fill="currentColor">
                    <path d="M12 2l1.5 3.5L17 7l-3.5 1.5L12 12l-1.5-3.5L7 7l3.5-1.5L12 2z" />
                  </svg>
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute -bottom-1 right-1 h-2.5 w-2.5 text-mint-400" fill="currentColor">
                    <path d="M12 2l1.5 3.5L17 7l-3.5 1.5L12 12l-1.5-3.5L7 7l3.5-1.5L12 2z" />
                  </svg>
                </span>
                <p className="text-sm font-semibold text-ink-900">{t('Je suis là pour vous aider', 'I am here to help')}</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {[
                    { fr: 'Comment je lance une campagne ?', en: 'How do I launch a campaign?' },
                    { fr: 'Modèle ou scénario ?', en: 'Template or scenario?' },
                    { fr: 'Comment j’importe mes contacts ?', en: 'How do I import my contacts?' },
                  ].map((sug) => (
                    <button
                      key={sug.fr}
                      type="button"
                      data-testid="aide-suggestion"
                      onClick={() => setQuestion(locale === 'en' ? sug.en : sug.fr)}
                      className="rounded-full border border-ink-200 px-2.5 py-1 text-xs text-ink-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                    >
                      {t(sug.fr, sug.en)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {fil.map((e, i) => (
              <div key={`${i}-${e.question}`} className="space-y-1.5">
                <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-ink-100 px-3 py-1.5 text-sm text-ink-800" data-testid="aide-question-posee">
                  {e.question}
                </p>
                {!e.reponse.sait ? (
                  <div data-testid="aide-je-ne-sais-pas">
                    <p className="text-sm text-ink-700">
                      {t('Je ne trouve pas la réponse dans le mode d’emploi.', 'I cannot find the answer in the user guide.')}
                    </p>
                    {recours}
                  </div>
                ) : (
                  <div data-testid="aide-reponse">
                    <p className="whitespace-pre-wrap text-sm text-ink-800">{e.reponse.texte}</p>
                    {e.reponse.ecrans.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {e.reponse.ecrans.map((ec) => (
                          <Link
                            key={ec.cle}
                            href={ec.href}
                            data-testid={`aide-lien-${ec.cle}`}
                            onClick={() => setOuvert(false)}
                            className="block rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
                          >
                            {t('Ouvrir ', 'Open ')}
                            {locale === 'en' ? ec.en : ec.fr}
                            {ec.chemin.length > 0 && (
                              <span className="font-normal text-brand-500"> ({ec.chemin.join(' > ')})</span>
                            )}
                          </Link>
                        ))}
                      </div>
                    )}
                    {/* La SOURCE est montrée, et ce n'est pas décoratif : le client voit d'où sort la réponse,
                        et peut juger si elle parle bien de ce qu'il cherche. */}
                    {e.reponse.sources.length > 0 && (
                      <p className="mt-2 text-[11px] text-ink-400" data-testid="aide-sources">
                        {t('D’après : ', 'Based on: ')}{e.reponse.sources.join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}

            {occupe && <p className="text-sm text-ink-500" data-testid="aide-attente">{t('Je cherche…', 'Looking…')}</p>}
            {erreur !== null && (
              <div data-testid="aide-erreur">
                <p className="text-sm text-ink-700">{erreur}</p>
                {recours}
              </div>
            )}
            <div ref={basDuFil} />
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
