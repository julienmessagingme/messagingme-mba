'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { fmtNum, fmtCost, throughputLabel, tierLabel } from '@/lib/format';
import {
  getMe, getSettings, putSettings, getAccountStatus, setHubspotConnected,
  setHubspotListsEnabled as saveHubspotListsEnabled,
  setControlHandbackSeconds, getHubspotInstallLink,
  getStats, getTemplateStats, getCostSeries, getEsConfig, completeEmbeddedSignup,
  type MeResponse, type AccountStatusResponse, type AccountDot, type EsConfig,
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
  const t = useT();
  const { locale } = useLocale();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [account, setAccount] = useState<AccountStatusResponse | null>(null);
  const [mbaEnabled, setMbaEnabled] = useState(false);
  const [savingMba, setSavingMba] = useState(false);
  const [savingHubspot, setSavingHubspot] = useState(false);
  const [hubspotListsEnabled, setHubspotListsEnabled] = useState(false);
  // Durée du gel quand un opérateur prend la main. '' = valeur par défaut du serveur.
  const [handback, setHandback] = useState('');
  const [savingHandback, setSavingHandback] = useState(false);
  const [savingLists, setSavingLists] = useState(false);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Erreur PROPRE au statut du compte : distinguée de `error` pour ne jamais afficher « Aucun numéro »
   *  quand la vérité est « je n'ai pas réussi à le savoir ». */
  const [accountError, setAccountError] = useState<string | null>(null);
  /**
   * Chargement PROPRE au statut, distinct de `loading`. Indispensable : `getAccountStatus` fait deux
   * allers-retours vers l'API Graph de Meta, il arrive donc TOUJOURS après `getMe`/`getSettings` qui sont deux
   * requêtes SQL. Sans cet état, la fenêtre `loading=false, account=null, accountError=null` est le cas
   * NOMINAL, et le rendu y affiche « Aucun numéro » avant de se corriger.
   */
  const [accountLoading, setAccountLoading] = useState(true);

  const isAdmin = session.role === 'admin';

  /**
   * Statut du compte, chargé À PART et jamais en `Promise.all` avec le reste. C'était la cause du symptôme
   * « le numéro n'apparaît pas » : un `Promise.all` est tout-ou-rien, donc un hoquet sur `getMe` (qui ne sert
   * qu'à afficher un prénom) laissait `account` à null, et l'affichage retombait sur « Aucun numéro », ce qui
   * est un MENSONGE : on ne sait pas, ce n'est pas la même chose que ne pas en avoir.
   */
  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountError(null);
    try {
      setAccount(await getAccountStatus(session.tenantId));
    } catch (err) {
      setAccount(null);
      setAccountError(err instanceof Error ? err.message : t('Statut indisponible', 'Status unavailable'));
    } finally {
      setAccountLoading(false);
    }
  }, [session.tenantId, t]);

  /** Profil et réglages : `allSettled`, chaque réponse est appliquée indépendamment des autres. */
  const load = useCallback(async () => {
    setError(null);
    const [m, cfg] = await Promise.allSettled([getMe(session.tenantId), getSettings(session.tenantId)]);
    if (m.status === 'fulfilled') setMe(m.value);
    if (cfg.status === 'fulfilled') {
      setMbaEnabled(cfg.value.mbaEnabled);
      setHubspotListsEnabled(cfg.value.hubspotListsEnabled);
      setHandback(cfg.value.controlHandbackSeconds === null ? '' : String(Math.round(cfg.value.controlHandbackSeconds / 60)));
    }
    if (m.status === 'rejected' || cfg.status === 'rejected') {
      const reason = (m.status === 'rejected' ? m.reason : cfg.status === 'rejected' ? cfg.reason : null) as unknown;
      setError(reason instanceof Error ? reason.message : t('Chargement partiel', 'Partial load'));
    }
    setLoading(false);
  }, [session.tenantId, t]);

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
    void loadAccount();
    void loadKpis();
  }, [load, loadAccount, loadKpis]);

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

  async function toggleHubspotLists() {
    if (!isAdmin) return;
    const next = !hubspotListsEnabled;
    setSavingLists(true);
    setHubspotListsEnabled(next); // optimiste
    try {
      await saveHubspotListsEnabled(session.tenantId, next);
    } catch {
      setHubspotListsEnabled(!next); // rollback
    } finally {
      setSavingLists(false);
    }
  }

  const [installPending, setInstallPending] = useState(false);
  /**
   * Ouvre le lien d'install/re-consentement HubSpot. Le lien est demandé au backend (route admin-only), qui y met un
   * jeton SIGNÉ : le tenant n'est plus passé en clair dans l'URL (elle était forgeable). On ouvre ensuite l'URL renvoyée.
   */
  async function openHubspotInstall(grant?: 'lists') {
    if (!isAdmin || installPending) return;
    setInstallPending(true);
    try {
      const { installUrl } = await getHubspotInstallLink(session.tenantId, grant);
      window.open(installUrl, '_blank', 'noopener,noreferrer');
    } catch {
      alert(t("Impossible de générer le lien HubSpot pour le moment.", 'Could not generate the HubSpot link right now.'));
    } finally {
      setInstallPending(false);
    }
  }

  /**
   * Enregistre la durée du gel. Saisie en MINUTES (une durée en secondes n'a aucun sens pour un
   * utilisateur), champ vide = retour au défaut du serveur, 0 = pas de reprise automatique.
   */
  async function saveHandback() {
    if (!isAdmin) return;
    const brut = handback.trim();
    const minutes = brut === '' ? null : Number(brut);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) return;
    setSavingHandback(true);
    try {
      await setControlHandbackSeconds(session.tenantId, minutes === null ? null : minutes * 60);
    } catch {
      /* l'erreur reste visible par l'absence de confirmation ; pas de rollback, la saisie est conservée */
    } finally {
      setSavingHandback(false);
    }
  }

  const firstName = firstNameOf(me);
  const kpiRow = useMemo(
    () => [
      { label: t('Contacts', 'Contacts'), value: kpis ? fmtNum(kpis.contacts, locale) : '—' },
      { label: t('Messages échangés', 'Messages exchanged'), value: kpis ? fmtNum(kpis.exchanged, locale) : '—' },
      { label: t('Templates envoyés', 'Templates sent'), value: kpis ? fmtNum(kpis.templates, locale) : '—' },
      { label: t('Coût estimé', 'Estimated cost'), value: kpis ? (kpis.hasRates ? fmtCost(kpis.cost) : '—') : '—' },
    ],
    [kpis, t, locale],
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">
          {t('Bonjour', 'Hello')}{firstName ? ` ${firstName}` : ''}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">{t("Voici l'état de ton compte WhatsApp Business.", 'Here is the status of your WhatsApp Business account.')}</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Rangée de KPIs (30 derniers jours) — mêmes chiffres que la page Analytics. */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">{t('30 derniers jours', 'Last 30 days')}</div>
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
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Invariant de cette cascade : « Aucun numéro » ne s'affiche QUE si account est chargé ET dit qu'il
              n'y en a pas. Tant qu'on ne sait pas, on le dit (chargement, puis erreur avec de quoi relancer).
              Affirmer une absence qu'on n'a pas constatée était toute la cause du symptôme rapporté. */}
          {accountLoading ? (
            <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Numéro WhatsApp', 'WhatsApp number')}</h3>
              <p className="mt-2 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
            </div>
          ) : accountError ? (
            <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Numéro WhatsApp', 'WhatsApp number')}</h3>
              <p className="mt-2 text-sm text-ink-600">{t('Statut indisponible pour le moment.', 'Status unavailable right now.')}</p>
              <p className="mt-0.5 text-xs text-ink-400">{accountError}</p>
              <button
                type="button"
                onClick={() => void loadAccount()}
                className="mt-3 rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 transition hover:bg-ink-100"
              >
                {t('Réessayer', 'Retry')}
              </button>
            </div>
          ) : account && !account.hasNumber ? (
            <ConnectNumberZone tenantId={session.tenantId} isAdmin={isAdmin} onConnected={() => { setLoading(true); void load(); void loadAccount(); }} />
          ) : (
            <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Numéro WhatsApp', 'WhatsApp number')}</h3>
                {account && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DOT_HEX[account.status.dot] }} />
                    {account.status.label}
                  </span>
                )}
              </div>
              <div className="font-mono text-lg font-semibold text-ink-900">
                {account?.number ? (account.number.startsWith('+') ? account.number : `+${account.number}`) : t('Aucun numéro', 'No number')}
              </div>
              {account?.verifiedName && <div className="mt-0.5 text-xs text-ink-500">{account.verifiedName}</div>}
              {account && <p className="mt-1 text-xs text-ink-500">{account.status.reason}</p>}
              {account?.hasNumber && (
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-ink-100 pt-3 text-xs">
                  <div>
                    <div className="font-medium uppercase tracking-wide text-ink-400">{t('Qualité', 'Quality')}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: qualityHex(account.quality) }} />
                      {qualityLabel(account.quality, t)}
                    </div>
                  </div>
                  {account.tier && (
                    <Field label={t("Cap d'envoi", 'Sending limit')} value={tierLabel(account.tier, locale)} />
                  )}
                  {account.nameStatus && <Field label={t('Nom', 'Name')} value={nameStatusLabel(account.nameStatus, t)} />}
                  {account.throughputLevel && <Field label={t('Débit', 'Throughput')} value={throughputLabel(account.throughputLevel, locale)} />}
                  {account.wabaHealthStatus && <Field label={t('Santé du compte', 'Account health')} value={wabaHealthLabel(account.wabaHealthStatus, t)} />}
                </div>
              )}
              {account?.hasNumber && account.hubspotPortal?.connected && (
                // Portail relié : on affiche SUR QUEL portail, puis le toggle de synchro PAR numéro (qui gate le push).
                <div className="mt-4 border-t border-ink-100 pt-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                    <HubSpotMark className="h-[18px] w-[18px] shrink-0" />
                    <span>
                      {t('HubSpot : connecté au portail', 'HubSpot: connected to portal')}{' '}
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
                        {account.hubspotConnected ? t('Synchronisation activée', 'Sync enabled') : t('Synchronisation coupée', 'Sync disabled')}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {account.hubspotConnected
                          ? t('Les analyses de conversation sont synchronisées vers HubSpot.', 'Conversation analyses are synced to HubSpot.')
                          : t('La synchronisation vers HubSpot est coupée pour ce numéro.', 'Sync to HubSpot is disabled for this number.')}
                      </p>
                    </div>
                    {isAdmin && account.phoneNumberId && (
                      <button
                        onClick={toggleHubspot}
                        disabled={savingHubspot}
                        title={t('Activer/couper la synchro HubSpot', 'Enable/disable HubSpot sync')}
                        aria-pressed={account.hubspotConnected}
                        className={`relative h-7 w-12 shrink-0 rounded-full transition ${account.hubspotConnected ? 'bg-brand-500' : 'bg-ink-300'} ${savingHubspot ? 'opacity-60' : ''}`}
                      >
                        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${account.hubspotConnected ? 'left-[22px]' : 'left-0.5'}`} />
                      </button>
                    )}
                  </div>

                  {/* Toggle « Campagnes via données HubSpot » : autorise l'import de listes HubSpot comme destinataires. */}
                  <div className="mt-3 border-t border-ink-50 pt-3">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink-800">{t('Campagnes via données HubSpot', 'Campaigns from HubSpot data')}</div>
                        <p className="mt-0.5 text-xs text-ink-500">{t('Importe une liste HubSpot comme destinataires de campagne.', 'Import a HubSpot list as campaign recipients.')}</p>
                      </div>
                      {isAdmin && (
                        <button
                          onClick={toggleHubspotLists}
                          disabled={savingLists}
                          aria-pressed={hubspotListsEnabled}
                          title={t("Activer/désactiver l'import de listes HubSpot", 'Enable/disable HubSpot list import')}
                          className={`relative h-7 w-12 shrink-0 rounded-full transition ${hubspotListsEnabled ? 'bg-brand-500' : 'bg-ink-300'} ${savingLists ? 'opacity-60' : ''}`}
                        >
                          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${hubspotListsEnabled ? 'left-[22px]' : 'left-0.5'}`} />
                        </button>
                      )}
                    </div>
                    {/* Activé mais scope crm.lists.read pas encore accordé -> CTA de re-consentement CIBLÉ (ajoute le
                        scope à CE portail uniquement, sans re-solliciter les autres). */}
                    {isAdmin && hubspotListsEnabled && !account.hubspotPortal.listsScopeGranted && (
                      <button
                        type="button"
                        onClick={() => void openHubspotInstall('lists')}
                        disabled={installPending}
                        className="mt-2 inline-flex items-center rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-60"
                      >
                        {t("Autoriser l'accès aux listes HubSpot →", 'Authorize access to HubSpot lists →')}
                      </button>
                    )}
                    {hubspotListsEnabled && account.hubspotPortal.listsScopeGranted && (
                      <p className="mt-2 text-xs text-ink-500">{t("Accès aux listes autorisé. Choisis une liste HubSpot à l'étape « destinataires » d'une campagne.", "List access authorized. Pick a HubSpot list in a campaign's recipients step.")}</p>
                    )}
                  </div>
                </div>
              )}
              {/* Durée du gel : combien de temps une conversation reste à l'opérateur avant de repartir
                  toute seule. C'est le réglage qui décide combien de temps un client peut rester sans
                  réponse automatique, d'où le libellé explicite plutôt qu'un simple nombre. */}
              {account?.hasNumber && (
                <div className="mt-4 border-t border-ink-100 pt-3">
                  <div className="text-sm font-semibold text-ink-800">
                    {t("Reprise après intervention d'un opérateur", 'Hand back after an operator steps in')}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {t(
                      "Quand un opérateur répond dans l'inbox, le scénario se met en pause sur cette conversation. Voici combien de temps avant qu'il reprenne tout seul.",
                      'When an operator replies from the inbox, the scenario pauses on that conversation. This is how long before it resumes on its own.',
                    )}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={handback}
                      onChange={(e) => setHandback(e.target.value)}
                      onBlur={() => { void saveHandback(); }}
                      disabled={!isAdmin || savingHandback}
                      placeholder={t('par défaut', 'default')}
                      className="w-28 rounded-lg border border-ink-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
                    />
                    <span className="text-sm text-ink-600">{t('minutes', 'minutes')}</span>
                    {savingHandback && <span className="text-xs text-ink-400">{t('enregistrement...', 'saving...')}</span>}
                  </div>
                  <p className="mt-1.5 text-xs text-ink-400">
                    {handback.trim() === ''
                      ? t('Vide : la valeur par défaut du service s’applique (2 heures).', 'Empty: the service default applies (2 hours).')
                      : handback.trim() === '0'
                        ? t('0 : le scénario ne reprend JAMAIS tout seul. Il faut rendre la main depuis la conversation.', '0: the scenario never resumes on its own. You must hand back from the conversation.')
                        : t('Un opérateur peut rendre la main plus tôt, depuis la conversation.', 'An operator can hand back earlier, from the conversation.')}
                  </p>
                </div>
              )}
              {account?.hasNumber && account.hubspotPortal && !account.hubspotPortal.connected && (
                // Aucun portail relié : on ne montre PAS le toggle par numéro (pousser sans portail ne fait rien).
                // Le CTA lance l'install OAuth du connecteur en liant CE tenant (admin uniquement).
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-100 pt-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                      <HubSpotMark className="h-[18px] w-[18px] shrink-0" />
                      {t('HubSpot non connecté', 'HubSpot not connected')}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {t("Aucun portail HubSpot n'est relié à ce compte. Connecte-le pour synchroniser les analyses de conversation.", 'No HubSpot portal is linked to this account. Connect it to sync conversation analyses.')}
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => void openHubspotInstall()}
                      disabled={installPending}
                      className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
                    >
                      {t('Connecter HubSpot', 'Connect HubSpot')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Carte MBA (déplacée depuis Analytics) */}
          <div className="flex flex-col rounded-2xl border border-ink-200 bg-gradient-to-br from-white to-navy-50 p-5 shadow-sm">
            <div className="mb-3 flex items-start gap-3">
              {/* Logo Meta Business Agent (produit Meta), et non notre logo MM : cette carte parle du MBA de Meta. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/meta-business-agent.png" alt="Meta Business Agent" className="h-10 w-10 shrink-0 rounded-lg object-contain" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold tracking-tight text-ink-900">Meta Business Agent</div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {mbaEnabled
                    ? t("Activé : l'agent IA répondra quand Meta ouvrira la fonctionnalité sur ton numéro.", 'Enabled: the AI agent will reply once Meta opens the feature on your number.')
                    : t("Désactivé. Active-le pour préparer l'agent IA WhatsApp.", 'Disabled. Enable it to prepare the WhatsApp AI agent.')}
                  <span className="ml-1 text-ink-400">{t("En attente d'ouverture Meta (mur ToS Business AI).", 'Awaiting Meta rollout (Business AI ToS wall).')}</span>
                </p>
              </div>
            </div>
            <div className="mt-auto flex items-center gap-3 pt-2">
              <button
                onClick={toggleMba}
                disabled={!isAdmin || savingMba}
                title={isAdmin ? '' : t('Réservé aux admins', 'Admins only')}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${mbaEnabled ? 'bg-brand-500' : 'bg-ink-300'} ${!isAdmin ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${mbaEnabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
              <span className="text-sm font-medium text-ink-700">{mbaEnabled ? t('Activé', 'Enabled') : t('Désactivé', 'Disabled')}</span>
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

/** SDK JS Facebook (Embedded Signup). Chargé à la demande, une seule fois. */
declare global {
  interface Window {
    FB?: {
      init(opts: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
      login(cb: (resp: FbLoginResponse) => void, opts: Record<string, unknown>): void;
    };
  }
}
interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

let fbSdkLoading: Promise<void> | null = null;
function loadFbSdk(appId: string, version: string, t: (fr: string, en?: string) => string): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (fbSdkLoading) return fbSdkLoading;
  fbSdkLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if (!window.FB) { fbSdkLoading = null; reject(new Error(t('SDK Facebook indisponible', 'Facebook SDK unavailable'))); return; }
      window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version });
      resolve();
    };
    s.onerror = () => { fbSdkLoading = null; reject(new Error(t('chargement du SDK Facebook impossible (bloqueur de pub ?)', 'could not load the Facebook SDK (ad blocker?)'))); };
    document.head.appendChild(s);
  });
  return fbSdkLoading;
}

/** Attend qu'une valeur apparaisse (session info postMessage), sinon null au timeout. */
function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const v = get();
      if (v !== undefined) { clearInterval(t); resolve(v); }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(null); }
    }, 200);
  });
}

/**
 * Onboarding d'un espace SANS numéro : point d'entrée de l'**Embedded Signup Meta** (Tech Provider).
 * Le bouton ouvre la popup Meta (SDK FB + config_id) ; la popup renvoie (1) un `code` échangeable (TTL 30 s,
 * via le callback FB.login) et (2) `waba_id` + `phone_number_id` (via postMessage `WA_EMBEDDED_SIGNUP`).
 * On poste les trois au backend qui échange, rattache et abonne. Si META_ES_CONFIG_ID n'est pas posé côté
 * serveur, le bouton reste le placeholder « bientôt disponible ».
 */
function ConnectNumberZone({ tenantId, isAdmin, onConnected }: { tenantId: string; isAdmin: boolean; onConnected: () => void }) {
  const t = useT();
  const [cfg, setCfg] = useState<EsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // waba_id / phone_number_id arrivent par postMessage, PAS par le callback FB.login -> stash dans une ref.
  const idsRef = useRef<{ wabaId: string; phoneNumberId: string } | undefined>(undefined);

  useEffect(() => {
    getEsConfig(tenantId).then(setCfg).catch(() => setCfg({ enabled: false, appId: '', configId: '', graphVersion: '' }));
  }, [tenantId]);

  useEffect(() => {
    // Origine ANCRÉE sur la frontière de point : accepte www./business.facebook.com, REJETTE evilfacebook.com
    // (endsWith('facebook.com') l'aurait laissé passer -> injection d'ids forgés via postMessage).
    const FB_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*facebook\.com$/;
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);
    function onMsg(e: MessageEvent) {
      if (typeof e.origin !== 'string' || !FB_ORIGIN.test(e.origin)) return;
      // `e.data` peut être une CHAÎNE JSON (SDK) OU déjà un objet selon le canal -> on gère les deux.
      let d: { type?: string; event?: string; data?: Record<string, unknown> } & Record<string, unknown>;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data as typeof d);
      } catch { return; /* message non-JSON du SDK */ }
      if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
      // eslint-disable-next-line no-console
      console.info('[ES] message', d.event, d.data ?? d);
      // On capture les ids dès qu'ils sont présents, QUEL QUE SOIT l'event (FINISH, etc.), et qu'ils soient
      // envoyés en string OU en number (Meta n'est pas constant) -> plus de « popup n'a rien renvoyé » à tort.
      const p = (d.data ?? d) as { waba_id?: unknown; phone_number_id?: unknown };
      const wabaId = asStr(p.waba_id);
      const phoneNumberId = asStr(p.phone_number_id);
      if (wabaId && phoneNumberId) {
        idsRef.current = { wabaId, phoneNumberId };
        // eslint-disable-next-line no-console
        console.info('[ES] ids capturés', wabaId, phoneNumberId);
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  async function connect() {
    if (!cfg?.enabled || busy) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    idsRef.current = undefined;
    try {
      await loadFbSdk(cfg.appId, cfg.graphVersion, t);
      window.FB!.login(
        (resp) => {
          void (async () => {
            try {
              const code = resp?.authResponse?.code;
              if (typeof code !== 'string' || code === '') {
                setError(t('Connexion Meta annulée ou refusée.', 'Meta connection cancelled or denied.'));
                return;
              }
              // La session info (waba/numéro) peut arriver juste après le callback : on lui laisse 6 s.
              const ids = await waitFor(() => idsRef.current, 6000);
              if (!ids) {
                setError(t('La popup n’a pas renvoyé le compte WhatsApp sélectionné. Réessaie.', 'The popup did not return the selected WhatsApp account. Please try again.'));
                return;
              }
              const res = await completeEmbeddedSignup(tenantId, { code, ...ids });
              setWarnings(res.warnings ?? []);
              onConnected();
            } catch (err) {
              setError(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
            } finally {
              setBusy(false);
            }
          })();
        },
        { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
      setBusy(false);
    }
  }

  const ready = cfg?.enabled === true && isAdmin;
  return (
    <div className="rounded-2xl border border-dashed border-ink-300 bg-ink-50 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-ink-500">{t('Numéro WhatsApp', 'WhatsApp number')}</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-500">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DOT_HEX.grey }} />
          {t('Non connecté', 'Not connected')}
        </span>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink-100 text-ink-400" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold text-ink-700">{t('Connecter ton compte WhatsApp', 'Connect your WhatsApp account')}</div>
          <p className="mt-0.5 text-xs text-ink-500">
            {t("Rattache ton compte WhatsApp Business (Meta) pour activer l'envoi de messages et de campagnes. Tu choisis le business et le numéro dans la fenêtre Meta, on s'occupe du reste.", 'Link your WhatsApp Business account (Meta) to enable sending messages and campaigns. You choose the business and number in the Meta window, we handle the rest.')}
          </p>
        </div>
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {warnings.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {t('Connecté, avec avertissement', 'Connected, with warning')}{warnings.length > 1 ? 's' : ''} : {warnings.join(' · ')}
        </div>
      )}
      <div className="mt-4 flex items-center gap-3 border-t border-ink-200 pt-3">
        {ready ? (
          <button
            type="button"
            onClick={() => { void connect(); }}
            disabled={busy}
            className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
          >
            {busy ? t('Connexion en cours…', 'Connecting…') : t('Connecter mon compte WhatsApp', 'Connect my WhatsApp account')}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled
              title={isAdmin ? t('Bientôt disponible', 'Coming soon') : t('Réservé aux admins', 'Admins only')}
              className="cursor-not-allowed rounded-lg bg-ink-200 px-3 py-2 text-sm font-semibold text-ink-500"
            >
              {t('Connecter mon compte WhatsApp', 'Connect my WhatsApp account')}
            </button>
            <span className="text-xs text-ink-400">{isAdmin ? t('Disponible prochainement', 'Available soon') : t('Réservé aux admins', 'Admins only')}</span>
          </>
        )}
      </div>
    </div>
  );
}

function qualityHex(q: AccountStatusResponse['quality']): string {
  return q === 'GREEN' ? DOT_HEX.green : q === 'YELLOW' ? DOT_HEX.amber : q === 'RED' ? DOT_HEX.red : DOT_HEX.grey;
}
function qualityLabel(q: AccountStatusResponse['quality'], t: (fr: string, en?: string) => string): string {
  return q === 'GREEN' ? t('Verte', 'Green') : q === 'YELLOW' ? t('Moyenne', 'Medium') : q === 'RED' ? t('Rouge', 'Red') : t('Non évaluée', 'Not rated');
}

/** Statut du nom d'affichage (name_status Graph) -> libellé humain. */
function nameStatusLabel(s: string, t: (fr: string, en?: string) => string): string {
  const map: Record<string, string> = {
    APPROVED: t('Approuvé', 'Approved'),
    AVAILABLE_WITHOUT_REVIEW: t('Approuvé', 'Approved'),
    PENDING_REVIEW: t('En revue', 'In review'),
    PENDING: t('En revue', 'In review'),
    DECLINED: t('Refusé', 'Declined'),
    NONE: t('Aucun', 'None'),
    EXPIRED: t('Expiré', 'Expired'),
  };
  return map[s.toUpperCase()] ?? s;
}

/** Santé du WABA (health_status.can_send_message) -> libellé humain. */
function wabaHealthLabel(s: string, t: (fr: string, en?: string) => string): string {
  const map: Record<string, string> = { AVAILABLE: t('Disponible', 'Available'), LIMITED: t('Limitée', 'Limited'), BLOCKED: t('Bloquée', 'Blocked') };
  return map[s.toUpperCase()] ?? s;
}
