'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Logo } from '@/components/Logo';
import type { Session } from '@/lib/session';
import {
  getMe, getSettings, putSettings, getAccountStatus,
  type MeResponse, type AccountStatusResponse, type AccountDot,
} from '@/lib/api';

export default function AccueilPage() {
  return <AppShell active="accueil">{(session) => <AccueilInner session={session} />}</AppShell>;
}

/** Couleur de la pastille de statut compte (hex direct -> aucun risque de shade Tailwind manquant). */
const DOT_HEX: Record<AccountDot, string> = { green: '#17C74E', amber: '#E8A400', red: '#FF4D4F', grey: '#B8BEC9' };

/** Prénom depuis le nom complet ; repli sur la partie locale de l'email ; sinon vide. */
function firstNameOf(me: MeResponse | null): string {
  const n = me?.name?.trim();
  if (n) return n.split(/\s+/)[0] ?? '';
  const local = me?.email?.split('@')[0];
  return local ?? '';
}

function AccueilInner({ session }: { session: Session }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [account, setAccount] = useState<AccountStatusResponse | null>(null);
  const [mbaEnabled, setMbaEnabled] = useState(false);
  const [savingMba, setSavingMba] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = session.role === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, cfg, acc] = await Promise.all([
        getMe(session.tenantId),
        getSettings(session.tenantId),
        getAccountStatus(session.tenantId),
      ]);
      setMe(m);
      setMbaEnabled(cfg.mbaEnabled);
      setAccount(acc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleMba() {
    if (!isAdmin) return;
    const next = !mbaEnabled;
    setSavingMba(true);
    setMbaEnabled(next); // optimiste
    try {
      await putSettings(session.tenantId, next);
    } catch {
      setMbaEnabled(!next); // rollback
    } finally {
      setSavingMba(false);
    }
  }

  const firstName = firstNameOf(me);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">
          Bonjour{firstName ? ` ${firstName}` : ''}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">Voici l&apos;état de ton compte WhatsApp Business.</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-ink-500">Chargement…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Espace sans numéro (self-signup) -> onboarding grisé ; sinon carte statut opérationnelle. */}
          {account && !account.hasNumber ? (
            <ConnectNumberZone />
          ) : (
            <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-tight text-ink-900">Numéro WhatsApp</h3>
                {account && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DOT_HEX[account.status.dot] }} />
                    {account.status.label}
                  </span>
                )}
              </div>
              <div className="font-mono text-lg font-semibold text-ink-900">
                {account?.number ? (account.number.startsWith('+') ? account.number : `+${account.number}`) : 'Aucun numéro'}
              </div>
              {account && <p className="mt-1 text-xs text-ink-500">{account.status.reason}</p>}
              {account?.hasNumber && (
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-ink-100 pt-3 text-xs">
                  <div>
                    <div className="font-medium uppercase tracking-wide text-ink-400">Qualité</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: qualityHex(account.quality) }} />
                      {qualityLabel(account.quality)}
                    </div>
                  </div>
                  {account.tier && (
                    <div>
                      <div className="font-medium uppercase tracking-wide text-ink-400">Palier d&apos;envoi</div>
                      <div className="mt-0.5 text-sm font-semibold text-ink-800">{tierLabel(account.tier)}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Carte MBA (déplacée depuis Analytics) */}
          <div className="flex flex-col rounded-2xl border border-ink-200 bg-gradient-to-br from-white to-navy-50 p-5 shadow-sm">
            <div className="mb-3 flex items-start gap-3">
              <Logo className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold tracking-tight text-ink-900">Meta Business Agent</div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {mbaEnabled
                    ? "Activé : l'agent IA répondra quand Meta ouvrira la fonctionnalité sur ton numéro."
                    : "Désactivé. Active-le pour préparer l'agent IA WhatsApp."}
                  <span className="ml-1 text-ink-400">En attente d&apos;ouverture Meta (mur ToS Business AI).</span>
                </p>
              </div>
            </div>
            <div className="mt-auto flex items-center gap-3 pt-2">
              <button
                onClick={toggleMba}
                disabled={!isAdmin || savingMba}
                title={isAdmin ? '' : 'Réservé aux admins'}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${mbaEnabled ? 'bg-brand-500' : 'bg-ink-300'} ${!isAdmin ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${mbaEnabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
              <span className="text-sm font-medium text-ink-700">{mbaEnabled ? 'Activé' : 'Désactivé'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Onboarding d'un espace SANS numéro (self-signup) : zone grisée « Connecter ton numéro ». Remplace la carte de
 * statut opérationnelle tant qu'aucun numéro n'est rattaché. Le CTA est un placeholder inactif : c'est le futur
 * point d'entrée de l'Embedded Signup Meta (activable quand MessagingMe sera Tech Partner).
 */
function ConnectNumberZone() {
  return (
    <div className="rounded-2xl border border-dashed border-ink-300 bg-ink-50 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-ink-500">Numéro WhatsApp</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-500">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DOT_HEX.grey }} />
          Non connecté
        </span>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink-100 text-ink-400" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold text-ink-700">Connecter ton numéro</div>
          <p className="mt-0.5 text-xs text-ink-500">
            Première étape : rattache ton numéro WhatsApp Business pour activer l&apos;envoi de messages et de campagnes.
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3 border-t border-ink-200 pt-3">
        <button
          type="button"
          disabled
          title="Bientôt disponible"
          className="cursor-not-allowed rounded-lg bg-ink-200 px-3 py-2 text-sm font-semibold text-ink-500"
        >
          Connecter ton numéro
        </button>
        <span className="text-xs text-ink-400">Disponible prochainement</span>
      </div>
    </div>
  );
}

function qualityHex(q: AccountStatusResponse['quality']): string {
  return q === 'GREEN' ? DOT_HEX.green : q === 'YELLOW' ? DOT_HEX.amber : q === 'RED' ? DOT_HEX.red : DOT_HEX.grey;
}
function qualityLabel(q: AccountStatusResponse['quality']): string {
  return q === 'GREEN' ? 'Verte' : q === 'YELLOW' ? 'Moyenne' : q === 'RED' ? 'Rouge' : 'Non évaluée';
}

/** Palier de messagerie Meta -> libellé humain (nombre de conversations business par 24 h). */
function tierLabel(tier: string): string {
  const map: Record<string, string> = {
    TIER_50: '50 / jour',
    TIER_250: '250 / jour',
    TIER_1K: '1 000 / jour',
    TIER_10K: '10 000 / jour',
    TIER_100K: '100 000 / jour',
    TIER_UNLIMITED: 'Illimité',
    UNLIMITED: 'Illimité',
  };
  return map[tier.toUpperCase()] ?? tier;
}
