'use client';

import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell, UNREAD_CHANGED_EVENT } from '@/components/AppShell';
import { TemplatePreview } from '@/components/TemplatePreview';
import { isCampaignEligible } from '@/lib/campaign-eligibility';
import { dayKey, dayLabel, hourMin } from '@/lib/day';
import type { ControlOwner } from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { varCountOf } from '@/lib/fields';
import { repeterAvecGigue } from '@/lib/poll';
import { doitDescendre, estEnBas } from '@/lib/defilement-fil';
import { estAnnulation } from '@/lib/http';
import { ContactDetail } from '@/components/ContactDetail';
import { InboxRcsPanel } from '@/components/InboxRcsPanel';
import {
  listConversations,
  countConversationsATraiter,
  getSettings,
  listUsers,
  setConversationAssignee,
  queryContacts,
  listUserFields,
  listTags,
  type Contact,
  type UserFieldDef,
  getConversationMessages,
  releaseConversation,
  effacerConversation,
  replyConversation,
  listTemplates,
  sendTemplateToConversation,
  resolveTemplateParamsForConversation,
  markConversationRead,
  listWorkflows, estEnLigne,
  startWorkflowInConversation,
  type Conversation,
  type InboxMessage,
  type TemplateSummary,
  type WorkflowSummary,
} from '@/lib/api';

export default function InboxPage() {
  // Suspense : useSearchParams (deep-link ?c=) exige une frontière Suspense au build (Next 15).
  return (
    <AppShell active="inbox" fullBleed>
      {(session) => (
        <Suspense fallback={null}>
          <InboxInner session={session} />
        </Suspense>
      )}
    </AppShell>
  );
}

/**
 * Taille d'une page de conversations. 50 et non 100 : l'écran n'en montre qu'une dizaine à la fois, et une
 * page plus courte rend le premier affichage plus rapide. « Charger plus » va chercher la suite.
 */
const TAILLE_PAGE = 50;

/**
 * Traduit le filtre de l'écran en paramètres de requête. Un seul endroit : la liste et « charger plus »
 * doivent demander EXACTEMENT le même filtre, sinon la page suivante ne serait pas la suite de la première.
 */
function filtreEnParams(filtre: 'toutes' | 'aTraiter' | 'signalees'): { aTraiter?: boolean; signalees?: boolean } {
  if (filtre === 'aTraiter') return { aTraiter: true };
  if (filtre === 'signalees') return { signalees: true };
  return {};
}

/** Réponse de formulaire Flow (nfm_reply) : le payload est un objet JSON {champ: valeur}. Renvoie les
 *  paires à afficher, ou null si ce n'est pas un objet (bouton simple, ou JSON tronqué non parsable). */
function parseFormResponse(payload: string): Array<[string, unknown]> | null {
  try {
    const o = JSON.parse(payload) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const entries = Object.entries(o).filter(([k]) => k !== 'flow_token' && !k.startsWith('__'));
      return entries.length > 0 ? entries : null;
    }
  } catch {
    /* JSON tronqué/non parsable -> repli sur le brut */
  }
  return null;
}
function prettyKey(k: string): string {
  const s = k.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Initiales d'un nom : 2 lettres (1re de 2 mots, sinon 2 premières lettres). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Pastille d'auteur d'une bulle sortante (initiales + tooltip nom). */
function AgentBadge({ name }: { name: string }) {
  const t = useT();
  return (
    <span
      title={t(`Envoyé par ${name}`, `Sent by ${name}`)}
      aria-label={t(`Envoyé par ${name}`, `Sent by ${name}`)}
      className="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-ink-700 text-[10px] font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

/** Rendu d'un message entrant à payload : carte « formulaire rempli » si c'est un objet, sinon bouton. */
function InboundPayload({ body, payload }: { body: string | null; payload: string }) {
  const t = useT();
  const entries = parseFormResponse(payload);
  if (!entries) return <span>👆 {body ?? payload}</span>;
  return (
    <div className="space-y-0.5">
      <div className="mb-1 text-xs font-semibold opacity-70">📋 {t('Formulaire rempli', 'Form response')}</div>
      {entries.map(([k, v]) => (
        <div key={k} className="text-sm">
          <span className="opacity-60">{prettyKey(k)} : </span>
          {String(v)}
        </div>
      ))}
    </div>
  );
}

function InboxInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('c');
  const deepLinkApplied = useRef(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Filtre de la liste, à TROIS valeurs exclusives plutôt que deux booléens indépendants : « à traiter » et
   * « signalées » ne se combinent pas à l'écran, et deux drapeaux auraient permis un état que rien n'affiche.
   */
  const [filtre, setFiltre] = useState<'toutes' | 'aTraiter' | 'signalees'>('toutes');
  const onlyTodo = filtre === 'aTraiter';
  /** Une page de plus est peut-être disponible (la dernière était pleine). */
  const [peutCharger, setPeutCharger] = useState(false);
  const [chargementPage, setChargementPage] = useState(false);
  /** Compté par le SERVEUR sur toute la base : l'ancien calcul portait sur les conversations chargées. */
  const [todoCount, setTodoCount] = useState(0);
  /** Fiche contact ouverte, par `waId`. `null` = fermée, et la conversation reprend toute la largeur. */
  const [ficheWaId, setFicheWaId] = useState<string | null>(null);

  /**
   * Recharge la PREMIÈRE page. Le filtre est passé au serveur : le faire en mémoire ne voyait que les
   * conversations déjà chargées, donc au-delà d'une page il ignorait le reste sans le dire.
   */
  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await listConversations(session.tenantId, { limit: TAILLE_PAGE, ...filtreEnParams(filtre) });
      const liste = Array.isArray(r?.conversations) ? r.conversations : [];
      setConversations(liste);
      // Page pleine = il y a peut-être une suite. Pas de compteur total : il coûterait un décompte complet
      // pour dire ce que la longueur dit déjà.
      setPeutCharger(liste.length === TAILLE_PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t, filtre]);

  /** Page SUIVANTE, à la suite de la dernière conversation affichée. */
  const chargerPlus = useCallback(async () => {
    const dernier = conversations[conversations.length - 1];
    if (!dernier || chargementPage) return;
    setChargementPage(true);
    try {
      const r = await listConversations(session.tenantId, {
        limit: TAILLE_PAGE,
        // 🔴 Le curseur du SERVEUR, pas `lastMessageAt` : ce dernier est tronqué à la milliseconde et faisait
        // sauter les conversations dont la dernière activité tombe dans la même milliseconde que le point
        // d'arrêt. Elles n'apparaissaient sur aucune page, sans que rien ne le signale, et le dédoublonnage
        // ci-dessous n'y pouvait rien : il protège des doublons, pas des absences. Repli sur `lastMessageAt`
        // si le champ manque : c'est exactement le comportement d'avant, jamais pire.
        before: { at: dernier.curseur ?? dernier.lastMessageAt, id: dernier.id },
        ...filtreEnParams(filtre),
      });
      const suite = Array.isArray(r?.conversations) ? r.conversations : [];
      // Dédup par identifiant : entre deux pages, un message peut arriver et faire remonter une conversation
      // déjà affichée. Sans cette garde, elle apparaîtrait DEUX fois dans la liste.
      setConversations((prev) => {
        const connus = new Set(prev.map((c) => c.id));
        return [...prev, ...suite.filter((c) => !connus.has(c.id))];
      });
      setPeutCharger(suite.length === TAILLE_PAGE);
    } catch {
      setPeutCharger(false);
    } finally {
      setChargementPage(false);
    }
  }, [session.tenantId, conversations, filtre, chargementPage]);

  /** Compteur « À traiter » : compté par le serveur sur TOUTE la base, pas sur la page affichée. */
  const rechargerCompteur = useCallback(async () => {
    try {
      setTodoCount((await countConversationsATraiter(session.tenantId)).count);
    } catch {
      /* le compteur est un confort : son absence ne doit pas masquer la liste */
    }
  }, [session.tenantId]);
  useEffect(() => { void rechargerCompteur(); }, [rechargerCompteur, conversations]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Deep-link ?c=<id> : quand la liste est chargée, pré-sélectionne la conversation correspondante (une seule
  // fois, pour ne pas ré-écraser un choix manuel aux refresh suivants). Conv absente de la liste -> ignorée.
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId || conversations.length === 0) return;
    const match = conversations.find((c) => c.id === deepLinkId);
    if (match) {
      setSelected(match);
      deepLinkApplied.current = true;
    }
  }, [deepLinkId, conversations]);

  // Auto-refresh de la liste (~15 s), seulement quand l'onglet est visible (pas de martèlement en arrière-plan) ;
  // reload immédiat au retour de focus. Réutilise l'endpoint existant, aucun changement backend.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void reload(); };
    const arreter = repeterAvecGigue(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { arreter(); document.removeEventListener('visibilitychange', tick); };
  }, [reload]);

  // Le filtre est appliqué par le SERVEUR (`reload` le passe en paramètre) : la liste reçue est déjà la bonne.
  const visible = conversations;

  return (
    // Trois colonnes quand la fiche est ouverte : c'est la CONVERSATION qui rétrécit, pas la liste, parce
    // qu'on consulte la fiche en lisant le fil, et qu'une liste qui change de largeur perd le repère visuel.
    <div className={`grid gap-4 p-4 lg:h-full ${ficheWaId ? 'lg:grid-cols-[320px_1fr_340px]' : 'lg:grid-cols-[320px_1fr]'}`}>
      <section className="lg:flex lg:min-h-0 lg:flex-col">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Conversations', 'Conversations')} ({conversations.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
        </div>
        <div className="mb-3 flex gap-1 text-xs">
          <button onClick={() => setFiltre('toutes')} className={`rounded-md px-2 py-1 ${filtre === 'toutes' ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100'}`}>{t('Toutes', 'All')}</button>
          <button onClick={() => setFiltre('aTraiter')} data-testid="inbox-filter-todo" className={`rounded-md px-2 py-1 ${filtre === 'aTraiter' ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100'}`}>
            {t('À traiter', 'To handle')}{todoCount > 0 ? ` (${todoCount})` : ''}
          </button>
          {/* Modération : les conversations où l'analyse a relevé des injures. Le constat arrive 15 à 20 min
              après coup, c'est donc une liste à relire, pas une alerte. */}
          <button onClick={() => setFiltre('signalees')} data-testid="inbox-filter-flagged" className={`rounded-md px-2 py-1 ${filtre === 'signalees' ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100'}`}>
            {t('Signalées', 'Flagged')}
          </button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            {filtre === 'aTraiter'
              ? t('Rien à traiter : toutes les conversations sont gérées par le scénario.', 'Nothing to handle: every conversation is handled by the scenario.')
              : filtre === 'signalees'
                ? t('Aucune conversation signalée. L’analyse relève les injures environ 15 min après le dernier message.', 'No flagged conversation. The analysis spots abuse about 15 min after the last message.')
                : t('Aucune conversation. Elles apparaissent quand un client répond à une campagne.', 'No conversations yet. They appear when a customer replies to a campaign.')}
          </div>
        ) : (
          <ul className="space-y-1.5 lg:flex-1 lg:overflow-y-auto">
            {visible.map((c) => (
              <li key={c.id}>
                {/*
                  DEUX gestes distincts sur la même vignette, donc deux boutons FRÈRES et non imbriqués (un
                  bouton dans un bouton est du HTML invalide, et le clic intérieur devient imprévisible) :
                  la zone ouvre la conversation, le NOM ouvre la fiche du contact.

                  L'extrait du dernier message a été retiré : le fil complet est juste à côté, le répéter en
                  minuscule ne servait qu'à faire deviner ce qu'on peut lire en entier.
                */}
                <div
                  className={`relative w-full rounded-xl border px-3 py-2 transition ${
                    selected?.id === c.id ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-white hover:bg-ink-50'
                  }`}
                >
                  <button
                    onClick={() => setSelected(c)}
                    aria-label={t('Ouvrir la conversation', 'Open conversation')}
                    className="absolute inset-0 rounded-xl"
                  />
                  {/* `pointer-events-none` sur le contenu, `auto` sur le seul bouton du nom : sans ça le
                      contenu recouvre le bouton de fond, et un clic au milieu de la vignette n'ouvrirait
                      RIEN. Le geste de tous les jours doit marcher partout sur la ligne. */}
                  <div className="pointer-events-none relative flex items-baseline justify-between gap-2">
                    <span className={`flex min-w-0 items-baseline text-sm ${c.unread ? 'font-semibold text-ink-900' : 'font-medium'}`}>
                      {/* Point de non-lu : le compteur du menu doit pouvoir se traduire en action, sinon il dit
                          « 3 » sans dire lesquelles. */}
                      {c.unread && <span data-testid="unread-dot" className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-coral align-middle" aria-label={t('non lu', 'unread')} />}
                      <button
                        onClick={() => setFicheWaId(c.waId)}
                        data-testid={`open-contact-${c.id}`}
                        title={t('Voir la fiche du contact', 'View contact record')}
                        className="pointer-events-auto truncate text-left hover:underline"
                      >
                        {c.profileName ?? `+${c.waId}`}
                      </button>
                    </span>
                    <span className="pointer-events-none shrink-0 text-[11px] text-ink-400">{hourMin(c.lastMessageAt, locale)}</span>
                  </div>
                  {/* Le badge n'apparaît QUE si quelqu'un détient le fil : l'afficher sur toutes les
                      lignes noierait l'information, alors que c'est l'exception qui doit sauter aux yeux. */}
                  {c.controlOwner !== 'app_workflow' && (
                    <span className="pointer-events-none relative mt-1 inline-block"><ControlBadge owner={c.controlOwner} /></span>
                  )}
                </div>
              </li>
            ))}
            {/* Chargement à la demande plutôt qu'au défilement : l'auto-refresh de 15 s recharge la première
                page, et un défilement infini se battrait avec lui à chaque tour. */}
            {peutCharger && (
              <li className="pt-1">
                <button
                  onClick={() => { void chargerPlus(); }}
                  disabled={chargementPage}
                  data-testid="inbox-load-more"
                  className="w-full rounded-xl border border-dashed border-ink-300 px-3 py-2 text-xs font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-50"
                >
                  {chargementPage ? t('Chargement…', 'Loading…') : t('Charger plus de conversations', 'Load more conversations')}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="lg:min-h-0">
        {selected ? (
          <Thread key={selected.id} session={session} conversation={selected} onSent={reload} />
        ) : (
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-ink-300 bg-white text-sm text-ink-400">
            {t('Sélectionne une conversation', 'Select a conversation')}
          </div>
        )}
      </section>

      {ficheWaId && (
        <section className="lg:min-h-0 lg:overflow-y-auto" data-testid="inbox-contact-panel">
          <FicheContact session={session} waId={ficheWaId} onClose={() => setFicheWaId(null)} />
        </section>
      )}
    </div>
  );
}

/**
 * Fiche du contact d'une conversation, ouverte depuis l'Inbox au clic sur son nom.
 *
 * Réutilise `ContactDetail`, le MÊME composant que la page mini-CRM : c'est tout l'intérêt de l'avoir
 * extrait. Une seconde fiche écrite ici aurait divergé au premier champ ajouté.
 *
 * Le contact est retrouvé par son numéro via la recherche existante : l'Inbox connaît le `waId`, pas
 * l'identifiant de contact, et une route dédiée pour cette seule traduction n'aurait rien apporté.
 */
function FicheContact({ session, waId, onClose }: { session: Session; waId: string; onClose: () => void }) {
  const t = useT();
  const [contact, setContact] = useState<Contact | null>(null);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [etat, setEtat] = useState<'chargement' | 'absent' | 'ok' | 'erreur'>('chargement');

  useEffect(() => {
    let vivant = true;
    setEtat('chargement');
    (async () => {
      // Les référentiels sont chargés en même temps mais indépendamment : sans eux la fiche s'affiche quand
      // même, seulement moins complète. Les rendre bloquants ferait échouer l'ouverture pour un détail.
      const [c, f, g] = await Promise.allSettled([
        queryContacts(session.tenantId, { phoneContains: waId }, { limit: 1 }),
        listUserFields(session.tenantId),
        listTags(session.tenantId),
      ]);
      if (!vivant) return;
      if (f.status === 'fulfilled') setUserFields(f.value.fields);
      if (g.status === 'fulfilled') setTags(g.value.tags.map((x) => x.tag));
      if (c.status !== 'fulfilled') { setEtat('erreur'); return; }
      const trouve = c.value.contacts[0] ?? null;
      setContact(trouve);
      setEtat(trouve ? 'ok' : 'absent');
    })().catch(() => { if (vivant) setEtat('erreur'); });
    return () => { vivant = false; };
  }, [session.tenantId, waId]);

  if (etat === 'chargement') {
    return <div className="rounded-2xl border border-ink-200 bg-white p-4 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</div>;
  }
  if (etat !== 'ok' || !contact) {
    return (
      <div className="rounded-2xl border border-ink-200 bg-white p-4 text-sm text-ink-500">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-ink-700">{`+${waId}`}</span>
          <button onClick={onClose} className="text-xs text-ink-500 hover:text-ink-800">{t('Fermer', 'Close')}</button>
        </div>
        {/* Un fil peut exister sans fiche : une conversation ouverte par un numéro jamais importé dans le
            mini-CRM. On le dit, au lieu d'afficher une fiche vide qui laisserait croire à une erreur. */}
        {etat === 'absent'
          ? t('Aucune fiche pour ce numéro dans le mini-CRM.', 'No contact record for this number in the mini-CRM.')
          : t('Fiche indisponible pour le moment.', 'Contact record unavailable right now.')}
      </div>
    );
  }
  return (
    <ContactDetail
      contact={contact}
      userFields={userFields}
      tagSuggestions={tags}
      tenantId={session.tenantId}
      onUpdated={setContact}
      onFieldCreated={(def) => setUserFields((prev) => [...prev, def])}
      onClose={onClose}
    />
  );
}

/**
 * Affectation d'une conversation à un membre de l'équipe.
 *
 * Trois lectures possibles selon qui regarde :
 *   - manager ou admin  -> un sélecteur, pour confier la conversation ou la libérer ;
 *   - l'agent affecté   -> une pastille « pour moi » ;
 *   - un autre agent    -> une pastille qui NOMME l'affectataire, pour qu'il comprenne pourquoi la zone de
 *     réponse lui est fermée. Sans ce nom, la conversation paraîtrait cassée.
 *
 * ⚠️ Ce composant ne PROTÈGE rien : le refus d'écrire est appliqué par le serveur. Il rend seulement la
 * règle lisible, pour qu'on ne rédige pas un message qu'on ne pourra pas envoyer.
 */
function AffectationControl({ session, conversation, onChange }: { session: Session; conversation: Conversation; onChange: () => void }) {
  const t = useT();
  const peutAffecter = session.role === 'admin' || session.role === 'manager';
  const [membres, setMembres] = useState<Array<{ id: string; name: string | null; email: string }>>([]);
  const [busy, setBusy] = useState(false);
  const affecte = conversation.assignedTo ?? null;

  useEffect(() => {
    if (!peutAffecter) return;
    // Silencieux, et surtout VALIDÉ : une réponse 200 sans `users` (backend antérieur, proxy) poserait
    // `undefined` dans un état typé tableau, et le rendu suivant ferait tomber TOUT le fil de conversation,
    // pas seulement ce sélecteur. Le try/catch ne suffit pas, il faut vérifier la forme.
    listUsers(session.tenantId)
      .then((r) => setMembres(Array.isArray(r?.users) ? r.users : []))
      .catch(() => setMembres([]));
  }, [session.tenantId, peutAffecter]);

  async function choisir(valeur: string): Promise<void> {
    setBusy(true);
    try {
      await setConversationAssignee(session.tenantId, conversation.id, valeur === '' ? null : valeur);
      onChange();
    } catch {
      /* l'échec se voit à l'absence de changement dans la liste ; pas d'alerte au milieu d'une conversation */
    } finally {
      setBusy(false);
    }
  }

  if (!peutAffecter) {
    if (affecte === null) return null;
    const pourMoi = conversation.assignedToMe === true;
    return (
      <span
        data-testid="assignment-badge"
        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${pourMoi ? 'bg-brand-50 text-brand-700' : 'bg-ink-100 text-ink-600'}`}
      >
        {pourMoi
          ? t('pour moi', 'assigned to me')
          : t(`suivi par ${conversation.assignedToName ?? '…'}`, `handled by ${conversation.assignedToName ?? '…'}`)}
      </span>
    );
  }
  return (
    <select
      data-testid="assignment-select"
      value={affecte ?? ''}
      disabled={busy}
      onChange={(e) => { void choisir(e.target.value); }}
      className="rounded-lg border border-ink-300 px-2 py-0.5 text-[11px] text-ink-700 disabled:opacity-50"
      title={t('Affecter cette conversation', 'Assign this conversation')}
    >
      <option value="">{t('Non affectée', 'Unassigned')}</option>
      {membres.map((m) => (
        <option key={m.id} value={m.id}>{m.name ?? m.email}</option>
      ))}
    </select>
  );
}

function Thread({ session, conversation, onSent }: { session: Session; conversation: Conversation; onSent: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  // Qui détient le fil. Sans cette information, l'opérateur voit le scénario se taire sans comprendre
  // pourquoi, et ne sait pas s'il doit rendre la main.
  const [controlOwner, setControlOwner] = useState<ControlOwner>('app_workflow');
  const [releasing, setReleasing] = useState(false);
  const [effacement, setEffacement] = useState(false);
  const [text, setText] = useState('');
  /**
   * La conversation est confiée à quelqu'un d'autre, et je ne suis ni manager ni admin.
   *
   * Un champ ABSENT vaut « pas d'affectation » : une instance serveur antérieure à cette fonctionnalité ne
   * doit fermer la réponse à personne. On ne ferme que sur une affectation explicitement connue.
   */
  const fermeeCarAffectee =
    (conversation.assignedTo ?? null) !== null
    && conversation.assignedToMe !== true
    && session.role !== 'admin'
    && session.role !== 'manager';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [showRcs, setShowRcs] = useState(false);
  // Canal RCS allumé pour cet espace ? Déduit du dépôt d'agent côté serveur, comme dans les campagnes et le
  // builder. Éteint -> aucun bouton RCS : proposer un envoi qui finira en 422 n'aide personne.
  const [rcsEnabled, setRcsEnabled] = useState(false);
  useEffect(() => {
    void getSettings(session.tenantId).then((s) => setRcsEnabled(s.rcsEnabled === true)).catch(() => {});
  }, [session.tenantId]);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Le conteneur défilant du fil. Sert à savoir si l'opérateur est REMONTÉ dans l'historique. */
  const filRef = useRef<HTMLDivElement>(null);
  /**
   * « L'opérateur était-il en bas ? », mesuré AVANT que le contenu ne bouge (cf `lib/defilement-fil.ts`).
   * Vrai au départ : à l'ouverture, la seule position qui a du sens est le message le plus récent.
   */
  const etaitEnBasRef = useRef(true);
  /** Le fil n'a pas encore été peuplé : le premier chargement descend, sans consulter la géométrie. */
  const premierChargementRef = useRef(true);

  // Dernier message DÉJÀ vu dans ce fil : sert à ne marquer « lu » qu'au vrai changement, et pas à chacun
  // des rafraîchissements de 4 s. Remis à zéro par le remontage du composant à chaque conversation.
  const dernierVuRef = useRef<string | null>(null);

  /**
   * Dernier message DÉJÀ affiché, pour ne demander que la SUITE au rafraîchissement suivant.
   *
   * En `ref` et non en état dérivé : `load` ne doit pas être recréé à chaque nouveau message, sinon l'effet
   * qui installe le minuteur se relancerait toutes les quatre secondes.
   */
  const bornRef = useRef<{ at: string; id: string } | null>(null);
  /** Requête de fil en cours, annulée quand on change de conversation ou qu'on quitte l'écran. */
  const enVolRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    enVolRef.current?.abort();
    const ctrl = new AbortController();
    enVolRef.current = ctrl;
    try {
      // DELTA (lot 5 du programme II) : on ne redemande que ce qui est arrivé APRÈS ce qu'on a déjà. Le fil
      // se rafraîchit toutes les 4 s ; il retéléchargeait jusqu'à 500 messages à chaque tour, par onglet.
      const res = await getConversationMessages(session.tenantId, conversation.id, {
        ...(bornRef.current ? { apres: bornRef.current } : {}),
        signal: ctrl.signal,
      });
      // ⚠️ On AJOUTE, on ne remplace plus. Conséquence assumée : un message effacé côté serveur reste à
      // l'écran jusqu'au prochain changement de conversation. Le produit n'efface pas de message, et le fil
      // se remonte à chaque sélection (`key={selected.id}`), donc l'écart ne survit pas à un clic.
      if (res.messages.length > 0) {
        const arrivee = res.messages[res.messages.length - 1]!;
        // 🔴 LE CURSEUR VIENT DU SERVEUR ET REPART TEL QUEL. Il valait `createdAt`, qui a traversé un `Date`
        // JavaScript et n'a donc que la milliseconde là où Postgres stocke la microseconde : le dernier
        // message repassait le filtre à chaque tour et se ré-ajoutait au fil toutes les 4 secondes, ce qui
        // faisait défiler l'écran tout seul. Curseur absent (serveur plus ancien) : on n'en pose PAS, donc le
        // tour suivant redemande le fil entier. C'est le repli sûr de cette route, trop de messages plutôt
        // que trop peu, et le dédoublonnage ci-dessous le rend invisible.
        bornRef.current = arrivee.curseur ? { at: arrivee.curseur, id: arrivee.id } : null;
        // Toujours en AJOUT : au premier chargement `prev` est vide, donc l'ajout rend le fil entier. Le
        // composant est remonté à chaque conversation (`key={selected.id}`), donc `prev` ne mélange jamais
        // deux fils.
        //
        // ⚠️ Et en AJOUT DÉDOUBLONNÉ : un message n'apparaît qu'une fois dans un fil, quoi qu'il arrive en
        // face. Cette garde-ci ne dépend d'aucune hypothèse sur le curseur, donc elle tient aussi le jour où
        // le serveur renvoie deux fois la même bulle pour une autre raison. Et quand tout est déjà connu,
        // `prev` est rendu TEL QUEL : la référence ne change pas, donc l'effet de défilement ne se
        // redéclenche pas. C'est ce qui rend le fil calme.
        setMessages((prev) => {
          const connus = new Set(prev.map((m) => m.id));
          const nouveaux = res.messages.filter((m) => !connus.has(m.id));
          return nouveaux.length === 0 ? prev : [...prev, ...nouveaux];
        });
        // Le fil est ouvert à l'écran : il est lu. On le dit au serveur à l'ouverture, puis à chaque nouveau
        // message, jamais à chaque tick. Best-effort : la pastille n'est pas une raison de casser le fil.
        if (arrivee.id !== dernierVuRef.current) {
          dernierVuRef.current = arrivee.id;
          markConversationRead(session.tenantId, conversation.id)
            .then(() => window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT)))
            .catch(() => { /* pastille d'appoint */ });
        }
      }
      // Rien de nouveau -> `messages` garde sa référence, donc l'effet de scroll ne se redéclenche pas : c'est
      // la garde anti-saut de scroll d'avant, obtenue ici gratuitement par le delta.
      setWindowOpen(res.windowOpen);
      setControlOwner(res.controlOwner);
    } catch (err) {
      // Une requête ANNULÉE n'est pas une panne : changer de conversation annule la précédente, et afficher
      // un bandeau rouge à chaque clic serait absurde.
      if (estAnnulation(err)) return;
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    }
  }, [session.tenantId, conversation.id, t]);

  // Annule la requête en vol au démontage (changement de conversation, sortie de l'inbox).
  useEffect(() => () => { enVolRef.current?.abort(); }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh du fil ouvert (~4 s, chat vivant) tant que l'onglet est visible. Thread est remonté par
  // conversation (key=selected.id), donc l'interval se recrée proprement à chaque changement de conversation.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const arreter = repeterAvecGigue(tick, 4000);
    document.addEventListener('visibilitychange', tick);
    return () => { arreter(); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  /**
   * Descendre sur un NOUVEAU message, mais jamais arracher l'opérateur qui lit plus haut.
   *
   * Deux gardes, et il fallait les deux. La première est ailleurs : `messages` ne change de référence que
   * lorsqu'une bulle inconnue arrive, donc cet effet ne se déclenche plus à chaque tour de rafraîchissement.
   * La seconde est ici : même sur un vrai nouveau message, on ne descend que si l'opérateur était DÉJÀ en
   * bas. S'il est remonté pour relire, le fil reste où il l'a laissé.
   *
   * 🔴 La mesure est prise AVANT que le contenu ne bouge, sur l'événement de défilement, et JAMAIS ici. La
   * mesurer dans cet effet (ce que faisait le code jusqu'au 2026-09-02) donne une réponse fausse deux fois :
   * à l'ouverture d'un fil long (`scrollTop` à 0, donc « pas en bas », donc on n'y descend pas) et à l'arrivée
   * d'un message plus haut que la tolérance (on était en bas avant l'ajout, plus après). Cf `lib/defilement-fil.ts`.
   */
  useEffect(() => {
    const fil = filRef.current;
    if (!fil) return;
    const auDefilement = () => { etaitEnBasRef.current = estEnBas(fil); };
    fil.addEventListener('scroll', auDefilement, { passive: true });
    return () => fil.removeEventListener('scroll', auDefilement);
  }, []);

  useEffect(() => {
    if (messages.length === 0) return;
    const premierChargement = premierChargementRef.current;
    if (!doitDescendre({ premierChargement, etaitEnBas: etaitEnBasRef.current })) return;
    premierChargementRef.current = false;
    // À l'ouverture on descend SEC : animer la traversée de tout l'historique n'aide personne et se voit.
    bottomRef.current?.scrollIntoView(premierChargement ? undefined : { behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await replyConversation(session.tenantId, conversation.id, text.trim());
      setText('');
      await load();
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Envoi impossible', 'Failed to send'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Efface le contenu du fil. Irréversible, et il FERME la fenêtre de 24 h.
   *
   * La confirmation dit les deux, parce que ni l'un ni l'autre ne se devine : « irréversible » s'attend d'un
   * bouton rouge, mais « vous ne pourrez plus répondre librement à cette personne » ne s'attend pas du tout.
   */
  async function effacer() {
    const question = t(
      'Effacer TOUS les messages de cette conversation ?\n\nC’est irréversible.\n\nEt la fenêtre de 24 h se calcule sur le dernier message reçu : après l’effacement, elle sera fermée, donc vous ne pourrez plus répondre librement à ce contact tant qu’il n’aura pas réécrit.',
      'Erase ALL messages in this conversation?\n\nThis cannot be undone.\n\nAnd the 24h window is computed from the last received message: after erasing, it will be closed, so you will not be able to reply freely to this contact until they write again.',
    );
    if (!window.confirm(question)) return;
    setEffacement(true);
    setError(null);
    try {
      await effacerConversation(session.tenantId, conversation.id);
      // Le fil est vidé côté serveur : on remet l'écran à zéro plutôt que d'attendre le prochain tour, et on
      // relâche le curseur, sinon le delta repartirait d'un message qui n'existe plus.
      setMessages([]);
      bornRef.current = null;
      setWindowOpen(false);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Effacement impossible', 'Erase failed'));
    } finally {
      setEffacement(false);
    }
  }

  async function release() {
    setReleasing(true);
    setError(null);
    try {
      const res = await releaseConversation(session.tenantId, conversation.id);
      setControlOwner(res.controlOwner);
      onSent(); // rafraîchit la liste : le badge y change aussi
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Reprise impossible', 'Hand back failed'));
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="flex h-[540px] flex-col rounded-2xl border border-ink-200 bg-white shadow-sm lg:h-full">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div>
          <span className="text-sm font-semibold">{conversation.profileName ?? `+${conversation.waId}`}</span>
          <span className="ml-2 font-mono text-xs text-ink-400">+{conversation.waId}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Affectation : à côté du contrôle du fil, mais ce sont DEUX choses différentes. Le badge de
              contrôle dit ce qui parle (scénario, humain, agent Meta) ; celui-ci dit qui s'en occupe. */}
          <AffectationControl
            session={session}
            conversation={conversation}
            onChange={onSent}
          />
          <ControlBadge owner={controlOwner} />
          {/* Rendre la main : sans ce bouton, le seul retour possible serait le délai d'inactivité, donc un
              opérateur qui règle une question en deux minutes devrait attendre des heures. */}
          {controlOwner === 'app_human' && (
            <button
              onClick={() => { void release(); }}
              disabled={releasing}
              className="rounded-lg border border-ink-300 px-2 py-0.5 text-[11px] font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
            >
              {releasing ? t('...', '...') : t('Rendre la main', 'Hand back')}
            </button>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${windowOpen ? 'bg-mint-50 text-mint-700' : 'bg-amber-50 text-amber-700'}`}>
            {windowOpen ? t('fenêtre 24 h ouverte', '24h window open') : t('fenêtre 24 h fermée', '24h window closed')}
          </span>
          {/* 🔴 EFFACER LE CONTENU. Réservé aux administrateurs côté serveur ; on ne montre pas le bouton aux
              autres, mais c'est la garde du serveur qui décide, pas cet affichage.
              La confirmation DIT la conséquence que personne ne devine : effacer les messages ferme la fenêtre
              de 24 h, parce qu'elle se calcule sur le dernier message ENTRANT. Après ça, plus personne ne peut
              répondre librement à ce contact tant qu'il n'a pas réécrit. */}
          {session.role === 'admin' && (
            <button
              data-testid="conversation-effacer"
              onClick={() => { void effacer(); }}
              disabled={effacement}
              className="rounded-lg border border-ink-300 px-2 py-0.5 text-[11px] font-medium text-coral transition hover:bg-red-50 disabled:opacity-50"
            >
              {effacement ? t('...', '...') : t('Effacer le contenu', 'Erase content')}
            </button>
          )}
        </div>
      </div>

      <div ref={filRef} data-testid="fil-messages" className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.map((m, i) => {
          // Séparateur de jour (fuseau Paris) quand le jour change vs le message précédent.
          const showSep = i === 0 || dayKey(m.createdAt) !== dayKey(messages[i - 1]!.createdAt);
          return (
            <Fragment key={m.id}>
              {showSep && (
                <div className="flex justify-center py-1">
                  <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-[11px] font-medium text-ink-500">{dayLabel(m.createdAt, locale)}</span>
                </div>
              )}
              <div className={`flex items-end gap-1.5 ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                {/* Couleur PAR CANAL : le fil est unique par contact, c'est la bulle qui dit par quel tuyau
                    elle est passée. WhatsApp garde ses couleurs historiques (aucune bulle existante ne
                    change), le RCS prend le mint. Canal absent ou inconnu (message d'avant la migration
                    0056) -> WhatsApp, jamais une couleur muette. */}
                <div
                  className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${
                    m.channel === 'rcs'
                      ? (m.direction === 'out' ? 'bg-mint-500 text-white' : 'bg-mint-100 text-ink-800')
                      : (m.direction === 'out' ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-800')
                  }`}
                  title={m.channel === 'rcs' ? 'RCS' : undefined}
                >
                  {m.type === 'template' ? (
                    <span className="italic opacity-90">📋 {m.body}</span>
                  ) : m.buttonPayload && m.direction === 'in' ? (
                    <InboundPayload body={m.body} payload={m.buttonPayload} />
                  ) : (
                    m.body ?? <span className="italic opacity-70">[{m.type}]</span>
                  )}
                  <div className={`mt-0.5 text-right text-[10px] ${m.direction === 'out' ? 'text-white/70' : 'text-ink-400'}`}>{hourMin(m.createdAt, locale)}</div>
                </div>
                {/* Pastille de l'auteur (repli neutre : rien si pas d'auteur, legacy ou réponse auto). */}
                {m.direction === 'out' && m.senderName ? <AgentBadge name={m.senderName} /> : null}
              </div>
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/*
        Conversation confiée à QUELQU'UN D'AUTRE : on remplace la barre de réponse par une explication, au
        lieu de la laisser en place et de laisser rédiger un message que le serveur refusera. L'agent VOIT
        toujours la conversation, il sait juste qu'elle n'est pas à lui, et qui la suit.

        Le refus réel vient du serveur : ce bloc ne protège rien, il évite une frustration.
      */}
      {fermeeCarAffectee ? (
        <div className="border-t border-ink-100 p-3 text-center text-sm text-ink-500" data-testid="assigned-elsewhere">
          {t(
            `Cette conversation est suivie par ${conversation.assignedToName ?? 'un autre membre'}. Un manager peut vous l’affecter.`,
            `This conversation is handled by ${conversation.assignedToName ?? 'another member'}. A manager can assign it to you.`,
          )}
        </div>
      ) : windowOpen ? (
        <div className="flex items-center gap-2 border-t border-ink-100 p-3">
          <button
            onClick={() => setShowTemplate(true)}
            title={t('Envoyer un template', 'Send a template')}
            className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-sm text-ink-600 hover:bg-ink-50"
          >
            📋
          </button>
          <button
            onClick={() => setShowScenario(true)}
            title={t('Lancer un scénario', 'Start a scenario')}
            data-testid="inbox-open-scenario"
            className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-sm text-ink-600 hover:bg-ink-50"
          >
            🧩
          </button>
          {rcsEnabled && (
            <button
              onClick={() => setShowRcs(true)}
              title={t('Envoyer un message RCS', 'Send an RCS message')}
              data-testid="inbox-open-rcs"
              className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-sm text-ink-600 hover:bg-ink-50"
            >
              📱
            </button>
          )}
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
            placeholder={t('Répondre (fenêtre de service 24 h)...', 'Reply (24h service window)...')}
            className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <button
            onClick={send}
            disabled={busy || text.trim() === ''}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? '...' : t('Envoyer', 'Send')}
          </button>
        </div>
      ) : (
        <div className="border-t border-ink-100 p-3">
          <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t('Fenêtre de 24 h fermée : WhatsApp interdit le message libre. Pour reprendre contact, envoie un ', '24-hour window closed: WhatsApp does not allow free-form messages. To reach out again, send an ')}<b>{t('template approuvé', 'approved template')}</b>.
          </p>
          <button
            onClick={() => setShowTemplate(true)}
            className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            {t('Envoyer un template', 'Send a template')}
          </button>
          {rcsEnabled && (
            <button
              onClick={() => setShowRcs(true)}
              data-testid="inbox-open-rcs"
              className="mt-2 w-full rounded-lg border border-mint-500 px-3 py-2 text-sm font-medium text-mint-700 hover:bg-mint-50"
            >
              {t('…ou envoyer un message RCS (pas de fenêtre de 24 h)', '…or send an RCS message (no 24h window)')}
            </button>
          )}
          <button
            onClick={() => setShowScenario(true)}
            data-testid="inbox-open-scenario"
            className="mt-2 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            {t('Lancer un scénario', 'Start a scenario')}
          </button>
        </div>
      )}

      {showTemplate && (
        <TemplateSendPanel
          session={session}
          conversationId={conversation.id}
          onClose={() => setShowTemplate(false)}
          onSent={async () => { setShowTemplate(false); await load(); onSent(); }}
        />
      )}

      {showRcs && (
        <InboxRcsPanel
          tenantId={session.tenantId}
          conversationId={conversation.id}
          onClose={() => setShowRcs(false)}
          onSent={async () => { setShowRcs(false); await load(); onSent(); }}
        />
      )}

      {showScenario && (
        <ScenarioSendPanel
          session={session}
          conversationId={conversation.id}
          windowOpen={windowOpen}
          onClose={() => setShowScenario(false)}
          onSent={async () => { setShowScenario(false); await load(); onSent(); }}
        />
      )}
    </div>
  );
}

/**
 * Lancer un SCÉNARIO sur la conversation ouverte. Calqué sur TemplateSendPanel.
 *
 * La liste dépend de la fenêtre de service, et c'est toute la règle : fenêtre OUVERTE, tous les scénarios,
 * puisque le contact vient d'écrire et qu'un message rapide ou un formulaire passera. Fenêtre FERMÉE, seuls
 * ceux qui OUVRENT par un template configuré, les seuls que Meta laisse passer. Un tag, une action ou une
 * condition avant ce template ne gênent pas : c'est ce qui OUVRE qui compte, pas le premier bloc.
 *
 * `isCampaignEligible` répond exactement à cette question et sert déjà au sélecteur de campagne : même règle,
 * même code, aucune seconde version à maintenir. Le serveur re-tranche de toute façon sur l'état réel.
 *
 * ⚠️ Déclaré au niveau MODULE, comme TemplateSendPanel : dans le corps de Thread, la fonction était recréée à
 * chaque rendu, donc React démontait puis remontait la modale ouverte au moindre re-render (le fil recharge
 * toutes les 4 s), effaçant la sélection en cours.
 */
function ScenarioSendPanel({
  session,
  conversationId,
  windowOpen,
  onClose,
  onSent,
}: {
  session: Session;
  conversationId: string;
  windowOpen: boolean;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const t = useT();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selId, setSelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await listWorkflows(session.tenantId);
        if (!alive) return;
        setTotal(res.workflows.length);
        // L'éligibilité vient désormais du SERVEUR (même règle que la garde de création). Repli sur le calcul
        // local tant qu'une API d'avant ne l'envoie pas : deux conteneurs ne redémarrent pas à la même seconde.
        setWorkflows(windowOpen ? res.workflows : res.workflows.filter((w) => w.campaignEligible ?? (w.graph ? isCampaignEligible(w.graph) : false)));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('Scénarios indisponibles', 'Scenarios unavailable'));
      }
    })();
    return () => { alive = false; };
  }, [session.tenantId, windowOpen, t]);

  const sel = workflows.find((w) => w.id === selId) ?? null;

  async function lancer() {
    if (!sel) return;
    setBusy(true);
    setError(null);
    try {
      await startWorkflowInConversation(session.tenantId, conversationId, sel.id);
      await onSent();
    } catch (err) {
      // Le serveur rend la RAISON exacte du refus (422) : on l'affiche telle quelle, elle est déjà lisible.
      setError(err instanceof Error ? err.message : t('Lancement impossible', 'Failed to start'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Lancer un scénario', 'Start a scenario')}</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">×</button>
        </div>
        <p className="mt-1 text-xs text-ink-500">
          {windowOpen
            ? t('Le contact a écrit il y a moins de 24 h : tous tes scénarios peuvent partir.', 'The contact wrote less than 24h ago: any of your scenarios can run.')
            : t('Fenêtre de 24 h fermée : seuls les scénarios qui ouvrent par un template ou par un message RCS peuvent partir.', '24-hour window closed: only scenarios opening with a template or an RCS message can run.')}
        </p>

        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-ink-700">{t('Scénario', 'Scenario')}</label>
          {workflows.length === 0 ? (
            <p className="text-xs text-amber-700" data-testid="scenario-none">
              {total === 0
                ? t('Aucun scénario. Crée-en un dans le menu « Scénario » à gauche.', 'No scenario yet. Create one from the "Scenario" menu on the left.')
                : t("Aucun de tes scénarios ne peut partir hors de la fenêtre de 24 h : il faudrait qu'il ouvre par l'envoi d'un template, ou par un message RCS, qui lui n'a pas de fenêtre (une étiquette, une action ou une condition avant lui ne posent aucun problème).", 'None of your scenarios can run outside the 24h window: it would need to open by sending a template, or an RCS message, which has no window (a tag, an action or a condition before it is fine).')}
            </p>
          ) : (
            <select value={selId} onChange={(e) => { setSelId(e.target.value); setError(null); }} className={inputCls} data-testid="scenario-select">
              <option value="" disabled>{t('Choisir…', 'Choose…')}</option>
              {/* « non publié » : fenêtre ouverte, la liste n'est pas filtrée et un scénario jamais mis en
                  ligne y figure. Le lancer ne ferait rien du tout, autant le dire avant le clic. */}
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>{estEnLigne(w) ? w.name : `${w.name} (${t('non publié', 'not published')})`}</option>
              ))}
            </select>
          )}
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="scenario-error">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">{t('Annuler', 'Cancel')}</button>
          <button
            onClick={lancer}
            disabled={!sel || busy}
            data-testid="scenario-send"
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Lancement…', 'Starting…') : t('Lancer', 'Start')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateSendPanel({
  session,
  conversationId,
  onClose,
  onSent,
}: {
  session: Session;
  conversationId: string;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [sel, setSel] = useState<TemplateSummary | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  /** Libellé du champ qui alimente chaque variable ('' si aucun indice) : dit D'OÙ vient la valeur. */
  const [labels, setLabels] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await listTemplates(session.tenantId);
        // Carousels INCLUS : l'API relit leurs cartes chez Meta et re-téléverse les visuels avant d'envoyer
        // (même chemin que la campagne). Un carousel non envoyable ressort en 422 avec sa raison.
        if (alive) setTemplates(res.templates.filter((x) => x.status === 'APPROVED'));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('Templates indisponibles', 'Templates unavailable'));
      }
    })();
    return () => { alive = false; };
  }, [session.tenantId, t]);

  const varCount = varCountOf(sel?.body);
  const needsMedia = sel?.headerFormat === 'IMAGE' || sel?.headerFormat === 'VIDEO' || sel?.headerFormat === 'DOCUMENT';
  // 🔴 L'image du TEMPLATE d'abord. Meta exige le média à chaque envoi, mais il est déjà choisi depuis la
  // création : le redemander à l'opérateur était une corvée sans raison, et il n'a aucun moyen de retrouver
  // cette URL. On ne demande donc que si le template n'en porte aucune (vieux template, handle expiré).
  const mediaDuTemplate = sel?.headerMediaUrl ?? '';
  const mediaAFournir = needsMedia && mediaDuTemplate === '';
  const previewExamples = Array.from({ length: varCount }, (_, i) => vars[i] || `{{${i + 1}}}`);
  const varsFilled = Array.from({ length: varCount }).every((_, i) => (vars[i] ?? '').trim() !== '');
  const canSend = !!sel && !busy && varsFilled && (!mediaAFournir || imageUrl.trim() !== '');

  function pick(value: string) {
    const found = templates.find((x) => `${x.name}::${x.language}` === value) ?? null;
    setSel(found);
    setVars([]);
    setLabels([]);
    setImageUrl('');
    setError(null);
    // Variables PRÉ-REMPLIES depuis la fiche du contact, via les indices posés à la création du template.
    // L'opérateur voit les vraies valeurs et peut les corriger, au lieu de deviner ce qu'attend `{{1}}`.
    const n = varCountOf(found?.body);
    if (found && n > 0) {
      void resolveTemplateParamsForConversation(session.tenantId, conversationId, { name: found.name, language: found.language, count: n })
        .then((r) => { setVars(r.values); setLabels(r.labels); })
        .catch(() => { /* résolution indisponible : les champs restent à remplir à la main */ });
    }
  }

  async function send() {
    if (!sel) return;
    setBusy(true);
    setError(null);
    try {
      await sendTemplateToConversation(session.tenantId, conversationId, {
        templateName: sel.name,
        language: sel.language,
        bodyParams: Array.from({ length: varCount }, (_, i) => vars[i] ?? ''),
        ...(sel.category ? { templateCategory: sel.category } : {}),
        // Le média du TEMPLATE d'abord, celui saisi à la main seulement en secours : Meta exige le fichier à
        // chaque envoi, mais l'opérateur n'a aucun moyen de retrouver l'URL de ce qu'il a choisi à la création.
        ...(needsMedia && (mediaDuTemplate || imageUrl.trim())
          ? {
            headerMediaUrl: mediaDuTemplate || imageUrl.trim(),
            headerFormat: sel.headerFormat as 'IMAGE' | 'VIDEO' | 'DOCUMENT',
          }
          : {}),
      });
      await onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Envoi impossible', 'Failed to send'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Envoyer un template', 'Send a template')}</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">×</button>
        </div>
        <p className="mt-1 text-xs text-ink-500">{t('Le seul moyen de ré-engager un contact hors fenêtre de 24 h.', 'The only way to re-engage a contact outside the 24h window.')}</p>

        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-ink-700">{t('Template approuvé', 'Approved template')}</label>
          {templates.length === 0 ? (
            <p className="text-xs text-amber-700">{t('Aucun template approuvé. Crée-en un dans Campagnes → Templates.', 'No approved template. Create one in Campaigns → Templates.')}</p>
          ) : (
            <select value={sel ? `${sel.name}::${sel.language}` : ''} onChange={(e) => pick(e.target.value)} className={inputCls}>
              <option value="" disabled>{t('Choisir…', 'Choose…')}</option>
              {templates.map((tpl) => (
                <option key={`${tpl.name}::${tpl.language}`} value={`${tpl.name}::${tpl.language}`}>
                  {tpl.name} ({tpl.language}){tpl.isCarousel ? ` · ${t('carousel', 'carousel')}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {sel && (
          <>
            {varCount > 0 && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-ink-700">{t('Variables', 'Variables')}</label>
                <div className="space-y-2">
                  {Array.from({ length: varCount }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="flex w-28 shrink-0 items-center gap-1 text-xs text-ink-400">
                        {`{{${i + 1}}}`}
                        {labels[i] ? <span className="truncate rounded bg-brand-50 px-1 text-brand-600">{labels[i]}</span> : null}
                      </span>
                      <input
                        value={vars[i] ?? ''}
                        onChange={(e) => setVars((x) => { const c = [...x]; c[i] = e.target.value; return c; })}
                        className={`${inputCls} flex-1`}
                        placeholder={t('valeur', 'value')}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {needsMedia && !mediaAFournir && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-ink-50 px-3 py-2">
                {sel.headerFormat === 'IMAGE' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaDuTemplate} alt="" referrerPolicy="no-referrer" className="h-10 w-16 shrink-0 rounded border border-ink-200 object-cover" />
                ) : (
                  <span className="text-lg">{sel.headerFormat === 'VIDEO' ? '🎬' : '📄'}</span>
                )}
                <p className="text-xs text-ink-500" data-testid="template-media-repris">
                  {t('L’en-tête défini sur le template part avec le message. Rien à fournir.', 'The header defined on the template goes out with the message. Nothing to provide.')}
                </p>
              </div>
            )}

            {mediaAFournir && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-ink-700">
                  {t(
                    `URL de l'${sel.headerFormat === 'IMAGE' ? 'image' : sel.headerFormat === 'VIDEO' ? 'vidéo' : 'document'} (header du template)`,
                    `${sel.headerFormat === 'IMAGE' ? 'Image' : sel.headerFormat === 'VIDEO' ? 'Video' : 'Document'} URL (template header)`,
                  )}
                </label>
                <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." className={inputCls} />
                <p className="mt-1 text-[11px] text-amber-700">
                  {t('Ce template a un en-tête média, mais son fichier n’est plus lisible chez Meta (lien expiré). Collez-en un pour cet envoi.', 'This template has a media header, but its file is no longer readable at Meta (expired link). Paste one for this send.')}
                </p>
              </div>
            )}

            <div className="mt-3">
              {/* Un carousel se montre comme un carousel : le corps seul ne dit rien de ce que le contact reçoit. */}
              <TemplatePreview template={{ body: sel.body, buttons: [], ...(sel.carousel ? { carousel: sel.carousel } : {}) }} examples={previewExamples} />
            </div>
          </>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">{t('Annuler', 'Cancel')}</button>
          <button
            onClick={send}
            disabled={!canSend}
            className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Envoi...', 'Sending...') : t('Envoyer le template', 'Send the template')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Qui répond au client en ce moment. Trois états mutuellement exclusifs.
 *
 * L'enjeu n'est pas décoratif : quand un opérateur détient le fil, le scénario se tait volontairement.
 * Sans ce badge, ce silence ressemblerait à une panne.
 */
function ControlBadge({ owner }: { owner: ControlOwner }) {
  const t = useT();
  const LOOK: Record<ControlOwner, { label: string; cls: string; title: string }> = {
    app_workflow: {
      label: t('scénario', 'scenario'),
      cls: 'bg-ink-100 text-ink-600',
      title: t('Le scénario automatique répond.', 'The automated scenario is responding.'),
    },
    app_human: {
      label: t('vous avez la main', 'you have the hand'),
      cls: 'bg-brand-50 text-brand-700',
      // 🔴 Cette infobulle a promis pendant des semaines que « les campagnes ne l'enverront pas ». C'est FAUX,
      // et l'inverse exact de ce que fait le code : une campagne passe `ignoreHumanControl` et REPREND la main
      // (src/workflow/executor.ts, `runFrom`), parce qu'un opérateur la déclenche, donc c'est un humain qui a
      // la main. C'est un choix délibéré et testé côté serveur. Le mensonge était donc ici, pas dans le
      // comportement, et il est affiché à l'opérateur sur chaque conversation qu'il détient.
      title: t(
        'Un opérateur a la main : ni le scénario ni l’agent n’écrivent. Une campagne, si : elle part et reprend la main.',
        'An operator has the hand: neither the scenario nor the agent writes. A campaign does: it goes out and takes the hand back.',
      ),
    },
    mba: {
      label: t('agent Meta', 'Meta agent'),
      cls: 'bg-violet-50 text-violet-700',
      title: t("L'agent de Meta répond directement au client.", 'Meta’s agent is answering the customer directly.'),
    },
  };
  const look = LOOK[owner];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${look.cls}`} title={look.title}>
      {look.label}
    </span>
  );
}
