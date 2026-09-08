'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { getSoldeAgent } from '@/lib/api-agent';
import { eurosDepuisMicro, SOLDE_BAS_MICRO_EUR } from '@/lib/agent-solde';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';

/**
 * Le crédit des agents IA : ce qu'il reste, et ce qui le fait descendre.
 *
 * ⚠️ CET ÉCRAN NE RECHARGE PAS ENCORE, ET IL LE DIT. Julien, le 2026-09-08 : « pas la peine de construire
 * cet écran, faut que je crée le produit dans Stripe et qu'on passe en pro Vercel ». L'entrée de menu, elle,
 * a été demandée tout de suite. Une entrée qui mène à une page vide serait un cul-de-sac : elle montre donc
 * ce qui EXISTE déjà (le solde, qui est réel et déjà débité à chaque appel de modèle) et annonce ce qui
 * manque, plutôt que de laisser deviner.
 *
 * 🔴 Le solde est celui de l'ESPACE, pas d'un agent : tous les agents y puisent, et c'est pour ça que cette
 * page est à côté de la liste des agents et non dans la fiche de l'un d'eux.
 */
export default function CreditPage() {
  return <AppShell active="agents-credit">{(session) => <CreditInner session={session} />}</AppShell>;
}

function CreditInner({ session }: { session: Session }) {
  const t = useT();
  const [solde, setSolde] = useState<number | null>(null);
  const [charge, setCharge] = useState(false);

  useEffect(() => {
    let vivant = true;
    getSoldeAgent(session.tenantId)
      .then((s) => { if (vivant) { setSolde(s); setCharge(true); } })
      .catch(() => { if (vivant) setCharge(true); });
    return () => { vivant = false; };
  }, [session.tenantId]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight text-ink-900">{t('Crédit des agents IA', 'AI agent credit')}</h1>

      <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="credit-solde">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('Crédit restant', 'Credit left')}</div>
        {!charge && <p className="mt-1 text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>}
        {charge && solde === null && (
          <p className="mt-1 text-sm text-ink-400">
            {t('Aucun crédit n’est suivi sur cet espace.', 'No credit is tracked on this workspace.')}
          </p>
        )}
        {charge && solde !== null && (
          <>
            <div className="mt-1 text-3xl font-light tracking-tight text-ink-900 tabular-nums">{eurosDepuisMicro(solde)} €</div>
            {solde <= 0 && (
              <p className="mt-2 text-sm text-coral" data-testid="credit-epuise">
                {t(
                  'Épuisé : vos agents ne répondent plus et sortent par « Plafond atteint ».',
                  'Used up: your agents no longer answer and leave through “Cap reached”.',
                )}
              </p>
            )}
            {solde > 0 && solde < SOLDE_BAS_MICRO_EUR && (
              <p className="mt-2 text-sm text-gold" data-testid="credit-bas">
                {t('C’est bas : au bout, vos agents cesseront de répondre.', 'That is low: once it runs out, your agents stop answering.')}
              </p>
            )}
          </>
        )}
      </section>

      <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-ink-900">{t('Recharger', 'Top up')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Le rechargement en ligne n’est pas encore ouvert. En attendant, contactez-nous : le crédit est ajouté à votre espace dans la foulée.',
            'Online top-up is not open yet. In the meantime, contact us: the credit is added to your workspace right away.',
          )}
        </p>
        <p className="mt-3 text-xs text-ink-400">
          {t(
            'Ce que le crédit paie : chaque aller-retour d’un agent avec son modèle, en production comme dans le bac à sable. Rien d’autre n’y touche.',
            'What the credit pays for: every round trip between an agent and its model, in production as in the sandbox. Nothing else draws on it.',
          )}
        </p>
      </section>
    </div>
  );
}
