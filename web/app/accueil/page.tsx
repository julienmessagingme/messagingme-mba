'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RcsChannelCard, useCanalRcs } from '@/components/RcsChannelCard';
import { CanauxServices } from '@/components/CanauxServices';
import { LogoHubSpot } from '@/components/LogosCanaux';
import { Toggle } from '@/components/Toggle';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { fmtNum, fmtCost, sendingLimitLabel, mmLiteBadge, accountReviewBadge, businessVerificationBadge, type StatusBadge } from '@/lib/format';
import {
  getMe, getSettings, getAccountStatus, setHubspotConnected, disconnectHubspot, deconnecterHubspotEspace, listPhoneNumbers,
  setHubspotListsEnabled as saveHubspotListsEnabled,
  getStats, getTemplateStats, getCostSeries,
  demanderCodeNumero, activerNumero,
  type MeResponse, type AccountStatusResponse, type CanalCodeNumero,
} from '@/lib/api';
import { DOT_HEX } from '@/lib/ui';
import { PastilleNumero } from '@/components/PastilleNumero';
import { getMbaStatus, getMbaMessages, putMbaActivation, type MbaStatus } from '@/lib/api-mba';
import { ChiffreMessagesTenus } from '@/components/EnteteAgent';
import { agentMetaRepond, lireMessagesTenus, type MessagesTenus } from '@/lib/chiffres-canaux';
import { useConnexionNumero, type ConnexionNumero } from '@/lib/connexion-numero';
import { lireHubspotActif, affichageHubspotAccueil } from '@/lib/hubspot-actif';
import { useInstallationHubspot } from '@/lib/hubspot-installation';

export default function AccueilPage() {
  return <AppShell active="accueil">{(session) => <AccueilInner session={session} />}</AppShell>;
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
  currency: string | null; // devise du compte rendue par Meta ; null -> nombre nu, jamais un « € » supposé
}

function AccueilInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [account, setAccount] = useState<AccountStatusResponse | null>(null);
  const [mbaEnabled, setMbaEnabled] = useState(false);
  /**
   * Les avertissements rendus par la connexion du numéro, gardés AU NIVEAU DE LA PAGE.
   *
   * 🔴 ILS VIVAIENT DANS `ConnectNumberZone`, ET ILS DISPARAISSAIENT À L'INSTANT OÙ ILS ARRIVAIENT. La zone
   * de connexion ne s'affiche que tant que l'espace n'a pas de numéro : dès que la connexion aboutit, elle
   * est remplacée par la carte du numéro, et le message part avec elle. Le 2026-09-22 au soir, c'est
   * exactement comme ça qu'un enregistrement raté est passé inaperçu, et la cause a failli être perdue.
   */
  const [avertissementsConnexion, setAvertissementsConnexion] = useState<string[]>([]);
  /**
   * L'etat REEL de l'agent chez Meta, par opposition a `mbaEnabled` qui n'est que NOTRE drapeau.
   *
   * 🔴 CETTE DISTINCTION EST TOUT LE CORRECTIF DU 2026-09-10. La carte affichait `mbaEnabled` sous le titre
   * « Meta Business Agent », a cote d'une phrase ECRITE EN DUR annoncant qu'on attendait l'ouverture de
   * Meta. Les deux etaient faux le meme jour : l'agent tournait chez Meta en `EVERYONE` depuis des jours,
   * et Julien a bascule ce bouton en croyant l'eteindre. Il a eteint notre drapeau, qui ne commande que le
   * bloc MBA du constructeur de scenario. `null` = pas encore lu, ou lecture impossible.
   */
  const [mbaReel, setMbaReel] = useState<MbaStatus | null>(null);
  const [savingMba, setSavingMba] = useState(false);
  const [erreurMba, setErreurMba] = useState<string | null>(null);
  const [savingHubspot, setSavingHubspot] = useState(false);
  // Dialogue Pause vs Déconnexion complète (candidat 2), ouvert au clic « couper ». Nombre de numéros du tenant :
  // sert à AVERTIR que la déconnexion (tenant-wide, le portail est lié par tenant) coupe TOUS les numéros.
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [numbersCount, setNumbersCount] = useState(1);
  // Vrai brièvement après une REPRISE de pause : les analyses accumulées sont rattrapées côté worker (F3-a).
  const [catchupNotice, setCatchupNotice] = useState(false);
  const [hubspotListsEnabled, setHubspotListsEnabled] = useState(false);
  /**
   * L'interrupteur HubSpot de l'espace (Paramètres > Intégrations, migration 0179). `undefined` = pas lu, ou
   * API plus ancienne : le bloc garde alors le comportement d'avant (`affichageHubspotAccueil`).
   */
  const [hubspotActif, setHubspotActif] = useState<boolean | undefined>(undefined);
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
      setHubspotActif(lireHubspotActif(cfg.value));
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
      setKpis({ contacts, exchanged, templates, cost: cost.total, hasRates: cost.hasRates, currency: cost.currency });
    } catch {
      // Silencieux : les KPIs sont un plus, pas un bloquant. On laisse la rangée en « — ».
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
    void loadAccount();
    void loadKpis();
  }, [load, loadAccount, loadKpis]);

  /**
   * Allume ou eteint l'agent, CHEZ META quand c'est possible, et pas seulement chez nous.
   *
   * 🔴 AVANT LE 2026-09-10, CE BOUTON N'ECRIVAIT QUE `mbaEnabled`, notre drapeau local. Un utilisateur qui
   * le baissait croyait couper l'agent ; il ne coupait rien du tout, et Meta continuait de repondre a ses
   * clients. C'est arrive a Julien sur son propre numero. Un interrupteur qui n'interrompt pas est pire
   * qu'une absence d'interrupteur : il fait croire que la question est reglee.
   *
   * ⚠️ L'ORDRE COMPTE : Meta d'abord, notre drapeau ensuite. Si l'appel a Meta echoue (numero non eligible,
   * jeton expire, agent jamais cree), on ne touche a rien et on le DIT. L'inverse laisserait notre drapeau
   * annoncer un etat que Meta n'a pas.
   *
   * ⚠️ Quand le numero n'est pas eligible, le bouton ne pilote QUE notre drapeau, qui garde son sens propre :
   * il ouvre le bloc MBA du constructeur de scenario pour preparer les parcours avant l'ouverture de Meta.
   */
  /**
   * L'etat REEL de l'agent chez Meta, relu des que le numero du compte est connu.
   *
   * ⚠️ SEPARE DE `load()` : le numero ne vient pas du profil mais de l'etat du compte, qui se charge par un
   * autre chemin. Le lire dans `load()` aurait marche une fois sur deux, selon l'ordre d'arrivee des deux
   * reponses, ce qui est exactement le genre de dependance qui rend un ecran « parfois juste ».
   *
   * Best-effort : cet appel depend d'un jeton valide et d'un aller-retour chez Meta. Un echec laisse
   * `null`, et la carte dit « non lu » plutot que d'inventer un etat.
   */
  useEffect(() => {
    const pn = account?.phoneNumberId;
    if (!pn) { setMbaReel(null); return; }
    let vivant = true;
    getMbaStatus(session.tenantId, pn)
      .then((s) => { if (vivant) setMbaReel(s); })
      .catch(() => { if (vivant) setMbaReel(null); });
    return () => { vivant = false; };
  }, [session.tenantId, account?.phoneNumberId]);

  /**
   * Les messages échangés dans les conversations de l'agent de Meta, sous son cadre (Julien, 2026-09-25). LA MÊME
   * mesure que l'en-tête de MBA > Paramètres (`getMbaMessages`), avec la même légende (`ChiffreMessagesTenus`).
   *
   * 🔴 LUE SEULEMENT QUAND META DIT QUE L'AGENT RÉPOND (`agentMetaRepond(mbaReel)`), jamais sur notre drapeau
   * `mbaEnabled`. La dépendance est ce BOOLÉEN et pas l'objet `mbaReel`, recréé à chaque relecture du statut.
   * ⚠️ `null` = on ne sait pas (lecture en cours, route pas encore déployée, compte non administrateur, dépendance
   * non câblée côté serveur) : rien ne s'affiche, jamais un zéro.
   */
  const mbaRepond = agentMetaRepond(mbaReel);
  const [messagesMba, setMessagesMba] = useState<MessagesTenus | null>(null);
  useEffect(() => {
    const pn = account?.phoneNumberId;
    if (!pn || !mbaRepond) { setMessagesMba(null); return; }
    let vivant = true;
    getMbaMessages(session.tenantId, pn)
      .then((r) => { if (vivant) setMessagesMba(lireMessagesTenus(r)); })
      .catch(() => { if (vivant) setMessagesMba(null); });
    return () => { vivant = false; };
  }, [session.tenantId, account?.phoneNumberId, mbaRepond]);

  /**
   * Allumer ou éteindre l'agent de Meta. UN appel, décidé côté SERVEUR.
   *
   * 🔴 CE BOUTON A CASSÉ TROIS FOIS LE 2026-09-10, ET TOUJOURS DE LA MÊME FAÇON : il n'échouait pas, il
   * SAUTAIT l'appel à Meta et écrivait notre drapeau quand même. L'écran annonçait « désactivé » pendant que
   * l'agent de Meta répondait aux clients. Le matin il n'appelait Meta nulle part ; corrigé, il ne l'appelait
   * que si l'état Meta était déjà lu ; corrigé, il ne l'appelait que si le NUMÉRO était déjà chargé.
   *
   * Le défaut n'était aucune de ces trois lignes : c'était de laisser CE COMPOSANT arbitrer avec une
   * connaissance partielle. Il ne reste ici aucune condition sur un état à moitié chargé, aucune écriture
   * optimiste à défaire : on envoie une intention, on affiche ce que le serveur a réellement fait.
   */
  async function toggleMba() {
    if (!isAdmin) return;
    setSavingMba(true);
    setErreurMba(null);
    try {
      const r = await putMbaActivation(session.tenantId, !mbaEnabled);
      setMbaEnabled(r.enabled);
      // Relire l'état chez Meta pour que la phrase de la carte dise la vérité tout de suite. Best-effort :
      // l'action a déjà abouti, un échec de relecture ne doit pas la faire passer pour ratée.
      if (r.phoneNumberId) {
        getMbaStatus(session.tenantId, r.phoneNumberId).then(setMbaReel).catch(() => {});
      }
      // ⚠️ On DIT quand le geste n'a porté que de notre côté, au lieu de laisser croire qu'il a tout fait.
      if (r.chezMeta === 'non_eligible') {
        setErreurMba(t(
          'Réglage enregistré de notre côté. Meta n’a pas encore ouvert l’agent sur ce numéro, il n’y avait rien à y changer.',
          'Saved on our side. Meta has not opened the agent on this number yet, there was nothing to change there.',
        ));
      } else if (r.chezMeta === 'aucun_numero') {
        setErreurMba(t(
          'Réglage enregistré. Aucun numéro connecté, donc aucun agent Meta à piloter.',
          'Saved. No number connected, so no Meta agent to drive.',
        ));
      }
    } catch (e) {
      // Rien n'a été écrit, ni chez Meta ni chez nous : le serveur refuse d'agir sur une incertitude. Le
      // bouton reste donc sur son état d'avant, qui est le vrai.
      setErreurMba(e instanceof Error ? e.message : t('Le changement n’a pas pu être appliqué.', 'The change could not be applied.'));
    } finally {
      setSavingMba(false);
    }
  }

  // Nombre de numéros du tenant : sert à avertir dans le dialogue de déconnexion (tenant-wide). Admin only, best-effort
  // (un échec laisse le défaut 1 -> pas de faux avertissement).
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    listPhoneNumbers(session.tenantId).then((r) => { if (alive) setNumbersCount(r.phoneNumbers.length); }).catch(() => {});
    return () => { alive = false; };
  }, [isAdmin, session.tenantId]);

  // PAUSE / REPRISE (F3-a). `next=false` -> pause (paused_at posé) ; `next=true` -> reprise (paused_at effacé + rattrapage).
  async function applyHubspotState(next: boolean) {
    if (!isAdmin || !account?.phoneNumberId) return;
    const prev = { hubspotConnected: account.hubspotConnected, hubspotPausedAt: account.hubspotPausedAt };
    setSavingHubspot(true);
    setCatchupNotice(false);
    setAccount((a) => (a ? { ...a, hubspotConnected: next, hubspotPausedAt: next ? null : new Date().toISOString() } : a));
    try {
      const res = await setHubspotConnected(session.tenantId, account.phoneNumberId, next);
      if (res.catchupTriggered) setCatchupNotice(true); // reprise après pause -> rattrapage en cours
    } catch {
      setAccount((a) => (a ? { ...a, ...prev } : a)); // rollback (statut + pause)
    } finally {
      setSavingHubspot(false);
    }
  }

  // DÉCONNEXION COMPLÈTE (candidat 2) : délie le portail (le connecteur révoque le token si dernier tenant) et coupe
  // la synchro. Optimiste : coupé SANS pause (paused_at=null -> libellé « coupée », pas « en pause »).
  async function disconnectHubspotAction() {
    // ⚠️ PLUS DE NUMÉRO EXIGÉ (2026-09-25) : un espace sans numéro peut relier un portail depuis que
    // l'interrupteur existe, et doit pouvoir le délier. Il passe par la porte de l'ESPACE.
    if (!isAdmin || !account) return;
    // Capture COMPLÈTE pour le rollback, y compris le portail (une déconnexion délie le portail côté serveur).
    const prev = { hubspotConnected: account.hubspotConnected, hubspotPausedAt: account.hubspotPausedAt, hubspotPortal: account.hubspotPortal };
    setSavingHubspot(true);
    setCatchupNotice(false);
    // Optimiste : coupé (paused_at null -> « coupée », pas « en pause ») ET portail DÉLIÉ. Passer hubspotPortal à
    // {connected:false} fait basculer l'UI vers « Connecter HubSpot » et masque le bloc synchro : plus de toggle
    // fantôme qui reposerait hubspot_connected=true alors qu'aucun portail n'est lié (état orphelin).
    setAccount((a) => (a ? { ...a, hubspotConnected: false, hubspotPausedAt: null, hubspotPortal: { connected: false } } : a));
    try {
      if (account.phoneNumberId) await disconnectHubspot(session.tenantId, account.phoneNumberId);
      else await deconnecterHubspotEspace(session.tenantId);
    } catch {
      setAccount((a) => (a ? { ...a, ...prev } : a)); // rollback complet : le connecteur a échoué, rien n'a été délié côté serveur
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

  // Ouvre le lien d'install/re-consentement HubSpot : le MÊME geste que la carte de Paramètres > Intégrations.
  const { ouvrir: openHubspotInstall, enCours: installPending } = useInstallationHubspot(session.tenantId, isAdmin);

  /**
   * La connexion d'un numéro et le canal RCS, créés UNE fois ici et partagés par leur carte ET par
   * l'interrupteur du bloc « Canaux et services » : deux instances liraient deux états, et couper depuis
   * l'interrupteur laisserait la carte annoncer l'inverse.
   */
  const connexionNumero = useConnexionNumero(session.tenantId, (avertissements) => {
    setAvertissementsConnexion(avertissements);
    setLoading(true);
    void load();
    void loadAccount();
  });
  const rcs = useCanalRcs(session.tenantId);
  const affichageHubspot = account
    ? affichageHubspotAccueil({ actif: hubspotActif, aUnNumero: account.hasNumber, portailRelie: account.hubspotPortal?.connected === true })
    : 'rien';

  const firstName = firstNameOf(me);
  const kpiRow = useMemo(
    () => [
      { label: t('Contacts', 'Contacts'), value: kpis ? fmtNum(kpis.contacts, locale) : '—' },
      { label: t('Messages échangés', 'Messages exchanged'), value: kpis ? fmtNum(kpis.exchanged, locale) : '—' },
      { label: t('Templates envoyés', 'Templates sent'), value: kpis ? fmtNum(kpis.templates, locale) : '—' },
      { label: t('Coût estimé', 'Estimated cost'), value: kpis ? (kpis.hasRates ? fmtCost(kpis.cost, locale, kpis.currency) : '—') : '—' },
    ],
    [kpis, t, locale],
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">
          {t('Bonjour', 'Hello')}{firstName ? ` ${firstName}` : ''}
        </h2>
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

      {/* 🔴 CANAUX ET SERVICES (plan du 2026-09-25) : un interrupteur par canal ou service, au même endroit.
          Admin seulement : tous ses gestes le sont côté serveur, et deux de ses lectures aussi. */}
      {isAdmin && (
        <CanauxServices
          tenantId={session.tenantId}
          compte={accountLoading ? null : account}
          compteEnEchec={!accountLoading && accountError !== null}
          onNumeroChange={() => { void loadAccount(); }}
          connexionNumero={connexionNumero}
          rcs={rcs}
          hubspotActif={hubspotActif}
          onHubspotActif={setHubspotActif}
        />
      )}

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Carte Meta Business Agent, remontée en tête du dashboard, avec la reprise après opérateur juste
              en dessous du toggle (demande fondateur : les deux gouvernent qui répond au client).
              ⚠️ ENVELOPPÉE depuis le 2026-09-25, pour porter le chiffre de ses conversations SOUS le cadre : la
              carte garde `flex-1`, donc elle s'étire encore jusqu'au bas de la rangée quand le chiffre manque. */}
          <div className="flex flex-col gap-3">
            <div data-testid="settings-card" className="flex flex-1 flex-col rounded-2xl border border-ink-200 bg-gradient-to-br from-white to-navy-50 p-5 shadow-sm">
              <div className="mb-3 flex items-start gap-3">
                {/* Logo Meta Business Agent (produit Meta), et non notre logo MM : cette carte parle du MBA de Meta. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/meta-business-agent.png" alt="Meta Business Agent" className="h-10 w-10 shrink-0 rounded-lg object-contain" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold tracking-tight text-ink-900">Meta Business Agent</div>
                  {/* 🔴 CE QUE META DIT, PAS CE QU'ON SUPPOSE. La phrase « En attente d'ouverture Meta » etait
                      ECRITE EN DUR ici : elle ne mesurait rien, et elle est restee affichee des semaines
                      apres que le numero soit devenu eligible. Elle ne s'affiche plus que quand elle est
                      VRAIE, c'est-a-dire quand Meta repond `is_eligible: false`. */}
                  <p className="mt-0.5 text-xs text-ink-500" data-testid="mba-etat-reel">
                    {mbaReel === null
                      ? t('État chez Meta : non lu pour l’instant.', 'State at Meta: not read yet.')
                      : !mbaReel.eligible
                        ? t("Meta n'a pas encore ouvert l'agent sur ce numéro. Le bouton prépare le bloc MBA des scénarios en attendant.", 'Meta has not opened the agent on this number yet. The switch prepares the MBA block in scenarios meanwhile.')
                        : mbaReel.settings?.rollout?.enabled
                          ? t(
                            `L'agent de Meta RÉPOND en ce moment, à ${mbaReel.settings?.ai_audience === 'ALLOWLISTED_ONLY' ? 'la liste autorisée' : 'tout le monde'}. Il répond avant nos scénarios.`,
                            `Meta's agent IS ANSWERING right now, to ${mbaReel.settings?.ai_audience === 'ALLOWLISTED_ONLY' ? 'the allowlist' : 'everyone'}. It answers before our scenarios.`,
                          )
                          : t("Éligible, agent éteint chez Meta. Personne ne répond automatiquement.", 'Eligible, agent off at Meta. Nobody answers automatically.')}
                  </p>
                  {erreurMba && <p className="mt-1 text-xs text-coral" data-testid="mba-erreur">{erreurMba}</p>}
                </div>
              </div>
              <div className="flex items-center gap-3 pt-2">
                <Toggle
                  testid="mba-toggle"
                  checked={mbaEnabled}
                  onChange={toggleMba}
                  disabled={!isAdmin || savingMba}
                  title={isAdmin ? '' : t('Réservé aux admins', 'Admins only')}
                />
                <span className="text-sm font-medium text-ink-700">{mbaEnabled ? t('Activé', 'Enabled') : t('Désactivé', 'Disabled')}</span>
                {/* ⚠️ DIRE CE QUE LE BOUTON PILOTE. Tant que Meta n'a pas ouvert, il ne commande que notre
                    cote, et se taire la-dessus est exactement ce qui a fait croire a une coupure. */}
                {mbaReel !== null && !mbaReel.eligible && (
                  <span className="text-xs text-ink-400">{t('(côté Engage Me seulement)', '(Engage Me side only)')}</span>
                )}
              </div>
              {/* La reprise après intervention d'un opérateur vivait ICI. Elle a rejoint MBA > Paramètres >
                  Activation, avec le passage de main : ce sont les deux faces d'une même question, « qui parle
                  au client », et les séparer obligeait à comprendre deux écrans pour régler une seule chose. */}
              {account?.hasNumber && (
                <div className="mt-4 border-t border-ink-100 pt-3">
                  <Link href="/mba/parametres?tab=activation" className="text-sm font-medium text-brand-600 underline" data-testid="lien-activation">
                    {t('Régler qui répond au client', 'Set who answers the customer')}
                  </Link>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {t(
                      'Le passage de main vers un humain, et combien de temps un opérateur garde la conversation.',
                      'Handover to a human, and how long an operator keeps the conversation.',
                    )}
                  </p>
                </div>
              )}
            </div>
            {/* 🔴 `messagesMba !== null`, JAMAIS `?? 0` : un zéro dirait que l'agent n'a parlé à personne. */}
            {messagesMba !== null && (
              <div data-testid="mba-messages" className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
                <ChiffreMessagesTenus {...messagesMba} />
              </div>
            )}
          </div>

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
            <ConnectNumberZone isAdmin={isAdmin} connexion={connexionNumero} />
          ) : (
            <div data-testid="numero-card" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Numéro WhatsApp', 'WhatsApp number')}</h3>
                {account && <PastilleNumero status={account.status} />}
              </div>
              <div className="flex items-center gap-3">
                {/**
                  * La pastille du numéro, telle que Meta la montre dans le Business Manager et telle que la
                  * voient les destinataires (demande de Julien, 2026-09-08).
                  *
                  * ⚠️ ELLE MANQUE SOUVENT, et ce n'est pas une panne : un numéro sans photo de profil est le
                  * cas ordinaire tant que personne n'en a posé une (les deux numéros du parc étaient dans ce
                  * cas le 2026-09-08). On n'affiche alors RIEN, pas un cadre vide ni une icône grise qui
                  * ferait croire à un chargement en échec.
                  */}
                {account?.photoProfilUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element -- l'URL est SIGNÉE par Meta et
                     expire : le composant Image de Next optimiserait et cacherait une adresse éphémère. */
                  <img
                    src={account.photoProfilUrl}
                    alt=""
                    data-testid="numero-pastille"
                    className="h-10 w-10 shrink-0 rounded-full border border-ink-200 object-cover"
                  />
                )}
                <div>
                  <div className="font-mono text-lg font-semibold text-ink-900">
                    {account?.number ? (account.number.startsWith('+') ? account.number : `+${account.number}`) : t('Aucun numéro', 'No number')}
                  </div>
                  {account?.verifiedName && <div className="mt-0.5 text-xs text-ink-500">{account.verifiedName}</div>}
                </div>
              </div>
              {account && <p className="mt-1 text-xs text-ink-500">{account.status.reason}</p>}
              {/* Les avertissements de la connexion, montrés ICI parce que la zone qui les recevait est
                  démontée au moment où ils arrivent. Sans ça, un enregistrement raté ne laisse aucune trace
                  à l'écran (2026-09-22). */}
              {avertissementsConnexion.length > 0 && (
                <div data-testid="avertissements-connexion" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {t('Connecté, avec avertissement', 'Connected, with warning')}{avertissementsConnexion.length > 1 ? 's' : ''} : {avertissementsConnexion.join(' · ')}
                </div>
              )}
              {/* ⚠️ `numberStatus !== null` AVANT tout : un statut qu'on n'a pas pu lire n'est pas un numéro
                  inactif. Affirmer une panne qu'on n'a pas constatée est le défaut que la cascade au-dessus
                  corrige déjà pour « Aucun numéro ». */}
              {account?.hasNumber && account.numberStatus !== null && account.numberStatus !== 'CONNECTED' && (
                <ActiverNumeroZone
                  tenantId={session.tenantId}
                  isAdmin={isAdmin}
                  verifie={account.codeVerificationStatus === 'VERIFIED'}
                  onActive={() => { setAvertissementsConnexion([]); setLoading(true); void load(); void loadAccount(); }}
                />
              )}
              {account?.hasNumber && (
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-ink-100 pt-3 text-xs">
                  <div>
                    <div className="font-medium uppercase tracking-wide text-ink-400">{t('Qualité', 'Quality')}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: qualityHex(account.quality) }} />
                      {qualityLabel(account.quality, t)}
                    </div>
                  </div>
                  {/* Cap d'envoi 24 h TOUJOURS affiché (le vrai plafond métier). Le débit brut 80 msg/s, identique
                      pour tous, a été retiré. Repli honnête si Meta n'a pas encore évalué le palier. */}
                  <Field label={t("Cap d'envoi 24 h", 'Sending limit /24h')} value={sendingLimitLabel(account.tier, locale)} />
                  {account.nameStatus && <Field label={t('Nom', 'Name')} value={nameStatusLabel(account.nameStatus, t)} />}
                  {account.wabaHealthStatus && <Field label={t('Santé du compte', 'Account health')} value={wabaHealthLabel(account.wabaHealthStatus, t)} />}
                </div>
              )}
              {/* Statut du compte WhatsApp Business : MM Lite (demande fondateur), revue Meta, vérification
                  d'entreprise, business propriétaire, et renvoi HONNÊTE vers le Business Manager pour le moyen
                  de paiement (non lisible via l'API WhatsApp avec notre token). */}
              {account?.hasNumber && (
                <div data-testid="waba-status-panel" className="mt-4 border-t border-ink-100 pt-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">{t('Compte WhatsApp Business', 'WhatsApp Business account')}</div>
                  <div className="flex flex-wrap gap-x-8 gap-y-3 text-xs">
                    <BadgeField label={t('API MM Lite', 'MM Lite API')} badge={mmLiteBadge(account.marketingMessagesLiteApiStatus, locale)} />
                    <BadgeField label={t('Revue du compte', 'Account review')} badge={accountReviewBadge(account.accountReviewStatus, locale)} />
                    <BadgeField label={t("Vérification d'entreprise", 'Business verification')} badge={businessVerificationBadge(account.businessVerificationStatus, locale)} />
                    {account.ownerBusinessName && <Field label={t('Business', 'Business')} value={account.ownerBusinessName} />}
                  </div>
                  <p className="mt-3 text-xs text-ink-500">
                    {t('Moyen de paiement : à vérifier dans le', 'Payment method: check it in the')}{' '}
                    <a
                      href="https://business.facebook.com/billing_hub/accounts"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-brand-700 underline"
                    >
                      {t('Business Manager Meta', 'Meta Business Manager')}
                    </a>
                    {t(" (non exposé par l'API WhatsApp).", ' (not exposed by the WhatsApp API).')}
                  </p>
                </div>
              )}
            </div>
          )}


          {/* Canal RCS : juste sous la carte du numéro WhatsApp, parce que c'est la même question posée à
              l'opérateur (« par où je parle à mes clients ? »). Le RCS n'a pas de numéro, il a un AGENT :
              l'activation demande donc la clé du canal, pas un raccordement de ligne. */}
          <RcsChannelCard rcs={rcs} isAdmin={isAdmin} />

          {/* HubSpot : carte SÉPARÉE, sous le bloc MBA. Elle vivait imbriquée dans la carte du numéro, où
              elle passait inaperçue alors qu'elle gouverne une intégration entière. La grille fait 2 colonnes :
              placé en 3e position, ce bloc retombe sous le MBA.
              🔴 DEPUIS LE 2026-09-25, C'EST L'INTERRUPTEUR DE PARAMÈTRES > INTÉGRATIONS QUI LE FAIT APPARAÎTRE, plus
              la présence d'un numéro : un espace neuf doit pouvoir connecter HubSpot avant d'avoir un numéro. La
              règle, et ses trois cas, vivent dans `affichageHubspotAccueil`. */}
          {!accountLoading && !accountError && account && affichageHubspot === 'bloc' && (
            <div data-testid="hubspot-card" className="flex flex-col rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold tracking-tight text-ink-900">HubSpot</h3>
              {account.hubspotPortal?.connected && (
                // Portail relié : on affiche SUR QUEL portail, puis le toggle de synchro PAR numéro (qui gate le push).
                <div className="mt-4 border-t border-ink-100 pt-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                    <LogoHubSpot className="h-[18px] w-[18px] shrink-0" />
                    <span>
                      {t('HubSpot : connecté au portail', 'HubSpot: connected to portal')}{' '}
                      <span className="font-mono text-brand-700">{account.hubspotPortal.hubDomain ?? account.hubspotPortal.hubId}</span>
                    </span>
                  </div>
                  <a href="/tuto-hubspot" target="_blank" rel="noopener noreferrer" data-testid="hubspot-tuto-link" className="mt-1 inline-block text-xs text-brand-600 hover:underline">
                    {t('Comment afficher les analyses dans HubSpot ? (tuto)', 'How to show analyses in HubSpot? (guide)')}
                  </a>
                  {/* La synchro se règle PAR NUMÉRO : sans numéro, pas de toggle, mais la déconnexion complète
                      (tenant-wide) reste offerte, sans quoi l'interrupteur de Paramètres ne pourrait jamais s'éteindre. */}
                  {!account.hasNumber && isAdmin && (
                    <button
                      type="button"
                      data-testid="hubspot-deconnexion-espace"
                      onClick={() => setShowDisconnect(true)}
                      disabled={savingHubspot}
                      className="mt-2 rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-60"
                    >
                      {t('Déconnexion complète', 'Full disconnect')}
                    </button>
                  )}
                  {account.hasNumber && (
                  <div className="mt-2 flex items-center justify-between">
                    <div className="min-w-0">
                      <div data-testid="hubspot-sync-state" className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: account.hubspotConnected ? DOT_HEX.green : account.hubspotPausedAt ? DOT_HEX.amber : DOT_HEX.grey }}
                        />
                        {account.hubspotConnected
                          ? t('Synchronisation activée', 'Sync enabled')
                          : account.hubspotPausedAt
                            ? t('Synchronisation en pause', 'Sync paused')
                            : t('Synchronisation coupée', 'Sync disabled')}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {account.hubspotConnected
                          ? t('Les analyses de conversation sont synchronisées vers HubSpot.', 'Conversation analyses are synced to HubSpot.')
                          : account.hubspotPausedAt
                            ? t('En pause : les analyses produites pendant la pause seront renvoyées à HubSpot à la reprise.', 'Paused: analyses produced during the pause will be resent to HubSpot when you resume.')
                            : t('La synchronisation vers HubSpot est coupée pour ce numéro.', 'Sync to HubSpot is disabled for this number.')}
                      </p>
                      {catchupNotice && (
                        <p data-testid="hubspot-catchup-notice" className="mt-1 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs text-brand-700">
                          {t('Rattrapage en cours : les analyses accumulées pendant la pause sont renvoyées vers HubSpot.', 'Catching up: analyses accumulated during the pause are being resent to HubSpot.')}
                        </p>
                      )}
                    </div>
                    {isAdmin && account.phoneNumberId && (
                      <Toggle
                        testid="hubspot-sync-toggle"
                        checked={account.hubspotConnected}
                        onChange={() => (account.hubspotConnected ? setShowDisconnect(true) : void applyHubspotState(true))}
                        disabled={savingHubspot}
                        title={t('Activer/couper la synchro HubSpot', 'Enable/disable HubSpot sync')}
                      />
                    )}
                  </div>
                  )}

                  {/* Dialogue Pause vs Déconnexion complète (candidat 2), ouvert au clic « couper ». Tailwind pur, accessible
                      (role=dialog, aria-modal, fermeture Escape + clic hors carte). Deux issues : pause réversible (F3-a) ou
                      déconnexion complète (délie le portail + révoque le token côté connecteur). Sans numéro, la pause
                      (qui se règle par numéro) n'est pas offerte : seule reste la déconnexion. */}
                  {showDisconnect && (
                    <div
                      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 px-4"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="hubspot-disconnect-title"
                      data-testid="hubspot-disconnect-dialog"
                      onClick={() => setShowDisconnect(false)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setShowDisconnect(false); }}
                    >
                      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
                        <h3 id="hubspot-disconnect-title" className="text-base font-semibold tracking-tight text-ink-900">
                          {account.phoneNumberId
                            ? t('Couper la synchronisation HubSpot', 'Turn off HubSpot sync')
                            : t('Déconnecter HubSpot', 'Disconnect HubSpot')}
                        </h3>
                        {account.phoneNumberId && (
                          <p className="mt-1 text-sm text-ink-600">
                            {t('Mettre en pause : réversible. À la reprise, les analyses produites pendant la pause sont renvoyées à HubSpot.', 'Pause: reversible. On resume, analyses produced during the pause are resent to HubSpot.')}
                          </p>
                        )}
                        <p className="mt-2 text-sm text-ink-600">
                          {t('Déconnexion complète : délie votre compte HubSpot et révoque son accès. Il faudra le reconnecter pour réactiver.', 'Full disconnect: unlinks your HubSpot account and revokes its access. You will need to reconnect it to re-enable.')}
                        </p>
                        {numbersCount > 1 && (
                          <p data-testid="hubspot-disconnect-multi-warning" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            {t('Attention : la déconnexion coupe HubSpot pour TOUS vos numéros (le compte HubSpot est lié à votre espace, pas à un numéro).', 'Warning: disconnecting turns off HubSpot for ALL your numbers (the HubSpot account is linked to your workspace, not to a single number).')}
                          </p>
                        )}
                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <button
                            onClick={() => setShowDisconnect(false)}
                            className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                          >
                            {t('Annuler', 'Cancel')}
                          </button>
                          {account.phoneNumberId && (
                            <button
                              data-testid="hubspot-pause-btn"
                              onClick={() => { setShowDisconnect(false); void applyHubspotState(false); }}
                              className="rounded-lg bg-ink-100 px-3 py-2 text-sm font-semibold text-ink-800 transition hover:bg-ink-200"
                            >
                              {t('Mettre en pause', 'Pause')}
                            </button>
                          )}
                          <button
                            data-testid="hubspot-disconnect-btn"
                            onClick={() => { setShowDisconnect(false); void disconnectHubspotAction(); }}
                            className="rounded-lg bg-red-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-600"
                          >
                            {t('Déconnexion complète', 'Full disconnect')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Toggle « Campagnes via données HubSpot » : autorise l'import de listes HubSpot comme destinataires. */}
                  <div className="mt-3 border-t border-ink-50 pt-3">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink-800">{t('Campagnes via données HubSpot', 'Campaigns from HubSpot data')}</div>
                        <p className="mt-0.5 text-xs text-ink-500">{t('Importe une liste HubSpot comme destinataires de campagne.', 'Import a HubSpot list as campaign recipients.')}</p>
                      </div>
                      {isAdmin && (
                        <Toggle
                          checked={hubspotListsEnabled}
                          onChange={toggleHubspotLists}
                          disabled={savingLists}
                          title={t("Activer/désactiver l'import de listes HubSpot", 'Enable/disable HubSpot list import')}
                        />
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
              {account.hubspotPortal && !account.hubspotPortal.connected && (
                // Aucun portail relié : on ne montre PAS le toggle par numéro (pousser sans portail ne fait rien).
                // Le CTA lance l'install OAuth du connecteur en liant CE tenant (admin uniquement).
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-100 pt-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                      <LogoHubSpot className="h-[18px] w-[18px] shrink-0" />
                      {t('HubSpot non connecté', 'HubSpot not connected')}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {t("Aucun portail HubSpot n'est relié à ce compte. Connecte-le pour synchroniser les analyses de conversation.", 'No HubSpot portal is linked to this account. Connect it to sync conversation analyses.')}
                    </p>
                    <a href="/tuto-hubspot" target="_blank" rel="noopener noreferrer" data-testid="hubspot-tuto-link-cta" className="mt-1 inline-block text-xs text-brand-600 hover:underline">
                      {t('Quoi faire dans HubSpot après la connexion ? (tuto)', 'What to do in HubSpot after connecting? (guide)')}
                    </a>
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
          {/* Interrupteur éteint, aucun portail : une ligne DISCRÈTE, pas une carte. Elle dit où l'allumer. */}
          {!accountLoading && !accountError && affichageHubspot === 'renvoi' && (
            <p data-testid="hubspot-renvoi" className="text-xs text-ink-500 lg:col-span-2">
              {t('HubSpot est éteint pour cet espace.', 'HubSpot is off for this workspace.')}{' '}
              <Link href="/parametres#integration-hubspot" data-testid="hubspot-renvoi-lien" className="text-brand-600 hover:underline">
                {t('L’allumer dans Paramètres > Intégrations', 'Turn it on in Settings > Integrations')}
              </Link>
            </p>
          )}
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

/** Champ étiquette + pastille colorée selon le `tone` du badge (ok=vert, warn=ambre, unknown=gris). */
function BadgeField({ label, badge }: { label: string; badge: StatusBadge }) {
  const hex = badge.tone === 'ok' ? DOT_HEX.green : badge.tone === 'warn' ? DOT_HEX.amber : DOT_HEX.grey;
  return (
    <div>
      <div className="font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: hex }} />
        {badge.label}
      </div>
    </div>
  );
}

// Le SDK Facebook vit dans `@/lib/fb-sdk` depuis le 2026-09-23 : l'écran des publicités ouvre lui aussi
// une fenêtre Meta, et `fbSdkLoading` est un singleton de module qu'on ne peut pas dupliquer.

/**
 * Onboarding d'un espace SANS numéro : le bouton ouvre la fenêtre Meta (Embedded Signup).
 *
 * ⚠️ LA MÉCANIQUE A QUITTÉ CE COMPOSANT (2026-09-25) pour `useConnexionNumero` (`@/lib/connexion-numero`),
 * créé une fois par l'Accueil : l'interrupteur « Numéro WhatsApp » du bloc « Canaux et services » lance la même
 * connexion, et deux copies auraient été deux fenêtres Meta à tenir alignées. Si META_ES_CONFIG_ID n'est pas posé
 * côté serveur, le bouton reste le placeholder « bientôt disponible ».
 */
function ConnectNumberZone({ isAdmin, connexion }: { isAdmin: boolean; connexion: ConnexionNumero }) {
  const t = useT();
  const { cfg, busy, error, connect } = connexion;
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

/**
 * « Activer le numéro » : finir dans la console ce que la fenêtre Meta a laissé en plan.
 *
 * 🔴 POURQUOI CET ÉCRAN EXISTE. Depuis la v4 de l'inscription, un client peut terminer le parcours Meta avec
 * un numéro NON vérifié. Meta affiche pourtant « Your account is connected », et le numéro reste incapable
 * d'envoyer. Le 2026-09-22 au soir, il a fallu passer par WhatsApp Manager pour le débloquer : un client,
 * lui, n'aurait eu aucun recours.
 *
 * 🔴 AUCUNE RELANCE AUTOMATIQUE, et ce n'est pas un raccourci (décision de Julien, 2026-09-22). Meta ne
 * permet que DIX requêtes par numéro sur 72 heures, toutes étapes confondues ; au-delà, le numéro est bloqué
 * trois jours. Un écran qui réessaierait tout seul brûlerait ce quota sans que personne ne le voie. Tout part
 * d'un clic, et un échec laisse le numéro « à activer », visible.
 */
function ActiverNumeroZone({ tenantId, isAdmin, verifie, onActive }: { tenantId: string; isAdmin: boolean; verifie: boolean; onActive: () => void }) {
  const t = useT();
  const [canal, setCanal] = useState<CanalCodeNumero>('VOICE');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function envoyerCode() {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    setInfo(null);
    try {
      await demanderCodeNumero(tenantId, canal);
      setInfo(canal === 'VOICE'
        ? t('Meta appelle le numéro et dicte le code. Saisis-le ci-dessous.', 'Meta is calling the number and will read out the code. Enter it below.')
        : t('Meta envoie le code par SMS. Saisis-le ci-dessous.', 'Meta is sending the code by SMS. Enter it below.'));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Envoi du code impossible', 'Could not send the code'));
    } finally {
      setBusy(false);
    }
  }

  async function activer() {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    setInfo(null);
    try {
      // Le code n'est envoyé que s'il y en a un : sur un numéro déjà vérifié, il ne reste que l'enregistrement,
      // et le serveur refuse la vérification que Meta rejetterait.
      await activerNumero(tenantId, code.trim() === '' ? undefined : code.trim());
      setCode('');
      onActive();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Activation impossible', 'Activation failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="activer-numero" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
      <div className="text-sm font-semibold text-amber-900">{t('Ce numéro n’est pas encore activé chez Meta', 'This number is not activated at Meta yet')}</div>
      <p className="mt-0.5 text-xs text-amber-800">
        {verifie
          ? t('Le numéro est vérifié : il ne reste qu’à l’activer pour qu’il puisse envoyer.', 'The number is verified: it only needs to be activated before it can send.')
          : t('Meta n’a pas encore vérifié ce numéro par code. Tant qu’il ne l’est pas, il ne peut pas envoyer.', 'Meta has not verified this number by code yet. Until then, it cannot send.')}
      </p>
      {!isAdmin ? (
        <p className="mt-2 text-xs text-amber-800">{t('Demande à un admin de l’espace de terminer l’activation.', 'Ask a workspace admin to finish the activation.')}</p>
      ) : (
        <>
          {!verifie && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* Appel par défaut : Meta déconseille le SMS sur un numéro VoIP, et seul le propriétaire du
                  numéro sait ce qu'il en est. */}
              <select
                aria-label={t('Canal du code', 'Code channel')}
                value={canal}
                onChange={(e) => setCanal(e.target.value === 'SMS' ? 'SMS' : 'VOICE')}
                className="rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-sm text-ink-800"
              >
                <option value="VOICE">{t('Par appel', 'By phone call')}</option>
                <option value="SMS">{t('Par SMS', 'By SMS')}</option>
              </select>
              <button
                type="button"
                onClick={() => { void envoyerCode(); }}
                disabled={busy}
                data-testid="demander-code"
                className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-60"
              >
                {t('Recevoir le code', 'Get the code')}
              </button>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                placeholder={t('Code reçu', 'Code received')}
                aria-label={t('Code reçu', 'Code received')}
                data-testid="champ-code"
                className="w-32 rounded-lg border border-amber-300 px-2 py-1.5 text-sm"
              />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => { void activer(); }}
              disabled={busy || (!verifie && code.trim() === '')}
              data-testid="activer-bouton"
              className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
            >
              {busy ? t('En cours…', 'Working…') : t('Activer le numéro', 'Activate the number')}
            </button>
            <span className="text-xs text-amber-800">
              {t('Meta ne permet que dix essais par numéro sur 72 heures : ne relance pas en rafale.', 'Meta allows only ten attempts per number over 72 hours: do not retry in bursts.')}
            </span>
          </div>
        </>
      )}
      {info && <p className="mt-2 rounded-lg bg-white px-3 py-2 text-xs text-amber-900">{info}</p>}
      {erreur && <p data-testid="activer-erreur" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{erreur}</p>}
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
