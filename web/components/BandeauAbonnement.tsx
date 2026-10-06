'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { lireAbonnementNumero, type EtatAbonnementNumero } from '@/lib/api/abonnement-numero';
import { apiDeLaSession } from '@/lib/api/connexion-numero';

/**
 * LE BANDEAU DE L'ABONNEMENT DU NUMÉRO (lot 4, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`), sur
 * toutes les pages de la console. En retard : la date de la coupure ; suspendu : les envois sont coupés, et la date de
 * libération quand l'abonnement est fini ; fin prévue : un rappel discret. Un admin a le geste (« Régler » ouvre le
 * portail de Stripe, « Se réabonner » un nouveau paiement qui rend le même numéro) ; un membre est invité à prévenir un
 * administrateur. Une API sans la route, ou une lecture qui échoue : aucun bandeau.
 */
export function BandeauAbonnement({ tenantId, admin }: { tenantId: string; admin: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const [e, setE] = useState<EtatAbonnementNumero | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    lireAbonnementNumero(tenantId).then((r) => { if (vivant) setE(r); }).catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);

  if (e === null || (e.etat !== 'en_retard' && e.etat !== 'suspendu' && e.etat !== 'fin_prevue')) return null;
  const date = (iso: string | null) => (iso
    ? new Date(iso).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : '');
  const api = apiDeLaSession(tenantId);
  const aller = async (ouvrir: () => Promise<{ url: string }>) => {
    setEnCours(true);
    setErreur(null);
    try { window.location.assign((await ouvrir()).url); } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong'));
      setEnCours(false);
    }
  };
  const reabonner = e.etat === 'suspendu' && e.fini;
  const texte = e.etat === 'en_retard'
    ? t(`Le renouvellement de l’abonnement de votre numéro WhatsApp a échoué. Sans paiement, ses envois seront coupés le ${date(e.coupureLe)}.`,
      `The renewal of your WhatsApp number subscription failed. Without payment, its messages will stop on ${date(e.coupureLe)}.`)
    : e.etat === 'suspendu'
      ? (e.fini
        ? t(`Les envois de votre numéro WhatsApp sont coupés : son abonnement est terminé. Sans réabonnement, le numéro sera libéré le ${date(e.liberationLe)}.`,
          `Your WhatsApp number can no longer send: its subscription has ended. Without renewal, the number will be released on ${date(e.liberationLe)}.`)
        : t('Les envois de votre numéro WhatsApp sont coupés : son abonnement est impayé.', 'Your WhatsApp number can no longer send: its subscription is unpaid.'))
      : t(`L’abonnement de votre numéro WhatsApp se termine le ${date(e.finPrevueLe)}.`, `Your WhatsApp number subscription ends on ${date(e.finPrevueLe)}.`);
  const ton = e.etat === 'suspendu'
    ? 'border-danger-200 bg-danger-50 text-danger-700'
    : e.etat === 'en_retard' ? 'border-alerte-300 bg-alerte-50 text-alerte-900' : 'border-ink-200 bg-ink-50 text-ink-700';
  const bouton = 'ml-auto rounded-controle px-3 py-1.5 text-xs font-semibold transition-colors duration-150 disabled:opacity-60';

  return (
    <div className={`shrink-0 border-b px-4 py-2 sm:px-6 ${ton}`} data-testid="bandeau-abonnement" data-etat={e.etat}>
      <div className="mx-auto flex w-full max-w-liste flex-wrap items-center gap-3 text-sm">
        <span>{texte}</span>
        {admin ? (
          reabonner ? (
            <button type="button" disabled={enCours} onClick={() => { void aller(() => api.payer('console')); }} data-testid="bandeau-abonnement-reabonner"
              className={`${bouton} bg-danger-600 text-white hover:bg-danger-700`}>
              {t('Se réabonner', 'Renew')}
            </button>
          ) : api.portail ? (
            <button type="button" disabled={enCours} onClick={() => { const p = api.portail; if (p) void aller(p); }} data-testid="bandeau-abonnement-regler"
              className={`${bouton} border border-current bg-white hover:bg-ink-50`}>
              {e.etat === 'fin_prevue' ? t('Gérer', 'Manage') : t('Régler', 'Pay now')}
            </button>
          ) : null
        ) : (
          <span className="text-xs">{t('Prévenez un administrateur de l’espace.', 'Let a workspace admin know.')}</span>
        )}
        {erreur && <span className="w-full text-xs">{erreur}</span>}
      </div>
    </div>
  );
}
