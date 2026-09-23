import { evaluateConditionGroup } from '../workflow/conditions';
import type { EvalContext } from '../workflow/conditions';
import { matchesTrigger, isInCooldown, reprendLaMain } from './match';
import type { AutomationRow, AutomationEvent, AutomationTriggerKind } from './match';

/**
 * Déclenche les scénarios abonnés à un événement. IO INJECTÉE (aucun import pg) -> testable sans base, comme
 * `WorkflowExecutor`. Le matching pur vit dans `./match`, l'évaluation des conditions dans `workflow/conditions`.
 *
 * Trois filtres composés, dans cet ordre (du moins cher au plus cher) :
 *   1. le déclencheur correspond à l'événement (pur, aucune requête) ;
 *   2. le contact n'est pas en anti-rebond pour cette automation (1 requête par automation candidate) ;
 *   3. le `conditionGroup` éventuel est satisfait (contexte contact construit UNE fois, et seulement si besoin).
 */
export interface AutomationRunnerDeps {
  /**
   * Ce contact est-il bloqué ? Un contact bloqué ne déclenche plus aucune automation : son message est
   * enregistré et reste lisible, mais rien ne part vers lui.
   *
   * OPTIONNELLE : absente, aucun contact n'est bloqué, c'est-à-dire le comportement d'avant la modération.
   */
  contactBloque?(tenantId: string, waId: string): Promise<boolean>;
  /** Automations ACTIVES du tenant pour ces types de déclencheur (index partiel `enabled`). */
  listEnabled(tenantId: string, kinds: readonly AutomationTriggerKind[]): Promise<AutomationRow[]>;
  /** Dernier déclenchement de cette automation pour ce contact. null = jamais déclenché. */
  lastFiredAt(automationId: string, waId: string): Promise<Date | null>;
  /**
   * Enregistre le déclenchement (upsert). Appelé AVANT le démarrage : voir la note anti-boucle plus bas.
   *
   * `marqueur` retient POUR QUELLE occurrence on a tiré. Seul `avant_date` s'en sert : une date qui change
   * est une occurrence neuve, et le balayage a besoin de distinguer « déjà tiré » de « déjà tiré POUR CETTE
   * date », sans quoi un rendez-vous reporté ne redonnerait aucun rappel.
   *
   * 🔴 AVEC un marqueur, c'est un CLAIM : `false` = ce marqueur était déjà en place, un autre tour a tiré pour
   * cette occurrence, il ne faut pas tirer. C'est ce qui empêche un rappel de partir deux fois (R10). Sans
   * marqueur, l'écriture est inconditionnelle et rend toujours `true`.
   */
  markFired(automationId: string, waId: string, marqueur?: string): Promise<boolean>;
  /**
   * Annule le déclenchement enregistré. Appelé quand le scénario n'a PAS démarré (`false`) : dans ce cas rien
   * n'a été envoyé (les gardes de l'exécuteur agissent AVANT tout envoi), donc consommer l'anti-rebond
   * avalerait la prochaine vraie demande du client pendant toute la durée du délai.
   */
  clearFired(automationId: string, waId: string): Promise<void>;
  /**
   * État du contact pour évaluer un `conditionGroup`. null = contact introuvable -> les automations qui ont
   * une condition sont ALORS ignorées (on ne déclenche pas « au cas où » sur un filtre qu'on n'a pas pu vérifier).
   * Non appelé du tout si aucune automation candidate n'a de condition.
   */
  evalContext(tenantId: string, waId: string): Promise<EvalContext | null>;
  /**
   * Démarre le scénario. Renvoie false s'il n'a pas démarré (fil détenu, bloc absent, scénario supprimé).
   *
   * `windowOpen` = la fenêtre de service 24 h est PROUVÉE ouverte (le contact vient d'écrire). Le scénario peut
   * alors ouvrir par un message rapide / formulaire ; sinon la garde de l'exécuteur s'applique.
   */
  /**
   * true = parti. `false` OU une chaîne (la raison du refus) = pas parti : l'automation ne consomme
   * que le fait, pas la raison.
   *
   * 🔴 LES TROIS DERNIERS ARGUMENTS VOYAGENT DANS UN OBJET, et ce n'est pas de la cosmétique. Une flèche à
   * cinq paramètres reste assignable à un contrat qui en déclare six, et le sixième est avalé EN SILENCE
   * (mesuré dans ce dépôt, cf. le CLAUDE.md). Le jour où `reprendLaMain` est né, un câblage écrit pour
   * l'ancienne signature aurait donc continué de compiler en ignorant la reprise de main. Changer la FORME
   * force le compilateur à nommer chaque implémentation.
   */
  startWorkflow(tenantId: string, workflowId: string, waId: string, opts: {
    startNodeId: string | null;
    /** La fenêtre de service 24 h est PROUVÉE ouverte (le contact vient d'écrire). */
    windowOpen: boolean;
    /**
     * Ce démarrage REPREND la conduite du fil, même tenue par un opérateur ou par l'agent de Meta.
     *
     * Réservé aux automations POSSÉDÉES qui naissent d'un geste du contact (`reprendLaMain`) : le bouton
     * d'une chaîne, et depuis le lot 3 le clic sur une publicité. C'est un geste EXPLICITE de l'abonné vers
     * ce scénario, exactement comme une campagne est un geste explicite d'un opérateur. Une automation
     * ordinaire vaut `false` et reste bloquée par un fil tenu, ce qui est le bon défaut.
     */
    reprendLaMain: boolean;
  }): Promise<boolean | string>;
  /** Anti-rebond appliqué aux automations qui n'ont rien réglé (`cooldownSeconds` null). */
  defaultCooldownSeconds: number;
  /**
   * Nombre de déclenchements de cette automation depuis `since`. Sert le PLAFOND horaire ci-dessous.
   * Absent -> aucun plafond (rétro-compatible pour les suites de tests à deps minimales).
   */
  firedSince?(automationId: string, since: Date): Promise<number>;
  /**
   * Plafond de declenchements par automation et par heure, PAR DEFAUT pour l'instance. L'anti-rebond est par
   * (automation, CONTACT) : il n'empeche donc rien a l'echelle d'une population. Or un seul acte
   * d'exploitation peut produire des milliers d'evenements d'un coup (une campagne directe rouvre l'analyse
   * de tous ses destinataires, qui repartent ensuite en « conversation analysee »). Ce plafond est la seule
   * chose qui borne la facture dans ce cas.
   *
   * 🔴 Une automation qui porte son PROPRE `maxFiresPerHour` l'emporte sur celui-ci, plus strict comme plus
   * large (cf. juste en dessous, dans la boucle). Ce reglage-ci reste la regle de toutes les autres.
   */
  maxFiresPerHour?: number;
  now?: () => number;
}

/**
 * CE QUI RESTREINT UN TOUR D'ÉVALUATION, quand l'appelant en sait plus que le déclencheur.
 *
 * 🔴 UN SEUL APPELANT LA POSE AUJOURD'HUI : le routage d'un lead publicitaire (lot 3, spec § 3.3), qui exige
 * que **seule** l'automation de la publicité soit évaluée. Ce n'est pas exprimable par la mise en
 * correspondance : une automation `ctwa_ad` sans pub précise veut dire « n'importe quelle pub », et elle a
 * raison de le vouloir partout ailleurs. Il fallait donc pouvoir dire « celle-là, et aucune autre ».
 *
 * ⚠️ ELLE NE DISPENSE D'AUCUN FILTRE : l'automation nommée passe quand même l'anti-rebond, sa condition et
 * son plafond. Restreindre l'ENSEMBLE des candidates n'est pas donner un laissez-passer à celle qui reste.
 */
export interface OptionsRun {
  /** `null` = aucune restriction, c'est-à-dire le comportement de tous les appelants sauf un. */
  seuleAutomation: string | null;
}

const SANS_RESTRICTION: OptionsRun = { seuleAutomation: null };

/** Les types de déclencheur qu'un événement donné peut activer (évite de charger des automations hors sujet). */
function kindsFor(ev: AutomationEvent): AutomationTriggerKind[] {
  if (ev.kind === 'message') return ['keyword', 'new_contact', 'ctwa_ad'];
  if (ev.kind === 'tag_added') return ['tag_added'];
  if (ev.kind === 'hubspot_deal_stage') return ['hubspot_deal_stage'];
  if (ev.kind === 'webhook') return ['webhook'];
  if (ev.kind === 'avant_date') return ['avant_date'];
  return ['conversation_analyzed'];
}

/**
 * Évalue les automations d'un tenant contre un événement et démarre celles qui passent les trois filtres.
 * Renvoie le nombre de scénarios réellement démarrés.
 *
 * Isolation PAR AUTOMATION : une automation qui échoue (scénario supprimé, base indisponible) ne doit pas
 * empêcher les autres de se déclencher, ni faire échouer l'appelant (le job webhook est partagé).
 */
export async function runAutomations(
  tenantId: string,
  ev: AutomationEvent,
  deps: AutomationRunnerDeps,
  opts: OptionsRun = SANS_RESTRICTION,
): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  // Contact BLOQUÉ : son message reste enregistré et lisible, mais il ne déclenche plus rien. C'est le seul
  // point d'entrée des automations, donc la seule garde nécessaire pour que « bloqué » veuille dire quelque
  // chose côté scénarios. Dépendance optionnelle : absente, rien ne change.
  if (deps.contactBloque && (await deps.contactBloque(tenantId, ev.waId))) return 0;
  // ⚠️ LA RESTRICTION S'APPLIQUE AVANT LA MISE EN CORRESPONDANCE, et l'ordre de ces deux filtres n'est pas
  // indifférent : l'inverse évaluerait `matchesTrigger` sur des automations qu'on vient d'écarter, donc
  // ferait dépendre le résultat de leur configuration. Ici, « seule celle-là » veut dire exactement ça.
  const candidates = (await deps.listEnabled(tenantId, kindsFor(ev)))
    .filter((a) => opts.seuleAutomation === null || a.id === opts.seuleAutomation)
    .filter((a) => a.enabled && matchesTrigger(a, ev));
  if (candidates.length === 0) return 0;

  // Contexte contact construit UNE seule fois, et SEULEMENT si au moins une candidate porte une condition
  // (même principe que `buildCtx` dans l'executor : pas de requête pour un graphe qui n'en a pas besoin).
  let ctx: EvalContext | null = null;
  let ctxLoaded = false;

  // La fenêtre de service 24 h est PROUVÉE ouverte quand l'événement est un message entrant WHATSAPP : le
  // contact vient d'écrire À META. Le scénario déclenché peut donc légitimement ouvrir par un message rapide ou
  // un formulaire (usage ouvert par le Lot D). Un événement qui ne prouve pas la fenêtre (tag posé depuis le
  // CRM) garde la protection.
  //
  // 🔴 Le test du CANAL n'est pas un détail : un message reçu en RCS ne passe pas par Meta et ne rouvre
  // aucune fenêtre. Sans lui, brancher les automations sur le RCS aurait fait partir un message rapide
  // WhatsApp chez un contact hors fenêtre, refusé en 131047. C'est mot pour mot le défaut que bf0408d a
  // corrigé ailleurs, réintroduit par une autre porte.
  const windowOpen = ev.kind === 'message' && ev.channel === 'whatsapp';

  let started = 0;
  for (const a of candidates) {
    try {
      // L'anti-rebond ne s'applique PAS à `avant_date`. Il protège d'un même événement qui se répète ;
      // ici l'unicité est déjà garantie, et plus finement, par le marqueur d'occurrence que le balayage
      // consulte. L'appliquer en plus empêcherait un rendez-vous reporté à l'intérieur du délai de
      // redonner son rappel, ce qui est exactement ce qu'on veut permettre.
      if (ev.kind !== 'avant_date') {
        const last = await deps.lastFiredAt(a.id, ev.waId);
        if (isInCooldown(last, a.cooldownSeconds, deps.defaultCooldownSeconds, now())) continue;
      }

      if (a.conditionGroup) {
        if (!ctxLoaded) { ctx = await deps.evalContext(tenantId, ev.waId); ctxLoaded = true; }
        // Contact introuvable : on ne peut pas vérifier le filtre, donc on ne déclenche pas.
        if (!ctx || !evaluateConditionGroup(a.conditionGroup, ctx)) continue;
      }

      // Plafond par automation : borne le fan-out d'un evenement de masse (analyse rouverte pour toute une
      // campagne, par exemple). Verifie APRES l'anti-rebond (moins cher) et AVANT tout demarrage.
      //
      // 🔴 Le plafond de l'AUTOMATION l'emporte sur celui de l'instance. Un lien de chaine WhatsApp doit
      // pouvoir accueillir des milliers d'abonnes apres un post qui marche, sans qu'on desserre pour autant
      // la garde des autres automations, qui elle borne des envois FACTURES. `null` = pas de reglage propre,
      // donc le plafond de l'instance s'applique, ce qui est le cas de toutes les automations ordinaires.
      // `0` (ici comme au global) veut dire « aucun plafond », c'est un choix explicite et non un oubli.
      const plafond = a.maxFiresPerHour ?? deps.maxFiresPerHour;
      if (deps.firedSince && plafond !== undefined && plafond > 0) {
        const depuis = new Date(now() - 3600_000);
        if ((await deps.firedSince(a.id, depuis)) >= plafond) {
          // Le message porte le plafond REELLEMENT applique : annoncer celui de l'instance alors que celui
          // de l'automation a tranche enverrait chercher le reglage au mauvais endroit, et une automation
          // n'a aucun ecran ou cette raison pourrait s'afficher.
          // eslint-disable-next-line no-console
          console.error(`automation ${a.id} (${a.name}) : plafond de ${plafond} déclenchements/heure atteint, déclenchement ignoré`);
          continue;
        }
      }

      // 🔴 IL N'Y A PLUS DE GARDE « UN PARCOURS ATTEND DÉJÀ » ICI, et c'est une décision de Julien du
      // 2026-09-07 : « on ne bloque personne sur un scénario, surtout quand on lance un nouveau scénario ».
      //
      // Ce qu'il y avait avant, et pourquoi ça ne pouvait pas rester : un `hasWaitingRun` qui SAUTAIT le
      // déclenchement. Il défendait un vrai risque (deux parcours vivants pour un seul message, le plus
      // ancien devenant orphelin), mais par le mauvais remède : il bloquait au lieu de trancher. Vécu en
      // production, un lien de chaîne cliqué pendant qu'un autre parcours attendait n'ouvrait jamais son
      // scénario, et la fenêtre de la garde étant de sept jours, le numéro restait muet une semaine.
      //
      // Le risque est désormais fermé à la SOURCE : `runFrom` clôt le parcours actif avant de persister le
      // nouveau, donc il ne peut plus y en avoir deux. La garde n'avait plus rien à défendre.
      //
      // ⚠️ CE QUI FREINE VRAIMENT UN SCÉNARIO QUI REPOSE SON PROPRE DÉCLENCHEUR, et il faut le nommer avec
      // exactitude : c'est l'ANTI-REBOND (`lastFiredAt` + `isInCooldown`), pas le marquage. `markFired` sans
      // marqueur est inconditionnel et rend toujours `true` : il ENREGISTRE le tir, il ne le refuse jamais.
      // Le marquage sert seulement à ce que l'anti-rebond ait quelque chose à lire, même si le démarrage
      // lève une exception à mi-chemin.
      //
      // 🔴 Et l'anti-rebond ne freine QUE s'il est non nul : `isInCooldown` rend `false` dès que le délai
      // vaut 0 (`src/automation/match.ts`). Une automation réglée à 0, sans plafond horaire, sur un scénario
      // qui repose son propre tag, boucle. L'ancienne garde du parcours actif freinait ce cas par accident,
      // quand le scénario laissait un `waiting` derrière lui. Ce n'est pas une raison de la garder (elle
      // bloquait des cas légitimes bien plus souvent qu'elle n'attrapait celui-là), c'en est une de ne pas
      // prétendre que la protection est complète : la question est notée dans `todo.md`.

      // On marque AVANT de démarrer, pour que l'anti-rebond ait quelque chose à lire même si le démarrage
      // lève une exception à mi-chemin (un envoi a pu partir).
      //
      // ⚠️ « Anti-boucle » était le mot employé ici, et il promettait trop : ce marquage n'a jamais REFUSÉ
      // quoi que ce soit. Sans marqueur, `markFired` est inconditionnel et rend toujours `true`. Ce qui
      // freine est l'anti-rebond juste au-dessus, et seulement s'il est non nul (cf. la note qui précède la
      // boucle).
      //
      // 🔴 ET C'EST UN CLAIM pour `avant_date` (R10). Le balayage publie tant que le marqueur n'est pas posé ;
      // si la file prend du retard, il republie la MÊME échéance, et sans ce claim les deux événements
      // partaient. Un client avec quinze rendez-vous à la même heure suffisait à le déclencher, et le
      // symptôme était deux rappels WhatsApp identiques, facturés, chez un vrai client.
      //
      // ⚠️ Le rattrapage du balayage n'est PAS cassé : quand le scénario ne démarre pas, `clearFired` efface
      // le marqueur juste en dessous, donc la tentative suivante regagne le claim. C'est le comportement
      // voulu, documenté dans `date-sweep.ts`.
      if (!(await deps.markFired(a.id, ev.waId, ev.kind === 'avant_date' ? ev.valeur : undefined))) {
        // eslint-disable-next-line no-console
        console.log(`automation ${a.id} : rappel déjà tiré pour cette échéance chez ${ev.waId}, ignoré`);
        continue;
      }
      const issue = await deps.startWorkflow(tenantId, a.workflowId, ev.waId, {
        startNodeId: a.startNodeId,
        windowOpen,
        // 🔴 SEULES LA CHAÎNE ET LA PUBLICITÉ REPRENNENT LA MAIN. Julien, le 2026-09-08 : « quand ça vient
        // d'une chaîne et que ça pointe vers un scénario, ça reprend la main ». Sans ça le clic ne lançait
        // RIEN dès que le fil était tenu, ce qui est le cas presque à chaque fois au second clic : l'agent de
        // Meta étant allumé, chaque scénario lui rend le fil en arrivant au bout, pour 24 heures. Et c'était
        // MUET des deux côtés. Le lead d'une publicité arrive dans exactement la même situation.
        reprendLaMain: reprendLaMain(a),
      });
      // `false` OU une chaîne (la raison du refus) = PAS parti. Tester la simple vérité JS comptait une
      // chaîne comme un succès : le tir restait marqué et l'anti-rebond avalait en silence la prochaine
      // vraie demande du client. Tout le reste (`true`, câblage muet) = parti, comme le moteur de campagne.
      const parti = issue !== false && typeof issue !== 'string';
      if (parti) {
        started += 1;
      } else {
        // Les gardes de l'exécuteur ont refusé AVANT tout envoi (fil tenu par un humain/MBA, bloc absent,
        // scénario supprimé) : rien n'est parti, donc rien à protéger. Garder le tir ferait taire la
        // prochaine vraie demande du client pendant toute la durée de l'anti-rebond.
        if (typeof issue === 'string') {
          // 🔴 Une automation n'a aucun écran où afficher la raison : ce log est le SEUL endroit où elle vit,
          // et c'est un vrai trou. Le 2026-09-08, un bouton de chaîne refusé ici (« la conversation est tenue
          // par un opérateur ») était parfaitement muet pour l'abonné comme pour la console, pendant que
          // l'écran des chaînes affichait « N personnes ont envoyé ce message » juste à côté : le refus était
          // indiscernable d'une panne, et on a cherché trois heures du côté du bouton. Rendre cette raison à
          // un écran est noté dans `todo.md`.
          // eslint-disable-next-line no-console
          console.log(`automation ${a.id} : scénario non démarré pour ${ev.waId} : ${issue}`);
        }
        await deps.clearFired(a.id, ev.waId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`automation ${a.id} ignorée:`, err instanceof Error ? err.message : err);
    }
  }
  return started;
}
