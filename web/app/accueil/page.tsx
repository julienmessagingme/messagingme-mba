'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Logo } from '@/components/Logo';
import type { Session } from '@/lib/session';
import { fmtNum, fmtCost, throughputLabel, tierLabel } from '@/lib/format';
import {
  getMe, getSettings, putSettings, getAccountStatus, setHubspotConnected,
  getStats, getTemplateStats, getCostSeries,
  type MeResponse, type AccountStatusResponse, type AccountDot,
} from '@/lib/api';

export default function AccueilPage() {
  return <AppShell active="accueil">{(session) => <AccueilInner session={session} />}</AppShell>;
}

/** Couleur de la pastille de statut compte (hex direct -> aucun risque de shade Tailwind manquant). */
const DOT_HEX: Record<AccountDot, string> = { green: '#17C74E', amber: '#E8A400', red: '#FF4D4F', grey: '#B8BEC9' };

/** Logo HubSpot (sprocket officiel monochrome, Simple Icons) en couleur de marque. Marque l'intégration au niveau du toggle. */
function HubSpotMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#FF7A59" role="img" aria-label="HubSpot" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z" />
    </svg>
  );
}

/** Prénom depuis le nom complet ; repli sur la partie locale de l'email ; sinon vide. */
function firstNameOf(me: MeResponse | null): string {
  const n = me?.name?.trim();
  if (n) return n.split(/\s+/)[0] ?? '';
  const local = me?.email?.split('@')[0];
  return local ?? '';
}

/** Total KPI sur 30 j, calculés à partir des mêmes endpoints que la page Analytics (pas de recalcul divergent). */
interface Kpis {
  contacts: number;      // total cumulé de contacts (dernière valeur de la série cumulative)
  exchanged: number;     // messages échangés (hors template) sur 30 j
  templates: number;     // templates envoyés sur 30 j
  cost: number;          // coût estimé sur 30 j
  hasRates: boolean;     // false -> Meta n'a fourni aucun tarif : afficher « — » plutôt qu'un faux 0
}

function AccueilInner({ session }: { session: Session }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [account, setAccount] = useState<AccountStatusResponse | null>(null);
  const [mbaEnabled, setMbaEnabled] = useState(false);
  const [savingMba, setSavingMba] = useState(false);
  const [savingHubspot, setSavingHubspot] = useState(false);
  const [kpis, setKpis] = useState<Kpis | null>(null);
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

  // KPIs 30 j : chargés à part (non bloquants). Un hoquet des stats/coût n'efface pas la carte statut.
  const loadKpis = useCallback(async () => {
    try {
      const [stats, tpl, cost] = await Promise.all([
        getStats(session.tenantId),
        getTemplateStats(session.tenantId),
        getCostSeries(session.tenantId),
      ]);
      const contacts = stats.contacts.length ? (stats.contacts[stats.contacts.length - 1]?.count ?? 0) : 0;
      const exchanged = stats.exchanged.reduce((s, p) => s + p.count, 0);
      const templates = tpl.breakdown.reduce((s, r) => s + r.count, 0);
      setKpis({ contacts, exchanged, templates, cost: cost.total, hasRates: cost.hasRates });
    } catch {
      // Silencieux : les KPIs sont un plus, pas un bloquant. On laisse la rangée en « — ».
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
    void loadKpis();
  }, [load, loadKpis]);

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

  async function toggleHubspot() {
    if (!isAdmin || !account?.phoneNumberId) return;
    const next = !account.hubspotConnected;
    setSavingHubspot(true);
    setAccount((a) => (a ? { ...a, hubspotConnected: next } : a)); // optimiste
    try {
      await setHubspotConnected(session.tenantId, account.phoneNumberId, next);
    } catch {
      setAccount((a) => (a ? { ...a, hubspotConnected: !next } : a)); // rollback
    } finally {
      setSavingHubspot(false);
    }
  }

  const firstName = firstNameOf(me);
  const kpiRow = useMemo(
    () => [
      { label: 'Contacts', value: kpis ? fmtNum(kpis.contacts) : '—' },
      { label: 'Messages échangés', value: kpis ? fmtNum(kpis.exchanged) : '—' },
      { label: 'Templates envoyés', value: kpis ? fmtNum(kpis.templates) : '—' },
      { label: 'Coût estimé', value: kpis ? (kpis.hasRates ? fmtCost(kpis.cost) : '—') : '—' },
    ],
    [kpis],
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">
          Bonjour{firstName ? ` ${firstName}` : ''}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">Voici l&apos;état de ton compte WhatsApp Business.</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Rangée de KPIs (30 derniers jours) — mêmes chiffres que la page Analytics. */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">30 derniers jours</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {kpiRow.map((k) => (
            <div key={k.label} className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{k.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{k.value}</div>
            </div>
          ))}
        </div>
      </div>

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
              {account?.verifiedName && <div className="mt-0.5 text-xs text-ink-500">{account.verifiedName}</div>}
              {account && <p className="mt-1 text-xs text-ink-500">{account.status.reason}</p>}
              {account?.hasNumber && (
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-ink-100 pt-3 text-xs">
                  <div>
                    <div className="font-medium uppercase tracking-wide text-ink-400">Qualité</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: qualityHex(account.quality) }} />
                      {qualityLabel(account.quality)}
                    </div>
                  </div>
                  {account.tier && (
                    <Field label="Cap d'envoi" value={tierLabel(account.tier)} />
                  )}
                  {account.nameStatus && <Field label="Nom" value={nameStatusLabel(account.nameStatus)} />}
                  {account.throughputLevel && <Field label="Débit" value={throughputLabel(account.throughputLevel)} />}
                  {account.wabaHealthStatus && <Field label="Santé du compte" value={wabaHealthLabel(account.wabaHealthStatus)} />}
                </div>
              )}
              {account?.hasNumber && account.hubspotPortal?.connected && (
                // Portail relié : on affiche SUR QUEL portail, puis le toggle de synchro PAR numéro (qui gate le push).
                <div className="mt-4 border-t border-ink-100 pt-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                    <HubSpotMark className="h-[18px] w-[18px] shrink-0" />
                    <span>
                      HubSpot : connecté au portail{' '}
                      <span className="font-mono text-brand-700">{account.hubspotPortal.hubDomain ?? account.hubspotPortal.hubId}</span>
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: account.hubspotConnected ? DOT_HEX.green : DOT_HEX.grey }}
                        />
                        {account.hubspotConnected ? 'Synchronisation activée' : 'Synchronisation coupée'}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {account.hubspotConnected
                          ? "Les analyses de conversation sont synchronisées vers HubSpot."
                          : "La synchronisation vers HubSpot est coupée pour ce numéro."}
                      </p>
                    </div>
                    {isAdmin && account.phoneNumberId && (
                      <button
                        onClick={toggleHubspot}
                        disabled={savingHubspot}
                        title="Activer/couper la synchro HubSpot"
                        aria-pressed={account.hubspotConnected}
                        className={`relative h-7 w-12 shrink-0 rounded-full transition ${account.hubspotConnected ? 'bg-brand-500' : 'bg-ink-300'} ${savingHubspot ? 'opacity-60' : ''}`}
                      >
                        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${account.hubspotConnected ? 'left-[22px]' : 'left-0.5'}`} />
                      </button>
                    )}
                  </div>
                </div>
              )}
              {account?.hasNumber && account.hubspotPortal && !account.hubspotPortal.connected && (
                // Aucun portail relié : on ne montre PAS le toggle par numéro (pousser sans portail ne fait rien).
                // Le CTA lance l'install OAuth du connecteur en liant CE tenant (admin uniquement).
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-100 pt-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                      <HubSpotMark className="h-[18px] w-[18px] shrink-0" />
                      HubSpot non connecté
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      Aucun portail HubSpot n&apos;est relié à ce compte. Connecte-le pour synchroniser les analyses de conversation.
                    </p>
                  </div>
                  {isAdmin && (
                    <a
                      href={`https://mm-hubspot.messagingme.app/oauth/install?tenant=${encodeURIComponent(session.tenantId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
                    >
                      Connecter HubSpot
                    </a>
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

/** Petit champ étiquette + valeur (rangée de détails du numéro). */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-ink-800">{value}</div>
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

/** Statut du nom d'affichage (name_status Graph) -> libellé humain. */
function nameStatusLabel(s: string): string {
  const map: Record<string, string> = {
    APPROVED: 'Approuvé',
    AVAILABLE_WITHOUT_REVIEW: 'Approuvé',
    PENDING_REVIEW: 'En revue',
    PENDING: 'En revue',
    DECLINED: 'Refusé',
    NONE: 'Aucun',
    EXPIRED: 'Expiré',
  };
  return map[s.toUpperCase()] ?? s;
}

/** Santé du WABA (health_status.can_send_message) -> libellé humain. */
function wabaHealthLabel(s: string): string {
  const map: Record<string, string> = { AVAILABLE: 'Disponible', LIMITED: 'Limitée', BLOCKED: 'Bloquée' };
  return map[s.toUpperCase()] ?? s;
}
