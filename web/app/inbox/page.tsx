'use client';

import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell, UNREAD_CHANGED_EVENT } from '@/components/AppShell';
import { TemplatePreview } from '@/components/TemplatePreview';
import { isCampaignEligible } from '@/lib/campaign-eligibility';
import { dayKey, dayLabel, hourMin, jourHeure } from '@/lib/day';
import type { ControlOwner } from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { varCountOf } from '@/lib/fields';
import { repeterAvecGigue } from '@/lib/poll';
import { doitDescendre, estEnBas } from '@/lib/defilement-fil';
import { ApiError, estAnnulation } from '@/lib/http';
import { langueSortanteParDefaut, nomDeLangue } from '@/lib/langue-nom';
import {
  cibleDeLecture, ecrireTraductionActive, lireTraductionActive, marqueTraduction, texteDeBulle, texteDuVocal,
} from '@/lib/traduction-lecture';
import { ContactDetail } from '@/components/ContactDetail';
import { PieceJointeRecue } from '@/components/PieceJointeRecue';
import { DUREE_MEDIA_RECU_JOURS_AFFICHEE, legendeDePieceJointe, natureDePieceJointe } from '@/lib/piece-jointe';
import { InboxRcsPanel } from '@/components/InboxRcsPanel';
import { InboxDossiers, libelleDossier, type DossierInbox } from '@/components/InboxDossiers';
import {
  destinationsEnLot, estActionRangement, libelleRangement, type ActionRangement,
} from '@/lib/inbox-rangement';
import {
  listConversations,
  countConversationsParDossier,
  archiverConversation,
  marquerTraitee,
  type CompteursInbox,
  getSettings,
  listMembresAffectables,
  prendreConversationPourMoi,
  setConversationAssignee,
  queryContacts,
  listUserFields,
  listTags,
  type Contact,
  type UserFieldDef,
  getConversationMessages,
  releaseConversation,
  prendreConversation,
  signalerConversation,
  lireMediaMessage,
  transcrireMessage,
  effacerConversation,
  replyConversation,
  traduireSortant,
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
import { Bouton, classesBouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { Icone } from '@/components/Icone';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';

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
 * Traduit le DOSSIER de l'écran en paramètres de requête. Un seul endroit : la liste et « charger plus »
 * doivent demander EXACTEMENT le même filtre, sinon la page suivante ne serait pas la suite de la première.
 */
/**
 * Applique UN geste de rangement à UNE conversation. Point de passage unique du menu de la conversation
 * ouverte ET du menu de la sélection : deux copies de cette correspondance geste -> appel dériveraient au
 * premier dossier ajouté, et rien ne le signalerait (les deux menus compilent séparément).
 *
 * Rend le nouveau détenteur du fil quand le geste le change (« à traiter » est une PRISE de contrôle),
 * `null` sinon : l'écran de la conversation ouverte en a besoin pour rouvrir la zone de réponse tout de
 * suite, sans attendre le rechargement.
 */
async function appliquerRangement(tenantId: string, conversationId: string, action: ActionRangement): Promise<ControlOwner | null> {
  if (action === 'a-traiter') return (await prendreConversation(tenantId, conversationId)).controlOwner;
  if (action === 'signaler' || action === 'ne-plus-signaler') {
    await signalerConversation(tenantId, conversationId, action === 'signaler');
    return null;
  }
  if (action === 'traiter' || action === 'ne-plus-traiter') {
    await marquerTraitee(tenantId, conversationId, action === 'traiter');
    return null;
  }
  await archiverConversation(tenantId, conversationId, action === 'archiver');
  return null;
}

function dossierEnParams(d: DossierInbox): { aTraiter?: boolean; traitees?: boolean; signalees?: boolean; archivees?: boolean; affectee?: string | 'aucune' } {
  if (typeof d === 'object') return { affectee: d.membre };
  if (d === 'aTraiter') return { aTraiter: true };
  if (d === 'traitees') return { traitees: true };
  if (d === 'signalees') return { signalees: true };
  if (d === 'archivees') return { archivees: true };
  if (d === 'nonAffectees') return { affectee: 'aucune' };
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
      className="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

/** Rendu d'un message entrant à payload : carte « formulaire rempli » si c'est un objet, sinon bouton. */
function InboundPayload({ body, payload }: { body: string | null; payload: string }) {
  const t = useT();
  const entries = parseFormResponse(payload);
  if (!entries) return <span className="inline-flex items-center gap-1"><Icone nom="clic" taille="petite" />{body ?? payload}</span>;
  return (
    <div className="space-y-0.5">
      <div className="mb-1 flex items-center gap-1 text-xs font-semibold opacity-70"><Icone nom="formulaire" taille="petite" />{t('Formulaire rempli', 'Form response')}</div>
      {entries.map(([k, v]) => (
        <div key={k} className="text-sm">
          <span className="opacity-60">{prettyKey(k)} : </span>
          {String(v)}
        </div>
      ))}
    </div>
  );
}

/**
 * LA MARQUE D'UNE BULLE : « traduit », « traduction échouée », ou RIEN.
 *
 * 🔴 LES DEUX DERNIERS ÉTATS NE SE CONFONDENT PAS, et c'est la règle du lot. Une traduction TENTÉE qui
 * n'est pas revenue le dit ; un message au-delà du plafond de 40 n'a jamais été tenté, donc il ne dit
 * rien. Marquer le second comme un échec ferait chercher une panne inexistante sur tout l'historique
 * ancien d'une conversation, à chaque ouverture.
 *
 * ⚠️ UNE TRADUCTION EST MARQUÉE COMME TELLE, exactement comme la transcription d'un vocal : c'est la
 * lecture d'un modèle, pas ce que le client a écrit. L'original reste lisible au survol, ce qui est la
 * seule façon de le retrouver sans éteindre le réglage.
 */
function MarqueDeTraduction({ message }: { message: InboxMessage }) {
  const t = useT();
  const marque = marqueTraduction(message);
  if (marque === 'aucune') return null;
  if (marque === 'traduit') {
    return (
      <div
        data-testid={`bulle-traduite-${message.id}`}
        title={message.body ?? undefined}
        className="mt-0.5 text-xs font-medium text-ink-500"
      >
        {t('traduit', 'translated')}
      </div>
    );
  }
  return (
    <div
      data-testid={`bulle-traduction-echouee-${message.id}`}
      className="mt-0.5 text-xs font-medium text-alerte-700"
    >
      {t('traduction échouée', 'translation failed')}
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
  const [dossier, setDossier] = useState<DossierInbox>('toutes');
  /**
   * Les conversations COCHÉES, pour le rangement en lot. Vidée à chaque changement de dossier : garder une
   * sélection faite dans un autre dossier ferait ranger des lignes qu'on ne voit plus.
   */
  const [cochees, setCochees] = useState<Set<string>>(new Set());
  const [compteurs, setCompteurs] = useState<CompteursInbox>({ tout: 0, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] });
  const [rangementEnCours, setRangementEnCours] = useState(false);
  /**
   * Qui voit la charge par collaborateur.
   *
   * ⚠️ La MÊME règle que celle qui autorise à AFFECTER une conversation (`AffectationControl`) : montrer le
   * geste sans montrer la charge serait incohérent, et c'est le manager que cette section sert.
   */
  const peutAffecter = session.role === 'admin' || session.role === 'manager';
  /**
   * Puis-je PRENDRE une conversation du pot commun (migration 0160) ? Rendu par le SERVEUR avec la liste,
   * calculé par la règle de la route qui écrit : l'écran ne la recalcule pas, sinon il finirait par montrer
   * un bouton que le serveur refuse.
   */
  const [peutPrendre, setPeutPrendre] = useState(false);
  /** Une page de plus est peut-être disponible (la dernière était pleine). */
  const [peutCharger, setPeutCharger] = useState(false);
  const [chargementPage, setChargementPage] = useState(false);
  /** Fiche contact ouverte, par `waId`. `null` = fermée, et la conversation reprend toute la largeur. */
  const [ficheWaId, setFicheWaId] = useState<string | null>(null);

  /**
   * Recharge la PREMIÈRE page. Le filtre est passé au serveur : le faire en mémoire ne voyait que les
   * conversations déjà chargées, donc au-delà d'une page il ignorait le reste sans le dire.
   */
  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await listConversations(session.tenantId, { limit: TAILLE_PAGE, ...dossierEnParams(dossier) });
      const liste = Array.isArray(r?.conversations) ? r.conversations : [];
      setConversations(liste);
      setPeutPrendre(r?.peutPrendre === true);
      /**
       * 🔴 LA CONVERSATION OUVERTE SUIT LA LISTE RECHARGÉE. `selected` était une COPIE prise au clic et
       * jamais rafraîchie : après « Traité », le menu de la conversation ouverte proposait encore « Traité »
       * au lieu de son contraire, et le même défaut existait déjà pour « Signalé » et pour l'affectation.
       * Même identifiant = même `key` du fil, donc rien n'est remonté, seules les propriétés changent. Une
       * conversation qui a QUITTÉ le dossier reste affichée telle quelle : on ne ferme pas ce qu'on lit.
       */
      setSelected((prev) => (prev ? liste.find((c) => c.id === prev.id) ?? prev : prev));
      // Page pleine = il y a peut-être une suite. Pas de compteur total : il coûterait un décompte complet
      // pour dire ce que la longueur dit déjà.
      setPeutCharger(liste.length === TAILLE_PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t, dossier]);

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
        ...dossierEnParams(dossier),
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
  }, [session.tenantId, conversations, dossier, chargementPage]);

  /**
   * Les compteurs du menu, comptés par le SERVEUR sur toute la base (pas sur la page affichée).
   *
   * ⚠️ Une seule lecture pour tous les dossiers et la charge : un appel par dossier, ce seraient autant d'instants
   * différents, et le menu affiche les chiffres les uns sous les autres.
   */
  const rechargerCompteur = useCallback(async () => {
    try {
      setCompteurs(await countConversationsParDossier(session.tenantId));
    } catch {
      /* les compteurs sont un confort : leur absence ne doit pas masquer la liste */
    }
  }, [session.tenantId]);
  useEffect(() => { void rechargerCompteur(); }, [rechargerCompteur, conversations]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Changer de dossier VIDE la sélection : garder des lignes cochées dans un dossier qu'on ne regarde plus
  // ferait ranger des conversations qu'on ne voit pas.
  useEffect(() => { setCochees(new Set()); }, [dossier]);

  /** Coche ou décoche une ligne. */
  function basculerCoche(id: string): void {
    setCochees((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  /**
   * Range les conversations cochées dans le dossier choisi (2026-09-09, demande de Julien).
   *
   * 🔴 CE GESTE N'AVAIT QU'UNE SEULE DESTINATION, « Archiver », alors que la conversation ouverte en a
   * quatre depuis ce matin : cocher dix lignes ne permettait pas de les remettre « à traiter », il fallait
   * les ouvrir une par une. Les destinations offertes viennent de `destinationsEnLot`, qui les déduit du
   * DOSSIER et non de chaque ligne (une sélection est hétérogène, un libellé qui bascule n'y a pas de sens).
   *
   * ⚠️ SÉQUENTIEL et non en parallèle : chaque rangement invalide les compteurs, et vingt requêtes
   * simultanées feraient vingt recalculs pour un seul résultat. Vingt lignes cochées restent vingt appels,
   * ce qui est le prix d'un geste rare fait sur ce que l'écran affiche.
   *
   * ⚠️ Une conversation qui échoue n'arrête pas les autres : on range ce qui peut l'être, et la liste
   * rechargée montre ce qui reste. Un échec partiel qui annulerait tout serait pire.
   */
  async function rangerLesCochees(action: ActionRangement): Promise<void> {
    if (rangementEnCours || cochees.size === 0) return;
    // 🔴 « Ne plus signaler » NE PEUT RIEN sur une conversation signalée par le MODÈLE : le constat de
    // l'analyse n'est pas effaçable à la main, et la ligne resterait dans le dossier. On n'écrit donc que là
    // où le geste a un effet, au lieu d'appels qui réussissent sans rien changer. Les lignes du modèle
    // restent visiblement signalées, ce qui est la vérité.
    // Même raison pour « Ne plus marquer traité » : on n'écrit que sur les lignes qui le sont. Et pour « À
    // traiter », qu'on n'applique PAS aux lignes traitées : prendre leur fil ne les ferait pas entrer dans un
    // dossier qui les exclut, et la conversation ouverte ne propose pas ce geste sur elles non plus.
    const cibles = action === 'ne-plus-signaler'
      ? conversations.filter((c) => cochees.has(c.id) && c.signaleeMain === true).map((c) => c.id)
      : action === 'ne-plus-traiter' && dossier !== 'traitees'
        ? conversations.filter((c) => cochees.has(c.id) && c.traitee === true).map((c) => c.id)
        : action === 'a-traiter'
          ? conversations.filter((c) => cochees.has(c.id) && c.traitee !== true).map((c) => c.id)
          : [...cochees];
    if (cibles.length === 0) return;
    setRangementEnCours(true);
    setError(null);
    try {
      /**
       * 🔴 LES ÉCHECS SE COMPTENT ET SE DISENT, ILS NE S'AVALENT PLUS (2026-09-11).
       *
       * Cette boucle attrapait TOUT en silence, et c'était juste tant que le geste n'écrivait qu'en local :
       * une conversation disparue entre l'affichage et le clic ne doit pas bloquer les autres. Depuis que
       * « À traiter » appelle META (`thread_control` action `take`), un refus est un cas NORMAL et lourd de
       * conséquence : l'opérateur croirait avoir éteint l'agent de Meta sur toute sa sélection alors qu'il
       * répond encore sur une partie, et il cesserait de surveiller ces fils.
       *
       * ⚠️ ON CONTINUE QUAND MÊME la sélection : un échec partiel qui annulerait tout serait pire. Ce qui
       * change est qu'on le DIT à la fin, avec le compte.
       */
      let echecs = 0;
      // Les lignes TRAITÉES qu'« À traiter » laisse de côté : on le DIT à la fin, sans quoi l'opérateur
      // croirait avoir pris le fil de toute sa sélection. 🔴 COMPTÉES par leur statut, pas par différence :
      // une ligne cochée qui a quitté la liste rechargée (seconde page, rafraîchissement de 15 s) n'est pas
      // « traitée », et le dire lui prescrirait un geste impossible (revue du 2026-09-19).
      const ecartees = action === 'a-traiter'
        ? conversations.filter((c) => cochees.has(c.id) && c.traitee === true).length
        : 0;
      for (const id of cibles) {
        try {
          await appliquerRangement(session.tenantId, id, action);
        } catch {
          echecs += 1;
        }
      }
      setCochees(new Set());
      await reload();
      await rechargerCompteur();
      // 🔴 APRÈS LE RECHARGEMENT, ET C'EST OBLIGATOIRE : `reload` commence par `setError(null)`. Posé avant,
      // le message était effacé une milliseconde plus tard, et l'écran redevenait muet sur des refus bien
      // réels. Attrapé par l'e2e, pas par la relecture.
      // Les deux constats peuvent coexister : aucun ne doit taire l'autre.
      const constats: string[] = [];
      if (echecs > 0) {
        constats.push(t(
          `${echecs} conversation(s) sur ${cibles.length} n’ont pas pu être rangées. Rouvrez-les une par une : le détail y est affiché.`,
          `${echecs} of ${cibles.length} conversations could not be filed. Open them one by one: the reason is shown there.`,
        ));
      }
      if (ecartees > 0) {
        constats.push(t(
          `${ecartees} conversation(s) marquée(s) « Traité » laissée(s) de côté : retirez d’abord ce statut pour les remettre à traiter.`,
          `${ecartees} conversation(s) marked “Done” left out: remove that status first to put them back to handle.`,
        ));
      }
      if (constats.length > 0) setError(constats.join(' '));
    } finally {
      setRangementEnCours(false);
    }
  }

  /**
   * Deep-link `?c=<id>` : pré-sélectionne la conversation visée, UNE seule fois (pour ne pas ré-écraser un
   * choix manuel aux rafraîchissements suivants).
   *
   * 🔴 ET ELLE VA LA CHERCHER QUAND ELLE N'EST PAS DANS LA PAGE (2026-09-23). Ce lien vient désormais du
   * bouton « Ouvrir la conversation » d'une fiche du mini-CRM, et le fil d'un contact peut dater de
   * plusieurs mois : hors de la première page, donc invisible de cette liste. Le lien était alors IGNORÉ en
   * silence, ce qui se lit comme un bouton cassé. On demande le fil par son identifiant, et on l'ajoute en
   * tête de la liste affichée.
   *
   * ⚠️ IL IGNORE LE DOSSIER COURANT, délibérément : on a demandé CE fil-là. Un fil archivé ou déjà traité
   * n'appartient à aucun dossier ordinaire, et ce sont justement les cas où l'on clique pour aller le relire.
   *
   * ⚠️ ÉCHEC SILENCIEUX : une API plus ancienne que le paramètre `id` rend la liste entière, et le fil visé
   * s'y trouve ou non, exactement comme avant. On ne montre pas d'erreur pour un lien : l'Inbox reste
   * utilisable, c'est l'essentiel de l'écran.
   */
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId) return;
    const match = conversations.find((c) => c.id === deepLinkId);
    if (match) {
      setSelected(match);
      deepLinkApplied.current = true;
      return;
    }
    // ⚠️ ON ATTEND LA FIN DU PREMIER CHARGEMENT, PAS UNE LISTE NON VIDE. La liste peut etre legitimement
    // VIDE (un espace neuf, un dossier sans rien), et c'est justement le cas ou le fil visé n'y est pas :
    // se caler sur sa longueur laissait le lien sans effet, exactement le defaut qu'on repare.
    if (loading) return;
    deepLinkApplied.current = true;
    let vivant = true;
    void listConversations(session.tenantId, { id: deepLinkId, limit: 1 })
      .then((r) => {
        const conv = (r.conversations ?? []).find((c) => c.id === deepLinkId);
        if (!vivant || !conv) return;
        setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]));
        setSelected(conv);
      })
      .catch(() => { /* un lien qui ne mène nulle part ne doit pas casser l'Inbox */ });
    return () => { vivant = false; };
  }, [deepLinkId, conversations, loading, session.tenantId]);

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

  // Au moins une ligne cochée porte-t-elle un signalement HUMAIN ? C'est ce qui décide si « Ne plus
  // signaler » a un sens sur la sélection (cf. `destinationsEnLot`).
  const selectionAvecSignalementManuel = conversations.some((c) => cochees.has(c.id) && c.signaleeMain === true);
  // Même question pour « Ne plus marquer traité » hors du dossier « Traité ».
  const selectionAvecTraitee = conversations.some((c) => cochees.has(c.id) && c.traitee === true);
  // Et l'inverse, pour « À traiter », qui ne s'applique qu'aux lignes NON traitées.
  const selectionAvecNonTraitee = conversations.some((c) => cochees.has(c.id) && c.traitee !== true);

  return (
    // 🔴 LES DOSSIERS ONT LEUR PROPRE COLONNE (2026-09-09, demande de Julien). Le menu vivait AU-DESSUS de
    // la liste, dans la même colonne : cliquer « Tout » ou « À traiter » faisait apparaître les
    // conversations SOUS le menu, et il fallait redescendre pour changer de dossier. Une boîte mail ne
    // fonctionne pas comme ça : les dossiers restent à gauche, en place, et c'est la colonne d'à côté qui
    // change. Le menu est court et fixe, la liste est longue et défile : les empiler faisait défiler les
    // deux ensemble.
    //
    // Quatre colonnes au maximum quand la fiche est ouverte : c'est la CONVERSATION qui rétrécit, jamais la
    // liste, parce qu'on consulte la fiche en lisant le fil, et qu'une liste qui change de largeur perd le
    // repère visuel.
    //
    // ⚠️ Rien de tout ça en dessous de `lg` : le menu revient AU-DESSUS de la liste, empilé. Trois colonnes
    // sur un téléphone ne laisseraient rien de lisible à aucune des trois.
    //
    // 🔴 LA BORDURE DE LA COLONNE DES DOSSIERS TOMBE SOUS LE TRAIT VERTICAL DE L'ENTÊTE (Julien, 2026-09-25).
    // Ce trait ferme la zone du logo (`lg:w-60`, puis un séparateur `w-px`, `AppShell`) : la colonne part donc du
    // bord (`lg:pl-0` sur la grille) et fait ces MÊMES deux mesures, lues dans le thème et pas recopiées, pour
    // que sa bordure droite occupe exactement le pixel du trait. `inbox-dossiers.spec.ts` le mesure.
    // `grid-cols-1` sous `lg` : une colonne `minmax(0, 1fr)`. Sans elle, la piste implicite prenait la largeur
    // de son contenu le plus large (la barre d'envoi), et la page débordait de 211 px sur un téléphone.
    <div className={`grid grid-cols-1 gap-4 p-4 lg:h-full lg:pl-0 ${ficheWaId ? 'lg:grid-cols-[calc(theme(spacing.60)_+_theme(spacing.px))_320px_1fr_340px]' : 'lg:grid-cols-[calc(theme(spacing.60)_+_theme(spacing.px))_320px_1fr]'}`}>
      {/* 🔴 LE MENU DE DOSSIERS REMPLACE LES TROIS BOUTONS DE FILTRE, il ne s'y ajoute pas. Deux endroits
          pour le même choix, c'est deux états qui divergent : le dépôt l'a déjà payé sur le contrôle du
          fil. Modération comprise : « Signalé » est l'ancien bouton, dans ce menu comme les autres.
          Il défile SÉPARÉMENT : un espace à vingt collaborateurs a un menu plus long que l'écran. */}
      <div data-testid="inbox-colonne-dossiers" className="lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-ink-200 lg:pl-4 lg:pr-3">
        <InboxDossiers
          dossier={dossier}
          compteurs={compteurs}
          peutVoirAffectation={peutAffecter}
          onChange={setDossier}
        />
      </div>

      <section data-testid="inbox-liste" className="lg:flex lg:min-h-0 lg:flex-col">
        {/* Le titre nomme le DOSSIER OUVERT, pas « Conversations » : le mot était déjà l'intitulé du groupe
            dans le menu d'à côté, et deux fois le même mot côte à côte ne dit plus où l'on est. */}
        <div className="mb-2 flex items-center justify-between gap-2">
          {/*
            🔴 LE TITRE NE PORTE PLUS DE NOMBRE (revue du 2026-09-09). Il affichait `conversations.length`,
            c'est-à-dire ce qui est CHARGÉ (une page de 50), juste à côté d'un menu qui affiche le vrai total
            de l'espace : « Tout (50) » sous « Tout (200) ». Et le premier grimpait à chaque « charger plus »
            pendant que le second ne bougeait pas.
            Deux nombres pour le même dossier, côte à côte, qui se contredisent : c'est la même famille que
            les trois boutons de filtre remplacés par ce menu, « deux endroits pour la même chose sont deux
            états qui divergent ». Le compteur juste, celui de l'espace entier, vit dans le menu.
          */}
          <TitrePage className="min-w-0 truncate" data-testid="inbox-titre-dossier">
            {libelleDossier(dossier, compteurs, t)}
          </TitrePage>
          <button onClick={reload} className="shrink-0 text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
        </div>
        {/* Rangement en LOT : la barre n'apparaît qu'avec au moins une ligne cochée, pour ne pas occuper une
            place permanente au-dessus de la liste.

            🔴 UN MENU, PLUS UN BOUTON (2026-09-09, demande de Julien). Le bouton n'offrait que « Archiver » :
            une sélection ne pouvait aller QUE là, alors que la conversation ouverte se range dans quatre
            dossiers. Le menu porte les mêmes libellés (`libelleRangement`, écrit une seule fois pour les
            deux) et retombe TOUJOURS sur son titre, comme celui de la conversation : il déclenche une
            action, il ne porte pas un état. */}
        {cochees.size > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-controle bg-brand-50 px-2.5 py-1.5 text-xs">
            <span className="text-brand-800">{t(`${cochees.size} sélectionnée(s)`, `${cochees.size} selected`)}</span>
            <select
              data-testid="inbox-ranger-selection"
              aria-label={t('Ranger la sélection', 'File the selection')}
              disabled={rangementEnCours}
              value=""
              onChange={(e) => { const v = e.target.value; if (estActionRangement(v)) void rangerLesCochees(v); }}
              className="ml-auto rounded-controle border border-brand-300 bg-white px-2 py-1 font-medium text-brand-800 disabled:opacity-40"
            >
              <option value="">{rangementEnCours ? t('...', '...') : t('Ranger dans…', 'File in…')}</option>
              {destinationsEnLot(dossier, selectionAvecSignalementManuel, selectionAvecTraitee, selectionAvecNonTraitee).map((a) => (
                <option key={a} value={a}>{libelleRangement(a, t)}</option>
              ))}
            </select>
          </div>
        )}
        {error && <p className="mb-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        {loading ? (
          <Squelette forme="lignes" />
        ) : visible.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-500">
            {dossier === 'aTraiter'
              ? t('Rien à traiter : toutes les conversations sont gérées par le scénario.', 'Nothing to handle: every conversation is handled by the scenario.')
              : dossier === 'traitees'
                ? t('Aucune conversation traitée : marquez « Traité » celles qui n’attendent plus rien.', 'No conversation marked as done: mark as done those that need nothing more.')
              : dossier === 'signalees'
                ? t('Aucune conversation signalée : l’analyse relève les injures environ 15 min après le dernier message.', 'No flagged conversation: the analysis spots abuse about 15 min after the last message.')
                : dossier === 'archivees'
                  ? t('Aucune conversation archivée : cochez-en une et rangez-la ici quand elle est finie.', 'No archived conversation: tick one and file it here when it is done.')
                  : typeof dossier === 'object' || dossier === 'nonAffectees'
                    ? t('Aucune conversation dans ce dossier.', 'No conversation in this folder.')
                    : t('Aucune conversation : elles apparaissent quand un client répond à une campagne.', 'No conversations yet: they appear when a customer replies to a campaign.')}
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
                  data-testid={`inbox-ligne-${c.id}`}
                  data-mba={c.controlOwner === 'mba' ? 'oui' : undefined}
                  className={`relative w-full rounded-carte border px-3 py-2 transition-colors duration-150 ${
                    selected?.id === c.id
                      ? 'border-brand-500 bg-brand-50'
                      /* 🔴 UN FIL TENU PAR L'AGENT DE META SE VOIT SANS SE LIRE (demande de Julien,
                         2026-09-11). Un fond bleu clair et une baguette : on balaie la colonne et on sait
                         d'un coup d'œil ce que Meta tient, au lieu de lire une pastille de onze pixels sur
                         chaque ligne. La mention texte « agent Meta » disparaît d'ici, elle faisait double
                         emploi ; elle reste dans l'en-tête du fil, où l'on a besoin du mot exact.
                         ⚠️ LA SÉLECTION GAGNE, et c'est volontaire : savoir OÙ L'ON EST prime sur savoir qui
                         tient le fil, qu'on lit alors dans l'en-tête juste à côté.
                         ⚠️ UN APLAT ET NON PLUS UN DÉGRADÉ depuis le 2026-09-25 (passe « anti-slop ») : le dégradé
                         bleu-violet était décoratif, l'aplat dit la même chose. */
                      : c.controlOwner === 'mba'
                        ? 'border-brand-200 bg-brand-50/60 hover:bg-brand-50'
                        : 'border-ink-200 bg-white hover:bg-ink-50'
                  }`}
                >
                  <button
                    onClick={() => setSelected(c)}
                    aria-label={t('Ouvrir la conversation', 'Open conversation')}
                    className="absolute inset-0 rounded-carte"
                  />
                  {/* `pointer-events-none` sur le contenu, `auto` sur le seul bouton du nom : sans ça le
                      contenu recouvre le bouton de fond, et un clic au milieu de la vignette n'ouvrirait
                      RIEN. Le geste de tous les jours doit marcher partout sur la ligne. */}
                  {/*
                    🔴 LA CASE EST HORS DU FLUX, posée en absolu sur le bord gauche, et le contenu prend une
                    marge à gauche. Mise DANS la ligne de contenu, elle décalait le nom du contact jusqu'au
                    CENTRE de la vignette : le nom y interceptait le clic destiné au bouton de fond, et un
                    clic au milieu de la ligne ouvrait la fiche au lieu de la conversation. Attrapé par
                    `inbox-fiche-contact.spec.ts`, qui garde exactement ce geste.

                    `pointer-events-auto` et `z-10` : le bouton de fond couvre toute la vignette en absolu,
                    donc sans eux un clic sur la case ouvrirait la conversation au lieu de cocher.
                  */}
                  <input
                    type="checkbox"
                    data-testid={`cocher-${c.id}`}
                    checked={cochees.has(c.id)}
                    onChange={() => basculerCoche(c.id)}
                    aria-label={t('Sélectionner cette conversation', 'Select this conversation')}
                    className="pointer-events-auto absolute left-2 top-1/2 z-10 -translate-y-1/2 accent-brand-500"
                  />
                  <div className="pointer-events-none relative ml-5 flex items-baseline justify-between gap-2">
                    <span className={`flex min-w-0 items-baseline text-sm ${c.unread ? 'font-semibold text-ink-900' : 'font-medium'}`}>
                      {/* Point de non-lu : le compteur du menu doit pouvoir se traduire en action, sinon il dit
                          « 3 » sans dire lesquelles. */}
                      {c.unread && <span data-testid="unread-dot" className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-danger align-middle" aria-label={t('non lu', 'unread')} />}
                      {/* 🔴 LA BAGUETTE PORTE CE QUE LE TEXTE DISAIT, infobulle comprise. Retirer la
                          mention sans rien mettre à la place aurait retiré l'information à qui ne connaît
                          pas encore le code couleur, et à qui navigue au lecteur d'écran. */}
                      {c.controlOwner === 'mba' && (
                        <span
                          data-testid={`inbox-baguette-${c.id}`}
                          title={t('L’agent de Meta répond directement au client.', 'Meta’s agent is answering the customer directly.')}
                          aria-label={t('agent Meta', 'Meta agent')}
                          role="img"
                          className="mr-1.5 shrink-0 text-brand-600"
                        >
                          {/* Une baguette. Une icône plutôt qu'un emoji : un emoji change de tête selon le
                              système, et celui-ci doit rester le même signe pour tout le monde, parce qu'il
                              REMPLACE un mot (le nom accessible est porté par le `span`). */}
                          <Icone nom="baguette" taille="ligne" className="inline align-[-0.2em]" />
                        </span>
                      )}
                      <button
                        onClick={() => setFicheWaId(c.waId)}
                        data-testid={`open-contact-${c.id}`}
                        title={t('Voir la fiche du contact', 'View contact record')}
                        className="pointer-events-auto truncate text-left hover:underline"
                      >
                        {c.profileName ?? `+${c.waId}`}
                      </button>
                      {/* 🔴 LA SEULE PASTILLE DE LA LISTE, et c'est un arbitrage explicite de Julien du 2026-09-19
                          (« Traité » reste dans « Tout » AVEC une pastille), qui fait exception à celui du
                          2026-09-11 (« plus aucun badge »). Sans elle, une conversation traitée serait
                          indiscernable dans « Tout » d'une conversation qui attend. Absente du dossier « Traité »,
                          dont le titre dit déjà la même chose. */}
                      {c.traitee === true && dossier !== 'traitees' && (
                        <span
                          data-testid={`inbox-traitee-${c.id}`}
                          className="ml-1.5 shrink-0 rounded-full bg-succes-100 px-1.5 py-px text-xs font-medium text-ink-500"
                        >
                          {t('Traité', 'Done')}
                        </span>
                      )}
                    </span>
                    <span className="pointer-events-none shrink-0 text-xs text-ink-500">{jourHeure(c.lastMessageAt, locale)}</span>
                  </div>
                  {/* 🔴 PLUS AUCUN BADGE DANS LA LISTE (demande de Julien, 2026-09-11 : « quand un agent a
                      la main, laisse juste le frame en blanc, pas obligé d'écrire Vous avez la main »).
                      Le badge `mba` était déjà parti, remplacé par le dégradé et la baguette ; celui de
                      l'humain part à son tour, et il ne reste rien. C'est cohérent : la liste sert à
                      REPÉRER l'exception, et l'exception est désormais la seule chose colorée. Le
                      détenteur exact se lit dans l'en-tête de la conversation ouverte, où l'on a la place
                      et le besoin du mot juste. */}
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
                  className="w-full rounded-controle px-3 py-2 text-xs font-medium text-brand-600 transition-colors duration-150 hover:bg-brand-50 disabled:opacity-50"
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
          <Thread key={selected.id} session={session} conversation={selected} dossier={dossier} peutPrendre={peutPrendre} onSent={reload} />
        ) : (
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-carte border border-ink-200 bg-white text-sm text-ink-500">
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
    return <div className="rounded-carte border border-ink-200 bg-white p-4"><Squelette forme="fil" lignes={4} /></div>;
  }
  if (etat !== 'ok' || !contact) {
    return (
      <div className="rounded-carte border border-ink-200 bg-white p-4 text-sm text-ink-500">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-ink-900">{`+${waId}`}</span>
          <button onClick={onClose} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
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
/**
 * RANGER LA CONVERSATION OUVERTE dans un dossier (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUI MANQUAIT, ET POURQUOI ÇA SE VOYAIT MAL. Seul « Archivé » était atteignable, et seulement depuis
 * la LISTE, en cochant une case : sur la conversation ouverte, aucun rangement n'existait. Surtout, remettre
 * une conversation « à traiter » était impossible autrement qu'en ENVOYANT un message, puisque c'est l'envoi
 * qui prend le fil. On écrivait donc à un client pour un geste de rangement interne.
 *
 * ⚠️ LA LISTE A DEPUIS SON PROPRE MENU (le même jour, seconde demande de Julien) : la barre de sélection
 * offre les mêmes destinations pour plusieurs conversations d'un coup. Les deux menus partagent les
 * libellés et l'application du geste (`libelleRangement`, `appliquerRangement`) mais PAS le choix des
 * options, et c'est délibéré : voir `destinationsEnLot`.
 *
 * ⚠️ CE MENU N'OFFRE JAMAIS « À traiter » EN MÊME TEMPS QUE LE BOUTON « Rendre la main », et c'est ce qui
 * évite deux endroits pour le même choix : ce sont les deux moitiés d'une bascule, l'une n'apparaît que
 * quand l'autre est absente. Le bouton reste où il est, il porte une histoire d'incident et ses propres cas
 * de test.
 *
 * ⚠️ L'AFFECTATION à un membre n'est PAS ici : elle est ORTHOGONALE (une conversation peut être affectée à
 * quelqu'un ET tenue par le scénario), et le serveur fait respecter cette séparation. Les réunir dans un
 * seul menu laisserait croire qu'on choisit entre les deux.
 */
function RangerDans({ session, conversation, dossier, controlOwner, onFait }: {
  session: Session;
  conversation: Conversation;
  dossier: DossierInbox;
  controlOwner: ControlOwner;
  onFait: (owner: ControlOwner | null) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const archivee = dossier === 'archivees';
  const signaleeMain = conversation.signaleeMain === true;
  const traitee = conversation.traitee === true;
  /**
   * CE FIL A-T-IL DEJA PORTE UN MESSAGE ?
   *
   * ⚠️ L'APERCU EST CE QUE L'ECRAN SAIT, et il suffit : toute ecriture de message en pose un
   * (`upsertConversationByWaId`), et un fil qu'un operateur vient d'OUVRIR depuis la fiche d'un contact n'en
   * a aucun. C'est le seul etat qui produit un aperçu nul.
   */
  const aParle = conversation.lastPreview !== null;

  async function ranger(action: ActionRangement): Promise<void> {
    setBusy(true);
    try {
      onFait(await appliquerRangement(session.tenantId, conversation.id, action));
    } catch {
      /* L'échec se voit à l'absence de changement dans la liste, comme pour l'affectation : une alerte au
         milieu d'une conversation coûte plus qu'elle n'apprend. */
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      data-testid="ranger-dans"
      aria-label={t('Ranger la conversation', 'File the conversation')}
      disabled={busy}
      // La valeur retombe TOUJOURS sur le libellé : ce menu déclenche une action, il ne porte pas un état.
      // Laisser l'option choisie affichée ferait croire à un réglage, et re-choisir la même ne ferait rien.
      value=""
      onChange={(e) => { const v = e.target.value; if (estActionRangement(v)) void ranger(v); }}
      className="rounded-controle border border-ink-300 bg-white px-2 py-0.5 text-xs text-ink-900 disabled:opacity-50"
    >
      <option value="">{busy ? t('...', '...') : t('Ranger dans…', 'File in…')}</option>
      {/* 🔴 ICI les options se déduisent de l'ÉTAT DE CETTE conversation, pas du dossier : on en connaît le
          détenteur et la nature du signalement. Le menu de la SÉLECTION ne le peut pas (elle est hétérogène)
          et se déduit du dossier, cf. `destinationsEnLot`. Les libellés, eux, sont les mêmes des deux côtés.

          « À traiter » SEULEMENT quand le scénario tient le fil : sinon la conversation y est déjà, et c'est
          le bouton « Rendre la main » qui offre le geste inverse. */}
      {/* ⚠️ Et jamais sur une conversation TRAITÉE : prendre le fil ne la ferait pas entrer dans « À
          traiter », que le statut exclut. C'est « Ne plus marquer traité » qui l'y rend. */}
      {/* ⚠️ ET JAMAIS SUR UN FIL SANS AUCUN MESSAGE (relecture du 2026-09-23). Un fil qu'on vient d'ouvrir
          depuis une fiche contact est `app_workflow` par defaut : l'option s'affichait, la prise du fil
          REUSSISSAIT, et le fil n'entrait pourtant pas dans « A traiter », que ce dossier exclut faute de
          message. L'ecran annoncait donc un succes sans effet visible, ce qui est le motif « offert-et-inerte »
          que ce produit s'interdit ailleurs. */}
      {controlOwner === 'app_workflow' && !traitee && aParle && <option value="a-traiter">{libelleRangement('a-traiter', t)}</option>}
      {/* « Traité » ou son contraire, selon l'état de CETTE conversation. Rien depuis Archivé : une
          conversation archivée n'apparaît dans aucun dossier ordinaire, le statut n'y serait pas visible. */}
      {!archivee && (traitee
        ? <option value="ne-plus-traiter">{libelleRangement('ne-plus-traiter', t)}</option>
        : <option value="traiter">{libelleRangement('traiter', t)}</option>)}
      {signaleeMain
        ? <option value="ne-plus-signaler">{libelleRangement('ne-plus-signaler', t)}</option>
        : <option value="signaler">{libelleRangement('signaler', t)}</option>}
      {archivee
        ? <option value="desarchiver">{libelleRangement('desarchiver', t)}</option>
        : <option value="archiver">{libelleRangement('archiver', t)}</option>}
    </select>
  );
}


/**
 * UN VOCAL DANS LE FIL : l'ECOUTER, ou le faire TRANSCRIRE (2026-09-09, demande de Julien).
 *
 * 🔴 LE CHOIX EST A L'OPERATEUR, ET C'EST LUI QUI L'A TRANCHE : « il faut qu'il ait le choix, soit l'ecouter
 * avec un petit bouton lecture, soit le demander a transcrire ». Neuf fois sur dix il ecoutera, c'est plus
 * rapide que de lire. Transcrire automatiquement ferait payer un service que personne n'a demande.
 * ⚠️ Le chemin de l'AGENT sera l'inverse (automatique et obligatoire), parce qu'un modele ne sait pas ecouter.
 *
 * 🔴 RIEN N'EST TELECHARGE AU RENDU. Un fil de trente messages dont dix vocaux tirerait vingt mega a
 * l'ouverture, pour des fichiers que personne n'ecoutera. Les octets ne partent qu'au clic.
 *
 * ⚠️ POURQUOI UN BLOB ET PAS UN `src` : une balise `<audio src>` ne sait pas poser d'en-tete
 * `Authorization`, elle ne peut donc atteindre aucune de nos routes. On recupere les octets avec le jeton,
 * et on en fabrique une URL locale, revoquee au demontage sous peine de fuite memoire.
 *
 * ⚠️ LA TRANSCRIPTION EST MARQUEE COMME TELLE. C'est la lecture d'un modele, pas ce que le client a ecrit :
 * la presenter comme une citation ferait prendre une supposition pour un fait, et un operateur qui reprend
 * une conversation menee par l'IA n'aurait aucun moyen de le savoir. Le vocal reste ecoutable a cote.
 */
function VocalMessage({ session, conversationId, message, traduire }: {
  session: Session; conversationId: string; message: InboxMessage;
  /**
   * La langue de lecture, ou `null` quand le réglage est éteint.
   *
   * 🔴 UN SEUL GESTE POUR L'OPÉRATEUR : un vocal espagnol revient dans sa langue sans qu'il ait à
   * transcrire puis à traduire. Le serveur sait déjà le faire (`transcrireMessage` prend la cible) ; ce
   * qui manquait, c'est que l'écran la lui dise.
   */
  traduire: 'fr' | 'en' | null;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  /**
   * Ce qui s'affiche sous le lecteur, et s'il s'agit de notre lecture.
   *
   * ⚠️ La traduction d'une transcription DÉJÀ rangée arrive avec le fil (`affiche`), pas avec un clic :
   * au rechargement d'une conversation dont le vocal avait été transcrit, elle doit revenir traduite,
   * sinon une bulle resterait en espagnol au milieu d'un fil français sans raison visible.
   */
  const initial = texteDuVocal(message);
  const [texte, setTexte] = useState<string | null>(initial.texte);
  const [traduit, setTraduit] = useState<boolean>(initial.traduit);
  const [occupe, setOccupe] = useState<'audio' | 'texte' | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  /**
   * 🔴 LE VOCAL A DISPARU CHEZ WHATSAPP (sept jours, mesuré le 2026-09-19). Les deux boutons échouaient alors
   * à chaque clic sur « ce vocal n'a pas pu être récupéré », ce qui fait réessayer. Le serveur le dit
   * d'avance (`mediaExpire`), ou par un 410 si WhatsApp l'a effacé plus tôt.
   */
  const [expire, setExpire] = useState(message.mediaExpire === true);

  // Révoque l'URL d'objet au démontage : sans ça, chaque vocal écouté garde ses octets en mémoire du
  // navigateur jusqu'au rechargement de la page.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function ecouter(): Promise<void> {
    setOccupe('audio'); setErreur(null);
    try {
      setUrl(URL.createObjectURL(await lireMediaMessage(session.tenantId, conversationId, message.id)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) setExpire(true);
      else setErreur(t('Ce vocal n’a pas pu être récupéré.', 'This voice note could not be fetched.'));
    } finally { setOccupe(null); }
  }

  async function transcrire(): Promise<void> {
    setOccupe('texte'); setErreur(null);
    try {
      const r = await transcrireMessage(session.tenantId, conversationId, message.id, traduire);
      /**
       * ⚠️ `texte` RESTE CE QUI A ÉTÉ DIT, et la traduction est un champ à part : on affiche la seconde
       * quand elle existe, mais on ne confond pas les deux. Une traduction qui échoue (`null`) laisse
       * donc la transcription, jamais une bulle vide.
       */
      setTexte(r.traduction ?? r.texte);
      setTraduit(r.traduction !== null && r.traduction !== undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) setExpire(true);
      else setErreur(t('La transcription a échoué, réessayez.', 'Transcription failed, try again.'));
    } finally { setOccupe(null); }
  }

  return (
    <div className="space-y-1" data-testid={`vocal-${message.id}`}>
      {/* Expiré : ni « Écouter » ni « Transcrire », qui échoueraient. Une transcription faite AVANT reste
          affichée plus bas, elle est à nous. */}
      {expire && !url && (
        <p className="flex items-center gap-1 text-xs italic opacity-80" data-testid={`vocal-expire-${message.id}`}>
          <Icone nom="micro" taille="petite" />
          {t(
            `Vocal expiré : WhatsApp ne garde les pièces jointes que ${DUREE_MEDIA_RECU_JOURS_AFFICHEE} jours.`,
            `Voice note expired: WhatsApp only keeps attachments for ${DUREE_MEDIA_RECU_JOURS_AFFICHEE} days.`,
          )}
        </p>
      )}
      {expire && !url ? null : url
        // eslint-disable-next-line jsx-a11y/media-has-caption
        ? <audio src={url} controls autoPlay className="h-8 max-w-[220px]" data-testid={`vocal-lecteur-${message.id}`} />
        : (
          <button
            type="button"
            onClick={() => { void ecouter(); }}
            disabled={occupe !== null}
            data-testid={`vocal-ecouter-${message.id}`}
            className="inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium text-ink-900 hover:bg-white disabled:opacity-50"
          >
            {occupe === 'audio' ? t('Chargement…', 'Loading…') : <><Icone nom="ecouter" taille="petite" />{t('Écouter', 'Listen')}</>}
          </button>
        )}
      {texte === null && !expire && (
        <button
          type="button"
          onClick={() => { void transcrire(); }}
          disabled={occupe !== null}
          data-testid={`vocal-transcrire-${message.id}`}
          className="ml-1 rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium text-ink-900 hover:bg-white disabled:opacity-50"
        >
          {occupe === 'texte' ? t('Transcription…', 'Transcribing…') : t('Transcrire', 'Transcribe')}
        </button>
      )}
      {texte !== null && (
        <p className="rounded-controle bg-white/60 px-2 py-1 text-xs text-ink-900" data-testid={`vocal-texte-${message.id}`}>
          {/* L'étiquette DIT laquelle des deux lectures on montre. « transcription » sur un texte traduit
              ferait passer notre lecture pour ce qui a été dit, et le fil sert de trace. */}
          <span className="mr-1 font-medium text-ink-500">
            {traduit ? t('transcription traduite', 'translated transcript') : t('transcription', 'transcript')}
          </span>
          {texte}
        </p>
      )}
      {erreur && <p className="text-xs text-danger-600" data-testid={`vocal-erreur-${message.id}`}>{erreur}</p>}
    </div>
  );
}

function AffectationControl({ session, conversation, peutPrendre, onChange }: {
  session: Session; conversation: Conversation;
  /** Le serveur dit que je peux PRENDRE une conversation du pot commun (migration 0160). */
  peutPrendre: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const peutAffecter = session.role === 'admin' || session.role === 'manager';
  const [membres, setMembres] = useState<Array<{ id: string; nom: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [refusPrise, setRefusPrise] = useState<string | null>(null);
  const affecte = conversation.assignedTo ?? null;

  useEffect(() => {
    if (!peutAffecter) return;
    /**
     * 🔴 `listMembresAffectables` ET PLUS `listUsers` (2026-09-19). Ce sélecteur lisait `GET /users`, réservé
     * aux ADMINS : chez un manager, qui a pourtant le droit d'affecter, la liste revenait vide et il ne
     * pouvait confier la conversation à personne. Silencieux, et VALIDÉ côté client : une réponse mal formée
     * ne doit pas faire tomber le fil entier, seulement ce menu.
     */
    listMembresAffectables(session.tenantId)
      .then((m) => setMembres(m))
      .catch(() => setMembres([]));
  }, [session.tenantId, peutAffecter]);

  /**
   * « JE M'EN OCCUPE » : l'agent se sert dans le pot commun (migration 0160, arbitrage de Julien du
   * 2026-09-19). Le serveur l'affecte à la SESSION, jamais à un identifiant qu'on lui passerait, et répond
   * 409 si un collègue a été plus rapide : on le dit, puis la liste rechargée montre qui l'a prise.
   */
  async function prendre(): Promise<void> {
    setBusy(true); setRefusPrise(null);
    try {
      await prendreConversationPourMoi(session.tenantId, conversation.id);
    } catch (err) {
      setRefusPrise(err instanceof Error ? err.message : t('Impossible de prendre cette conversation.', 'Could not take this conversation.'));
    } finally {
      setBusy(false);
      onChange();
    }
  }

  /**
   * 🔴 LE REFUS RESTE AFFICHÉ APRÈS LE RECHARGEMENT (revue du 2026-09-19). `onChange` recharge la liste juste
   * après l'échec : la conversation passe alors « suivie par » le collègue plus rapide, ou le bouton
   * disparaît si le réglage vient d'être coupé, et le message partait AVEC le bouton. Il vit donc à côté de
   * tout ce que ce composant rend, pas dans la seule branche du bouton.
   */
  const refus = refusPrise ? <span className="text-xs text-danger-600" data-testid="prendre-refus">{refusPrise}</span> : null;

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
    // Personne ne l'a, et l'espace permet aux agents de se servir : le bouton. Rien d'autre n'est offert,
    // ni la passer à un collègue ni la rendre ensuite : prendre n'est pas réaffecter.
    if (affecte === null && peutPrendre) {
      return (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => { void prendre(); }}
            disabled={busy}
            data-testid="prendre-conversation"
            className="rounded-full border border-brand-500 px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
          >
            {t('Je m’en occupe', 'I’ll take it')}
          </button>
          {refus}
        </span>
      );
    }
    if (affecte === null) return refus;
    const pourMoi = conversation.assignedToMe === true;
    return (
      <span className="flex items-center gap-1.5">
        <span
          data-testid="assignment-badge"
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${pourMoi ? 'bg-brand-50 text-brand-700' : 'bg-ink-100 text-ink-500'}`}
        >
          {pourMoi
            ? t('pour moi', 'assigned to me')
            : t(`suivi par ${conversation.assignedToName ?? '…'}`, `handled by ${conversation.assignedToName ?? '…'}`)}
        </span>
        {refus}
      </span>
    );
  }
  return (
    <select
      data-testid="assignment-select"
      value={affecte ?? ''}
      disabled={busy}
      onChange={(e) => { void choisir(e.target.value); }}
      className="rounded-controle border border-ink-300 px-2 py-0.5 text-xs text-ink-900 disabled:opacity-50"
      title={t('Affecter cette conversation', 'Assign this conversation')}
    >
      <option value="">{t('Non affectée', 'Unassigned')}</option>
      {/* 🔴 L'AFFECTATAIRE ACTUEL EST TOUJOURS DANS LA LISTE (revue du 2026-09-19). La liste ne porte que les
          comptes ACTIFS : une conversation encore confiée à un membre révoqué n'avait pas son option, et le
          menu affichait « Non affectée » alors que les agents restaient bloqués en écriture. */}
      {affecte !== null && !membres.some((m) => m.id === affecte) && (
        <option value={affecte}>{conversation.assignedToName ?? t('Membre retiré', 'Removed member')}</option>
      )}
      {membres.map((m) => (
        <option key={m.id} value={m.id}>{m.nom}</option>
      ))}
    </select>
  );
}

function Thread({ session, conversation, dossier, peutPrendre, onSent }: {
  session: Session; conversation: Conversation;
  /** Le dossier OUVERT. Sert au menu de rangement : « Désarchiver » ne se propose que depuis Archivé. */
  dossier: DossierInbox;
  /** Je peux PRENDRE une conversation du pot commun (rendu par le serveur avec la liste). */
  peutPrendre: boolean;
  onSent: () => void;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const { locale } = useLocale();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  // Qui détient le fil. Sans cette information, l'opérateur voit le scénario se taire sans comprendre
  // pourquoi, et ne sait pas s'il doit rendre la main.
  const [controlOwner, setControlOwner] = useState<ControlOwner>('app_workflow');
  /**
   * L'agent de Meta est-il allumé sur cet espace ?
   *
   * 🔴 SANS LUI, LE BOUTON DISPARAÎT AU PIRE MOMENT (constaté par Julien le 2026-09-10). Quand l'agent de
   * Meta passe la conversation à un humain, le fil nous revient et le détenteur devient `app_workflow` :
   * l'ancienne condition `controlOwner !== 'app_workflow'` cachait alors le bouton. Or c'est PRÉCISÉMENT le
   * moment où un opérateur peut vouloir la rendre, avant même d'avoir répondu, parce qu'il vient de lire et
   * de juger que ce n'est pas pour lui.
   */
  const [mbaActif, setMbaActif] = useState(false);
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
  /**
   * LA TRADUCTION D'UN SORTANT (migration 0137), et ses deux états.
   *
   * `langueContact` est la langue APPRISE du contact, `null` tant qu'on n'a rien appris : le bouton
   * nomme alors la langue par défaut, donc il ne ment jamais sur sa cible.
   *
   * 🔴 `redactionOrigine` GARDE CE QUE L'OPÉRATEUR AVAIT ÉCRIT, et il part avec l'envoi : `body`
   * portera ce qui est PARTI (le traduit, c'est ce que le client recevra), cette colonne l'original.
   * Ne garder qu'un des deux est faux dans les deux sens.
   */
  const [langueContact, setLangueContact] = useState<string | null>(null);
  const [traduction, setTraduction] = useState<{ origine: string; traduit: string } | null>(null);
  const [traduisant, setTraduisant] = useState(false);
  /**
   * LIRE LES MESSAGES REÇUS DANS SA LANGUE (2026-09-13), par NAVIGATEUR comme le choix de langue.
   *
   * ⚠️ LU AU PREMIER RENDU, et c'est possible ici SANS risque d'hydratation : `Thread` n'existe que
   * lorsqu'une conversation est sélectionnée, donc jamais pendant le rendu serveur (qui affiche
   * « Sélectionne une conversation »). Le lire dans un effet, comme le fait `LocaleProvider` qui lui
   * est rendu côté serveur, coûterait un chargement de fil EN VO avant le vrai, donc un aller-retour
   * complet pour rien à chaque ouverture de conversation.
   */
  const [traduireRecus, setTraduireRecus] = useState<boolean>(() => lireTraductionActive());
  /** La traduction n'a pas pu se faire. Rendu par le serveur SEULEMENT quand on demande `traduire`. */
  const [traductionIndisponible, setTraductionIndisponible] = useState(false);
  /**
   * POURQUOI, parce que les deux causes n'appellent pas le même geste (revue du 2026-09-13).
   *
   * 🔴 CE BANDEAU A AFFIRMÉ « le crédit de cet espace est épuisé » DANS LES DEUX CAS, et c'était faux
   * dans celui qui était justement l'état de la production : aucun modèle de traduction n'y est
   * configuré. On envoyait donc un administrateur recharger un crédit sans rapport, en lui cachant la
   * seule cause réelle. Une phrase fausse coûte plus cher qu'aucune phrase, parce qu'on la suit.
   */
  const [traductionCause, setTraductionCause] = useState<'instance' | 'credit' | null>(null);
  /** La langue demandée au serveur, ou `undefined` : c'est celle de la console, jamais une question de plus. */
  const cibleLecture = cibleDeLecture(traduireRecus, locale);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [showRcs, setShowRcs] = useState(false);
  // Canal RCS allumé pour cet espace ? Déduit du dépôt d'agent côté serveur, comme dans les campagnes et le
  // builder. Éteint -> aucun bouton RCS : proposer un envoi qui finira en 422 n'aide personne.
  const [rcsEnabled, setRcsEnabled] = useState(false);
  useEffect(() => {
    void getSettings(session.tenantId).then((s) => {
      setRcsEnabled(s.rcsEnabled === true);
      setMbaActif(s.mbaEnabled === true);
    }).catch(() => {});
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
  /**
   * 🔴 UNE REQUÊTE DE FIL EST-ELLE ENCORE EN VOL ? C'EST LA GARDE QUI EMPÊCHE DE PAYER EN BOUCLE.
   *
   * Depuis que le fil se fait TRADUIRE (2026-09-13), sa requête peut durer jusqu'à 20 secondes (le
   * plafond que s'accorde le traducteur) pendant que le minuteur la relance toutes les 4 secondes. Or
   * `abort()` ferme la connexion du NAVIGATEUR : il n'annule pas l'appel au modèle, déjà parti, déjà
   * facturé au crédit prépayé du client. Et comme le curseur du delta ne se pose qu'à la RÉCEPTION
   * d'une réponse, chaque tour repartait du fil ENTIER et relançait une traduction complète.
   *
   * Résultat mesuré au diff : jusqu'à cinq traductions payées du même lot par minute, en boucle tant
   * que l'opérateur reste sur la conversation, et un écran qui peut ne jamais afficher la traduction
   * puisque chaque requête est tuée avant d'aboutir.
   *
   * ⚠️ LE TICK PASSE SON TOUR, IL N'ANNULE PLUS. L'annulation reste pour ce qui la justifie vraiment :
   * un changement de conversation, la sortie de l'écran, et depuis le 2026-09-13 le changement de
   * LANGUE DE LECTURE. Dans les trois cas la réponse en vol ne nous intéresse plus, et les trois sont
   * des gestes DÉLIBÉRÉS de l'opérateur, pas un minuteur : c'est ce qui les sépare du tour de 4 s.
   * Basculer deux fois de suite paie donc deux lots, et c'est le prix assumé d'un geste voulu.
   */
  const enCoursRef = useRef(false);
  /**
   * 🔴 LE PROCHAIN CHARGEMENT REMPLACE LE FIL AU LIEU DE S'Y AJOUTER. Posé quand la langue de lecture
   * change, et seulement là.
   *
   * Sans lui, remettre `bornRef` à zéro ne suffirait PAS : le serveur renverrait bien le fil entier,
   * mais l'écran n'ajoute que les identifiants qu'il ne connaît pas encore (c'est sa garde anti-doublon).
   * Les bulles déjà affichées garderaient donc leur langue d'avant pour toujours, et l'opérateur verrait
   * un fil à moitié traduit sans pouvoir rien y faire.
   *
   * ⚠️ EXPLICITE, et jamais déduit de « `bornRef` est nul ». Un fil dont le serveur ne rend pas de
   * curseur repart du fil entier à CHAQUE tour : remplacer à chaque fois donnerait un nouveau tableau
   * toutes les 4 secondes, donc une nouvelle référence, donc l'effet de défilement relancé en boucle.
   * C'est cette référence stable qui rend le fil calme.
   */
  const remplacerAuProchainRef = useRef(false);

  const load = useCallback(async (o?: { passerSiEnVol?: boolean }) => {
    if (o?.passerSiEnVol === true && enCoursRef.current) return;
    enVolRef.current?.abort();
    const ctrl = new AbortController();
    enVolRef.current = ctrl;
    enCoursRef.current = true;
    try {
      // DELTA (lot 5 du programme II) : on ne redemande que ce qui est arrivé APRÈS ce qu'on a déjà. Le fil
      // se rafraîchit toutes les 4 s ; il retéléchargeait jusqu'à 500 messages à chaque tour, par onglet.
      const res = await getConversationMessages(session.tenantId, conversation.id, {
        ...(bornRef.current ? { apres: bornRef.current } : {}),
        // La langue de LECTURE, celle de la console. Absente = la réponse est mot pour mot celle
        // d'avant ce lot, et aucun appel de modèle n'est payé.
        ...(cibleLecture ? { traduire: cibleLecture } : {}),
        signal: ctrl.signal,
      });
      // ⚠️ CONSOMMÉ ICI, après la réponse et pas avant : une requête qui échoue ou qui est annulée doit
      // laisser le remplacement DÛ, sinon le fil resterait à moitié traduit jusqu'au prochain clic.
      const remplacer = remplacerAuProchainRef.current;
      remplacerAuProchainRef.current = false;
      // 🔴 REMPLACEMENT INTÉGRAL : les bulles déjà à l'écran viennent de changer de langue, et leurs
      // identifiants n'ont pas bougé. L'ajout dédoublonné ci-dessous les laisserait telles quelles.
      if (remplacer) setMessages(res.messages);
      // ⚠️ On AJOUTE, SAUF au changement de langue de lecture traité juste au-dessus. Conséquence assumée
      // de l'ajout : un message effacé côté serveur reste à l'écran jusqu'au prochain changement de
      // conversation. Le produit n'efface pas de message, et le fil se remonte à chaque sélection
      // (`key={selected.id}`), donc l'écart ne survit pas à un clic.
      if (res.messages.length > 0) {
        const arrivee = res.messages[res.messages.length - 1]!;
        // 🔴 LE CURSEUR VIENT DU SERVEUR ET REPART TEL QUEL. Il valait `createdAt`, qui a traversé un `Date`
        // JavaScript et n'a donc que la milliseconde là où Postgres stocke la microseconde : le dernier
        // message repassait le filtre à chaque tour et se ré-ajoutait au fil toutes les 4 secondes, ce qui
        // faisait défiler l'écran tout seul. Curseur absent (serveur plus ancien) : on n'en pose PAS, donc le
        // tour suivant redemande le fil entier. C'est le repli sûr de cette route, trop de messages plutôt
        // que trop peu, et le dédoublonnage ci-dessous le rend invisible.
        bornRef.current = arrivee.curseur ? { at: arrivee.curseur, id: arrivee.id } : null;
        // En AJOUT : au premier chargement `prev` est vide, donc l'ajout rend le fil entier. Le composant
        // est remonté à chaque conversation (`key={selected.id}`), donc `prev` ne mélange jamais deux fils.
        //
        // ⚠️ SAUTÉ QUAND LE FIL VIENT D'ÊTRE REMPLACÉ, et c'est obligatoire : les bulles reviennent avec
        // les mêmes identifiants et un AUTRE texte, donc le dédoublonnage ci-dessous les rejetterait et
        // ré-écraserait le remplacement par l'ancienne langue.
        //
        // ⚠️ Et en AJOUT DÉDOUBLONNÉ : un message n'apparaît qu'une fois dans un fil, quoi qu'il arrive en
        // face. Cette garde-ci ne dépend d'aucune hypothèse sur le curseur, donc elle tient aussi le jour où
        // le serveur renvoie deux fois la même bulle pour une autre raison. Et quand tout est déjà connu,
        // `prev` est rendu TEL QUEL : la référence ne change pas, donc l'effet de défilement ne se
        // redéclenche pas. C'est ce qui rend le fil calme.
        if (!remplacer) {
          setMessages((prev) => {
            const connus = new Set(prev.map((m) => m.id));
            const nouveaux = res.messages.filter((m) => !connus.has(m.id));
            return nouveaux.length === 0 ? prev : [...prev, ...nouveaux];
          });
        }
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
      // la garde anti-saut de scroll d'avant, obtenue ici gratuitement par le delta. (Un REMPLACEMENT en
      // change forcément la référence, mais il n'arrive qu'au changement de langue de lecture, donc sur un
      // geste délibéré de l'opérateur et pas à chaque tour.)
      setWindowOpen(res.windowOpen);
      setControlOwner(res.controlOwner);
      // La langue APPRISE du contact. Elle arrive a CHAQUE tour, y compris sur un delta vide : c'est
      // elle qui nomme la cible du bouton de traduction, et elle peut changer en cours de conversation.
      setLangueContact(res.langueContact ?? null);
      /**
       * 🔴 PAS DE CRÉDIT, ET ON LE DIT PLUTÔT QUE DE RESTER MUET. Le serveur ne rend ce champ que
       * lorsqu'on a demandé `traduire` : absent, il vaut faux, ce qui éteint le bandeau dès que
       * l'opérateur coupe le réglage. Ce n'est pas une panne et c'est un 200 : le fil s'affiche, en VO.
       */
      setTraductionIndisponible(res.traductionIndisponible === true);
      // ⚠️ `null` quand le serveur ne dit rien (version plus ancienne, ou traduction qui a marché) : le
      // bandeau retombe alors sur sa formulation prudente plutôt que d'inventer une cause.
      setTraductionCause(res.traductionCause === 'instance' || res.traductionCause === 'credit' ? res.traductionCause : null);
    } catch (err) {
      // Une requête ANNULÉE n'est pas une panne : changer de conversation annule la précédente, et afficher
      // un bandeau rouge à chaque clic serait absurde.
      if (estAnnulation(err)) return;
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      // ⚠️ SEULEMENT SI C'EST ENCORE NOTRE REQUÊTE. Une requête annulée par une suivante ne doit pas
      // déclarer la voie libre : la suivante, elle, est bien en vol, et le tick doit continuer de la
      // laisser finir.
      if (enVolRef.current === ctrl) enCoursRef.current = false;
    }
    // ⚠️ `cibleLecture` EST UNE DÉPENDANCE, et c'est ce qui recharge le fil quand on bascule le réglage
    // (ou quand la console change de langue, ce qui change la cible sans qu'on ait rien basculé).
  }, [session.tenantId, conversation.id, t, cibleLecture]);

  // Annule la requête en vol au démontage (changement de conversation, sortie de l'inbox).
  useEffect(() => () => { enVolRef.current?.abort(); }, []);

  /**
   * 🔴 LA LANGUE DE LECTURE A CHANGÉ : LE PROCHAIN CHARGEMENT REPREND LE FIL ENTIER, ET IL REMPLACE.
   *
   * Les deux gestes sont nécessaires, et pour deux raisons différentes. `bornRef` porte le curseur du
   * delta : sans sa remise à zéro, on ne demanderait que les messages arrivés DEPUIS le dernier tour, et
   * l'historique déjà à l'écran resterait dans sa langue d'origine pour toujours. Et le remplacement
   * parce que l'ajout de `load` est DÉDOUBLONNÉ PAR IDENTIFIANT : les bulles reviennent avec les mêmes
   * identifiants et un autre texte, donc elles seraient ignorées.
   *
   * ⚠️ DANS UN EFFET SUR LA CIBLE, et pas dans le gestionnaire du bouton, parce que la cible change
   * AUSSI quand la console change de langue alors que le réglage, lui, n'a pas bougé. Deux causes, un
   * seul endroit. Il est déclaré AVANT l'effet de chargement : React exécute les effets dans l'ordre de
   * déclaration, donc les deux marques sont posées avant que `load` ne parte.
   *
   * ⚠️ Il se déclenche aussi au MONTAGE, et c'est sans conséquence : remplacer une liste vide par le fil
   * entier est exactement ce que faisait l'ajout.
   */
  useEffect(() => {
    bornRef.current = null;
    remplacerAuProchainRef.current = true;
  }, [cibleLecture]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh du fil ouvert (~4 s, chat vivant) tant que l'onglet est visible. Thread est remonté par
  // conversation (key=selected.id), donc l'interval se recrée proprement à chaque changement de conversation.
  useEffect(() => {
    // ⚠️ `passerSiEnVol` : un tour qui tombe pendant qu'une requête traduit encore ne relance RIEN.
    // Cf. le docblock de `enCoursRef` : sans lui, on paie le même lot jusqu'à cinq fois par minute.
    const tick = () => { if (document.visibilityState === 'visible') void load({ passerSiEnVol: true }); };
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

  /**
   * La cible d'une traduction sortante : ce qu'on a APPRIS du contact, sinon la langue par défaut.
   *
   * ⚠️ Le bouton la NOMME, et c'est toute la garde : la langue apprise peut être fausse une fois (un
   * contact francophone qui répond « ok » ou par un emoji), et l'opérateur le voit AVANT d'envoyer.
   */
  const cibleSortante = langueContact ?? langueSortanteParDefaut(locale);

  /**
   * ALLUMER OU ÉTEINDRE LA LECTURE TRADUITE. Le rechargement du fil n'est PAS fait ici : il découle de
   * l'effet sur `cibleLecture`, qui couvre aussi le changement de langue de la console.
   *
   * ⚠️ Le réglage est rangé TOUT DE SUITE : un opérateur qui bascule puis change de conversation doit
   * retrouver son choix, et `Thread` est remonté à chaque sélection.
   */
  function basculerTraduction(actif: boolean): void {
    setTraduireRecus(actif);
    ecrireTraductionActive(actif);
    // Éteindre fait disparaître le bandeau sans attendre la réponse : le serveur ne rendra plus le champ.
    if (!actif) setTraductionIndisponible(false);
  }

  /**
   * TRADUIRE ce qui est dans la zone de saisie. N'ENVOIE RIEN.
   *
   * 🔴 C'est une garde, pas une commodité : une traduction ratée en entrée se rattrape sur l'original
   * affiché à côté ; une traduction ratée en SORTIE est partie chez un client, et aucun message
   * WhatsApp livré ne se rappelle. Le texte traduit REMPLACE donc le brouillon, et l'opérateur relit.
   */
  async function traduire() {
    const origine = text.trim();
    if (origine === '') return;
    setTraduisant(true);
    setError(null);
    try {
      const r = await traduireSortant(session.tenantId, conversation.id, origine, cibleSortante);
      setText(r.texte);
      setTraduction({ origine, traduit: r.texte });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Traduction impossible', 'Translation failed'));
    } finally {
      setTraduisant(false);
    }
  }

  /**
   * Le brouillon a changé : ce qu'on avait traduit n'est plus ce qui va partir.
   *
   * 🔴 SANS CETTE REMISE À ZÉRO, ON MENTIRAIT DANS LA TRACE. L'opérateur traduit, puis retouche le
   * texte espagnol à la main : `redaction_origine` porterait encore le français d'avant, qui n'a plus
   * rien à voir avec ce qui part. Une trace fausse est pire que pas de trace.
   */
  function ecrire(valeur: string) {
    setText(valeur);
    if (traduction && valeur !== traduction.traduit) setTraduction(null);
  }

  async function send() {
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      // `text` est ce qui PART (traduit compris) ; `origine` ce que l'opérateur avait écrit.
      await replyConversation(session.tenantId, conversation.id, text.trim(), traduction?.origine ?? null);
      setText('');
      setTraduction(null);
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
    if (!(await confirmer({ titre: t('Effacer le contenu', 'Erase the content'), message: question, confirmer: t('Effacer', 'Erase') }))) return;
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

  /**
   * LE BOUTON DE CONTRÔLE DU FIL, QUI VA DÉSORMAIS À DEUX ADRESSES SELON LE SENS.
   *
   * 🔴 IL N'EN AVAIT QU'UNE, ET C'ÉTAIT LE BUG DU 2026-09-11. « Reprendre la main » et « Rendre la main »
   * sont deux gestes OPPOSÉS, et les deux appelaient `/release`. Sur un fil tenu par l'agent de Meta,
   * « Reprendre la main » revenait donc à demander à Meta de le garder, puis à remettre notre côté en
   * automatique : l'agent répondait au message suivant du client, exactement ce que le libellé promet
   * d'empêcher. Le sens du geste décide maintenant de la route, et `/prendre` appelle `thread_control`
   * avec l'action `take`.
   */
  async function basculerLeFil() {
    setReleasing(true);
    setError(null);
    try {
      const res = controlOwner === 'mba'
        ? await prendreConversation(session.tenantId, conversation.id)
        : await releaseConversation(session.tenantId, conversation.id);
      setControlOwner(res.controlOwner);
      onSent(); // rafraîchit la liste : le badge y change aussi
    } catch (err) {
      // ⚠️ Le message du serveur est repris TEL QUEL quand il y en a un : sur un refus de Meta, il porte la
      // porte de secours (« envoyez un message »), que ce repli générique effacerait.
      setError(err instanceof Error ? err.message : t('Reprise impossible', 'Hand back failed'));
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="flex h-[540px] flex-col rounded-carte border border-ink-200 bg-white lg:h-full">
      {/* ⚠️ `flex-wrap` sur l'en-tête et sur son groupe de droite : un 13 pouces laisse environ 700 px à
          cette colonne, et les commandes y sont déjà nombreuses. Sans lui, la dernière arrivée pousse les
          autres hors du cadre au lieu de passer à la ligne, ce qui ne se voit ni comme un débordement de
          page ni comme un chevauchement (les rectangles restent disjoints), donc aucune des deux gardes de
          largeur ne l'attraperait. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-ink-100 px-4 py-2.5">
        <div className="min-w-0">
          <span className="text-sm font-semibold">{conversation.profileName ?? `+${conversation.waId}`}</span>
          <span className="ml-2 font-mono text-xs text-ink-500">+{conversation.waId}</span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {/*
            🔴 LIRE LES MESSAGES REÇUS DANS SA LANGUE, ET C'EST LA LANGUE DE LA CONSOLE. Pas une question
            de plus : on sait déjà dans quelle langue la personne lit son produit, et deux réglages pour
            une même chose finissent par se contredire.

            ⚠️ PAR NAVIGATEUR (`localStorage`), comme le choix de langue, et jamais par espace : deux
            collègues lisent le même fil, l'un en français l'autre en anglais, et c'est ce cas-là qui a
            fait naître cette fonctionnalité.

            ⚠️ IL RESTE VISIBLE MÊME SANS CRÉDIT. Un interrupteur qui disparaît quand il ne sert à rien
            laisse croire à une panne de l'écran ; le bandeau juste en dessous dit la vraie raison.
          */}
          <label
            data-testid="toggle-traduction"
            className={classesBouton('secondaire', 'petite', 'shrink-0 gap-1.5')}
            title={t('Les messages reçus sont traduits dans la langue de la console', 'Incoming messages are translated into the console language')}
          >
            <input
              type="checkbox"
              role="switch"
              checked={traduireRecus}
              onChange={(e) => basculerTraduction(e.target.checked)}
              className="h-3.5 w-3.5 rounded-controle border-ink-300 accent-brand-500"
            />
            {t('Traduire les messages reçus', 'Translate incoming messages')}
          </label>
          {/* Affectation : à côté du contrôle du fil, mais ce sont DEUX choses différentes. Le badge de
              contrôle dit ce qui parle (scénario, humain, agent Meta) ; celui-ci dit qui s'en occupe. */}
          <AffectationControl
            session={session}
            conversation={conversation}
            peutPrendre={peutPrendre}
            onChange={onSent}
          />
          <RangerDans
            session={session}
            conversation={conversation}
            dossier={dossier}
            controlOwner={controlOwner}
            onFait={(owner) => { if (owner) setControlOwner(owner); onSent(); }}
          />
          <ControlBadge owner={controlOwner} />
          {/*
            🔴 LE BOUTON S'AFFICHE POUR LES DEUX DÉTENTEURS, PAS SEULEMENT L'HUMAIN (2026-09-08). Il ne
            sortait que sur `app_human`, alors que la route, elle, rend la main quel que soit le détenteur.
            Un fil pris par l'agent de Meta n'avait donc AUCUNE sortie depuis la console : il fallait
            attendre le délai d'inactivité (24 h), et pendant ces 24 h aucun déclencheur automatique
            n'écrivait dedans. Vécu le 2026-09-08 : un bouton de chaîne cliqué par Julien ne lançait rien,
            le mot-clé correspondait pourtant et l'automation était bien trouvée.

            ⚠️ Le libellé n'est PAS le même dans les deux sens, et LA ROUTE NON PLUS depuis le 2026-09-11.
            Un opérateur REND une main qu'il a prise (`/release`) ; face à l'agent de Meta, on la lui PREND
            (`/prendre`, qui appelle `thread_control` avec l'action `take`). Les deux ont longtemps partagé
            le même appel, et c'est ce qui laissait l'agent de Meta répondre juste après un clic sur
            « Reprendre la main ».
          */}
          {(controlOwner !== 'app_workflow' || mbaActif) && (
            <Bouton variante="secondaire" taille="petite" enCours={releasing}
              onClick={() => { void basculerLeFil(); }}
              disabled={releasing}
              data-testid="inbox-rendre-la-main"
            >
              {releasing
                ? t('...', '...')
                : controlOwner === 'mba'
                  ? t('Reprendre la main', 'Take back')
                  : controlOwner === 'app_human'
                    ? t('Rendre la main', 'Hand back')
                    : t('Passer à l’agent Meta', 'Hand to Meta agent')}
            </Bouton>
          )}
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
              className="rounded-controle border border-ink-300 px-2 py-0.5 text-xs font-medium text-danger transition-colors duration-150 hover:bg-danger-50 disabled:opacity-50"
            >
              {effacement ? t('...', '...') : t('Effacer le contenu', 'Erase content')}
            </button>
          )}
        </div>
      </div>

      {/*
        🔴 SANS CRÉDIT, L'ÉCRAN LE DIT AU LIEU DE RESTER MUET. La traduction est payée par le crédit
        PRÉPAYÉ du client (clé Gateway de l'espace, migration 0124), contrairement au bot d'aide qui est
        sur notre clé : un espace sans crédit ne traduit pas, et le fil s'affiche en VO. Sans ce bandeau,
        l'opérateur verrait un interrupteur allumé et des messages en espagnol, sans aucune explication,
        et il conclurait à une panne du produit.

        ⚠️ CE N'EST PAS UNE ERREUR, donc ni bandeau rouge ni `error` : la route répond 200, le fil est
        complet, il est simplement dans sa langue d'origine.
      */}
      {traduireRecus && traductionIndisponible && (
        <p
          data-testid="traduction-indisponible"
          data-cause={traductionCause ?? 'inconnue'}
          className="mx-4 mt-2 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-800"
        >
          {traductionCause === 'credit' && t(
            'Traduction indisponible : le crédit de cet espace est épuisé. Les messages restent dans leur langue d’origine, un administrateur peut le recharger.',
            'Translation unavailable: this workspace has run out of credit. Messages stay in their original language, an admin can top it up.',
          )}
          {/* ⚠️ AUCUN RENVOI VERS LE CRÉDIT ICI : la cause est chez nous, et rien de ce que le client
              ferait n'y changerait quoi que ce soit. Lui dire de recharger le ferait payer pour rien. */}
          {traductionCause === 'instance' && t(
            'Traduction indisponible sur ce serveur : elle n’y est pas encore activée. Les messages restent dans leur langue d’origine.',
            'Translation is not enabled on this server yet. Messages stay in their original language.',
          )}
          {traductionCause === null && t(
            'Traduction indisponible : les messages restent dans leur langue d’origine.',
            'Translation unavailable: messages stay in their original language.',
          )}
        </p>
      )}

      {/* `data-fil-defilant` : c'est ce conteneur, et pas la fenêtre, qui fait défiler le fil. Une photo reçue
          s'y cherche pour se charger quand ELLE y devient visible (`PieceJointeRecue`). */}
      <div ref={filRef} data-testid="fil-messages" data-fil-defilant="" className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.map((m, i) => {
          // Séparateur de jour (fuseau Paris) quand le jour change vs le message précédent.
          const showSep = i === 0 || dayKey(m.createdAt) !== dayKey(messages[i - 1]!.createdAt);
          return (
            <Fragment key={m.id}>
              {showSep && (
                <div className="flex justify-center py-1">
                  <span className="text-xs font-medium text-ink-500">{dayLabel(m.createdAt, locale)}</span>
                </div>
              )}
              <div className={`flex items-end gap-1.5 ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                {/* Couleur PAR CANAL : le fil est unique par contact, c'est la bulle qui dit par quel tuyau
                    elle est passée. WhatsApp prend l'accent de la console, le RCS le bleu nuit. ⚠️ Jamais
                    une teinte d'état (`succes`, `alerte`, `danger`) : une bulle RCS verte se lirait « réussi »
                    à côté d'une bulle WhatsApp qui ne l'aurait pas été. Canal absent ou inconnu (message
                    d'avant la migration 0056) -> WhatsApp, jamais une couleur muette. */}
                <div
                  className={`max-w-[75%] rounded-carte px-3 py-1.5 text-sm ${
                    m.channel === 'rcs'
                      ? (m.direction === 'out' ? 'bg-navy-600 text-white' : 'bg-navy-50 text-ink-900')
                      : (m.direction === 'out' ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-900')
                  }`}
                  title={m.channel === 'rcs' ? 'RCS' : undefined}
                >
                  {/* 🔴 `texteDeBulle` ET PAS `m.body` : quand le fil a été demandé traduit, le texte à
                      afficher est `affiche`, qui porte notre lecture pour un entrant et la RÉDACTION
                      D'ORIGINE pour un sortant (sur un sortant traduit, `body` porte ce qui est PARTI,
                      donc l'opérateur y verrait sa propre phrase en espagnol). Sans `traduire`, le champ
                      est absent et tout retombe sur `body`, mot pour mot comme avant. */}
                  {m.type === 'template' ? (
                    <span className="italic opacity-90"><Icone nom="modele" taille="petite" className="mr-1 inline align-[-0.15em]" />{texteDeBulle(m)}</span>
                  ) : m.type === 'audio' && m.aMedia === true && m.direction === 'in' ? (
                    // Le vocal remplace le libellé `[audio]`, qui ne disait rien de ce que le client a dit.
                    <VocalMessage session={session} conversationId={conversation.id} message={m} traduire={cibleLecture ?? null} />
                  ) : natureDePieceJointe(m.type) !== null && m.aMedia === true && m.direction === 'in' ? (
                    // La photo, le document ou la vidéo remplacent `[image]` / `[document]` (2026-09-19). La
                    // légende de l'expéditeur, elle, reste affichée dessous, traduite si le fil l'est.
                    <PieceJointeRecue
                      tenantId={session.tenantId}
                      conversationId={conversation.id}
                      message={m}
                      nature={natureDePieceJointe(m.type)!}
                      legende={legendeDePieceJointe(texteDeBulle(m), m.type)}
                    />
                  ) : m.buttonPayload && m.direction === 'in' ? (
                    <InboundPayload body={texteDeBulle(m)} payload={m.buttonPayload} />
                  ) : (
                    texteDeBulle(m) ?? <span className="italic opacity-70">[{m.type}]</span>
                  )}
                  <MarqueDeTraduction message={m} />
                  <div className={`mt-0.5 text-right text-xs ${m.direction === 'out' ? 'text-white/70' : 'text-ink-500'}`}>{hourMin(m.createdAt, locale)}</div>
                </div>
                {/* Pastille de l'auteur (repli neutre : rien si pas d'auteur, legacy ou réponse auto). */}
                {m.direction === 'out' && m.senderName ? <AgentBadge name={m.senderName} /> : null}
              </div>
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mx-4 mb-2 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      {/*
        Conversation confiée à QUELQU'UN D'AUTRE : on remplace la barre de réponse par une explication, au
        lieu de la laisser en place et de laisser rédiger un message que le serveur refusera. L'agent VOIT
        toujours la conversation, il sait juste qu'elle n'est pas à lui, et qui la suit.

        Le refus réel vient du serveur : ce bloc ne protège rien, il évite une frustration.

        ⚠️ UNE CLÉ PAR BARRE (2026-09-25). La fenêtre part OUVERTE par défaut et bascule à la réponse du fil :
        sans clé, React garde le même bouton DOM au même rang et le RELABELLISE, donc un clic parti sur
        « Lancer un scénario » au moment de la bascule arrivait sur « Envoyer un template ». Avec une clé,
        la barre est remplacée, et un clic en vol tombe sur un nœud détaché au lieu du mauvais bouton.
      */}
      {fermeeCarAffectee ? (
        <div className="border-t border-ink-100 p-3 text-center text-sm text-ink-500" data-testid="assigned-elsewhere">
          {t(
            `Cette conversation est suivie par ${conversation.assignedToName ?? 'un autre membre'}. Un manager peut vous l’affecter.`,
            `This conversation is handled by ${conversation.assignedToName ?? 'another member'}. A manager can assign it to you.`,
          )}
        </div>
      ) : windowOpen ? (
        // `flex-wrap` et le champ en tête sur un téléphone : trois icônes, le champ, « Traduire » et « Envoyer »
        // ne tiennent pas sur 358 px, et la rangée débordait de l'écran.
        <div key="fenetre-ouverte" className="flex flex-wrap items-center gap-2 border-t border-ink-100 p-3 sm:flex-nowrap">
          <button
            onClick={() => setShowTemplate(true)}
            title={t('Envoyer un template', 'Send a template')}
            aria-label={t('Envoyer un template', 'Send a template')}
            className="shrink-0 rounded-controle border border-ink-300 p-2 text-ink-500 transition-colors duration-150 hover:bg-ink-50"
          >
            <Icone nom="modele" />
          </button>
          <button
            onClick={() => setShowScenario(true)}
            title={t('Lancer un scénario', 'Start a scenario')}
            data-testid="inbox-open-scenario"
            aria-label={t('Lancer un scénario', 'Start a scenario')}
            className="shrink-0 rounded-controle border border-ink-300 p-2 text-ink-500 transition-colors duration-150 hover:bg-ink-50"
          >
            <Icone nom="scenario" />
          </button>
          {rcsEnabled && (
            <button
              onClick={() => setShowRcs(true)}
              title={t('Envoyer un message RCS', 'Send an RCS message')}
              data-testid="inbox-open-rcs"
              aria-label={t('Envoyer un message RCS', 'Send an RCS message')}
              className="shrink-0 rounded-controle border border-ink-300 p-2 text-ink-500 transition-colors duration-150 hover:bg-ink-50"
            >
              <Icone nom="mobile" />
            </button>
          )}
          <input
            value={text}
            onChange={(e) => ecrire(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
            placeholder={t('Répondre (fenêtre de service 24 h)...', 'Reply (24h service window)...')}
            data-testid="zone-saisie"
            className="order-first min-w-0 flex-1 basis-full rounded-controle sm:order-none sm:basis-auto border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          {/*
            🔴 LE BOUTON NOMME SA CIBLE, jamais « Traduire » tout court. L'opérateur voit où part sa
            phrase AVANT de valider, ce qui est la seule protection qui reste quand la langue apprise du
            contact est fausse (un « ok » ou un emoji peuvent la fausser une fois).

            🔴 ET IL N'ENVOIE PAS : il remplace le brouillon par sa traduction, que l'opérateur relit.
            Une traduction ratée en entrée se rattrape sur l'original affiché à côté ; une traduction
            ratée en sortie est partie chez un client, et aucun message WhatsApp livré ne se rappelle.

            ⚠️ Il n'existe QUE dans ce bloc, celui de la fenêtre de 24 h ouverte. Un TEMPLATE ne se
            traduit pas : son texte est approuvé par Meta dans une langue donnée, et le texte approuvé
            EST le texte. Afficher « Traduire » sur un template mentirait.
          */}
          <button
            onClick={() => { void traduire(); }}
            disabled={traduisant || busy || text.trim() === ''}
            data-testid="bouton-traduire"
            title={t('Traduire avant d’envoyer, sans envoyer', 'Translate before sending, without sending')}
            className="shrink-0 whitespace-nowrap rounded-controle border border-ink-300 px-2.5 py-2 text-sm text-ink-500 transition-colors duration-150 hover:bg-ink-50 disabled:opacity-50"
          >
            {traduisant
              ? t('...', '...')
              : t(`Traduire en ${nomDeLangue(cibleSortante, locale)}`, `Translate to ${nomDeLangue(cibleSortante, locale)}`)}
          </button>
          <Bouton enCours={busy}
            onClick={send}
            disabled={busy || text.trim() === ''}
            data-testid="bouton-envoyer"
            className="shrink-0"
          >
            {busy ? '...' : t('Envoyer', 'Send')}
          </Bouton>
        </div>
      ) : (
        <div key="fenetre-fermee" className="border-t border-ink-100 p-3">
          <p className="mb-2 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-800">
            {t('Fenêtre de 24 h fermée : WhatsApp interdit le message libre. Pour reprendre contact, envoie un ', '24-hour window closed: WhatsApp does not allow free-form messages. To reach out again, send an ')}<b>{t('template approuvé', 'approved template')}</b>.
          </p>
          <Bouton
            onClick={() => setShowTemplate(true)}
            className="w-full"
          >
            {t('Envoyer un template', 'Send a template')}
          </Bouton>
          {rcsEnabled && (
            <button
              onClick={() => setShowRcs(true)}
              data-testid="inbox-open-rcs"
              className="mt-2 w-full rounded-controle border border-navy-300 px-3 py-2 text-sm font-medium text-navy-700 hover:bg-navy-50"
            >
              {t('…ou envoyer un message RCS (pas de fenêtre de 24 h)', '…or send an RCS message (no 24h window)')}
            </button>
          )}
          <Bouton variante="secondaire"
            onClick={() => setShowScenario(true)}
            data-testid="inbox-open-scenario"
            className="mt-2 w-full"
          >
            {t('Lancer un scénario', 'Start a scenario')}
          </Bouton>
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
    <Modale titre={t('Lancer un scénario', 'Start a scenario')} onClose={onClose}>
      <p className="mt-1 text-xs text-ink-500">
        {windowOpen
          ? t('Le contact a écrit il y a moins de 24 h : tous tes scénarios peuvent partir.', 'The contact wrote less than 24h ago: any of your scenarios can run.')
          : t('Fenêtre de 24 h fermée : seuls les scénarios qui ouvrent par un template ou par un message RCS peuvent partir.', '24-hour window closed: only scenarios opening with a template or an RCS message can run.')}
      </p>

      <div className="mt-3">
        <label className="mb-1 block text-sm font-medium text-ink-900">{t('Scénario', 'Scenario')}</label>
        {workflows.length === 0 ? (
          <p className="text-xs text-alerte-700" data-testid="scenario-none">
            {total === 0
              ? t('Aucun scénario : créez-en un dans le menu « Scénario ».', 'No scenario yet: create one from the “Scenario” menu.')
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

      {error && <p className="mt-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="scenario-error">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <Bouton variante="secondaire" onClick={onClose}>{t('Annuler', 'Cancel')}</Bouton>
        <Bouton enCours={busy}
          onClick={lancer}
          disabled={!sel || busy}
          data-testid="scenario-send"
        >
          {busy ? t('Lancement…', 'Starting…') : t('Lancer', 'Start')}
        </Bouton>
      </div>
    </Modale>
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
    <Modale titre={t('Envoyer un template', 'Send a template')} onClose={onClose}>
      <p className="mt-1 text-xs text-ink-500">{t('Le seul moyen de ré-engager un contact hors fenêtre de 24 h.', 'The only way to re-engage a contact outside the 24h window.')}</p>

      <div className="mt-3">
        <label className="mb-1 block text-sm font-medium text-ink-900">{t('Template approuvé', 'Approved template')}</label>
        {templates.length === 0 ? (
          <p className="text-xs text-alerte-700">{t('Aucun template approuvé : créez-en un dans Campagnes > Templates.', 'No approved template: create one in Campaigns > Templates.')}</p>
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
              <label className="mb-1 block text-sm font-medium text-ink-900">{t('Variables', 'Variables')}</label>
              <div className="space-y-2">
                {Array.from({ length: varCount }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="flex w-28 shrink-0 items-center gap-1 text-xs text-ink-500">
                      {`{{${i + 1}}}`}
                      {labels[i] ? <span className="truncate rounded-controle bg-brand-50 px-1 text-brand-600">{labels[i]}</span> : null}
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
            <div className="mt-3 flex items-center gap-2 rounded-controle bg-ink-50 px-3 py-2">
              {sel.headerFormat === 'IMAGE' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaDuTemplate} alt="" referrerPolicy="no-referrer" className="h-10 w-16 shrink-0 rounded-controle border border-ink-200 object-cover" />
              ) : (
                <Icone nom={sel.headerFormat === 'VIDEO' ? 'video' : 'modele'} taille="grande" className="text-ink-500" />
              )}
              <p className="text-xs text-ink-500" data-testid="template-media-repris">
                {t('L’en-tête défini sur le template part avec le message. Rien à fournir.', 'The header defined on the template goes out with the message. Nothing to provide.')}
              </p>
            </div>
          )}

          {mediaAFournir && (
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium text-ink-900">
                {t(
                  `URL de l'${sel.headerFormat === 'IMAGE' ? 'image' : sel.headerFormat === 'VIDEO' ? 'vidéo' : 'document'} (header du template)`,
                  `${sel.headerFormat === 'IMAGE' ? 'Image' : sel.headerFormat === 'VIDEO' ? 'Video' : 'Document'} URL (template header)`,
                )}
              </label>
              <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." className={inputCls} />
              <p className="mt-1 text-xs text-alerte-700">
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

      {error && <p className="mt-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <div className="mt-4 flex gap-2">
        <Bouton variante="secondaire" onClick={onClose} className="flex-1">{t('Annuler', 'Cancel')}</Bouton>
        <Bouton
          onClick={send}
          disabled={!canSend}
          className="flex-1"
        >
          {busy ? t('Envoi...', 'Sending...') : t('Envoyer le template', 'Send the template')}
        </Bouton>
      </div>
    </Modale>
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
      cls: 'bg-ink-100 text-ink-500',
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
      //
      // ⚠️ La liste des exceptions a GRANDI le 2026-09-08 : un abonné qui clique un bouton de chaîne reprend
      // aussi la main. Une infobulle qui énumère ce qui passe outre doit être complétée à chaque exception,
      // sinon elle redevient exactement le demi-mensonge qu'elle a mis des semaines à cesser d'être.
      title: t(
        'Un opérateur a la main : ni le scénario ni l’agent n’écrivent. Une campagne, si : elle part et reprend la main. Un bouton de chaîne cliqué aussi.',
        'An operator has the hand: neither the scenario nor the agent writes. A campaign does: it goes out and takes the hand back. So does a clicked channel button.',
      ),
    },
    mba: {
      label: t('agent Meta', 'Meta agent'),
      cls: 'bg-brand-100 text-brand-800',
      title: t("L'agent de Meta répond directement au client.", 'Meta’s agent is answering the customer directly.'),
    },
  };
  const look = LOOK[owner];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${look.cls}`} title={look.title}>
      {look.label}
    </span>
  );
}
