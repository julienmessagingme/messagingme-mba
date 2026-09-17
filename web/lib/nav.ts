/**
 * Le modèle de la barre de navigation, et la seule fonction qui sache où se trouve une page dedans.
 *
 * Pourquoi un module à part : la barre a désormais TROIS niveaux (« AI Agent » > « MBA » > « MBA, guide »).
 * Tant qu'elle en avait deux, l'appartenance d'une page à son groupe se lisait dans une table plate écrite à
 * la main dans `AppShell`. À trois niveaux ça ne suffit plus, parce qu'une page a maintenant une CHAÎNE
 * d'ancêtres et que deux choses en dépendent : le groupe à surligner (le premier), et les groupes à déplier
 * (tous). Une chaîne fausse ne casse rien de visible tout de suite, elle laisse juste la page active
 * invisible dans un menu replié, ce qui se remarque tard. D'où le calcul unique, ici, testé.
 */

export interface NavEntree {
  key: string;
  /** Une entrée porte SOIT un lien, SOIT des enfants. Un groupe n'est pas cliquable comme destination. */
  href?: string;
  label: string;
  /** Tracé de l'icône. Seul le premier niveau en porte une. */
  d?: string;
  children?: NavEntree[];
  badge?: number;
}

/**
 * La chaîne des groupes qui MÈNENT à `key`, du plus haut au plus bas (`['ia', 'mba']` pour « MBA, guide »).
 *
 * Vide si la clé est une entrée de premier niveau, ou si elle est inconnue : l'appelant traite les deux de
 * la même façon (aucun groupe à ouvrir), et c'est voulu. Une clé inconnue est une page dont l'onglet n'a pas
 * été déclaré dans la nav ; le bon comportement est alors de n'ouvrir aucun menu, pas de planter la barre.
 */
export function cheminDeNav(items: NavEntree[], key: string): string[] {
  for (const item of items) {
    if (item.key === key) return [];
    if (!item.children) continue;
    if (item.children.some((c) => c.key === key)) return [item.key];
    const dessous = cheminDeNav(item.children, key);
    // `dessous` vide veut dire « pas trouvé » OU « trouvé au premier niveau de ce sous-arbre » ; le cas
    // « trouvé » est déjà pris par le `some` juste au-dessus, donc ici un tableau vide est bien un échec.
    if (dessous.length > 0) return [item.key, ...dessous];
  }
  return [];
}

/**
 * LES GROUPES QUE LA BARRE DOIT OUVRIR pour une page donnée : ceux qui MÈNENT à `key`, plus `key` elle-même
 * quand c'est un GROUPE.
 *
 * 🔴 CE DERNIER CAS EST CELUI QUI MANQUAIT, et il ne se voit qu'une fois qu'un groupe a sa propre page.
 * `cheminDeNav('securite')` rend `[]` (« aucun groupe à traverser », ce qui est juste), si bien qu'en
 * arrivant sur la page d'accueil de Sécurité la barre laissait ses sous-menus REPLIÉS : l'écran annonçait
 * quatre destinations que le menu ne montrait pas.
 *
 * ⚠️ `cheminDeNav` n'est pas modifiée : son contrat est « la chaîne qui mène à », et une page qui EST un
 * groupe n'a pas de chaîne. C'est l'appelant qui a besoin des deux.
 */
export function groupesAOuvrir(items: NavEntree[], key: string): string[] {
  const chemin = cheminDeNav(items, key);
  return estGroupe(items, key) ? [...chemin, key] : chemin;
}

/** `key` désigne-t-elle une entrée qui porte des enfants (donc un groupe, et non une destination) ? */
function estGroupe(items: NavEntree[], key: string): boolean {
  for (const item of items) {
    if (item.key === key) return (item.children?.length ?? 0) > 0;
    if (item.children && estGroupe(item.children, key)) return true;
  }
  return false;
}

/**
 * Les trois onglets de premier niveau (2026-09-08).
 *
 * `console` = configurer et opérer · `inbox` = traiter les conversations · `perf` = lire les résultats.
 * Trois métiers qui ne se pratiquent ni au même moment ni par les mêmes personnes, et que la barre unique
 * mettait sur le même plan : un opérateur qui passe sa journée dans l'Inbox traversait un menu de quinze
 * entrées dont il n'en utilisait qu'une.
 */
export const ONGLETS = ['console', 'inbox', 'perf'] as const;
export type Onglet = (typeof ONGLETS)[number];

/** Cette clé est-elle quelque part dans cet arbre, à n'importe quelle profondeur ? */
export function contientLaCle(items: NavEntree[], key: string): boolean {
  return items.some((item) => item.key === key || (item.children ? contientLaCle(item.children, key) : false));
}

/**
 * L'onglet qui contient cette page.
 *
 * 🔴 POURQUOI C'EST UNE DÉDUCTION ET PAS UNE PROPRIÉTÉ. Trente-trois pages passent déjà leur clé à
 * `AppShell`. Leur faire passer AUSSI leur onglet, ce serait trente-trois occasions d'écrire le mauvais, et
 * une page ajoutée plus tard n'en aurait aucun. La nav sait déjà où vit chaque page : on le lui demande,
 * exactement comme `cheminDeNav` juste au-dessus lui demande les groupes à déplier.
 *
 * ⚠️ Une clé INCONNUE rend `console`, elle ne jette pas. Même parti pris que `cheminDeNav` : une page dont
 * l'onglet n'a pas été déclaré doit s'afficher dans un onglet plausible, pas faire disparaître la barre
 * entière. Ce qui empêche ce cas d'exister n'est pas ce repli, c'est le test de couverture du type `Tab`
 * (`web/lib/nav.test.ts`), qui exige que chaque page appartienne à un arbre et à un seul.
 */
export function ongletDeLaPage(arbres: Record<Onglet, NavEntree[]>, key: string): Onglet {
  return ONGLETS.find((o) => contientLaCle(arbres[o], key)) ?? 'console';
}

/**
 * LES ÉCRANS OUVERTS À L'ENCADREMENT (`manager`), EN PLUS DE L'INBOX.
 *
 * 🔴 UNE SEULE LISTE, ET DEUX CHOSES EN VIVENT : la garde d'accès de `AppShell` et le FILTRAGE du menu. Les
 * écrire séparément produirait exactement le défaut que la revue du 2026-09-14 a trouvé dans l'autre sens :
 * une garde serveur qui nomme `manager` pendant que la console ne l'y mène jamais. Une entrée de menu qui
 * renvoie à l'inbox est aussi mauvaise qu'une porte fermée qu'on annonce.
 *
 * 🔴 CE QUE CETTE OUVERTURE DONNE, ET CE QU'ELLE NE DONNE PAS (tranché par Julien le 2026-09-14 :
 * « ouvre la console aux managers sur les écrans de conformité »). Un manager CONSULTE : la liste des
 * désabonnés, la politique d'annonce d'IA, les deux journaux. Il ne RÈGLE rien : brancher un connecteur sur
 * le consentement ou changer la politique d'IA restent des décisions de la marque, refusées côté serveur et
 * masquées côté écran. « Rendre des comptes » et « décider » ne sont pas le même geste.
 *
 * ⚠️ LE JOURNAL DE LIVRAISON PORTE LES NUMÉROS DE TÉLÉPHONE, et il est dans cette liste. Le plan du chantier
 * 6 le gardait admin-only ; l'ouvrir est un choix explicite, pas un glissement. Il se défend : un manager
 * voit déjà des numéros dans l'Inbox, qui est son écran de tous les jours, et « quel message n'est pas
 * arrivé » sans dire « à qui » ne répond à rien.
 */
export const ECRANS_ENCADREMENT: readonly string[] = [
  'securite', 'securite-consentement', 'securite-ia', 'securite-audit', 'securite-erreurs',
];

/**
 * Ce rôle peut-il ouvrir cet écran ?
 *
 * ⚠️ C'est un CONFORT, pas un contrôle : la barrière est le `preHandler` du serveur. Elle existe pour ne pas
 * promettre une porte fermée, ce qui est exactement ce que l'ancien `adminOnly` faisait à l'envers.
 */
export function accesAutorise(ecran: string, role: string): boolean {
  if (role === 'admin') return true;
  if (ecran === 'inbox') return true;
  return role === 'manager' && ECRANS_ENCADREMENT.includes(ecran);
}

/**
 * L'arbre de nav réduit à ce que ce rôle peut ouvrir.
 *
 * ⚠️ UN GROUPE DONT PLUS AUCUN ENFANT N'EST OUVERT DISPARAÎT, sinon on afficherait un dossier vide. Un
 * groupe dont la clé elle-même est autorisée (la page d'accueil de Sécurité) est gardé même si ses enfants
 * sont filtrés : c'est le cas d'une page qui existe par elle-même.
 */
export function navPourRole(items: NavEntree[], role: string): NavEntree[] {
  if (role === 'admin') return items;
  const garder = (liste: NavEntree[]): NavEntree[] => liste.flatMap((item) => {
    if (item.children) {
      const enfants = garder(item.children);
      if (enfants.length === 0 && !accesAutorise(item.key, role)) return [];
      return [{ ...item, children: enfants }];
    }
    return accesAutorise(item.key, role) ? [item] : [];
  });
  return garder(items);
}

/**
 * Le traducteur de la console, tel que la barre l'utilise.
 *
 * ⚠️ `en` est OBLIGATOIRE ICI, alors que `useT()` le déclare facultatif, et ce n'est pas un oubli à
 * « corriger » : la carte de la console a besoin des DEUX libellés, et une entrée écrite `t('Accueil')`
 * produirait un libellé anglais vide sans que rien ne le signale. Le rendre obligatoire fait de cet oubli
 * une erreur de compilation. Un traducteur à `en` facultatif reste assignable à ce type, donc `useT()`
 * passe tel quel.
 */
export type Traducteur = (fr: string, en: string) => string;

/**
 * Les QUATRE listes de la barre, BRUTES, sans être composées.
 *
 * 🔴 `adminBas` (le bloc Developers) appartient à la Console pour la DÉDUCTION d'onglet, mais il se rend à
 * PART, collé en bas de la colonne. Les fusionner ici afficherait « Developers » deux fois, ce qui est déjà
 * arrivé et que l'E2E avait attrapé en refusant un sélecteur résolvant à deux éléments. La composition
 * reste donc chez l'appelant.
 */
export interface ListesNav {
  console: NavEntree[];
  inbox: NavEntree[];
  perf: NavEntree[];
  adminBas: NavEntree[];
}

/** Icônes de nav (tracés SVG, aucune dépendance). */
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
  // Un bouclier : c'est le seul pictogramme que tout le monde lit « sécurité » sans légende.
  securite: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  // Tools : une prise. Ce menu regroupe ce qui BRANCHE la console sur l'extérieur.
  tools: 'M9 2v6M15 2v6M7 8h10v5a5 5 0 01-10 0V8zM12 18v4',
  mba: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM6 19l.7 1.9L8.6 21l-1.9.7L6 23.6l-.7-1.9L3.4 21l1.9-.1L6 19z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a1.65 1.65 0 00.33 1.82l.05.05a2 2 0 11-2.83 2.83l-.05-.05a1.65 1.65 0 00-2.82 1.17V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.05.05a2 2 0 11-2.83-2.83l.05-.05A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.05-.05a2 2 0 112.83-2.83l.05.05A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.05-.05a2 2 0 112.83 2.83l-.05.05A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
};

/**
 * LES QUATRE LISTES DE LA BARRE, structure ET libellés.
 *
 * 🔴 POURQUOI UNE FONCTION ET PAS UNE CONSTANTE : les libellés suivent la langue courante, ils ne peuvent
 * donc pas être figés au chargement du module. Et pourquoi structure et libellés ENSEMBLE plutôt qu'une
 * constante de structure plus une table de libellés : ce seraient deux listes à tenir alignées à la main,
 * et le CLAUDE.md de ce dépôt documente ce que ça coûte.
 *
 * 🔴 ELLES ONT QUITTÉ `AppShell` LE 2026-09-11, et pas pour ranger. Cette barre est la CARTE de la console :
 * chaque entrée porte une clé stable, une adresse et un libellé bilingue, et c'est la seule description de
 * l'application qui ne puisse pas être fausse. Construite à l'intérieur du composant, au rendu, elle
 * n'était lisible par personne d'autre ; ici, `tests/web-carte-console.test.ts` la vérifie contre les pages
 * réelles, et le bot d'aide pourra s'en servir pour emmener quelqu'un sur le bon écran.
 *
 * ⚠️ `badgeInbox` est une valeur d'EXÉCUTION (le compte de non-lus), pas une propriété de la carte. C'est un
 * paramètre pour que la fonction reste appelable hors composant, là où ce compte n'existe pas.
 */
export function arbresNav(t: Traducteur, badgeInbox = 0): ListesNav {
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
      /**
       * « Other AI agent » devient un GROUPE le 2026-09-08 (demande de Julien) : la fiche des agents d'un
       * côté, le crédit de l'autre. Le solde n'est pas un réglage d'agent, il est celui de l'ESPACE : tous
       * les agents y puisent, et le ranger dans la fiche de l'un d'eux laisserait croire le contraire.
       *
       * ⚠️ `/agents` NE BOUGE PAS : c'est l'écran d'aujourd'hui, avec ses huit onglets et ses liens déjà
       * partagés. Seule l'entrée de menu gagne un parent.
       */
      { key: 'agents-groupe', label: t('Other AI agent', 'Other AI agent'), children: [
        { key: 'agents', href: '/agents', label: t('Agents', 'Agents') },
        { key: 'agents-credit', href: '/agents/credit', label: t('Crédit', 'Credit') },
      ] },
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
      /**
       * 🔴 « SCÉNARIO » EST ICI DEPUIS LE 2026-09-13 (demande de Julien), ET IL EST LE SEUL ENFANT DE
       * CONTENU QUI NE SOIT PAS UN GROUPE DE CANAL. Contenu est rangé par canal (WhatsApp / RCS /
       * Email / Bibliothèque) ; un scénario, lui, les TRAVERSE : le même parcours peut ouvrir en
       * WhatsApp, poursuivre en RCS et finir par un e-mail.
       *
       * ⚠️ LA TENSION A ÉTÉ POSÉE À JULIEN ET TRANCHÉE PAR LUI, plutôt que contournée en silence. Deux
       * autres places se défendaient : dans « Bibliothèque », qui est précisément « ce qui se réutilise
       * sans appartenir à un canal », ou en restant dans la liste du haut. Il a choisi « juste après
       * Email », à plat. Ne pas le « ranger » ailleurs par cohérence de structure sans le lui demander.
       */
      // ⚠️ SANS ICÔNE, demandé par Julien le 2026-09-14 (« enlever la petite icône devant scénario dans la
      // sidebar »). `d` est optionnel dans `NavEntree` : le rendu s'en passe sans réserver la place.
      { key: 'workflows', href: '/workflows', label: t('Scénario', 'Scenario') },
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
    // appartient. Les serveurs MCP y sont depuis le 2026-09-17, à côté des connecteurs API : même place,
    // même raison, et la même bibliothèque d'outils derrière.
    { key: 'tools', label: t('Tools', 'Tools'), d: icons.tools, children: [
      { key: 'webhooks', href: '/webhooks', label: t('Webhooks', 'Webhooks') },
      { key: 'connecteurs', href: '/connecteurs', label: t('Connecteurs API', 'API connectors') },
      // 🔴 « Outils » AU NIVEAU DE L'ESPACE, à côté des connecteurs, depuis la migration 0127. Un connecteur
      // est le SYSTÈME, un outil est l'ACTION qu'on y fait : les deux appartiennent au client, pas à un
      // agent. C'est ici qu'on voit qu'un outil sert à plusieurs agents, ce qu'aucun écran ne disait.
      // 🔴 « CONNECTEURS MCP », ET PAS « SERVEURS MCP ». `Developers > Serveur MCP` existe deja et decrit
      // le sens INVERSE (ce que NOUS exposons). Deux entrees a un S pres, pour deux choses opposees,
      // seraient indistinguables a la lecture. « Connecteurs » dit la meme chose que « Connecteurs API »
      // juste au-dessus : on va chercher ailleurs.
      { key: 'connecteurs-mcp', href: '/connecteurs-mcp', label: t('Connecteurs MCP', 'MCP connectors') },
      { key: 'outils-espace', href: '/outils', label: t('Outils', 'Tools') },
    ] },
  ];
  // Second tableau, rendu dans son propre conteneur COLLÉ EN BAS de la barre. La nav n'a aucun mécanisme de
  // placement (pas de champ `position`), donc le bas se fait par la structure, pas par une propriété d'entrée.
  const NAV_ADMIN_BAS: NavEntree[] = [
    // ⚠️ PARAMÈTRES ET SUPPORT SONT ICI DEPUIS LE 2026-09-08 (demande de Julien), et pas au bout de la liste
    // du haut. Ils ne servent pas le travail quotidien : ils le RÈGLENT, comme Developers juste en dessous.
    // Les laisser en fin de liste haute les mettait au même rang que Campagnes ou Scénario, qu'on ouvre dix
    // fois par jour. Aucune adresse ne change.
    { key: 'parametres', href: '/parametres', label: t('Paramètres', 'Settings'), d: icons.settings },
    { key: 'support', href: '/support', label: t('Support', 'Support'), d: icons.support },
    /**
     * LE CENTRE DE SÉCURITÉ & COMPLIANCE (2026-09-13).
     *
     * ⚠️ SES SOUS-MENUS ARRIVENT AU FUR ET À MESURE DE LEUR CONTENU, et c'est délibéré : une entrée de
     * menu qui ouvre une page vide est pire que pas d'entrée. Les deux journaux y sont parce qu'ils
     * EXISTAIENT déjà, dans Paramètres, où ils n'avaient rien à faire : on les consulte pour rendre des
     * comptes, pas pour régler l'espace. Consentement et IA suivront avec leurs écrans.
     */
    { key: 'securite', label: t('Sécurité', 'Security'), d: icons.securite, children: [
      // Le CONSENTEMENT en premier : c'est le seul sous-menu qui décrit ce que le produit s'interdit de
      // faire, les deux autres racontent ce qu'il a fait.
      { key: 'securite-consentement', href: '/securite/consentement', label: t('Consentement', 'Consent') },
      // L'IA juste après : comme le consentement, elle décrit ce que le produit s'ENGAGE à faire, quand les
      // deux journaux racontent ce qu'il A fait.
      { key: 'securite-ia', href: '/securite/ia', label: t('IA', 'AI') },
      { key: 'securite-audit', href: '/securite/audit', label: t('Audit trails', 'Audit trails') },
      { key: 'securite-erreurs', href: '/securite/erreurs', label: t('Journal des erreurs', 'Error log') },
    ] },
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
  const NAV_INBOX: NavEntree[] = [{ key: 'inbox', href: '/inbox', label: t('Inbox', 'Inbox'), d: icons.inbox, badge: badgeInbox }];

  /**
   * Les enfants de l'ancien groupe « Analytics », remontés d'un cran : dans cet onglet, ils SONT le menu.
   *
   * ⚠️ Aucune icône, et c'est un choix. Le rendu les accepte sans (`{item.d && <Ico …>}`), elles sont toutes
   * dans le même onglet donc l'icône ne distingue rien, et n'en donner qu'à certaines les désalignerait.
   * Le groupe « Quantitatif » n'en avait déjà pas.
   */
  const NAV_PERF: NavEntree[] = [
    /**
     * La synthese, PREMIERE entree et porte d entree de l onglet depuis le lot F (2026-09-08).
     *
     * ⚠️ `/dashboard` reste l adresse du premier sous-onglet quantitatif et n a PAS bouge : trois specs
     * Playwright et des liens deja distribues y pointent. Ce qui change, c est ou l onglet emmene par
     * defaut, et c est exactement ce que le lot A avait annonce (« la page de synthese des lots E et F
     * prendra sa propre adresse »). Elle ne fait pas d aiguillage : elle porte ce que les sous-onglets ne
     * montrent nulle part, donc elle n ajoute un clic a personne.
     */
    { key: 'perf-synthese', href: '/performance', label: t('Synthèse', 'Summary') },
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
  return { console: NAV_CONSOLE, inbox: NAV_INBOX, perf: NAV_PERF, adminBas: NAV_ADMIN_BAS };
}
