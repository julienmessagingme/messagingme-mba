'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import type { Session } from '@/lib/session';
import { getVentes, type StatsRange } from '@/lib/api';
import { ApiError, erreurDeChargement } from '@/lib/http';
import { useT, useLocale } from '@/lib/i18n';
import { presetRange } from '@/lib/range';
import { fmtNum } from '@/lib/format';
import type { Locale } from '@/lib/locale';
import { fmtMontant, lireVentes, type ChiffreVentesVue, type SourceVentesVue } from '@/lib/ventes';

/**
 * Analytics > Quantitatif > **Shopify** : ce que les envois WhatsApp ont rapporté sur la boutique (plan
 * `docs/superpowers/plans/2026-10-30-revenus-attribues-lot-2.md`, tâche 5). La lecture est celle de l'outil MCP
 * `get_revenue_stats` et de la page Shopify (`src/shopify/chiffre.ts`) : trois surfaces, un seul chiffre.
 *
 * 🔴 PAR DEVISE, JAMAIS ADDITIONNÉES, et LES COMMANDES DE TEST À PART : une boutique de développement n'a que celles-là,
 * l'écran les annonce sans les compter. La règle se lit sous le chiffre, pas dans une infobulle : une concordance dans
 * le temps n'est pas une preuve, et l'écran le dit.
 *
 * ⚠️ LA CONSOLE PART SUR VERCEL AVANT L'API : tant que `/stats/ventes` n'est pas déployée, elle rend 404, et l'écran dit
 * « pas encore disponible ».
 */
export default function ShopifyQuantiPage() {
  return <AppShell active="quanti-shopify">{(session) => <ShopifyInner session={session} />}</AppShell>;
}

type Etat =
  | { etat: 'chargement' }
  | { etat: 'pret'; ventes: ChiffreVentesVue }
  | { etat: 'indisponible' }
  | { etat: 'illisible' }
  | { etat: 'erreur'; message: string };

function ShopifyInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  // La même période par défaut que les sous-onglets voisins : passer de l'un à l'autre ne change pas la fenêtre.
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [etat, setEtat] = useState<Etat>({ etat: 'chargement' });

  useEffect(() => {
    // Une réponse arrivée après un changement de période ne doit pas écraser celle de la période affichée.
    let actif = true;
    setEtat({ etat: 'chargement' });
    getVentes(session.tenantId, range)
      .then((brut) => {
        if (!actif) return;
        const ventes = lireVentes(brut);
        setEtat(ventes ? { etat: 'pret', ventes } : { etat: 'illisible' });
      })
      .catch((err: unknown) => {
        if (!actif) return;
        setEtat(err instanceof ApiError && err.status === 404 ? { etat: 'indisponible' } : { etat: 'erreur', message: erreurDeChargement(err, t) });
      });
    return () => { actif = false; };
  }, [session.tenantId, range, t]);

  return (
    <div className="space-y-4">
      {/* La barre reste un enfant DIRECT de la page : elle est collante, et un conteneur à sa mesure la bornerait. */}
      <RangeBar title={<TitrePage>{t('Shopify', 'Shopify')}</TitrePage>} range={range} onChange={setRange} />
      <IntroPage>
        {t(
          'Ce que vos envois WhatsApp ont rapporté sur votre boutique Shopify : les commandes payées après un message, la part prouvée, et vos paniers relancés.',
          'What your WhatsApp sends brought in on your Shopify store: orders paid after a message, the proven part, and your reminded checkouts.',
        )}
      </IntroPage>
      {etat.etat === 'chargement' && <p className="text-sm text-ink-500">{t('Chargement des statistiques…', 'Loading statistics…')}</p>}
      {etat.etat === 'indisponible' && (
        <p data-testid="ventes-indisponible" className="rounded-controle bg-ink-50 px-3 py-2 text-sm text-ink-500">
          {t('Ces indicateurs ne sont pas encore disponibles.', 'These metrics are not available yet.')}
        </p>
      )}
      {etat.etat === 'illisible' && (
        <p data-testid="ventes-illisible" className="rounded-controle bg-ink-50 px-3 py-2 text-sm text-ink-500">
          {t('Ces indicateurs ne sont pas lisibles pour le moment. Réessayez dans quelques minutes.', 'These metrics cannot be read right now. Try again in a few minutes.')}
        </p>
      )}
      {etat.etat === 'erreur' && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{etat.message}</p>}
      {etat.etat === 'pret' && <Tableau ventes={etat.ventes} locale={locale} t={t} />}
    </div>
  );
}

type T = (fr: string, en?: string) => string;

function libelleSource(s: SourceVentesVue, t: T): string {
  switch (s.source) {
    case 'campagne': return s.nom ? t(`Campagne « ${s.nom} »`, `Campaign “${s.nom}”`) : t('Campagne supprimée', 'Deleted campaign');
    case 'relance_panier': return t('Relance de panier', 'Checkout reminder');
    case 'scenario': return t('Scénarios', 'Scenarios');
    case 'agent': return t('Agent IA', 'AI agent');
    case 'agent_meta': return t('Agent de Meta', 'Meta’s agent');
  }
}

function Tableau({ ventes, locale, t }: { ventes: ChiffreVentesVue; locale: Locale; t: T }) {
  const { reel, test, paniers } = ventes;
  const montant = (m: string, devise: string) => fmtMontant(m, devise, locale);
  const commandesTest = test.totaux.reduce((n, x) => n + x.commandes, 0);
  const brutsTest = test.totaux.map((x) => montant(x.brut, x.devise)).join(' · ');
  // Les seules parts prouvées non nulles, par devise : « dont 0 prouvés » ne dirait rien.
  const prouvesTest = test.totaux.filter((x) => Number(x.prouve) > 0).map((x) => montant(x.prouve, x.devise)).join(' · ');
  return (
    <>
      {reel.totaux.length === 0 ? (
        <p data-testid="ventes-vide" className="rounded-controle bg-ink-50 px-3 py-2 text-sm text-ink-500">
          {t('Aucune commande attribuée sur la période.', 'No order attributed in the period.')}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {reel.totaux.map((x) => (
            <div key={x.devise} data-testid={`ventes-total-${x.devise}`} className="rounded-carte border border-ink-200 bg-white p-5">
              <div className="text-xs font-medium text-ink-500">{t('Chiffre d’affaires brut', 'Gross revenue')} ({x.devise})</div>
              <div className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums text-ink-900">{montant(x.brut, x.devise)}</div>
              <div className="mt-1 text-xs text-ink-500">
                {t(`dont ${montant(x.prouve, x.devise)} prouvés · ${fmtNum(x.commandes, locale)} commandes`,
                  `of which ${montant(x.prouve, x.devise)} proven · ${fmtNum(x.commandes, locale)} orders`)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Comment on compte : dit SOUS le chiffre, pas dans une infobulle. */}
      <p data-testid="ventes-regle" className="text-xs text-ink-500">
        {t(
          'Commandes payées dans les 5 jours après un message WhatsApp reçu, attribuées au dernier envoi. Prouvé : panier relancé payé, ou visite venue de vos liens WhatsApp. Le reste est une concordance dans le temps, pas une preuve. Remboursements non déduits.',
          'Orders paid within 5 days after a WhatsApp message was received, credited to the last send. Proven: a reminded checkout paid, or a visit that came through your WhatsApp links. The rest is a match in time, not a proof. Refunds not deducted.',
        )}
      </p>

      {reel.sources.length > 0 && (
        <div className="rounded-carte border border-ink-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Par source', 'By source')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-xs" data-testid="ventes-sources">
              <thead>
                <tr className="text-ink-500">
                  <th className="py-1 pr-2 font-medium">{t('Source', 'Source')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('Brut', 'Gross')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('Dont prouvé', 'Proven')}</th>
                  <th className="py-1 text-right font-medium">{t('Commandes', 'Orders')}</th>
                </tr>
              </thead>
              <tbody>
                {reel.sources.map((s, i) => (
                  <tr key={`${s.source}-${s.campaignId ?? i}-${s.devise}`} className="border-t border-ink-100">
                    <td className="py-1 pr-2 text-ink-900">{libelleSource(s, t)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-ink-900">{montant(s.brut, s.devise)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-ink-900">{montant(s.prouve, s.devise)}</td>
                    <td className="py-1 text-right tabular-nums text-ink-900">{fmtNum(s.commandes, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink-900">{t('Paniers abandonnés', 'Abandoned checkouts')}</h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="ventes-paniers">
          <Compteur testid="ventes-relances" libelle={t('Relancés', 'Reminded')} valeur={fmtNum(paniers.relances, locale)} />
          <Compteur testid="ventes-recuperes" libelle={t('Récupérés', 'Recovered')} valeur={fmtNum(paniers.recuperes, locale)} />
          <Compteur
            testid="ventes-montant-recupere"
            libelle={t('Montant récupéré', 'Amount recovered')}
            valeur={paniers.montants.length === 0 ? fmtNum(0, locale) : paniers.montants.map((m) => montant(m.montant, m.devise)).join(' · ')}
          />
        </dl>
        <p className="mt-3 text-xs text-ink-500">
          {t(
            'Selon la date de la relance : un panier relancé la veille de la période et payé dedans compte dans le chiffre, pas dans les récupérés.',
            'By reminder date: a checkout reminded the day before the period and paid within it counts in the revenue, not in the recovered.',
          )}
        </p>
      </div>

      {(commandesTest > 0 || paniers.recuperesTest > 0) && (
        <p data-testid="ventes-tests" className="text-xs text-ink-500">
          {/* Une boutique de développement n'a QUE des commandes de test : leur part prouvée et leurs paniers récupérés se
              lisent ici, chaque morceau seulement s'il existe (relecture du lot B). */}
          {[
            commandesTest > 0 && t(
              `${fmtNum(commandesTest, locale)} commandes de test, non comptées : ${brutsTest}${prouvesTest ? ` (dont ${prouvesTest} prouvés)` : ''}`,
              `${fmtNum(commandesTest, locale)} test orders, not counted: ${brutsTest}${prouvesTest ? ` (of which ${prouvesTest} proven)` : ''}`,
            ),
            paniers.recuperesTest > 0 && t(
              paniers.recuperesTest === 1 ? '1 panier relancé récupéré en test' : `${fmtNum(paniers.recuperesTest, locale)} paniers relancés récupérés en test`,
              paniers.recuperesTest === 1 ? '1 reminded checkout recovered in test' : `${fmtNum(paniers.recuperesTest, locale)} reminded checkouts recovered in test`,
            ),
          ].filter(Boolean).join(' ; ')}.
        </p>
      )}
    </>
  );
}

function Compteur({ testid, libelle, valeur }: { testid: string; libelle: string; valeur: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{libelle}</dt>
      <dd data-testid={testid} className="text-xl font-semibold tabular-nums text-ink-900">{valeur}</dd>
    </div>
  );
}
