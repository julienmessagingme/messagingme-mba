'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getConversationAnalysisSummary, type ConversationAnalysisSummary, type StatsRange } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT, useLocale } from '@/lib/i18n';
import { comptesParIntention, libelleIntention, type Intention } from '@/lib/intentions';
import { Icone } from '@/components/Icone';
import { Squelette } from '@/components/Squelette';
import { Nd, useErreurRegroupee } from '@/components/Nd';

/**
 * « COMBIEN DE CONVERSATIONS PAR INTENTION », avec leurs SUJETS empilés dessous.
 *
 * 🔴 DEUX NIVEAUX, ET LE SECOND EST LE VRAI SUJET DE CETTE CARTE. Les intentions sont une énumération
 * FERMÉE (`src/analysis/schema.ts`, copiée dans `web/lib/intentions.ts`) : le modèle ne peut pas en
 * inventer d'autres, donc elles n'enflent pas. Le `topic`, lui, est du texte LIBRE, et c'est là que vit
 * l'inflation que Julien redoutait
 * (« on a un thème demande de devis, si un moment tu décides de créer un thème demande de cotation, c'est
 * un peu con »). Mesuré en production le 2026-09-17 : 13 sujets distincts pour 14 analyses, dont QUATRE
 * variantes de « consultation tarifs ». Rangés à plat, ces quatre-là sont dispersés et personne ne voit
 * qu'ils sont parents ; sous « Information », ils se retrouvent côte à côte et le problème se voit tout
 * seul. C'est l'argument du chantier des thèmes déclarés, rendu lisible plutôt que raconté.
 *
 * ⚠️ LE REGROUPEMENT EST UNE NORMALISATION DE CASSE, PAS UN RAPPROCHEMENT DE SENS. Le serveur applique
 * `lower(btrim(...))`, exactement comme les sujets fréquents : « Consultation Tarifs » et « consultation
 * tarifs » se fondent, « tarifs et offres » et « tarifs cinéma » restent deux lignes. C'est voulu, et c'est
 * précisément ce qu'on veut montrer.
 *
 * 🔴 CLIQUER UNE INTENTION EMMENE SUR L'ECRAN D'ANALYSE, FILTRE, ET AVEC LA MEME PERIODE. Par l'ADRESSE et
 * pas par un état en mémoire : l'écran devient partageable par copier-coller, et le retour arrière du
 * navigateur ramène à la synthèse dans son état. C'est le motif déjà en place sur
 * `/dashboard/funnel?campagne=<id>`.
 */

const CARD = 'rounded-carte border border-ink-200 bg-white p-5';

/** La liste, son ordre FIXE d'affichage et les libellés vivent dans `@/lib/intentions`, partagés avec
 *  l'Analyse des conversations. */

export function CarteIntentions({ tenantId, range }: { tenantId: string; range: StatsRange }) {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const [resume, setResume] = useState<ConversationAnalysisSummary | null | 'erreur'>(null);
  const [depliee, setDepliee] = useState<Intention | null>(null);

  useEffect(() => {
    let vivant = true;
    setResume(null);
    getConversationAnalysisSummary(tenantId, range)
      // 🔴 LE TYPE MENT SUR UNE DONNEE DE RESEAU : sans cette garde, un corps sans `intent` ferait jeter
      // le rendu, et ce n'est pas cette carte qui tomberait mais la PAGE, donc aussi la colonne des coûts.
      .then((d) => { if (vivant) setResume(d && d.intent ? d : 'erreur'); })
      .catch(() => { if (vivant) setResume('erreur'); });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to]);

  const regroupee = useErreurRegroupee('intentions', resume === 'erreur');

  const versAnalyse = (i: Intention): void => {
    // La période voyage avec l'intention : arriver sur une autre fenêtre que celle qu'on regardait
    // donnerait un compte différent de celui qu'on vient de cliquer, et le chiffre passerait pour faux.
    router.push(`/dashboard/quali?intention=${i}&from=${range.from}&to=${range.to}`);
  };

  return (
    <section className={CARD} data-testid="carte-intentions">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-ink-900">
          {t('Conversations par intention', 'Conversations by intent')}
        </h2>
        <p className="mt-0.5 text-xs text-ink-500">
          {t('Dépliez une intention pour voir ses sujets. Cliquez son nom pour ouvrir les conversations.',
            'Expand an intent to see its topics. Click its name to open the conversations.')}
        </p>
      </header>

      {resume === 'erreur' && regroupee && <Nd testId="intentions-erreur" className="text-sm" />}
      {resume === 'erreur' && !regroupee && (
        <p className="rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700" data-testid="intentions-erreur">
          {t('Les intentions n’ont pas pu être chargées.', 'Intents could not be loaded.')}
        </p>
      )}
      {resume === null && <Squelette forme="carte" />}

      {resume !== null && resume !== 'erreur' && resume.total === 0 && (
        <p className="text-xs text-ink-500" data-testid="intentions-vide">
          {t('Aucune conversation analysée sur cette période.', 'No analysed conversation over this period.')}
        </p>
      )}

      {resume !== null && resume !== 'erreur' && resume.total > 0 && (
        <div className="space-y-1.5">
          {comptesParIntention(resume.intent).map(({ intention: i, n }) => {
            const pct = resume.total > 0 ? Math.round((n / resume.total) * 100) : 0;
            const sujets = resume.topicsParIntention?.[i] ?? [];
            return (
              <div key={i} data-testid={`intention-${i}`}>
                <div className="flex items-center gap-2">
                  {/* Le CHEVRON déplie, le NOM navigue. Deux gestes différents sur deux cibles différentes :
                      un seul bouton qui ferait les deux obligerait à choisir, et le second geste serait
                      perdu. Un chevron sur une intention vide ne sert à rien, il n'est donc pas rendu. */}
                  <button
                    type="button"
                    onClick={() => setDepliee((v) => (v === i ? null : i))}
                    disabled={sujets.length === 0}
                    aria-expanded={depliee === i}
                    aria-label={t(`Voir les sujets de ${libelleIntention(i, t)}`, `Show topics for ${libelleIntention(i, t)}`)}
                    data-testid={`intention-deplier-${i}`}
                    className="shrink-0 rounded-controle p-0.5 text-ink-500 transition-colors duration-150 hover:bg-ink-100 disabled:invisible"
                  >
                    <Icone nom="deplier" taille="petite" className={`transition-transform duration-150 ${depliee === i ? 'rotate-180' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => versAnalyse(i)}
                    disabled={n === 0}
                    data-testid={`intention-ouvrir-${i}`}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-controle text-left transition-colors duration-150 hover:bg-ink-50 disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="w-32 shrink-0 truncate text-xs text-ink-500">{libelleIntention(i, t)}</span>
                    <span className="h-5 flex-1 overflow-hidden rounded-controle bg-ink-50">
                      <span className="block h-full rounded-controle bg-brand-400" style={{ width: `${pct}%` }} />
                    </span>
                    <span className={`w-8 shrink-0 text-right text-xs tabular-nums ${n > 0 ? 'font-medium text-brand-600 underline decoration-dotted underline-offset-2' : 'text-ink-500'}`}>
                      {fmtNum(n, locale)}
                    </span>
                  </button>
                </div>

                {depliee === i && sujets.length > 0 && (
                  <ul className="ml-7 mt-1 space-y-0.5 border-l border-ink-100 pl-3" data-testid={`intention-sujets-${i}`}>
                    {sujets.map((s) => (
                      <li key={s.topic} className="flex items-baseline justify-between gap-2 text-xs text-ink-500">
                        <span className="truncate" title={s.topic}>{s.topic}</span>
                        <span className="shrink-0 tabular-nums text-ink-500">{fmtNum(s.count, locale)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
