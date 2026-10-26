'use client';

import { useEffect, useState } from 'react';
import { Squelette } from '@/components/Squelette';
import { useT, useLocale } from '@/lib/i18n';
import { erreurDeChargement } from '@/lib/http';
import { lireFactures, portailPro, type FactureEspace, type StatutFacture } from '@/lib/api/offre';

/**
 * « VOS FACTURES » (2026-10-26, demande de Julien : un lien clair vers les factures ; tranché le même jour : elles se
 * LISENT dans la console). Toutes celles de l'espace chez Stripe, Pro, numéro et recharges, les plus récentes d'abord,
 * avec leur page et leur PDF hébergés par Stripe.
 *
 * ⚠️ UNE API PLUS ANCIENNE (404) OU STRIPE PAS CONFIGURÉ (503) : la section ne s'affiche pas, rien à promettre. Une
 * lecture qui échoue chez Stripe se dit, la page reste.
 * 🔴 Chaque lien s'ouvre dans un nouvel onglet, sans `opener` : la page de Stripe n'a pas à pouvoir piloter la console.
 */
export function FacturesEspace({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<{ factures: FactureEspace[]; plusSurStripe: boolean } | null | undefined>(undefined);
  const [erreur, setErreur] = useState<string | null>(null);
  const [portail, setPortail] = useState(false);

  useEffect(() => {
    let vivant = true;
    lireFactures(tenantId)
      .then((r) => { if (vivant) setEtat(r); })
      .catch((err: unknown) => {
        if (!vivant) return;
        setEtat(null);
        setErreur(erreurDeChargement(err, t));
      });
    return () => { vivant = false; };
  }, [tenantId, t]);

  async function ouvrirPortail(): Promise<void> {
    setPortail(true);
    try {
      window.location.assign((await portailPro(tenantId)).url);
    } catch (err) {
      setPortail(false);
      setErreur(erreurDeChargement(err, t));
    }
  }

  // Indisponible (API plus ancienne, Stripe pas configuré) : rien à montrer.
  if (etat === null && erreur === null) return null;

  const fr = locale === 'en' ? 'en-GB' : 'fr-FR';
  const date = (iso: string): string => new Date(iso).toLocaleDateString(fr, { day: 'numeric', month: 'long', year: 'numeric' });
  const montant = (f: FactureEspace): string => {
    try {
      return new Intl.NumberFormat(fr, { style: 'currency', currency: f.devise.toUpperCase() }).format(f.totalCentimes / 100);
    } catch {
      return `${(f.totalCentimes / 100).toLocaleString(fr)} ${f.devise.toUpperCase()}`;
    }
  };
  const objet = (f: FactureEspace): string => (f.objet === 'pro'
    ? t('Abonnement Pro', 'Pro subscription')
    : f.objet === 'numero' ? t('Numéro WhatsApp', 'WhatsApp number') : (f.libelle ?? t('Facture', 'Invoice')));
  const STATUTS: Record<StatutFacture, { libelle: string; classes: string }> = {
    payee: { libelle: t('Payée', 'Paid'), classes: 'bg-succes-50 text-succes-700' },
    a_regler: { libelle: t('À régler', 'Due'), classes: 'bg-alerte-50 text-alerte-700' },
    impayee: { libelle: t('Impayée', 'Unpaid'), classes: 'bg-danger-50 text-danger-700' },
    annulee: { libelle: t('Annulée', 'Void'), classes: 'bg-ink-100 text-ink-700' },
  };
  const lien = 'text-xs font-medium text-brand-600 hover:underline';

  return (
    <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-factures">
      <h2 className="text-sm font-semibold text-ink-900">{t('Vos factures', 'Your invoices')}</h2>
      <p className="mt-1 text-xs text-ink-500">
        {t('Abonnement, numéro et recharges du crédit IA, montants TTC. Chaque facture s’ouvre sur la page de Stripe, avec son PDF.',
          'Subscription, number and AI credit top-ups, amounts incl. VAT. Each invoice opens on Stripe’s page, with its PDF.')}
      </p>
      {etat === undefined && <Squelette forme="carte" className="mt-3" />}
      {etat && etat.factures.length === 0 && (
        <p className="mt-3 text-sm text-ink-500" data-testid="offre-factures-vide">{t('Aucune facture pour l’instant.', 'No invoice yet.')}</p>
      )}
      {etat && etat.factures.length > 0 && (
        <ul className="mt-3 divide-y divide-ink-100">
          {etat.factures.map((f) => (
            <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-sm" data-testid="offre-facture" data-statut={f.statut}>
              <span className="min-w-0 text-ink-900">
                {objet(f)}
                <span className="ml-2 text-xs text-ink-500">{date(f.le)}{f.numero ? ` · ${f.numero}` : ''}</span>
              </span>
              <span className="flex items-baseline gap-3">
                <span className="tabular-nums text-ink-900">{montant(f)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUTS[f.statut].classes}`}>{STATUTS[f.statut].libelle}</span>
                {f.urlPage && (
                  <a href={f.urlPage} target="_blank" rel="noopener noreferrer" className={lien} data-testid="offre-facture-voir">
                    {f.statut === 'a_regler' ? t('Régler', 'Pay') : t('Voir', 'View')}
                  </a>
                )}
                {f.urlPdf && (
                  <a href={f.urlPdf} target="_blank" rel="noopener noreferrer" className={lien} data-testid="offre-facture-pdf">PDF</a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {etat?.plusSurStripe && (
        <p className="mt-3 text-xs text-ink-500" data-testid="offre-factures-plus">
          {t('Les factures plus anciennes sont sur la page de Stripe.', 'Older invoices are on Stripe’s page.')}{' '}
          <button type="button" onClick={() => void ouvrirPortail()} disabled={portail} className={lien}>
            {t('Les voir', 'See them')}
          </button>
        </p>
      )}
      {erreur && <p className="mt-2 text-sm text-danger" data-testid="offre-factures-erreur">{erreur}</p>}
    </section>
  );
}
