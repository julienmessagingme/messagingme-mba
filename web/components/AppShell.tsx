'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearSession, type Session } from '@/lib/session';
import { countUnreadConversations, SESSION_EXPIRED_EVENT } from '@/lib/api';
import { Logo } from './Logo';
import { AccountMenu } from './AccountMenu';
import { BoutonAide } from './BoutonAide';
import { Icone } from './Icone';
import { useT } from '@/lib/i18n';
import { repeterAvecGigue } from '@/lib/poll';
import { arbresNav, groupesAOuvrir, ongletDeLaPage, accesAutorise, navPourRole, type NavEntree, type Onglet } from '@/lib/nav';

type Tab = 'accueil' | 'perf-synthese' | 'agents-credit' | 'quanti-messages' | 'quanti-couts' | 'quanti-funnel' | 'dashboard-quali' | 'dashboard-tableaux' | 'contacts' | 'campagnes' | 'chaine' | 'publicites' | 'workflows' | 'automations' | 'mba-guide' | 'mba-settings' | 'agents' | 'templates' | 'flows' | 'tags' | 'fields' | 'nodes' | 'email-templates' | 'rcs-messages' | 'inbox' | 'admin' | 'email-accounts' | 'support' | 'api-docs' | 'api-keys' | 'mcp' | 'webhooks' | 'connecteurs' | 'connecteurs-mcp' | 'parametres' | 'securite' | 'securite-consentement' | 'securite-ia' | 'securite-audit' | 'securite-erreurs' | 'compte';

// Le modèle d'entrée, le calcul de la chaîne d'ancêtres ET LES QUATRE LISTES vivent dans `lib/nav.ts` : le
// modèle est récursif depuis que la barre a trois niveaux, et les listes ont suivi le 2026-09-11 parce que
// cette barre est la CARTE de la console. Tout s'y teste sans monter de composant.

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

  // Les quatre listes de la barre vivent dans `lib/nav.ts` depuis le 2026-09-11 : elles sont la CARTE
  // de la console, et un composant ne se lit pas de l’extérieur. Le compte de non-lus leur est passé
  // ici, parce que c’est une valeur d’exécution et pas une propriété de la carte.
  const { console: NAV_CONSOLE, inbox: NAV_INBOX, perf: NAV_PERF, adminBas: NAV_ADMIN_BAS } = arbresNav(t, unread);

  /** Les trois arbres, dans l'ordre de recherche de `ongletDeLaPage`. Le bloc bas appartient à la Console. */
  const ARBRES: Record<Onglet, NavEntree[]> = {
    console: [...NAV_CONSOLE, ...NAV_ADMIN_BAS],
    inbox: NAV_INBOX,
    perf: NAV_PERF,
  };
  const onglet = ongletDeLaPage(ARBRES, active);

  // LES GROUPES ACTIFS, DÉDUITS de la nav ci-dessus (`lib/nav.ts`) : ceux qui MÈNENT à la page, plus la page
  // elle-même quand c'est un groupe (la page d'accueil de Sécurité en est une, cf. `groupesAOuvrir`). Deux
  // choses en vivent : les groupes à SURLIGNER et ceux à DÉPLIER. Elles étaient écrites à la main ; un
  // groupe oublié dans l'une laissait sa page active invisible, l'autre le gardait replié.
  //
  // ⚠️ Calculée dans l'arbre de l'onglet COURANT, pas dans leur union : deux arbres pourraient porter un
  // groupe de même clé, et l'union ferait déplier celui du mauvais onglet.
  const chemin = groupesAOuvrir(ARBRES[onglet], active);

  // Groupes repliables : ouverts au départ sur TOUTE la chaîne de la page active (à trois niveaux, n'ouvrir
  // que le premier laisserait la page dans un sous-menu encore replié). `active` est une prop stable, donc
  // pas de flicker : l'état initial est déjà bon au 1er rendu.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () => Object.fromEntries(chemin.map((k) => [k, true])),
  );

  /**
   * L'ACCÈS À CET ÉCRAN, DÉRIVÉ DE `accesAutorise` (`lib/nav.ts`) ET DE RIEN D'AUTRE.
   *
   * 🔴 CETTE GARDE DISAIT « tout ce qui n'est pas l'inbox est réservé aux admins », ET C'ÉTAIT TROP LARGE
   * DEPUIS LE 2026-09-13. Le centre de Sécurité a livré une route ouverte à `admin` ET `manager` (la liste
   * des désabonnés), la PREMIÈRE du dépôt à nommer ce rôle : elle était INERTE, parce qu'un manager était
   * renvoyé à l'inbox avant même que la page ne se monte. Trouvé en revue du chantier complet le
   * 2026-09-14, tranché par Julien le même jour : « ouvre la console aux managers sur les écrans de
   * conformité ».
   *
   * ⚠️ C'EST UN CONFORT, PAS UN CONTRÔLE : la barrière est le `preHandler` du serveur, et elle seule.
   * Celle-ci existe pour ne pas promettre une porte fermée.
   */
  const autorise = (role: string): boolean => accesAutorise(active, role);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    if (!accesAutorise(active, s.role)) {
      router.replace('/inbox');
      return;
    }
    setSession(s);
  }, [router, active]);

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
  if (!autorise(session.role)) return null;
  // L'écran dont le coin bas droit est pris par une barre d'envoi : le bouton d'aide monte dans l'entête.
  const aideDansEntete = active === 'inbox';

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
  // 🔴 FILTRÉ PAR RÔLE, PAR LA MÊME FONCTION QUE LA GARDE. Un manager ne doit pas voir une liste de dossiers
  // qui le renverraient tous à l'inbox : une porte annoncée et fermée est pire qu'une porte absente.
  const nav = navPourRole(NAV_DU_CORPS[onglet], session.role);
  const navBas = navPourRole(NAV_ADMIN_BAS, session.role);

  const itemCls = (on: boolean) =>
    `flex items-center gap-2.5 rounded-controle px-3 py-2 text-sm transition-colors duration-150 ${on ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900'}`;
  const subCls = (on: boolean) =>
    `block rounded-controle px-3 py-1.5 text-sm transition-colors duration-150 ${on ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900'}`;

  /**
   * Rendu RÉCURSIF d'une liste d'entrées. Trois niveaux existent aujourd'hui (« AI Agent » > « MBA » >
   * « Guide ») et la récursion en accepte davantage sans nouveau code : c'est ce qui évite qu'un
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
                  ? `flex w-full items-center gap-2.5 rounded-controle px-3 py-2 text-sm transition-colors duration-150 hover:bg-ink-100 ${chemin.includes(item.key) ? 'font-medium text-brand-700' : 'text-ink-500'}`
                  : `flex w-full items-center gap-2 rounded-controle px-3 py-1.5 text-sm transition-colors duration-150 hover:bg-ink-100 ${chemin.includes(item.key) ? 'font-medium text-brand-700' : 'text-ink-500'}`
              }
            >
              {item.icone && <Icone nom={item.icone} taille="nav" />}
              {item.label}
              <Icone nom="deplier" taille="petite" className={`ml-auto text-ink-400 transition-transform duration-150 ${openGroups[item.key] ? 'rotate-180' : ''}`} />
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
            {item.icone && <Icone nom={item.icone} taille="nav" />}
            {item.label}
            {item.badge !== undefined && item.badge > 0 && (
              <span
                data-testid={`nav-badge-${item.key}`}
                // `ml-auto` : la pastille se colle à droite de l'entrée, elle ne pousse jamais le libellé.
                className="ml-auto min-w-[20px] rounded-full bg-danger px-1.5 py-0.5 text-center text-xs font-semibold leading-none tabular-nums text-white"
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
   * ⚠️ La destination du Performance Lab est passée de `/dashboard` à `/performance` le 2026-09-08, quand
   * le lot F a donné son premier contenu à la page de synthèse. C'était le plan écrit du lot A, qui avait
   * refusé de créer l'adresse tant qu'elle n'aurait rien à montrer. `/dashboard` n'a pas bougé et reste la
   * première entrée du bloc Quantitatif.
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
    { cle: 'perf', label: t('Performance Lab', 'Performance Lab'), href: '/performance' },
  ];
  /**
   * 🔴 ON NE MONTRE QU'UNE PORTE QU'ON PEUT OUVRIR. Un compte `agent` n'a que l'inbox : lui montrer trois
   * onglets dont deux le renverraient aussitôt serait pire que la barre unique d'avant.
   *
   * ⚠️ UN `manager` GARDE LA CONSOLE, parce que c'est par elle qu'on atteint le centre de Sécurité (le menu
   * y vit, en bas de la colonne). Sa barre latérale, elle, est filtrée par `navPourRole` : il n'y verra que
   * ce qu'il peut ouvrir, jamais une liste de dossiers fermés.
   */
  const ongletsVisibles = ONGLETS_UI.filter((o) =>
    // ⚠️ DÉRIVÉ DE L'ARBRE, pas d'une correspondance onglet -> écran écrite à la main : un onglet se montre
    // quand il MÈNE quelque part pour ce rôle. L'inbox n'a pas d'arbre (son écran porte son propre menu),
    // elle est donc nommée à part, et c'est le seul cas particulier.
    o.cle === 'inbox' || navPourRole(ARBRES[o.cle], session.role).length > 0);

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
      {/* Le bloc bas appartient à la CONSOLE : le montrer sous le menu du Performance Lab y rangerait une
          entrée qui n'est pas de cet onglet.
          🔴 LA CONDITION PORTAIT `session.role === 'admin'`, UN SECOND CONTRÔLE DE RÔLE ÉCRIT EN DUR, et
          c'est exactement le motif « une capacité câblée sur deux consommateurs sur trois » : ouvrir les
          écrans de conformité aux managers a filtré `navBas` sans rien montrer, parce que ce bloc restait
          fermé. Il se décide désormais sur le CONTENU (`navBas.length`), donc un rôle qui n'a rien à voir
          ici ne voit pas un séparateur vide, et un rôle qui a quelque chose le voit, sans nouvelle règle. */}
      {onglet === 'console' && navBas.length > 0 && (
        <div data-testid="nav-bas" className="border-t border-ink-100 px-2 py-3">{renderNav(navBas)}</div>
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
    <div className={`flex flex-col bg-surface-subtle ${fullBleed ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'}`}>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center border-b border-ink-200 bg-white">
        {/**
          * 🔴 LA ZONE DE GAUCHE FAIT EXACTEMENT LA LARGEUR DE LA COLONNE LATÉRALE (`w-60`, soit 240 px), ET
          * C'EST CE QUI ALIGNE LES ONGLETS SUR SA FIN (2026-09-17, Julien : « console doit demarrer au
          * niveau de la fin de la colonne de la sidebar, ça doit être aligné sinon c'est pas beau »). Le
          * séparateur qui ferme cette zone tombe alors sur le `border-r` de la colonne : les deux traits
          * n'en font plus qu'un, du haut de l'écran jusqu'en bas.
          *
          * 🔴 ET ELLE GARDE SA LARGEUR SUR L'ONGLET INBOX, QUI N'A POURTANT AUCUNE COLONNE. C'est la moitié
          * de l'intérêt d'un alignement : un repère qui SAUTE en changeant d'onglet est pire qu'un repère
          * décalé. La zone ne se règle donc pas sur `avecBarreLaterale`.
          *
          * ⚠️ `lg:` ET PAS UNE LARGEUR FIXE : en dessous de ce point de rupture la colonne est un tiroir et
          * n'occupe aucune place, donc réserver 240 px pousserait les onglets hors de l'écran sur un
          * téléphone. Les trois valeurs `w-60` (ici et sur l'`aside`) doivent rester d'accord, comme
          * `h-14` / `top-14` / `3.5rem` juste au-dessus.
          *
          * ⚠️ LA COLONNE DES DOSSIERS DE L'INBOX S'ALIGNE AUSSI SUR CE TRAIT (2026-09-25) : elle lit `spacing.60` et
          * `spacing.px` dans le thème (`app/inbox/page.tsx`). Changer cette largeur ici, c'est la changer là-bas ;
          * `inbox-dossiers.spec.ts` mesure les deux.
          */}
        <div className="flex h-full shrink-0 items-center gap-3 px-4 lg:w-60">
          {avecBarreLaterale && (
            <button className="rounded-controle p-1.5 text-ink-500 hover:bg-ink-100 lg:hidden" onClick={() => setDrawerOpen(true)} aria-label={t('Ouvrir le menu', 'Open menu')}>
              <Icone nom="menu" taille="grande" />
            </button>
          )}
          <Link href={session.role === 'admin' ? '/accueil' : '/inbox'} className="flex min-w-0 shrink items-center gap-2" title={t('Accueil', 'Home')}>
            <Logo className="h-8 w-8 shrink-0" />
            <span className="hidden truncate text-sm font-semibold text-ink-900 sm:inline">Engage Me</span>
          </Link>
        </div>
        {/**
          * ⚠️ LES ONGLETS SE TIENNENT À DISTANCE DU LOGO, ET ILS NE LUI RESSEMBLENT PAS (2026-09-08, Julien :
          * « la police n'est pas assez différenciante et c'est positionné beaucoup trop proche du logo »).
          * Le séparateur vertical les détache de la marque, et c'est lui qui porte la distinction.
          *
          * ⚠️ LA CASSE HAUTE ET L'INTERLETTRAGE ONT ÉTÉ RETIRÉS LE 2026-09-25 (passe « anti-slop » de la
          * console) : des majuscules espacées pour structurer sont un marqueur d'interface générée. L'onglet se
          * distingue désormais de « Engage Me » par sa graisse (medium contre semi-bold), sa couleur (gris
          * secondaire, la marque est en encre) et la pastille de l'onglet actif, sans changer de famille.
          */}
        {/* ⚠️ `ml-4 lg:ml-0` : à partir de `lg`, la zone de gauche porte sa largeur et le séparateur DOIT
            tomber pile sur les 240 px, donc aucune marge. En dessous, cette largeur n'existe pas et une
            marge nulle collerait le trait au mot « Engage Me » : c'est précisément le reproche de Julien
            du 2026-09-08 (« positionné beaucoup trop proche du logo »), qu'on réintroduirait sur toute la
            plage tablette sans le voir depuis un grand écran. */}
        <span aria-hidden="true" data-testid="entete-separateur" className="ml-4 hidden h-6 w-px shrink-0 bg-ink-200 sm:block lg:ml-0" />
        {/* `min-w-0 flex-1` : sur un téléphone, les onglets défilent DANS leur zone au lieu de pousser le menu de
            compte hors de l'écran (mesuré le 2026-09-25 : « Performance Lab » passait sous l'avatar). */}
        <nav aria-label={t('Sections', 'Sections')} className="ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="onglets">
          {ongletsVisibles.map((o) => (
            <Link
              key={o.cle}
              href={o.href}
              data-testid={`onglet-${o.cle}`}
              aria-current={onglet === o.cle ? 'page' : undefined}
              className={`whitespace-nowrap rounded-controle px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
                onglet === o.cle
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900'
              }`}
            >
              {o.label}
              {o.badge !== undefined && o.badge > 0 && (
                <span
                  data-testid={`nav-badge-${o.cle}`}
                  // `ml-1.5` et non `ml-auto` : dans un onglet, la pastille se colle au libellé. `ml-auto`
                  // la pousserait au bout d'une largeur que l'onglet n'a pas.
                  className="ml-1.5 inline-block min-w-[20px] rounded-full bg-danger px-1.5 py-0.5 text-center text-xs font-semibold leading-none tabular-nums text-white"
                  aria-label={t(`${o.badge} conversation(s) non lue(s)`, `${o.badge} unread conversation(s)`)}
                >
                  {o.badge > 99 ? '99+' : o.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>
        {/* `pr-4` rend au menu de compte la marge que l'entête a perdue : le `px-4` est descendu dans la
            zone de gauche, qui porte désormais une largeur propre. Sans lui, l'avatar colle au bord. */}
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-4">
          {aideDansEntete && <BoutonAide tenantId={session.tenantId} ecranCourant={active} role={session.role} dansEntete />}
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
          <div className="shrink-0 border-b border-danger-200 bg-danger-50 px-4 py-2 sm:px-6" data-testid="session-expiree">
            <div className="mx-auto flex w-full max-w-liste flex-wrap items-center gap-3 text-sm text-danger-700">
              <span>{t('Votre session a expiré. Reconnectez-vous pour continuer : rien n’est perdu, mais vos actions ne sont plus enregistrées.', 'Your session has expired. Sign in again to continue: nothing is lost, but your actions are no longer being saved.')}</span>
              <button
                type="button"
                onClick={logout}
                data-testid="session-expiree-reconnecter"
                className="ml-auto rounded-controle bg-danger-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-danger-700"
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
          <div className="shrink-0 border-b border-alerte-300 bg-alerte-50 px-4 py-2 sm:px-6" data-testid="bandeau-observation">
            <div className="mx-auto flex w-full max-w-liste flex-wrap items-center gap-3 text-sm text-alerte-900">
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
                className="ml-auto rounded-controle bg-alerte-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-alerte-800"
              >
                {t('Quitter l’observation', 'Leave observation')}
              </button>
            </div>
          </div>
        )}
        <main className={fullBleed ? 'w-full flex-1 lg:flex lg:min-h-0 lg:flex-col' : 'mx-auto w-full max-w-liste flex-1 px-4 py-8 sm:px-6'}>{children(session)}</main>
      </div>
      </div>
      {/* 🔴 POSÉ UNE SEULE FOIS, ICI. Le bouton d'aide doit être sur les 36 écrans authentifiés ; le mettre
          page par page serait 36 occasions de l'oublier, et le 37e écran ne l'aurait pas. Il n'apparaît pas
          sur les écrans de connexion, qui ne passent pas par cette coquille et où il n'aurait rien à dire.
          `active` est la clé de nav de la page : c'est ce qui rend l'aide contextuelle sans rien demander. */}
      {/* Sur l'Inbox, il vit dans la barre du haut (`aideDansEntete`) : en bas à droite, il couvrait « Envoyer ». */}
      {!aideDansEntete && <BoutonAide tenantId={session.tenantId} ecranCourant={active} role={session.role} />}
    </div>
  );
}
