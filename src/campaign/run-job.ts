import { runCampaign, raisonPauseNonEcrite } from './engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
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
import { NumeroBloqueError, type MotifBlocage } from '../meta/numero-delie';
import { messageDePause } from './pause';
import type { Campaign, RunReport } from './types';
import type { CampaignSender } from './sender';
import { messageDe } from '../lib/erreur';

/**
 * Les capacités optionnelles du moteur voyagent dans un seul objet, `moteur`, transmis d'un spread : une
 * capacité ajoutée à `EngineDeps` traverse toute seule, sans liste de noms à tenir alignée (une capacité
 * oubliée dans une telle liste privait le moteur en silence).
 *
 * Le type fermé n'attrape pas une faute de frappe introduite par un spread (seul un littéral direct est
 * vérifié) : la garde est un `satisfies Partial<CapacitesMoteur>` sur l'objet intérieur du spread, dans
 * `src/worker.ts`.
 *
 * Restent à plat : les stores, requis, et `sender`, `canaux`, `renouvelerVerrou`, que ce job calcule lui-même.
 * Les exclure du type empêche un appelant de croire qu'il peut les poser.
 */
export type CapacitesMoteur = Omit<
  EngineDeps,
  'sender' | 'renouvelerVerrou' | 'canaux'
  | 'recipients' | 'campaigns' | 'quality' | 'numerosDelies'
>;

export interface RunJobDeps {
  /** Les capacités optionnelles du moteur, en bloc. Absent = aucune capacité (câblages de test). */
  moteur?: CapacitesMoteur;
  /** Le dépôt des campagnes. */
  repo: {
    getCampaign(id: string): Promise<Campaign | null>;
    /**
     * 🔴 Revalide que le numéro d'envoi appartient toujours au tenant, juste avant d'envoyer (défense contre une
     * réaffectation entre la création et l'exécution). Optionnel pour les tests ; le worker l'injecte en prod.
     */
    phoneNumberBelongsToTenant?(phoneNumberId: string, tenantId: string): Promise<boolean>;
    /**
     * Le numéro Meta de cet espace, pour un étage WhatsApp de repli sur une campagne qui n'en a pas (une campagne
     * RCS a `phone_number_id` vide). Le seul honnête est le premier numéro de l'espace, celui que l'écran de
     * création aurait choisi (ordre `created_at`). Hors boucle, une fois par étage : pas de cache ici.
     *
     * Absente ou sans réponse : le canal WhatsApp n'est pas servable et son étage échoue avec sa raison. Jamais un
     * envoi depuis un numéro vide, qui partirait chez Meta sur l'adresse `//messages`.
     */
    getTenantPhoneNumberId?(tenantId: string): Promise<string | null>;
  };
  /**
   * Construit le sender Meta (token du tenant en prod, faux en test ; async car le token se lit et se
   * déchiffre). `phoneNumberId` est passé explicitement : une campagne RCS a la colonne vide, et son repli
   * WhatsApp doit pourtant partir d'un numéro.
   */
  senderFor(campaign: Campaign, phoneNumberId: string): Promise<MessageSender>;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  quality: QualityProvider;
  rateLimiter?: RateGate;
  /** Fabrique du limiteur par campagne (intervalle minimal en ms), injectable pour tester sans vrai sleep. */
  makeRateLimiter?: (minIntervalMs: number) => RateGate;
  /**
   * Débit par défaut (msg/min) des campagnes sans ratePerMinute (`CAMPAIGN_DEFAULT_RATE_PER_MINUTE`). Absent
   * des tests à dessein : une campagne à rate null reste alors sans frein.
   */
  defaultRatePerMinute?: number;
  /**
   * Le plafond de débit du canal de cette campagne (`plafondDuCanal`) : seul endroit qui connaît à la fois la
   * campagne et son canal au moment d'appliquer un frein. Absent (tests) -> aucun plafond.
   */
  plafondDeDebit?: (canal: 'whatsapp' | 'rcs' | undefined) => number;
  /**
   * Sender du canal RCS pour cette campagne. `null` = aucun agent RCS exploitable, campagne mise en pause avec
   * la raison. Absent = canal non câblé : une campagne RCS est mise en pause plutôt que de partir sur le chemin
   * WhatsApp avec un `phone_number_id` vide.
   */
  rcs?: { senderForCampaign(campaign: Campaign, message: unknown): Promise<CampaignSender | null> };
  /**
   * Écrit la pause `numero_delie`, en une instruction, seulement si le numéro est encore délié en base (sans le
   * cache de la garde d'envoi) et que la campagne tourne encore. `true` = écrite.
   *
   * Requise : une telle pause écrite à tort ne se lève jamais seule (le balayage de reprise l'ignore, « Relier »
   * a déjà eu lieu), or le refus vient d'une garde mise en cache 5 s qui peut dire « délié » juste après
   * « Relier ». Écriture conditionnelle et non lecture puis écriture ; elle n'écrase pas une pause d'opérateur.
   * Transmise au moteur pour le même arrêt en cours de run, jamais par `CapacitesMoteur`.
   */
  numerosDelies: { pauserCampagne(campaignId: string, tenantId: string, phoneNumberId: string, motif: MotifBlocage): Promise<boolean> };
  /**
   * Sérialisation des runs d'une même campagne (cf. `run-lock.ts`). Un seul objet : on ne câble pas le verrou
   * sans dimensionner son bail ni relancer le travail qu'il a écarté. Absent (tests) = aucune sérialisation ; en
   * production, deux runs concurrents doubleraient le débit réel.
   */
  serialisation?: {
    verrou: CampaignRunLock;
    /** Destinataires en attente, pour dimensionner le bail sur la même estimation que l'expiration du job. */
    enAttente(campaignId: string): Promise<number>;
    /** Relance un run : le verrou a coalescé du travail refusé pendant qu'on le tenait. */
    relancer(campaignId: string): Promise<void>;
  };
  /** L'arrêt du service a-t-il été demandé (SIGTERM) ? Absent = le run va jusqu'au bout. */
  arretDemande?: () => boolean;
  /** Durée maximale d'un run avant qu'il rende la main et se réenfile. Absente -> aucun découpage. */
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
  const campaign = await deps.repo.getCampaign(campaignId);
  if (!campaign) throw new Error(`campaign-run : campagne inconnue ${campaignId}`);

  // Campagne au fil de l'eau déjà arrêtée : un job a pu être enfilé juste avant l'arrêt. L'exécuter enverrait un
  // message coupé et la ressusciterait, puisque le moteur remet une telle campagne en `running` en fin de run.
  if (campaign.webhookId && campaign.status === 'completed') {
    return { sent: 0, skipped: 0, failed: 0, paused: false, reason: "campagne au fil de l'eau arrêtée" };
  }

  // Campagne en pause : un job enfilé avant la pause (la file ne déduplique rien) la ressusciterait, puisque le
  // moteur remet la campagne en `running` à son démarrage. La reprise est explicite : `POST /run` repasse la
  // campagne en `running` avant d'enfiler. L'auto-relance n'insiste donc plus sur une campagne en pause.
  if (campaign.status === 'paused') {
    return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'campagne en pause' };
  }

  // La garde d'appartenance du numéro et la résolution des senders vivent dans la boucle ci-dessous, canal par
  // canal : posées sur `campaign.channel`, elles empêcheraient le repli WhatsApp d'une campagne RCS.

  /**
   * Les canaux que ce run doit savoir servir : ceux de la chaîne, pas celui de la campagne, sinon un
   * destinataire posé au rang 2 par la bascule serait refusé. Chaîne absente ou vide -> le canal de la campagne.
   */
  const chaine: Etage[] = campaign.chaine ?? [];
  const canalCampagne: CanalEtage = campaign.channel ?? 'whatsapp';
  const canauxVoulus: CanalEtage[] = chaine.length > 0
    ? [...new Set(chaine.map((e) => e.canal))]
    : [canalCampagne];

  /**
   * Le frein de cadence d'un canal : le rate de la campagne prime, à défaut le défaut serveur. Un rate résolu > 0
   * instancie un RateLimiter dédié à ce run, prioritaire sur un limiteur statique. Le throttle attend avant de
   * claimer le destinataire suivant : aucun destinataire ne reste `sending` plus d'une latence d'envoi.
   *
   * Le plafond est celui du canal, connu seulement ici (les enfileurs n'estiment qu'une durée). Chaque canal a
   * son frein : un run mixte peut dépasser le débit de la campagne, c'est assumé (ni fournisseur ni quota
   * partagés).
   */
  /** Le sender Meta, posé quand le canal WhatsApp s'est révélé servable. */
  let senderMeta: MessageSender | undefined;
  const makeLimiter = deps.makeRateLimiter ?? ((ms: number) => new RateLimiter(ms));
  const freinDuCanal = (canal: CanalEtage): RateGate | undefined => {
    const plafond = canal === 'email' ? SANS_PLAFOND : deps.plafondDeDebit?.(canal) ?? SANS_PLAFOND;
    const rate = resolveRatePerMinute(campaign.ratePerMinute, deps.defaultRatePerMinute ?? 0, plafond);
    return rate > 0 ? makeLimiter(Math.ceil(60_000 / rate)) : deps.rateLimiter;
  };

  /**
   * Ce qui empêche de servir le canal de la campagne la met en pause ; ce qui empêche de servir un canal de
   * repli ne fait que le retirer. Mettre en pause pour un repli sans agent couperait l'envoi lancé ; laisser
   * partir une campagne RCS sans son sender l'enverrait depuis un numéro Meta vide.
   */
  const canaux: Partial<Record<CanalEtage, CanalServi>> = {};
  let pauseDuCanalPrincipal: string | null = null;
  const refuser = (canal: CanalEtage, raison: string): void => {
    if (canal === canalCampagne) pauseDuCanalPrincipal ??= raison;
  };

  for (const canal of canauxVoulus) {
    if (canal === 'rcs') {
      // Le contenu de l'étage RCS part (message de la campagne au rang 1, de l'étage ensuite), sinon un repli
      // renverrait le message du premier canal.
      const etage = chaine.find((e) => e.canal === 'rcs');
      const message = etage && etage.rang !== RANG_INITIAL ? etage.rcsMessage : campaign.rcsMessage;
      if (!deps.rcs) { refuser(canal, 'canal RCS non câblé sur ce serveur'); continue; }
      const cs = await deps.rcs.senderForCampaign(campaign, message);
      if (!cs) { refuser(canal, 'aucun agent RCS exploitable pour cette campagne'); continue; }
      // Un seul appel : `freinDuCanal` construit un limiteur, l'appeler deux fois en fabriquerait deux.
      const frein = freinDuCanal(canal);
      canaux.rcs = { sender: cs, ...(frein ? { rateLimiter: frein } : {}) };
      continue;
    }
    if (canal === 'whatsapp') {
      // Le numéro de la campagne, sinon celui de l'espace (campagne RCS à repli WhatsApp). Vide des deux côtés =
      // canal non servable, jamais un envoi depuis un numéro vide.
      const numero = campaign.phoneNumberId !== ''
        ? campaign.phoneNumberId
        : (await deps.repo.getTenantPhoneNumberId?.(campaign.tenantId)) ?? '';
      if (numero === '') { refuser(canal, 'aucun numéro WhatsApp sur cet espace'); continue; }
      // Garde d'appartenance pour un numéro porté par la campagne seulement : celui de l'espace vient d'être lu
      // sur le tenant.
      if (numero === campaign.phoneNumberId && deps.repo.phoneNumberBelongsToTenant
        && !(await deps.repo.phoneNumberBelongsToTenant(numero, campaign.tenantId))) {
        refuser(canal, 'numéro non rattaché à ce workspace (réaffecté ?)');
        continue;
      }
      try {
        const meta = await deps.senderFor(campaign, numero);
        // Un seul appel, même raison qu'au-dessus.
        const frein = freinDuCanal(canal);
        canaux.whatsapp = {
          phoneNumberId: numero,
          ...(frein ? { rateLimiter: frein } : {}),
        };
        senderMeta = meta;
      } catch (err) {
        // Un token révoqué ou expiré met la campagne en pause au lieu de lever, ce que pg-boss rejouerait en
        // boucle. Sur un canal de repli, il le retire seulement.
        if (err instanceof TokenInvalidError) { refuser(canal, 'token WhatsApp révoqué/expiré, reconnectez le numéro'); continue; }
        /**
         * Numéro délié : la campagne entière passe en pause `numero_delie`, écrite en base, même si WhatsApp
         * n'est qu'un repli. Retirer l'étage ferait échouer des destinataires pour un état qu'un clic défait, et
         * sans statut écrit « Relier » ne saurait pas qu'elle attend.
         *
         * Écrite seulement si la base dit encore « délié », dans la même instruction : la garde en cache peut le
         * dire juste après « Relier ». Sinon rien n'est écrit, la campagne reste `running` sans run et le
         * balayage des campagnes gelées la relance dans la minute.
         */
        if (err instanceof NumeroBloqueError) {
          if (!(await deps.numerosDelies.pauserCampagne(campaign.id, campaign.tenantId, err.phoneNumberId, err.motif))) {
            return { sent: 0, skipped: 0, failed: 0, paused: false, reason: raisonPauseNonEcrite(err.motif) };
          }
          return { sent: 0, skipped: 0, failed: 0, paused: true, reason: messageDePause(err.motif, null, undefined) };
        }
        throw err;
      }
      continue;
    }
    // L'e-mail n'a aucun sender de campagne : son étage échoue avec sa raison, et la bascule passe au suivant.
    refuser(canal, "le canal e-mail n'est pas servable par une campagne");
  }

  if (pauseDuCanalPrincipal !== null) {
    return { sent: 0, skipped: 0, failed: 0, paused: true, reason: pauseDuCanalPrincipal };
  }

  /**
   * `EngineDeps.sender` est requis mais ne sert qu'un étage WhatsApp. Sans canal WhatsApp servable, ce sender
   * lève : un appel serait un bug de branchement, pas un envoi Meta parti d'une campagne RCS.
   */
  const sender: MessageSender = senderMeta ?? {
    sendMarketing: async (): Promise<never> => { throw new Error('campagne sans étage WhatsApp : le sender Meta ne doit jamais être appelé'); },
    sendTemplate: async (): Promise<never> => { throw new Error('campagne sans étage WhatsApp : le sender Meta ne doit jamais être appelé'); },
  };

  const optionsMoteur: EngineDeps = {
    // Un seul spread : une capacité ajoutée à `EngineDeps` arrive ici sans liste de noms à tenir, une capacité
    // absente reste `undefined`, son défaut documenté.
    ...deps.moteur,
    // Calculés par ce job, écrits après le spread pour gagner : un appelant ne peut pas les usurper.
    sender,
    canaux,
    recipients: deps.recipients,
    campaigns: deps.campaigns,
    quality: deps.quality,
    numerosDelies: deps.numerosDelies,
  };

  const serialisation = deps.serialisation;
  if (!serialisation) return runCampaign(campaign, optionsMoteur);

  // Bail court, renouvelé pendant le run (`BAIL_SECONDES`) : un process tué libère la campagne en deux minutes.
  const jeton = await serialisation.verrou.acquire(campaignId, campaign.tenantId, BAIL_SECONDES);
  if (jeton === null) {
    // Un run vivant tient le verrou : on ne lève pas, le travail sera fait par lui ou par sa relance. Lever ferait
    // rejouer ce job par pg-boss contre le même verrou, puis finir en file d'échec.
    return { sent: 0, skipped: 0, failed: 0, paused: false, reason: 'un run de cette campagne est déjà en cours' };
  }

  /**
   * Rend le verrou et relance si du travail a été écarté pendant qu'on le tenait. Ne laisse jamais remonter son
   * propre échec : le verrou se libère à l'expiration du bail, alors qu'un job en échec serait rejoué et
   * renverrait ce qui vient de partir.
   */
  const rendreLeVerrou = async (relancerSiDemande: boolean): Promise<void> => {
    try {
      const { rerunDemande } = await serialisation.verrou.release(campaignId, campaign.tenantId, jeton);
      if (rerunDemande && relancerSiDemande) await serialisation.relancer(campaignId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`campaign-run : libération du verrou impossible pour ${campaignId}`, messageDe(err));
    }
  };

  try {
    const rapport = await runCampaign(campaign, {
      ...optionsMoteur,
      renouvelerVerrou: () => serialisation.verrou.renouveler(campaignId, campaign.tenantId, jeton),
    });
    await rendreLeVerrou(true);
    // Il reste du travail : on repart, après avoir rendu le verrou (sinon le job suivant s'y heurterait).
    // `relancer` ne réenfile que s'il reste vraiment des destinataires en attente.
    if (rapport.reste) await serialisation.relancer(campaignId);
    return rapport;
  } catch (err) {
    // Verrou rendu même sur échec, sans relance : pg-boss rejoue déjà le job qui a levé.
    await rendreLeVerrou(false);
    throw err;
  }
}
