import { runCampaign } from './engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
  RateGate,
  CanalServi,
  EngineDeps,
} from './engine';
import { RANG_INITIAL } from './etages';
import type { CanalEtage, Etage } from './etages';
import { RateLimiter } from '../meta/http';
import { resolveRatePerMinute, SANS_PLAFOND } from './pacing';
import { BAIL_SECONDES, type CampaignRunLock } from './run-lock';
import { TokenInvalidError } from '../meta/credentials';
import type { Campaign, RunReport } from './types';
import type { CampaignSender } from './sender';

/**
 * 🔴 LES CAPACITÉS DU MOTEUR SONT IMBRIQUÉES, PLUS RECOPIÉES (constat C1 de l'audit externe du 2026-09-02).
 *
 * Ce contrat portait un `Pick<EngineDeps, ...>` de huit noms, plus trois membres déclarés à côté, et les onze
 * étaient RECOPIÉS un par un dans `optionsMoteur` plus bas. Deux listes à tenir alignées à la main, dont
 * l'oubli ne produisait AUCUNE erreur de compilation : ajouter une dépendance au moteur et oublier de la
 * recopier donnait un moteur privé de cette capacité, en silence.
 *
 * Ce n'était pas théorique, c'est arrivé en production le 2026-09-02 : `boutonsTraces` et `jetonsPourContacts`
 * étaient câblés dans le worker, absents de ce contrat, donc jamais vus par le moteur, et TOUTES les campagnes
 * portant un template à lien tracé échouaient en 131008.
 *
 * Désormais les capacités voyagent dans UN objet, `moteur`, transmis d'un seul geste (`...deps.moteur`). Il
 * n'y a plus de liste à tenir : une capacité ajoutée à `EngineDeps` traverse toute seule.
 *
 * ⚠️ MAIS LE TYPE FERMÉ NE SUFFIT PAS À ATTRAPER LA FAUTE DE FRAPPE, et ce commentaire a affirmé le
 * contraire pendant un jour. Mesuré au compilateur : une propriété en trop écrite DIRECTEMENT dans le
 * littéral `moteur: { ... }` est refusée (TS2353), mais la même introduite par un SPREAD passe en silence, et
 * un `satisfies` posé sur le littéral EXTÉRIEUR n'y change rien. Or le câblage du worker construit une partie
 * de ses capacités par spread conditionnel (`...(dryRun ? {} : { ... })`), c'est-à-dire exactement là où
 * vivaient `boutonsTraces` et `jetonsPourContacts` le jour de la panne. La garde qui marche est un
 * `satisfies Partial<CapacitesMoteur>` SUR l'objet intérieur du spread : elle est posée dans `src/worker.ts`,
 * et `tests/campagne-cablage.test.ts` la tient.
 *
 * ⚠️ Ce qui reste PLAT, et pourquoi. Les quatre stores (`recipients`, `campaigns`, `frequency`, `quality`)
 * sont REQUIS : les oublier est déjà une erreur de compilation, les imbriquer n'ajouterait rien. Et
 * `sender`, `channelSender`, `rateLimiter`, `renouvelerVerrou` ne viennent pas de l'appelant du tout : c'est
 * ce job qui les CALCULE. Les exclure du type est ce qui empêche un appelant de croire qu'il peut les poser.
 */
export type CapacitesMoteur = Omit<
  EngineDeps,
  'sender' | 'channelSender' | 'rateLimiter' | 'renouvelerVerrou' | 'canaux'
  | 'recipients' | 'campaigns' | 'frequency' | 'quality'
>;

export interface RunJobDeps {
  /**
   * Les capacités OPTIONNELLES du moteur, en bloc. Absent = aucune capacité, ce qui est exactement le
   * comportement des câblages de test qui n'en fournissent pas.
   */
  moteur?: CapacitesMoteur;
  getCampaign(id: string): Promise<Campaign | null>;
  /**
   * Construit le sender pour la campagne (MetaClient sur le token du tenant en prod, fake en test). Async : la
   * résolution du token par tenant (B1) lit la base + déchiffre.
   *
   * ⚠️ `phoneNumberId` EST PASSÉ EXPLICITEMENT, ET CE N'EST PAS `campaign.phoneNumberId` EN TOUTE
   * CIRCONSTANCE : une campagne RCS a la colonne VIDE (migration 0056) et son repli WhatsApp doit pourtant
   * partir d'un numéro. Un sender construit sur la campagne seule ne saurait pas d'où envoyer.
   */
  senderFor(campaign: Campaign, phoneNumberId: string): Promise<MessageSender>;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  frequency: FrequencyStore;
  quality: QualityProvider;
  rateLimiter?: RateGate;
  /** Fabrique du limiteur PAR CAMPAGNE (intervalle minimal en ms). Défaut : un vrai RateLimiter.
   *  Injectable pour tester le câblage sans dépendre d'un vrai sleep temporel. */
  makeRateLimiter?: (minIntervalMs: number) => RateGate;
  /**
   * Débit par défaut (msg/min) appliqué aux campagnes SANS ratePerMinute explicite. Injecté par le worker
   * depuis config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE. ABSENT des deps de test à dessein : sans lui, une campagne
   * à rate null reste en opt-out (aucun frein), donc les tests de câblage existants ne changent pas.
   */
  defaultRatePerMinute?: number;
  /**
   * Le plafond de débit DU CANAL de cette campagne (`plafondDuCanal`), en messages par minute.
   *
   * 🔴 C'est le seul endroit du dépôt qui connaît à la fois la campagne et son canal au moment d'appliquer
   * un frein. ⚠️ Absent (tests) -> aucun plafond, donc exactement le comportement d'avant ce lot.
   */
  plafondDeDebit?: (canal: 'whatsapp' | 'rcs' | undefined) => number;
  /**
   * Revalide que le numéro d'envoi de la campagne appartient toujours à son tenant, juste avant d'envoyer. Défense
   * contre une réaffectation de numéro survenue entre la création de la campagne et son exécution. OPTIONNEL :
   * absent des deps, la garde est sautée (les tests et l'e2e qui n'insèrent pas de ligne phone_numbers ne cassent
   * pas). Le worker l'injecte en prod.
   */
  phoneNumberBelongsToTenant?: (phoneNumberId: string, tenantId: string) => Promise<boolean>;
  /**
   * Sender du canal RCS pour CETTE campagne. `null` = aucun agent RCS exploitable (agent absent du tenant,
   * message manquant) -> campagne mise en PAUSE avec la raison, jamais un envoi à vide. ABSENT des deps =
   * canal RCS non câblé sur ce serveur : une campagne RCS est mise en pause au lieu de repartir en silence
   * sur le chemin WhatsApp, qui l'enverrait depuis un `phone_number_id` vide.
   */
  rcsSenderFor?: (campaign: Campaign, message: unknown) => Promise<CampaignSender | null>;
  /**
   * LE NUMÉRO META DE CET ESPACE, pour un étage WhatsApp de REPLI sur une campagne qui n'en a pas.
   *
   * ⚠️ MÊME CONTRAT QUE LES AUTRES `numeroDuTenant` DU DÉPÔT (`src/http/mba.ts`, `mba-publication.ts`,
   * `agent-catalogue.ts`), tous câblés sur `repo.getTenantPhoneNumberId`. Un nom de plus pour la même
   * dépendance obligerait à chercher laquelle on lit.
   *
   * ⚠️ CE TEXTE DISAIT « LES TROIS AUTRES », ET LE COMPTE ÉTAIT FAUX (mesuré le 2026-09-14). La même question
   * est posée sous QUATRE noms dans le dépôt (`numeroDuTenant`, `getTenantPhoneNumberId`, `phoneNumberFor`,
   * `getPhoneNumberId`). Le compte n'est plus écrit ici : il dérivait, et c'est précisément ce qu'un compte
   * écrit à la main finit par faire.
   *
   * 🔴 ET LA MISE EN CACHE NE VIT PAS ICI. Le chemin chaud (le runtime de scénario) lisait ce numéro par
   * DESTINATAIRE ; il passe depuis le 2026-09-15 par `src/meta/numero-espace.ts`, qui ne met en cache que les
   * réponses positives. Ce repli-ci est hors boucle, une fois par étage, donc il n'a rien à économiser.
   *
   * 🔴 UNE CAMPAGNE RCS A `phone_number_id` VIDE (migration 0056), et c'est correct : elle part d'un agent
   * de marque. Son repli WhatsApp, lui, a besoin d'un numéro, et le seul honnête est celui que l'écran de
   * création aurait choisi : le PREMIER numéro de l'espace (`listPhoneNumbers` et `getTenantPhoneNumberId`
   * ordonnent tous deux par `created_at`, vérifié, et l'assistant prend `numeros[0]`).
   *
   * ⚠️ ABSENTE ou sans réponse -> le canal WhatsApp n'est pas servable pour cette campagne, et son étage
   * échoue avec sa raison. Jamais un envoi depuis un `phone_number_id` vide, qui partirait chez Meta sur
   * l'adresse `//messages`.
   */
  numeroDuTenant?: (tenantId: string) => Promise<string | null>;
  /**
   * SÉRIALISATION des runs d'une même campagne (R1-bis, cf. `run-lock.ts`). Les trois pièces vont ensemble,
   * d'où un seul objet : on ne peut pas câbler le verrou sans savoir dimensionner son bail, ni sans savoir
   * relancer le travail qu'il a écarté.
   *
   * ABSENT = comportement d'avant, aucune sérialisation : les tests et l'e2e n'ont rien à câbler et gardent
   * leur comportement mot pour mot. La production l'injecte, sinon deux runs concurrents doublent le débit
   * réel de la campagne, ce que le slider de cadence est censé empêcher.
   */
  serialisation?: {
    verrou: CampaignRunLock;
    /** Destinataires en attente, pour dimensionner le bail sur la MÊME estimation que l'expiration du job. */
    enAttente(campaignId: string): Promise<number>;
    /** Relance un run : le verrou a coalescé du travail refusé pendant qu'on le tenait. */
    relancer(campaignId: string): Promise<void>;
  };
  /** L'arrêt du service a-t-il été demandé (SIGTERM) ? Absent = le run va jusqu'au bout, comme avant. */
  arretDemande?: () => boolean;
  /** Durée maximale d'un run avant qu'il rende la main et se réenfile (lot 5). Absente -> aucun découpage. */
  dureeMaxMs?: number;
  /** Horloge du moteur. Injectée par les tests pour éprouver la coupure de lot sans attendre. */
  now?: () => number;
}


/**
 * Handler du job `campaign-run` : charge la campagne, assemble ses dépendances et
 * exécute runCampaign. Payload de job non fiable -> valide `campaignId`.
 */
export async function campaignRunJob(data: unknown, deps: RunJobDeps): Promise<RunReport> {
  const campaignId = (data as { campaignId?: unknown } | null)?.campaignId;
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new Error('campaign-run : campaignId manquant dans le payload');
  }
  const campaign = await deps.getCampaign(campaignId);
  if (!campaign) throw new Error(`campaign-run : campagne inconnue ${campaignId}`);

  // Campagne AU FIL DE L'EAU déjà ARRÊTÉE. Un job a pu être enfilé juste avant l'arrêt, ou un arrivant être
  // inscrit dans la même seconde. L'exécuter aurait DEUX effets, tous deux faux : envoyer un message que
  // l'opérateur croit avoir coupé, et surtout la RESSUSCITER, puisque le moteur remet toute campagne au fil
  // de l'eau en `running` en sortie de run. Elle repartirait alors pour de bon, sans que personne l'ait voulu.
  if (campaign.webhookId && campaign.status === 'completed') {
    return { sent: 0, skipped: 0, failed: 0, paused: false, reason: "campagne au fil de l'eau arrêtée" };
  }

  // Campagne MISE EN PAUSE. Un job a pu être enfilé avant la pause et ne démarrer qu'après (la file ne
  // déduplique rien, cf. `Queue.enqueue` : plusieurs peuvent même attendre). L'exécuter la RESSUSCITERAIT,
  // puisque le moteur remet toute campagne en `running` à son démarrage : l'envoi repartirait alors que
  // l'opérateur vient de le couper, ce qui est exactement ce que la pause doit empêcher. La reprise est donc
  // EXPLICITE : `POST /run` repasse la campagne en `running` AVANT d'enfiler son job.
  //
  // Conséquence voulue, sur un chemin qui n'est pas celui de l'opérateur : le balayage d'auto-relance (F6)
  // n'insiste plus sur une campagne en pause. Il la relançait, le quality gate la remettait aussitôt en pause,
  // et la relance était perdue. Elle attend maintenant une reprise décidée.
  if (campaign.status === 'paused') {
    return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'campagne en pause' };
  }

  /**
   * ⚠️ LA GARDE D'APPARTENANCE DU NUMÉRO ET LA RÉSOLUTION DES SENDERS VIVENT DANS LA BOUCLE CI-DESSOUS,
   * canal par canal. Elles étaient ici, posées sur `campaign.channel`, et c'est exactement ce qui rendait
   * un run mono-canal : une campagne RCS y sautait la garde et n'obtenait jamais de sender Meta, donc son
   * repli WhatsApp ne pouvait pas partir.
   */

  /**
   * LES CANAUX QUE CE RUN DOIT SAVOIR SERVIR.
   *
   * 🔴 CE SONT CEUX DE LA CHAÎNE, PAS CELUI DE LA CAMPAGNE. C'est toute la différence entre une chaîne de
   * repli fonctionnelle et une chaîne décorative : un run construit sur `campaign.channel` ne pouvait que
   * REFUSER un destinataire que la bascule avait posé au rang 2.
   *
   * ⚠️ Chaîne absente ou vide (parc d'avant 0134, faux de test) -> le canal de la campagne, et lui seul,
   * donc exactement le comportement d'avant ce lot.
   */
  const chaine: Etage[] = campaign.chaine ?? [];
  const canalCampagne: CanalEtage = campaign.channel ?? 'whatsapp';
  const canauxVoulus: CanalEtage[] = chaine.length > 0
    ? [...new Set(chaine.map((e) => e.canal))]
    : [canalCampagne];

  /**
   * LE FREIN DE CADENCE D'UN CANAL.
   *
   * Le rate posé sur la campagne prime ; à défaut, le défaut serveur (absent en test -> opt-out préservé).
   * Un rate résolu > 0 instancie un RateLimiter dédié à CE run (intervalle minimal = 60000/rate ms),
   * prioritaire sur un éventuel limiteur statique. Le throttle attend AVANT de claimer le destinataire
   * suivant : aucun destinataire ne reste 'sending' plus longtemps qu'une latence d'envoi.
   *
   * 🔴 LE PLAFOND EST CELUI DU CANAL, PAS CELUI DE META POUR TOUT LE MONDE, et c'est ici, et seulement
   * ici, qu'on sait de quel canal on parle. Les enfileurs, eux, ne font qu'estimer une durée et prennent
   * une borne sûre (`plafondLePlusBas`).
   *
   * ⚠️ `deps.plafondDeDebit` absent (tests) -> aucun plafond, donc exactement le comportement d'avant.
   *
   * ⚠️ CHAQUE CANAL A SON PROPRE FREIN, DONC UN RUN MIXTE PEUT DÉPASSER LE DÉBIT DE LA CAMPAGNE, et c'est
   * assumé : les deux canaux ne partagent ni fournisseur ni quota, et c'est toute la raison d'être de
   * `plafondDuCanal`. Un frein commun ferait attendre un repli RCS derrière des envois WhatsApp. Le cas
   * est rare de toute façon : un run sert presque toujours un seul étage, la bascule étant ce qui déplace
   * un destinataire d'un rang à l'autre, entre deux runs.
   */
  /** Le sender Meta, posé quand le canal WhatsApp s'est révélé servable. Lu tout en bas, une seule fois. */
  let senderMeta: MessageSender | undefined;
  const makeLimiter = deps.makeRateLimiter ?? ((ms: number) => new RateLimiter(ms));
  const freinDuCanal = (canal: CanalEtage): RateGate | undefined => {
    const plafond = canal === 'email' ? SANS_PLAFOND : deps.plafondDeDebit?.(canal) ?? SANS_PLAFOND;
    const rate = resolveRatePerMinute(campaign.ratePerMinute, deps.defaultRatePerMinute ?? 0, plafond);
    return rate > 0 ? makeLimiter(Math.ceil(60_000 / rate)) : deps.rateLimiter;
  };

  /**
   * CE QUI EMPÊCHE DE SERVIR LE CANAL DE LA CAMPAGNE MET LA CAMPAGNE EN PAUSE ; ce qui empêche de servir
   * un canal de REPLI ne fait que le retirer de la table.
   *
   * 🔴 LA DISTINCTION EST LA SEULE CHOSE QUI COMPTE ICI. Mettre en pause une campagne WhatsApp qui part
   * parfaitement parce que son repli RCS n'a pas d'agent couperait l'envoi que l'opérateur a lancé ; à
   * l'inverse, laisser une campagne RCS partir sans son sender l'enverrait depuis un numéro Meta vide.
   */
  const canaux: Partial<Record<CanalEtage, CanalServi>> = {};
  let pauseDuCanalPrincipal: string | null = null;
  const refuser = (canal: CanalEtage, raison: string): void => {
    if (canal === canalCampagne) pauseDuCanalPrincipal ??= raison;
  };

  for (const canal of canauxVoulus) {
    if (canal === 'rcs') {
      // L'agent et le message sont figés sur la campagne (rang 1) ou sur l'étage (rangs suivants) : c'est
      // le CONTENU de l'étage RCS qui part, jamais celui de la campagne, sans quoi un repli renverrait le
      // message du premier canal.
      const etage = chaine.find((e) => e.canal === 'rcs');
      const message = etage && etage.rang !== RANG_INITIAL ? etage.rcsMessage : campaign.rcsMessage;
      if (!deps.rcsSenderFor) { refuser(canal, 'canal RCS non câblé sur ce serveur'); continue; }
      const cs = await deps.rcsSenderFor(campaign, message);
      if (!cs) { refuser(canal, 'aucun agent RCS exploitable pour cette campagne'); continue; }
      // ⚠️ UN SEUL APPEL : `freinDuCanal` CONSTRUIT un limiteur, il n'en rend pas un déjà là. L'appeler
      // deux fois (une pour tester, une pour poser) en fabriquerait deux, dont un jamais utilisé, et
      // doublerait le compte que les tests de câblage vérifient.
      const frein = freinDuCanal(canal);
      canaux.rcs = { sender: cs, ...(frein ? { rateLimiter: frein } : {}) };
      continue;
    }
    if (canal === 'whatsapp') {
      // Le numéro de la campagne, ou celui de l'espace quand la campagne n'en porte pas (campagne RCS à
      // repli WhatsApp). Vide des deux côtés = canal non servable, jamais un envoi depuis un numéro vide.
      const numero = campaign.phoneNumberId !== ''
        ? campaign.phoneNumberId
        : (await deps.numeroDuTenant?.(campaign.tenantId)) ?? '';
      if (numero === '') { refuser(canal, 'aucun numéro WhatsApp sur cet espace'); continue; }
      // Garde d'appartenance : elle ne vaut QUE pour un numéro porté par la campagne. Celui de l'espace
      // vient d'être lu SUR le tenant, l'interroger reviendrait à lui demander ce qu'on vient de lui dire.
      if (numero === campaign.phoneNumberId && deps.phoneNumberBelongsToTenant
        && !(await deps.phoneNumberBelongsToTenant(numero, campaign.tenantId))) {
        refuser(canal, 'numéro non rattaché à ce workspace (réaffecté ?)');
        continue;
      }
      try {
        const meta = await deps.senderFor(campaign, numero);
        // ⚠️ UN SEUL APPEL, même raison qu'au-dessus : `freinDuCanal` construit, il ne consulte pas.
        const frein = freinDuCanal(canal);
        canaux.whatsapp = {
          phoneNumberId: numero,
          ...(frein ? { rateLimiter: frein } : {}),
        };
        senderMeta = meta;
      } catch (err) {
        // Un token révoqué/expiré met la campagne en PAUSE proprement au lieu de laisser le throw remonter,
        // ce qui ferait rejouer le job en boucle par pg-boss. Sur un canal de repli, il le retire seulement.
        if (err instanceof TokenInvalidError) { refuser(canal, 'token WhatsApp révoqué/expiré, reconnectez le numéro'); continue; }
        throw err;
      }
      continue;
    }
    // 🔴 L'E-MAIL N'A AUCUN SENDER DE CAMPAGNE, et ce n'est pas un oubli de câblage : il n'en existe pas.
    // Son étage échoue donc avec sa raison, au vrai rang et au vrai canal, et la bascule passera au
    // suivant. L'inventer ici enverrait des messages par un chemin que personne n'a écrit.
    refuser(canal, "le canal e-mail n'est pas servable par une campagne");
  }

  if (pauseDuCanalPrincipal !== null) {
    return { sent: 0, skipped: 0, failed: 0, paused: true, reason: pauseDuCanalPrincipal };
  }

  /**
   * `EngineDeps.sender` est REQUIS par le type, mais le moteur ne l'utilise que pour un étage WhatsApp.
   * Ce garde rend l'invariant explicite : s'il est un jour appelé sans canal WhatsApp servable, c'est un
   * bug de branchement, et on veut le voir immédiatement plutôt qu'un envoi Meta parti d'une campagne RCS.
   */
  const sender: MessageSender = senderMeta ?? {
    sendMarketing: async (): Promise<never> => { throw new Error('campagne sans étage WhatsApp : le sender Meta ne doit jamais être appelé'); },
    sendTemplate: async (): Promise<never> => { throw new Error('campagne sans étage WhatsApp : le sender Meta ne doit jamais être appelé'); },
  };

  const optionsMoteur: EngineDeps = {
    // 🔴 UN SEUL SPREAD, et c'est tout l'intérêt : il n'y a plus de liste de noms à tenir alignée avec le
    // contrat. Une capacité ajoutée à `EngineDeps` arrive ici sans qu'on y pense, et une capacité oubliée
    // par l'appelant reste `undefined`, ce qui est le défaut documenté de chacune. C'est ce qui a manqué le
    // 2026-09-02, quand deux capacités câblées dans le worker n'ont jamais atteint le moteur.
    ...deps.moteur,
    // Ce qui suit vient de CE job, pas de l'appelant : il les calcule juste au-dessus. Écrits APRÈS le
    // spread, donc ils gagnent, ce qui est la bonne priorité (un appelant ne peut pas les usurper, le type
    // les lui interdit déjà).
    sender,
    canaux,
    recipients: deps.recipients,
    campaigns: deps.campaigns,
    frequency: deps.frequency,
    quality: deps.quality,
  };

  const serialisation = deps.serialisation;
  if (!serialisation) return runCampaign(campaign, optionsMoteur);

  // BAIL COURT, renouvelé pendant le run (cf. `BAIL_SECONDES`). Un process tué libère donc la campagne en deux
  // minutes, et le balayage de reprise peut la relancer. Un bail long l'aurait gelée pendant des heures, ce
  // qui est précisément le défaut R4 qu'on ferme ici.
  const jeton = await serialisation.verrou.acquire(campaignId, campaign.tenantId, BAIL_SECONDES);
  if (jeton === null) {
    // Un run vivant tient le verrou. On ne lève PAS : le travail sera fait, par lui ou par la relance qu'il
    // déclenchera en sortant. Lever ferait rejouer ce job par pg-boss, qui se heurterait au même verrou, cinq
    // fois, puis finirait en file d'échec pour un cas parfaitement normal.
    return { sent: 0, skipped: 0, failed: 0, paused: false, reason: 'un run de cette campagne est déjà en cours' };
  }

  /**
   * Rend le verrou, et relance si du travail a été écarté pendant qu'on le tenait. Ne laisse JAMAIS remonter
   * son propre échec : le verrou se libère de lui-même à l'expiration du bail, alors qu'un job en échec serait
   * rejoué et ré-enverrait ce qui vient de partir.
   */
  const rendreLeVerrou = async (relancerSiDemande: boolean): Promise<void> => {
    try {
      const { rerunDemande } = await serialisation.verrou.release(campaignId, campaign.tenantId, jeton);
      if (rerunDemande && relancerSiDemande) await serialisation.relancer(campaignId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`campaign-run : libération du verrou impossible pour ${campaignId}`, err instanceof Error ? err.message : err);
    }
  };

  try {
    const rapport = await runCampaign(campaign, {
      ...optionsMoteur,
      renouvelerVerrou: () => serialisation.verrou.renouveler(campaignId, campaign.tenantId, jeton),
    });
    await rendreLeVerrou(true);
    // Le lot s'est arrêté sur sa durée : il reste du travail, on repart. APRÈS avoir rendu le verrou, sinon
    // le job suivant se heurterait à lui et se contenterait de demander une relance, ce qui rallongerait le
    // trajet pour rien. `relancer` ne réenfile que s'il reste vraiment des destinataires en attente : deux
    // relances concurrentes ne font donc pas clignoter le statut de la campagne.
    if (rapport.reste) await serialisation.relancer(campaignId);
    return rapport;
  } catch (err) {
    // Le verrou est rendu même sur échec, sinon la campagne resterait bloquée jusqu'au bout de son bail. Sans
    // relance : pg-boss rejoue déjà le job qui a levé, en ajouter une ferait deux runs pour un seul incident.
    await rendreLeVerrou(false);
    throw err;
  }
}
