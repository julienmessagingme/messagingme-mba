'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';
import { Icone } from '@/components/Icone';
import { classesBouton } from '@/components/Bouton';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { useOffre } from '@/lib/use-offre';
import {
  FONCTIONS_OFFRE, NOMS_OFFRES, libelleFonction, nomDeLOffre, offreQuiOuvre,
  type FonctionOffre, type LimitesOffre, type NomOffre,
} from '@/lib/offre';

/**
 * L'OFFRE DE L'ESPACE (lot 6, tâche 7) : ce que l'espace consomme de ses limites, la grille des trois offres, et
 * « Passer en Pro ». Réservée aux administrateurs, comme le reste de Paramètres : en Pro ou en Entreprise, un agent ou un
 * manager ne déclenche aucun refus d'offre, et une Base n'a qu'un administrateur. La ROUTE, elle, se lit par tout membre :
 * la coquille en grise les menus de chacun.
 *
 * 🔴 LA GRILLE N'EST PAS RECOPIÉE ICI : elle arrive avec la vue de l'offre (`GET /tenants/:tenantId/offre`), lue dans la
 * seule définition du serveur (`src/offres/offres.ts`).
 *
 * ⚠️ JUSQU'À LA LIVRAISON B (le Pro chez Stripe), « Passer en Pro » mène au Support, sujet prérempli : l'exploitation
 * ouvre le Pro à la main. Aucun prix n'est affiché d'ici là, il arrivera avec le paiement.
 */
export default function OffrePage() {
  return <AppShell active="offre">{(session) => <OffreInner session={session} />}</AppShell>;
}

/** La fonction qui a mené ici, depuis un menu grisé (`/offre?fonction=inbox`). Lue après le montage de la coquille. */
function fonctionDemandee(): FonctionOffre | null {
  if (typeof window === 'undefined') return null;
  const f = new URLSearchParams(window.location.search).get('fonction');
  return (FONCTIONS_OFFRE as readonly string[]).includes(f ?? '') ? (f as FonctionOffre) : null;
}

/**
 * Les limites montrées dans la grille, dans cet ordre. ⚠️ Les deux limites des webhooks sortants (`adressesWebhook`,
 * `journalWebhooksJours`) n'y sont PAS : ce chantier n'existe pas encore (lot 12), et la console n'annonce pas une
 * limite d'une fonction qu'elle n'a pas.
 */
const LIGNES_LIMITES = [
  'utilisateurs', 'contacts', 'envoisModelesMois', 'automations', 'suppressionsJour', 'conservationJours', 'commissionPct',
  'numeroInclus', 'badge',
] as const satisfies ReadonlyArray<keyof LimitesOffre>;

function OffreInner({ session }: { session: Session }) {
  const t = useT();
  const vue = useOffre(session.tenantId);
  const [demandee] = useState(fonctionDemandee);

  const libelleLimite = (k: (typeof LIGNES_LIMITES)[number]): string => ({
    utilisateurs: t('Utilisateurs', 'Users'),
    contacts: t('Contacts créés', 'Contacts created'),
    envoisModelesMois: t('Modèles envoyés par mois', 'Templates sent per month'),
    automations: t('Automations allumées', 'Active automations'),
    suppressionsJour: t('Contacts supprimés par jour', 'Contacts deleted per day'),
    conservationJours: t('Conservation des conversations', 'Conversation retention'),
    commissionPct: t('Commission sur le crédit IA', 'Commission on AI credit'),
    numeroInclus: t('Numéro WhatsApp inclus', 'WhatsApp number included'),
    badge: t('Mention « Messaging Me » sur le widget', '“Messaging Me” mention on the widget'),
  })[k];

  const valeurLimite = (l: LimitesOffre, k: (typeof LIGNES_LIMITES)[number]): string => {
    const v = l[k];
    if (typeof v === 'boolean') return v ? t('Oui', 'Yes') : t('Non', 'No');
    if (v === null) return t('Sans limite', 'Unlimited');
    if (k === 'conservationJours') return v === 0 ? t('Sans limite', 'Unlimited') : t(`${v} jours`, `${v} days`);
    if (k === 'commissionPct') return `${v} %`;
    return v.toLocaleString('fr-FR');
  };

  if (vue === undefined) {
    return <div className="mx-auto max-w-liste space-y-4"><Squelette forme="carte" /></div>;
  }
  if (vue === null) {
    return (
      <div className="mx-auto max-w-liste space-y-4">
        <TitrePage>{t('Offre', 'Plan')}</TitrePage>
        <p className="text-sm text-ink-500" data-testid="offre-inconnue">
          {t('L’offre de cet espace n’est pas encore disponible. Réessayez dans quelques minutes.', 'This workspace’s plan is not available yet. Try again in a few minutes.')}
        </p>
      </div>
    );
  }

  const suivante: NomOffre | null = vue.offre === 'base' ? 'pro' : vue.offre === 'pro' ? 'entreprise' : null;
  const offreDemandee = demandee ? offreQuiOuvre(vue, demandee) : null;
  const jauges: Array<{ cle: string; libelle: string; utilise: number | null; max: number | null; note?: string }> = [
    { cle: 'contacts', libelle: t('Contacts créés', 'Contacts created'), utilise: vue.usage.contacts, max: vue.limites.contacts,
      note: t('Un contact qui vous écrit le premier n’est jamais compté.', 'A contact who writes to you first is never counted.') },
    { cle: 'modeles', libelle: t('Modèles envoyés ce mois-ci', 'Templates sent this month'), utilise: vue.usage.envoisModelesMois, max: vue.limites.envoisModelesMois,
      note: t('Les réponses dans les 24 h qui suivent un message du client ne sont jamais comptées.', 'Replies within 24 hours of a customer message are never counted.') },
    { cle: 'automations', libelle: t('Automations allumées', 'Active automations'), utilise: vue.usage.automations, max: vue.limites.automations },
    { cle: 'membres', libelle: t('Utilisateurs', 'Users'), utilise: vue.usage.membres, max: vue.limites.utilisateurs },
  ];

  return (
    <div className="mx-auto max-w-liste space-y-6">
      <div>
        <TitrePage>{t('Offre', 'Plan')}</TitrePage>
        <IntroPage>
          {t('Votre espace est en offre', 'Your workspace is on the')}{' '}
          <strong className="font-semibold text-ink-900" data-testid="offre-actuelle">{nomDeLOffre(vue.offre, t)}</strong>
          {t('.', ' plan.')}
        </IntroPage>
      </div>

      {demandee && offreDemandee && offreDemandee !== vue.offre && (
        <p className="rounded-carte border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700" data-testid="offre-raison">
          {t(`« ${libelleFonction(demandee, t)} » fait partie de l’offre ${nomDeLOffre(offreDemandee, t)}.`,
            `“${libelleFonction(demandee, t)}” is part of the ${nomDeLOffre(offreDemandee, t)} plan.`)}
        </p>
      )}

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-usage">
        <h2 className="text-sm font-semibold text-ink-900">{t('Ce que votre espace consomme', 'What your workspace uses')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {jauges.map((j) => {
            const plein = j.max !== null && j.utilise !== null && j.utilise >= j.max;
            return (
              <div key={j.cle} data-testid={`offre-usage-${j.cle}`}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-ink-500">{j.libelle}</span>
                  <span className={`tabular-nums font-medium ${plein ? 'text-danger' : 'text-ink-900'}`}>
                    {j.max === null
                      ? t('Sans limite', 'Unlimited')
                      : `${(j.utilise ?? 0).toLocaleString('fr-FR')} / ${j.max.toLocaleString('fr-FR')}`}
                  </span>
                </div>
                {j.max !== null && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                    <div className={`h-full rounded-full ${plein ? 'bg-danger' : 'bg-brand-500'}`} style={{ width: `${Math.min(100, Math.round(((j.utilise ?? 0) / Math.max(1, j.max)) * 100))}%` }} />
                  </div>
                )}
                {j.note && j.max !== null && <p className="mt-1 text-xs text-ink-400">{j.note}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {suivante && (
        <section className="flex flex-wrap items-center gap-3 rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-passer">
          <p className="min-w-0 flex-1 text-sm text-ink-500">
            {suivante === 'pro'
              ? t('Le Pro ouvre l’Inbox, les scénarios, les statistiques, l’agent de Meta et lève les limites de contacts, d’envois et d’automations.',
                'Pro unlocks the Inbox, scenarios, statistics and the Meta agent, and lifts the contact, sending and automation limits.')
              : t('L’Entreprise ajoute le RCS, les connecteurs CRM, le Performance Lab et une équipe à votre mesure, sur devis.',
                'Enterprise adds RCS, CRM connectors, the Performance Lab and a team sized for you, on quote.')}
          </p>
          <Link href={`/support?sujet=${suivante}`} className={classesBouton('principal')} data-testid={`offre-passer-${suivante}`}>
            {suivante === 'pro' ? t('Passer en Pro', 'Upgrade to Pro') : t('Nous contacter', 'Contact us')}
          </Link>
        </section>
      )}

      <section className="overflow-x-auto rounded-carte border border-ink-200 bg-white" data-testid="offre-grille">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-left">
              <th className="px-4 py-3 font-medium text-ink-500" />
              {NOMS_OFFRES.map((o) => (
                <th key={o} className={`px-4 py-3 text-center font-semibold ${o === vue.offre ? 'bg-brand-50 text-brand-700' : 'text-ink-900'}`} data-testid={`offre-colonne-${o}`}>
                  {nomDeLOffre(o, t)}
                  {o === vue.offre && <span className="ml-1.5 text-xs font-medium">{t('(la vôtre)', '(yours)')}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FONCTIONS_OFFRE.map((f) => (
              <tr key={f} className="border-b border-ink-100 last:border-0">
                <td className="px-4 py-2 text-ink-900">{libelleFonction(f, t)}</td>
                {NOMS_OFFRES.map((o) => (
                  <td key={o} className={`px-4 py-2 text-center ${o === vue.offre ? 'bg-brand-50' : ''}`}>
                    {vue.grille[o].fonctions.has(f)
                      ? <Icone nom="valide" taille="ligne" className="inline text-succes" titre={t('Inclus', 'Included')} />
                      : <Icone nom="cadenas" taille="ligne" className="inline text-ink-300" titre={t('Non inclus', 'Not included')} />}
                  </td>
                ))}
              </tr>
            ))}
            {LIGNES_LIMITES.map((k) => (
              <tr key={k} className="border-b border-ink-100 last:border-0">
                <td className="px-4 py-2 text-ink-900">{libelleLimite(k)}</td>
                {NOMS_OFFRES.map((o) => (
                  <td key={o} className={`px-4 py-2 text-center tabular-nums text-ink-700 ${o === vue.offre ? 'bg-brand-50' : ''}`}>
                    {valeurLimite(vue.grille[o].limites, k)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
