import type { ControlOwner } from './store.pg';

/**
 * La fenetre de service client de Meta : 24 h depuis le DERNIER message ENTRANT. Au-dela, aucun echange
 * n est possible sans template, et surtout aucune passation de fil n a de sens puisqu il n y a plus de
 * session a transmettre.
 *
 * Une constante et pas un reglage : ce delai appartient a Meta, pas a nous, et un client ne peut pas le
 * changer. Le rendre reglable donnerait l illusion d une prise sur une regle qui nous est imposee.
 */
const FENETRE_META_MS = 24 * 60 * 60 * 1000;

/** Ce dont le balayage a besoin (interface étroite, satisfaite par PgInboxStore). */
export interface ControlSweepDeps {
  /**
   * Les conversations dont le fil est détenu. `ageScenarioMs` borne ce qu'on ramène des fils tenus par un
   * SCÉNARIO : seuls les plus vieux que ce délai entrent, parce que `app_workflow` est l'état normal de
   * toute conversation et que les ramener tous saturerait le lot au détriment des fils humains à rendre.
   */
  listHeldControl(
    limit?: number,
    ageScenarioMs?: number,
  ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null; lastMessageAt: Date | null }>>;
  setControlOwner(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    opts?: { only?: readonly ControlOwner[] },
  ): Promise<boolean>;
  /**
   * Délai d'inactivité par détenteur, en ms. C'est le DÉFAUT du serveur : il s'applique aux clients qui
   * n'ont rien réglé. 0 ou absent = cet état n'est jamais repris automatiquement.
   */
  timeouts: Partial<Record<ControlOwner, number>>;
  /**
   * Réglage PAR CLIENT de la durée du gel humain, en ms. Absent de la Map = ce client n'a rien réglé, on
   * applique le défaut ci-dessus. Une valeur 0 = ce client ne veut aucune reprise automatique.
   *
   * Ne concerne QUE `app_human` : c'est la seule durée qui relève d'un arbitrage métier du client (combien
   * de temps on laisse un opérateur travailler tranquille). Le délai `mba` reste un garde-fou technique.
   */
  handbackMsByTenant?(tenantIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * L'agent de Meta est-il allumé chez ce client ? Décide de la DESTINATION d'un fil rendu : l'agent quand il
   * est là, le scénario sinon. Absent -> aucun tenant n'a MBA, donc comportement historique.
   */
  mbaActifParTenant?(tenantIds: readonly string[]): Promise<Set<string>>;
  /**
   * Rend effectivement le fil à Meta (`thread_control` action `release`). Appelé UNIQUEMENT quand la
   * destination est `mba`, et UNIQUEMENT sur une fenêtre encore ouverte.
   *
   * 🔴 SON VERDICT GOUVERNE L'ÉCRITURE LOCALE DEPUIS LE 2026-09-15. `false` (aucun numéro connecté) et une
   * exception (Meta refuse) empêchent tous deux la bascule locale. Le commentaire d'avant annonçait
   * l'inverse (« un échec ne doit pas empêcher la bascule locale ») : c'est ce best-effort qui a produit neuf
   * conversations annonçant `mba` alors que Meta pensait le contraire.
   */
  releaseToMba?(tenantId: string, waId: string): Promise<boolean>;
  now?: () => number;
}

/**
 * Rend la main au scénario sur les conversations que plus personne ne traite.
 *
 * Raison d'être : il n'existe AUCUN release automatique côté Meta. Sans ce balayage, un opérateur qui ferme
 * son onglet, ou un worker qui meurt, gèlerait la conversation indéfiniment, avec le scénario muet et le
 * client sans réponse. C'est la soupape de la capacité de gel, et elle doit partir dans le même
 * déploiement qu'elle.
 *
 * Extrait de `main()` pour être testable, comme ses jumeaux `campaign/schedule-sweep` et `analysis/sweep`.
 *
 * Renvoie le nombre de conversations réellement rendues.
 */
export async function runControlSweep(deps: ControlSweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());

  // Le lot ramène toutes les conversations tenues par un HUMAIN ou par l'agent de Meta sans aucun filtre
  // d'âge : ces délais-là sont réglables par client et peuvent être plus courts que le défaut du serveur,
  // donc un filtre SQL basé sur le défaut raterait silencieusement les conversations des clients pressés.
  //
  // ⚠️ LES FILS DE SCÉNARIO, EUX, SONT FILTRÉS PAR ÂGE EN SQL, et l'écart est voulu : leur délai est FIXE,
  // donc il peut voyager jusqu'à la requête. Sans ce filtre, `app_workflow` étant l'état NORMAL de toute
  // conversation, le lot serait saturé de fils parfaitement sains et les fils humains à rendre, plus
  // anciens, ne seraient jamais atteints.
  // Le délai des fils de scénario est FIXE (jamais réglable par client), donc il peut voyager jusqu'au SQL
  // et y borner ce qu'on ramène. 0 ou absent = on n'en ramène aucun, c'est-à-dire le comportement d'avant.
  const held = await deps.listHeldControl(undefined, deps.timeouts.app_workflow ?? 0);
  if (held.length === 0) return 0;

  // Un seul aller-retour pour tous les clients du lot, au lieu d'une requête par conversation.
  const tenantIds = [...new Set(held.map((c) => c.tenantId))];
  const parTenant = deps.handbackMsByTenant
    ? await deps.handbackMsByTenant(tenantIds)
    : new Map<string, number>();
  // Un seul aller-retour aussi pour savoir qui a l'agent de Meta allumé.
  const avecMba = deps.mbaActifParTenant ? await deps.mbaActifParTenant(tenantIds) : new Set<string>();

  let rendues = 0;
  for (const c of held) {
    // Le réglage du client prime sur le défaut du serveur, et UNIQUEMENT sur le gel humain : c'est la
    // seule durée qui relève d'un arbitrage métier (combien de temps on laisse un opérateur travailler).
    const reglageClient = c.owner === 'app_human' ? parTenant.get(c.tenantId) : undefined;
    const ms = reglageClient ?? deps.timeouts[c.owner];
    // Absent ou 0 = jamais de reprise automatique pour cet état. Un client qui pose 0 garde la main
    // jusqu'à ce qu'un opérateur la rende explicitement, c'est un choix légitime.
    if (ms === undefined || ms <= 0) continue;
    // `changedAt` null = bascule antérieure à la migration 0040, donc éligible (sinon ces conversations
    // resteraient bloquées pour toujours, ce qui est exactement ce que ce balayage existe pour éviter).
    if (c.changedAt !== null && now() - c.changedAt.getTime() < ms) continue;
    // `only` sur le détenteur LU : si une bascule est survenue entre la lecture et l'écriture (un opérateur
    // qui reprend la main juste à cet instant), la garde refuse et on ne détruit pas un contrôle tout neuf.
    // Destination : l'agent de Meta quand il est allumé chez ce client, le scénario sinon. Rien à arbitrer, la
    // règle se déduit de l'état du compte, ce qui est tout l'objet de la suppression du réglage de reprise.
    /**
     * 🔴 `app_workflow` REND AUSSI LA MAIN DEPUIS LE 2026-09-14, et c'est la soupape du geste `take`.
     * Avant, un scénario n'écrivait que notre colonne et Meta gardait le fil : son agent reprenait tout
     * seul. Depuis qu'on le prend pour de vrai, un parcours abandonné (le contact ne répond jamais, le run
     * reste `waiting`) garderait le fil à jamais.
     *
     * ⚠️ Sans MBA chez ce client, la destination vaut `app_workflow`, donc la valeur que la conversation
     * porte déjà : `setControlOwner` refuse une écriture qui ne change rien, la boucle passe au suivant, et
     * rien ne bouge. Ce cas est inoffensif par construction, pas par précaution.
     */
    /**
     * 🔴 ON NE PASSE PAS LA MAIN SUR UNE FENÊTRE FERMÉE, ET C'EST LE CORRECTIF DU 2026-09-15.
     *
     * L'agent de Meta ne peut prendre un fil que s'il existe une session ouverte. Mesuré ce jour-là : ce
     * balayage a rendu DIX conversations d'un coup, toutes muettes depuis 166 à 281 heures, donc toutes hors
     * fenêtre. Il n'y avait rien à transmettre, et le message suivant de l'une d'elles est arrivé en
     * `messages` (donc chez NOUS) au lieu de `standby` : notre colonne disait `mba`, Meta pensait l'inverse,
     * et personne n'a répondu au client.
     *
     * ⚠️ ON SAUTE, ON NE REPLIE PAS SUR `app_workflow`. Ce serait échanger un défaut contre un pire : c'est
     * la SEULE valeur que le dossier « À traiter » exclut, donc une conversation `app_human` abandonnée
     * deviendrait invisible au lieu d'être une ligne de travail. Sauter la laisse telle quelle, donc visible,
     * et le message entrant la reprendra (`remiseMbaSiPersonneNeSuit`) le jour où le client revient.
     *
     * ⚠️ `lastMessageAt` EST UN PROXY À SENS UNIQUE : un dernier message vieux de plus de 24 h PROUVE que la
     * fenêtre est fermée ; un dernier message récent mais SORTANT ne prouve pas qu'elle est ouverte. C'est
     * l'ordre inversé ci-dessous qui absorbe cette imprécision.
     */
    const fenetreOuverte = c.lastMessageAt !== null && now() - c.lastMessageAt.getTime() < FENETRE_META_MS;
    const versMba = (c.owner === 'app_human' || c.owner === 'app_workflow') && avecMba.has(c.tenantId);
    /**
     * ⚠️ LA GARDE PORTE SUR `versMba`, PAS SUR « ce client a l'agent allumé », ET LA NUANCE A ÉTÉ TROUVÉE EN
     * REVUE. Une première version sautait dès que le client avait l'agent, ce qui bloquait aussi les
     * transitions qui ne parlent PAS à Meta : un fil déjà détenu par l'agent, repris vers le scénario au bout
     * de 24 h, n'émet aucun appel et n'a donc rien à faire d'une fenêtre. La garde n'a de sens que là où un
     * appel Meta allait partir.
     */
    if (versMba && !fenetreOuverte) continue;
    /**
     * 🔴 META D'ABORD, L'ÉCRITURE ENSUITE, ET L'ORDRE EST INVERSÉ DEPUIS LE 2026-09-15.
     *
     * Il était l'inverse, avec cette raison : « la bascule locale d'abord, l'appel Meta en best-effort :
     * l'inverse laisserait un fil gelé pour toujours sur un hoquet réseau ». Cette crainte ne tient plus, et
     * elle ne tenait déjà pas tout à fait : refuser d'écrire ne GÈLE rien, ça laisse la conversation dans
     * l'état où elle est, donc VISIBLE, et ce balayage repasse toutes les cinq minutes. Ce qui l'emporte,
     * c'est qu'écrire un état que Meta n'a pas confirmé produit exactement la panne du 2026-09-15 : deux
     * systèmes qui se croient chacun déchargés du client.
     *
     * ⚠️ `rendreLeFil` LÈVE quand Meta refuse et rend `false` quand il n'y a aucun numéro connecté. Les deux
     * empêchent l'écriture, pour la même raison, et seul le refus mérite une trace : l'absence de numéro est
     * un état de configuration, pas une panne.
     *
     * ⚠️ RÉSIDU ASSUMÉ, RELEVÉ EN REVUE LE 2026-09-15, ET C'EST LE PRIX DE L'INVERSION. L'ordre d'avant
     * protégeait d'une course : la garde `only` refusait l'écriture si un opérateur avait repris la main
     * entre la lecture du lot et l'écriture, et l'appel Meta était alors sauté. Avec Meta d'abord, cette
     * course reste ouverte pendant la durée de l'appel. Le calcul est délibéré : la course demande un clic
     * « Reprendre la main » dans la fraction de seconde où ce balayage traite CETTE conversation, et son
     * remède est un second clic ; le défaut qu'on ferme, lui, a laissé neuf conversations dans un état faux
     * pendant des heures, sans recours. ⚠️ Le geste du chemin entrant (`remiseMbaSiPersonneNeSuit`), lui,
     * relit bien le détenteur avant d'appeler Meta : là-bas le risque est permanent, pas fugace.
     */
    /**
     * 🔴 « RIEN À RENDRE » N'EST PAS « RÉESSAYER PLUS TARD », et les confondre faisait boucler ce balayage
     * pour toujours. `releaseToMba` rend `false` quand il n'y avait RIEN à rendre : une conversation de
     * TEST (le fil est resté à l'application, délibérément), ou un espace sans numéro. Sauter la ligne
     * laissait alors la conversation en `app_human` immobile, donc CANDIDATE à la passe suivante, et à
     * toutes les suivantes : l'ensemble grossissait à chaque essai de Julien.
     *
     * ⚠️ UNE EXCEPTION, ELLE, RESTE UN `continue`. C'est le cas où Meta a REFUSÉ : là il y a bien quelque
     * chose à rendre et on n'y est pas arrivé, donc réessayer est juste. La distinction tient parce que
     * `rendreLeFil` LÈVE sur un refus de Meta et ne rend `false` que sur une absence de numéro.
     *
     * ⚠️ ET LA DESTINATION SUIT LE FAIT, pas l'intention : rien n'est parti chez Meta, donc on n'écrit pas
     * `mba`. `app_workflow` dit la vérité, c'est-à-dire que l'application garde le fil, exactement comme
     * pour un espace qui n'a pas d'agent de Meta du tout.
     */
    let rendu = true;
    if (versMba && deps.releaseToMba) {
      try {
        rendu = await deps.releaseToMba(c.tenantId, c.waId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`release vers MBA REFUSÉ pour ${c.waId}, l’état local n’a pas été écrit:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    const dest: ControlOwner = versMba && rendu ? 'mba' : 'app_workflow';
    if (!(await deps.setControlOwner(c.tenantId, c.waId, dest, { only: [c.owner] }))) continue;
    rendues += 1;
  }
  return rendues;
}
