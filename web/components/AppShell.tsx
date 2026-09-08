'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearSession, type Session } from '@/lib/session';
import { countUnreadConversations, SESSION_EXPIRED_EVENT } from '@/lib/api';
import { Logo } from './Logo';
import { AccountMenu } from './AccountMenu';
import { useT } from '@/lib/i18n';
import { repeterAvecGigue } from '@/lib/poll';
import { cheminDeNav, ongletDeLaPage, type NavEntree, type Onglet } from '@/lib/nav';

type Tab = 'accueil' | 'quanti-messages' | 'quanti-couts' | 'quanti-funnel' | 'quanti-erreurs' | 'dashboard-quali' | 'dashboard-tableaux' | 'contacts' | 'campagnes' | 'chaine' | 'workflows' | 'automations' | 'mba-guide' | 'mba-settings' | 'agents' | 'templates' | 'flows' | 'tags' | 'fields' | 'nodes' | 'email-templates' | 'rcs-messages' | 'inbox' | 'admin' | 'email-accounts' | 'support' | 'api-docs' | 'api-keys' | 'mcp' | 'webhooks' | 'connecteurs' | 'parametres';

/** Icônes de nav (SVG inline, aucune dépendance). */
const ICON = 'h-[18px] w-[18px] shrink-0';
const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const icons = {
  accueil: 'M3 10.5L12 3l9 7.5M5 9.5V20a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V9.5',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 012-2h12a2 2 0 012 2v7M4 13v5a2 2 0 002 2h12a2 2 0 002-2v-5',
  contacts: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  campaign: 'M3 11l18-5v12L3 14v-3zM11.6 16.8a3 3 0 11-5.8-1.6',
  // Chaine : une bulle de diffusion avec ses ondes. Elle ne reprend PAS l icone de Campagnes (le porte-voix)
  // alors que les deux diffusent : une campagne parle a des contacts connus, une chaine a des abonnes
  // anonymes, et confondre les deux a l oeil ferait chercher ses contacts dans le mauvais ecran.
  chaine: 'M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 01-13.2 7.9L3 21l1.1-4.8A9 9 0 1121 12z',
  content: 'M4 4h16v4H4zM4 12h10v8H4zM18 12h2v8h-2z',
  analytics: 'M3 3v18h18M8 17V9M13 17V5M18 17v-6',
  flow: 'M5 4h4v4H5zM15 16h4v4h-4zM7 8v4a2 2 0 002 2h6',
  // Automation : un éclair, le DÉCLENCHEUR. Elle partageait l'icône de « Scénario » (deux blocs reliés), donc
  // les deux entrées du menu étaient indiscernables alors qu'elles ne font pas la même chose : le scénario est
  // le parcours, l'automation est ce qui le déclenche.
  automation: 'M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z',
  support: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
  developers: 'M8 6l-5 6 5 6M16 6l5 6-5 6M13 4l-2 16',
  // Tools : une prise. Ce menu regroupe ce qui BRANCHE la console sur l'extérieur.
  tools: 'M9 2v6M15 2v6M7 8h10v5a5 5 0 01-10 0V8zM12 18v4',
  mba: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM6 19l.7 1.9L8.6 21l-1.9.7L6 23.6l-.7-1.9L3.4 21l1.9-.1L6 19z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a1.65 1.65 0 00.33 1.82l.05.05a2 2 0 11-2.83 2.83l-.05-.05a1.65 1.65 0 00-2.82 1.17V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.05.05a2 2 0 11-2.83-2.83l.05-.05A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.05-.05a2 2 0 112.83-2.83l.05.05A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.05-.05a2 2 0 112.83 2.83l-.05.05A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
};

// Le modèle d'entrée (et le calcul de la chaîne d'ancêtres) vit dans `lib/nav.ts` : il est récursif depuis
// que la barre a trois niveaux, et il se teste sans monter de composant.

/** Intervalle de rafraîchissement de la pastille de non-lus. Assez court pour qu'un message vu sur le
 *  téléphone apparaisse vite, assez long pour ne pas marteler l'API depuis toutes les pages. */
const UNREAD_POLL_MS = 30_000;

/**
 * Événement « le nombre de non-lus a bougé », émis par l'inbox quand elle marque un fil lu. Sans lui, la
 * pastille resterait allumée jusqu'à 30 s après que l'opérateur a ouvert la conversation.
 */
export const UNREAD_CHANGED_EVENT = 'mba:unread-changed';

/**
 * Coquille commune : garde d'auth + RBAC, SIDEBAR gauche (nav rôle-aware) + header (menu Compte à droite)
 * + contenu pleine largeur. RBAC : seule l'inbox est ouverte à l'agent ; tout le reste exige admin (la
 * vraie autorité reste le serveur, on évite juste d'afficher une page interdite).
 */
export function AppShell({ active, fullBleed = false, children }: { active: Tab; fullBleed?: boolean; children: (session: Session) => React.ReactNode }) {
  const router = useRouter();
  const t = useT();
  const [session, setSession] = useState<Session | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  // Session tombée : on l'apprend par l'événement émis au premier 401 (cf. `lib/api.ts`).
  const [sessionExpiree, setSessionExpiree] = useState(false);

  // Nav construite au rendu (et non en constante module) pour que les libellés suivent la langue courante.
  /**
   * 🔴 TROIS ARBRES DEPUIS LE 2026-09-08, un par onglet. C'était `NAV_ADMIN`, une liste unique qui mettait
   * sur le même plan trois métiers : configurer, traiter les conversations, lire les résultats.
   *
   * ⚠️ Le CONTENU des entrées n'a pas changé, seul leur rangement. Aucune adresse ne bouge : les onglets
   * sont un niveau de regroupement AU-DESSUS de la nav, pas un nouveau routage. Un favori ou un lien
   * partagé continue d'ouvrir la même page, qui s'affiche simplement dans son onglet.
   */
  const NAV_CONSOLE: NavEntree[] = [
    // L'accueil n'était atteignable que par le logo, ce qui ne se devine pas. Un agent ne le voit pas :
    // `pageDArrivee` l'envoie sur l'inbox, et cette page montre le statut du compte et ses réglages, qui ne
    // le concernent pas.
    { key: 'accueil', href: '/accueil', label: t('Accueil', 'Home'), d: icons.accueil },
    // Libellé seulement : l'URL reste `/contacts`, pour ne casser ni les liens existants ni les deep-links.
    { key: 'contacts', href: '/contacts', label: t('mini-CRM', 'mini-CRM'), d: icons.contacts },
    { key: 'campagnes', href: '/campaigns', label: t('Campagnes', 'Campaigns'), d: icons.campaign },
    // Juste apres Campagnes : les deux repondent a « comment je parle a plusieurs personnes a la fois ».
    { key: 'chaine', href: '/chaine', label: t('Chaîne', 'Channel'), d: icons.chaine },
    { key: 'workflows', href: '/workflows', label: t('Scénario', 'Scenario'), d: icons.flow },
    { key: 'automations', href: '/automations', label: t('Automation', 'Automation'), d: icons.automation },
    // Les DEUX répondeurs que le client peut faire parler : l'agent de Meta (MBA, son guide et ses réglages,
    // qui gardent leurs URL) et le nôtre. MBA est un SOUS-GROUPE et non deux entrées voisines : ses deux
    // écrans parlent du même agent, les mettre au même rang que « Other AI agent » laissait croire à trois
    // agents. C'est ce qui a fait passer la barre à trois niveaux (cf. `lib/nav.ts`).
    { key: 'ia', label: t('AI Agent', 'AI Agent'), d: icons.mba, children: [
      { key: 'mba', label: t('MBA', 'MBA'), children: [
        { key: 'mba-guide', href: '/mba', label: t('MBA, guide', 'MBA, guide') },
        { key: 'mba-settings', href: '/mba/parametres', label: t('MBA, paramètres', 'MBA, settings') },
      ] },
      { key: 'agents', href: '/agents', label: t('Other AI agent', 'Other AI agent') },
    ] },
    // Contenu, rangé PAR CANAL. Les sept entrées étaient à plat et l'oeil devait relire les libellés pour
    // retrouver le sien : « Templates WhatsApp », « Formulaires WhatsApp », « Messages RCS », « Modèles
    // d'email »... le canal était répété dans chaque libellé faute d'être porté par la structure. Il l'est
    // désormais, et les libellés n'ont plus à le redire.
    //
    // ⚠️ RCS et Email n'ont qu'un enfant chacun, et c'est VOULU : la symétrie des quatre canaux est ce qui
    // rend le menu lisible. Un groupe à un seul enfant coûte un clic ; quatre groupes dont deux à plat
    // coûteraient une relecture à chaque visite.
    { key: 'contenu', label: t('Contenu', 'Content'), d: icons.content, children: [
      { key: 'contenu-whatsapp', label: t('WhatsApp', 'WhatsApp'), children: [
        { key: 'templates', href: '/templates', label: t('Templates', 'Templates') },
        { key: 'flows', href: '/flows', label: t('Formulaires', 'Forms') },
      ] },
      { key: 'contenu-rcs', label: t('RCS', 'RCS'), children: [
        { key: 'rcs-messages', href: '/rcs-messages', label: t('Messages', 'Messages') },
      ] },
      { key: 'contenu-email', label: t('Email', 'Email'), children: [
        { key: 'email-templates', href: '/email-templates', label: t('Modèles', 'Templates') },
      ] },
      // « Bibliothèque » : ce qui se RÉUTILISE, sans appartenir à un canal.
      // ⚠️ Le groupe reste bancal, et le nom n'y peut rien : « Blocs » est du contenu, « Étiquettes » et
      // « Champs » sont de la donnée de CONTACT. Ils sont ici par héritage, leur place logique serait le
      // mini-CRM. Signalé à Julien le 2026-09-02, en attente d'arbitrage.
      { key: 'contenu-bibliotheque', label: t('Bibliothèque', 'Library'), children: [
        { key: 'nodes', href: '/nodes', label: t('Blocs', 'Blocks') },
        // « Étiquette » en français, « Tag » en anglais : le mot anglais est passé dans l'usage technique
        // mais reste du jargon pour un utilisateur métier francophone.
        { key: 'tags', href: '/tags', label: t('Étiquettes', 'Tags') },
        { key: 'fields', href: '/fields', label: t('Champs', 'Fields') },
      ] },
    ] },
    // Tools : ce qui BRANCHE la console sur l'extérieur. Les webhooks entrants, et les systèmes que les
    // agents IA interrogent. Les connecteurs sont ICI et pas dans un agent : un système appartient au CLIENT,
    // plusieurs agents tapent dans la même bibliothèque, et le déclarer dans un agent ferait croire qu'il lui
    // appartient. MCP viendra s'ajouter dans ce menu, à côté.
    { key: 'tools', label: t('Tools', 'Tools'), d: icons.tools, children: [
      { key: 'webhooks', href: '/webhooks', label: t('Webhooks', 'Webhooks') },
      { key: 'connecteurs', href: '/connecteurs', label: t('Connecteurs API', 'API connectors') },
    ] },
    { key: 'parametres', href: '/parametres', label: t('Paramètres', 'Settings'), d: icons.settings },
    { key: 'support', href: '/support', label: t('Support', 'Support'), d: icons.support },
  ];
  // Second tableau, rendu dans son propre conteneur COLLÉ EN BAS de la barre. La nav n'a aucun mécanisme de
  // placement (pas de champ `position`), donc le bas se fait par la structure, pas par une propriété d'entrée.
  const NAV_ADMIN_BAS: NavEntree[] = [
    { key: 'developers', label: t('Developers', 'Developers'), d: icons.developers, children: [
      { key: 'api-docs', href: '/developers/api', label: t('Documentation API', 'API documentation') },
      { key: 'api-keys', href: '/developers/keys', label: t('Clés d\'API', 'API keys') },
      { key: 'mcp', href: '/developers/mcp', label: t('Serveur MCP', 'MCP server') },
    ] },
  ];
  /**
   * L'onglet Inbox n'a PAS de barre de navigation : cette entrée sert à situer la page, pas à naviguer.
   * Le menu de dossiers (Tout / À traiter / Signalé / Archivé) vit DANS l'écran, pas dans la barre.
   */
  const NAV_INBOX: NavEntree[] = [{ key: 'inbox', href: '/inbox', label: t('Inbox', 'Inbox'), d: icons.inbox, badge: unread }];

  /**
   * Les enfants de l'ancien groupe « Analytics », remontés d'un cran : dans cet onglet, ils SONT le menu.
   *
   * ⚠️ Aucune icône, et c'est un choix. Le rendu les accepte sans (`{item.d && <Ico …>}`), elles sont toutes
   * dans le même onglet donc l'icône ne distingue rien, et n'en donner qu'à certaines les désalignerait.
   * Le groupe « Quantitatif » n'en avait déjà pas.
   */
  const NAV_PERF: NavEntree[] = [
    // ⚠️ `/dashboard` reste l adresse du PREMIER sous-onglet, pas une page d aiguillage : trois specs
    // Playwright et des liens deja distribues y pointent.
    // 🔴 Et depuis le 2026-09-08, c est AUSSI la porte d entree de l onglet Performance Lab. La tentation
    // sera d en faire une page d aiguillage « choisissez un tableau » : ce serait ajouter un clic a tout le
    // monde et casser les liens existants. La page de synthese des lots E et F prendra sa propre adresse.
    { key: 'quantitatif', label: t('Quantitatif', 'Quantitative'), children: [
      { key: 'quanti-messages', href: '/dashboard', label: t('Messages & contacts', 'Messages & contacts') },
      { key: 'quanti-couts', href: '/dashboard/couts', label: t('Coûts', 'Costs') },
      { key: 'quanti-funnel', href: '/dashboard/funnel', label: t('Funnel', 'Funnel') },
      { key: 'quanti-erreurs', href: '/dashboard/erreurs', label: t('Erreurs', 'Errors') },
    ] },
    { key: 'dashboard-quali', href: '/dashboard/quali', label: t('Qualitatif', 'Qualitative') },
    { key: 'dashboard-tableaux', href: '/dashboard/tableaux', label: t('Mes tableaux', 'My reports') },
  ];

  // ⚠️ IL N'Y A PLUS DE NAV PROPRE A L'AGENT depuis le 2026-09-08, et ce n'est pas un oubli : un compte
  // agent est toujours sur l'onglet Inbox (toute autre page le renvoie ici), et cet onglet n'a AUCUNE barre
  // laterale. Le `NAV_AGENT` d'avant serait donc du code que rien ne peut atteindre. Le jour ou une seconde
  // page s'ouvre aux agents, c'est l'arbre de SON onglet qui la portera, comme pour un admin.

  /** Les trois arbres, dans l'ordre de recherche de `ongletDeLaPage`. Le bloc bas appartient à la Console. */
  const ARBRES: Record<Onglet, NavEntree[]> = {
    console: [...NAV_CONSOLE, ...NAV_ADMIN_BAS],
    inbox: NAV_INBOX,
    perf: NAV_PERF,
  };
  const onglet = ongletDeLaPage(ARBRES, active);

  // Chaîne des groupes qui mènent à la page active, DÉDUITE de la nav ci-dessus (`lib/nav.ts`). Deux choses
  // en vivent : le groupe de premier niveau à surligner, et les groupes à déplier. Elles étaient écrites à la
  // main ; un groupe oublié dans l'une laissait sa page active invisible, l'autre le gardait replié.
  //
  // ⚠️ Calculée dans l'arbre de l'onglet COURANT, pas dans leur union : deux arbres pourraient porter un
  // groupe de même clé, et l'union ferait déplier celui du mauvais onglet.
  const chemin = cheminDeNav(ARBRES[onglet], active);

  // Groupes repliables : ouverts au départ sur TOUTE la chaîne de la page active (à trois niveaux, n'ouvrir
  // que le premier laisserait la page dans un sous-menu encore replié). `active` est une prop stable, donc
  // pas de flicker : l'état initial est déjà bon au 1er rendu.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () => Object.fromEntries(chemin.map((k) => [k, true])),
  );

  // Fail-safe : tout ce qui n'est pas l'inbox est réservé aux admins.
  const adminOnly = active !== 'inbox';

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    if (adminOnly && s.role !== 'admin') {
      router.replace('/inbox');
      return;
    }
    setSession(s);
  }, [router, adminOnly]);

  // Pastille de non-lus : relevée à l'arrivée puis toutes les 30 s. Échec silencieux (0) : une pastille est
  // une information d'appoint, elle ne doit jamais faire apparaître une erreur en travers du menu.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const lire = () => {
      countUnreadConversations(session.tenantId)
        .then(({ count }) => { if (alive) setUnread(count); })
        .catch(() => { /* pastille muette */ });
    };
    lire();
    const arreter = repeterAvecGigue(lire, UNREAD_POLL_MS);
    window.addEventListener(UNREAD_CHANGED_EVENT, lire);
    return () => { alive = false; arreter(); window.removeEventListener(UNREAD_CHANGED_EVENT, lire); };
  }, [session]);

  useEffect(() => {
    const tombee = (): void => setSessionExpiree(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, tombee);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, tombee);
  }, [session]);

  if (!session) return null;
  if (adminOnly && session.role !== 'admin') return null;

  function logout() {
    clearSession();
    router.replace('/login');
  }

  /**
   * L'arbre RENDU dans le corps de la barre.
   *
   * 🔴 DISTINCT de `ARBRES`, et la confusion coûte un doublon visible. `ARBRES` sert à la DÉDUCTION de
   * l'onglet : il doit contenir TOUTES les clés, le bloc bas (Developers) compris, sinon ces pages
   * n'appartiendraient à aucun onglet. Mais le bloc bas est rendu à part, collé en bas de la colonne : le
   * passer aussi au corps affichait « Developers » deux fois sur la Console. Attrapé par l'E2E, qui a refusé
   * un sélecteur résolvant à deux éléments.
   */
  const NAV_DU_CORPS: Record<Onglet, NavEntree[]> = { console: NAV_CONSOLE, inbox: NAV_INBOX, perf: NAV_PERF };
  const nav = NAV_DU_CORPS[onglet];

  const itemCls = (on: boolean) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${on ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'}`;
  const subCls = (on: boolean) =>
    `block rounded-md px-3 py-1.5 text-sm transition ${on ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`;

  /**
   * Rendu RÉCURSIF d'une liste d'entrées. Trois niveaux existent aujourd'hui (« AI Agent » > « MBA » >
   * « MBA, guide ») et la récursion en accepte davantage sans nouveau code : c'est ce qui évite qu'un
   * quatrième niveau se règle un jour par un troisième bloc copié-collé.
   *
   * Ce qui change avec la profondeur : le premier niveau seul porte une icône et le style « entrée », les
   * suivants prennent le style « sous-entrée » et un retrait. Le reste (repli, surlignage, fermeture du
   * tiroir mobile) est identique partout, donc écrit une seule fois.
   */
  const listeNav = (items: NavEntree[], niveau: number) => (
    <div className={niveau === 1 ? 'space-y-1' : 'space-y-0.5'}>
      {items.map((item) =>
        item.children ? (
          <div key={item.key}>
            <button
              type="button"
              onClick={() => setOpenGroups((s) => ({ ...s, [item.key]: !s[item.key] }))}
              aria-expanded={!!openGroups[item.key]}
              data-testid={`nav-groupe-${item.key}`}
              className={
                niveau === 1
                  ? `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition hover:bg-ink-100 ${chemin.includes(item.key) ? 'font-medium text-brand-700' : 'text-ink-600'}`
                  : `flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition hover:bg-ink-100 ${chemin.includes(item.key) ? 'font-medium text-brand-700' : 'text-ink-500'}`
              }
            >
              {item.d && <Ico d={item.d} />}
              {item.label}
              <svg viewBox="0 0 24 24" className={`ml-auto h-4 w-4 shrink-0 text-ink-400 transition-transform ${openGroups[item.key] ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {openGroups[item.key] && (
              <div className={`mt-0.5 border-l border-ink-100 pl-2 ${niveau === 1 ? 'ml-[30px]' : 'ml-2'}`}>
                {listeNav(item.children, niveau + 1)}
              </div>
            )}
          </div>
        ) : (
          <Link
            key={item.key}
            href={item.href!}
            onClick={() => setDrawerOpen(false)}
            className={niveau === 1 ? itemCls(active === item.key) : subCls(active === item.key)}
          >
            {item.d && <Ico d={item.d} />}
            {item.label}
            {item.badge !== undefined && item.badge > 0 && (
              <span
                data-testid={`nav-badge-${item.key}`}
                // `ml-auto` : la pastille se colle à droite de l'entrée, elle ne pousse jamais le libellé.
                className="ml-auto min-w-[20px] rounded-full bg-coral px-1.5 py-0.5 text-center text-[11px] font-semibold leading-none text-white"
                aria-label={t(`${item.badge} conversation(s) non lue(s)`, `${item.badge} unread conversation(s)`)}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </Link>
        ),
      )}
    </div>
  );

  // La barre a DEUX listes (le corps, et le bloc collé en bas). Un seul rendu pour les deux, pour qu'un
  // changement de style de nav n'ait pas à être fait deux fois.
  const renderNav = (items: NavEntree[]) => <nav>{listeNav(items, 1)}</nav>;

  /**
   * Les trois onglets et leur point d'entrée.
   *
   * ⚠️ La destination du Performance Lab est `/dashboard`, sa PREMIÈRE entrée, et non une page de synthèse :
   * celle-ci arrive avec les lots E et F, ceux qui lui donnent son contenu. Ce lot ne crée aucune adresse.
   */
  const ONGLETS_UI: Array<{ cle: Onglet; label: string; href: string; badge?: number }> = [
    { cle: 'console', label: t('Console', 'Console'), href: '/accueil' },
    /**
     * 🔴 LA PASTILLE DE NON-LUS SUIT L'INBOX ICI, et l'oublier était une régression que l'E2E a attrapée.
     * Elle vivait sur l'entrée « Inbox » de la barre latérale ; l'Inbox étant devenue un ONGLET, cette
     * entrée n'existe plus dans aucun menu, et la pastille avait disparu avec elle.
     *
     * ⚠️ Elle y gagne au passage : elle est désormais visible depuis les TROIS onglets, alors qu'elle ne
     * l'était que dans la barre. Un opérateur qui lit ses chiffres dans le Performance Lab voit qu'on lui
     * écrit, ce qui n'était pas le cas avant.
     */
    { cle: 'inbox', label: t('Inbox', 'Inbox'), href: '/inbox', badge: unread },
    { cle: 'perf', label: t('Performance Lab', 'Performance Lab'), href: '/dashboard' },
  ];
  /**
   * 🔴 Un compte `agent` n'a accès QU'À l'inbox (`adminOnly` plus haut, et le serveur derrière lui). Lui
   * montrer trois onglets dont deux le renverraient aussitôt à l'inbox serait pire que la barre unique
   * d'avant : on lui promettrait deux portes fermées.
   */
  const ongletsVisibles = session.role === 'admin' ? ONGLETS_UI : ONGLETS_UI.filter((o) => o.cle === 'inbox');

  /**
   * L'onglet Inbox n'a PAS de menu de navigation : son écran porte son propre menu de dossiers (lot B).
   * Une colonne vide y prendrait 15 rem de large pour ne rien montrer.
   */
  const avecBarreLaterale = onglet !== 'inbox';

  const SidebarInner = (
    // Colonne pleine hauteur : c'est elle qui permet au bloc bas de descendre. Le `flex-1` du corps ci-dessous
    // ne pousse rien tant que la colonne n'occupe pas vraiment la hauteur disponible.
    <div className="flex h-full flex-col pt-3">
      {/* ⚠️ Le logo a quitté cette colonne le 2026-09-08 : il vit dans l'entête, à gauche des onglets, parce
          que l'entête est désormais PLEINE LARGEUR et surplombe la colonne. L'avoir aux deux endroits
          l'aurait affiché deux fois sur la même page. */}
      {/* flex-1 pousse le bloc bas vers le bas ; overflow-y-auto fait scroller le CORPS de la nav sur un écran
          court, au lieu de faire déborder la colonne et de rendre le bloc bas inatteignable. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">{renderNav(nav)}</div>
      {/* Le bloc bas (Developers) appartient à la CONSOLE : le montrer sous le menu du Performance Lab y
          rangerait une entrée qui n'est pas de cet onglet. */}
      {session.role === 'admin' && onglet === 'console' && (
        <div className="border-t border-ink-100 px-2 py-3">{renderNav(NAV_ADMIN_BAS)}</div>
      )}
    </div>
  );

  return (
    /**
     * 🔴 L'ENTÊTE EST SORTIE DE LA COLONNE DE DROITE (2026-09-08). Elle vivait à l'intérieur, donc À DROITE
     * de la barre latérale ; les onglets y auraient eu l'air de faire partie du contenu, alors qu'ils
     * CHANGENT le menu. Ils surplombent donc les deux.
     *
     * ⚠️ `h-14` sur l'entête n'est pas décoratif : la colonne latérale est collante et haute d'un écran.
     * Sous une entête de hauteur inconnue elle dépasserait par le bas, et son bloc bas (Developers)
     * deviendrait inatteignable. D'où `top-14` et `h-[calc(100vh-3.5rem)]` juste en dessous : les trois
     * valeurs doivent rester d'accord, 3.5rem ÉTANT h-14.
     */
    <div className={`flex flex-col bg-[#F7F8FB] ${fullBleed ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'}`}>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white px-4">
        {avecBarreLaterale && (
          <button className="rounded-lg p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setDrawerOpen(true)} aria-label={t('Ouvrir le menu', 'Open menu')}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        )}
        <Link href={session.role === 'admin' ? '/accueil' : '/inbox'} className="flex shrink-0 items-center gap-2" title={t('Accueil', 'Home')}>
          <Logo className="h-8 w-8" />
          <span className="hidden text-sm font-semibold tracking-tight text-ink-900 sm:inline">Engage Me</span>
        </Link>
        <nav aria-label={t('Sections', 'Sections')} className="flex items-center gap-1 overflow-x-auto" data-testid="onglets">
          {ongletsVisibles.map((o) => (
            <Link
              key={o.cle}
              href={o.href}
              data-testid={`onglet-${o.cle}`}
              aria-current={onglet === o.cle ? 'page' : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition ${
                onglet === o.cle
                  ? 'bg-brand-50 font-semibold text-brand-700'
                  : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
              }`}
            >
              {o.label}
              {o.badge !== undefined && o.badge > 0 && (
                <span
                  data-testid={`nav-badge-${o.cle}`}
                  // `ml-1.5` et non `ml-auto` : dans un onglet, la pastille se colle au libellé. `ml-auto`
                  // la pousserait au bout d'une largeur que l'onglet n'a pas.
                  className="ml-1.5 inline-block min-w-[20px] rounded-full bg-coral px-1.5 py-0.5 text-center text-[11px] font-semibold leading-none text-white"
                  aria-label={t(`${o.badge} conversation(s) non lue(s)`, `${o.badge} unread conversation(s)`)}
                >
                  {o.badge > 99 ? '99+' : o.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <AccountMenu session={session} onLogout={logout} />
        </div>
      </header>

      <div className={`lg:flex ${fullBleed ? 'min-h-0 flex-1' : 'flex-1'}`}>
      {avecBarreLaterale && (
        <>
          {/* Sidebar desktop */}
          <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:block">
            {/* Hauteur réelle (et pas seulement collante) : sans elle, la colonne flex ne s'étire pas et le
                bloc bas se colle sous la dernière entrée au lieu de descendre. */}
            <div className="sticky top-14 h-[calc(100vh-3.5rem)]">{SidebarInner}</div>
          </aside>

          {/* Drawer mobile (z-40, sous les modales z-50) */}
          {drawerOpen && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <button aria-label={t('Fermer le menu', 'Close menu')} className="absolute inset-0 bg-ink-900/30" onClick={() => setDrawerOpen(false)} />
              <div className="absolute left-0 top-0 h-full w-60 border-r border-ink-200 bg-white">{SidebarInner}</div>
            </div>
          )}
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Session tombée : un message rouge dans un coin d'écran ne suffisait pas, le reste de l'interface
            restait actif et rien ne disait comment revenir. La bannière vit ICI, sous le header et hors du
            `<main>` : le mode pleine largeur y applique `lg:overflow-hidden`, donc une bannière posée dedans
            aurait pu être coupée. `shrink-0` pour qu'elle ne se fasse pas écraser par le contenu. */}
        {sessionExpiree && (
          <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 sm:px-6" data-testid="session-expiree">
            <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 text-sm text-red-700">
              <span>{t('Ta session a expiré. Reconnecte-toi pour continuer : rien n’est perdu, mais tes actions ne sont plus enregistrées.', 'Your session has expired. Sign in again to continue: nothing is lost, but your actions are no longer being saved.')}</span>
              <button
                type="button"
                onClick={logout}
                data-testid="session-expiree-reconnecter"
                className="ml-auto rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
              >
                {t('Reconnecter', 'Sign in again')}
              </button>
            </div>
          </div>
        )}
        {/* OBSERVATION d'un espace client depuis l'exploitation. Bandeau PERMANENT et non un simple badge :
            sans lui on oublie qu'on regarde chez quelqu'un d'autre, et on prend ses chiffres pour les siens.
            La lecture seule est imposée par le SERVEUR ; ce bandeau ne protège rien, il informe. */}
        {session.observation && (
          <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 sm:px-6" data-testid="bandeau-observation">
            <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 text-sm text-amber-900">
              <span>
                {t(
                  `Observation de l’espace « ${session.observation} ». Vous voyez ce que ce client voit. Aucune modification n’est possible.`,
                  `Observing the "${session.observation}" workspace. You see what this customer sees. No change is possible.`,
                )}
              </span>
              <button
                type="button"
                onClick={logout}
                data-testid="quitter-observation"
                className="ml-auto rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700"
              >
                {t('Quitter l’observation', 'Leave observation')}
              </button>
            </div>
          </div>
        )}
        <main className={fullBleed ? 'w-full flex-1 lg:flex lg:min-h-0 lg:flex-col' : 'mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6'}>{children(session)}</main>
      </div>
      </div>
    </div>
  );
}
