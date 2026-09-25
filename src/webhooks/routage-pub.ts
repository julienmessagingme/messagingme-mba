import { extractInbound } from './inbound';
import { arriveeDepuisMessage } from './arrivees-pub';
import { routerLeLead, restrictionDuRoutage } from '../pubs/routage';
import type { IssueRoutage, PubDuLead, RoutageDuMessage } from '../pubs/routage';
import { messageDe } from '../lib/erreur';

/**
 * LE ROUTAGE D'UN LEAD PUBLICITAIRE, câblé (lot 3, spec § 3.3). La RÈGLE, elle, est pure et vit dans
 * `src/pubs/routage.ts` : ce fichier ne fait que rassembler les faits, appliquer la décision, et dire aux
 * déclencheurs ce qu'ils ont le droit de faire de chaque message.
 *
 * 🔴 SA PLACE DANS LE JOB EST LA MOITIÉ DE SON COMPORTEMENT. Il tourne APRÈS `processArriveesPub` (qui a
 * écrit la ligne d'arrivée qu'il vient annoter) et AVANT `processTriggers` (qu'il restreint). Le déplacer
 * d'un cran dans un sens lui ferait annoter une ligne qui n'existe pas, dans l'autre lui ferait restreindre
 * des déclencheurs déjà partis.
 *
 * 🔴 IL NE PASSE PAS PAR `consumed`, ET C'EST DÉLIBÉRÉ. Ce jeu-là retire aussi le message à l'avance de
 * parcours (`processWorkflowAdvance`) : un lead qui arrive sur une pub « agent de Meta » alors qu'il répond
 * à un scénario en cours doit continuer d'y répondre. Restreindre les déclencheurs et consommer un message
 * sont deux choses différentes, et les confondre en fait une.
 *
 * ⚠️ ISOLÉ PAR MESSAGE, comme ses voisines : Meta groupe plusieurs contacts dans un même webhook, et l'échec
 * de l'un ne doit priver ni les autres, ni les étapes suivantes du job. Un message dont le routage échoue
 * n'entre dans aucune restriction, donc il suit le chemin ordinaire : c'est le repli le moins surprenant
 * (« comme avant ce lot »), et il est écrit ici plutôt que laissé au hasard.
 */
export interface RoutagePubDeps {
  /** Tenant propriétaire du numéro business. `null` si le numéro nous est inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /**
   * La campagne de cette publicité, D'APRÈS NOS TABLES (`pubs_connues`). `null` = jamais vue.
   *
   * 🔴 LE ROUTAGE NE LIT QUE NOS TABLES, sauf pour une copie encore inconnue (cf. `resoudreChezMeta`). On est
   * sur le chemin chaud d'un message entrant : un appel à un tiers à chaque lead ferait dépendre la réponse
   * au client de la disponibilité de Meta.
   */
  campagneConnue(tenantId: string, adId: string): Promise<string | null>;
  /**
   * Demande à Meta la campagne de cette publicité, et la MÉMORISE. `null` = Meta n'a pas répondu, a refusé,
   * ou a dépassé le délai. Un échec ne se mémorise pas : il figerait une panne réseau en verdict permanent.
   */
  resoudreChezMeta(tenantId: string, adId: string): Promise<string | null>;
  /** La publicité que NOUS pilotons pour cette campagne. `null` = campagne qui n'est pas à nous. */
  publiciteDeLaCampagne(tenantId: string, campagneId: string): Promise<PubDuLead | null>;
  contactBloque(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Le contact a-t-il dit STOP ?
   *
   * 🔴 REQUISE, JAMAIS OPTIONNELLE. Déclarée `estDesabonne?()` dans quatre interfaces, cette garde a fait
   * écrire à des contacts désabonnés DEUX FOIS en 48 heures (13 et 14 septembre 2026) : absente, elle ne
   * tournait pas, et le câblage qui l'oubliait compilait. Les fixtures disent leur hypothèse avec
   * `jamaisDesabonne` (`tests/consentement.ts`).
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Reprend le fil à l'agent de Meta ET pose le contrôle local à `app_workflow`. `false` = Meta a refusé.
   *
   * ⚠️ C'est `reprendreLeFilPourLApp` (`src/workflow/wiring.ts`), le geste qui existe déjà : `take` avec un
   * seul rejeu, puis l'état local. On le CÂBLE, on ne le récrit pas : ce serait le quatrième exemplaire
   * d'une famille qui a déjà cassé la production en en portant deux.
   */
  reprendreLeFil(tenantId: string, waId: string): Promise<boolean>;
  /**
   * REND LE FIL À L'AGENT DE META, quand on l'a pris et que personne n'a finalement parlé.
   *
   * ⚠️ C'est `remiseMbaSiPersonneNeSuit` (`src/workflow/wiring.ts`), le geste qui EXISTE, et qui porte déjà
   * les deux gardes qu'il faut : il ne rend rien si l'agent de Meta est éteint, ni si un parcours attend
   * une réponse. On le câble, on ne le récrit pas.
   */
  rendreLeFil(tenantId: string, waId: string): Promise<void>;
  /**
   * Inscrit sur l'arrivée déjà écrite ce que le routage a décidé.
   *
   * ⚠️ N'ÉCRIT QUE SI L'ISSUE EST ENCORE NULLE (premier routage gagnant) : Meta redélivre ses webhooks, et
   * un rejeu ne doit pas réécrire l'histoire d'un lead déjà routé, ni surtout déplacer l'heure de reprise.
   */
  noterIssue(tenantId: string, messageId: string, v: {
    campagneId: string | null; issue: IssueRoutage; repriseLe: Date | null;
  }): Promise<void>;
}

/**
 * `referral.source_type` que Meta pose sur une PUBLICATION, pas sur une publicité.
 *
 * ⚠️ ON NE DEMANDE PAS SA CAMPAGNE À META POUR CELLE-LÀ : un identifiant de publication n'est pas un
 * identifiant de pub, l'appel rendrait un 400 à chaque lead d'une page qui marche. L'ABSENCE de `source_type`,
 * elle, ne prouve rien : on tente, parce qu'un champ que Meta cesserait d'envoyer ne doit pas éteindre le
 * routage en silence.
 */
const SOURCE_PUBLICATION = 'post';

/**
 * Route chaque message entrant qui porte un `referral`, et rend la carte `messageId -> restriction` que
 * `processTriggers` consulte.
 *
 * ⚠️ UN MESSAGE ABSENT DE LA CARTE VAUT « chemin ordinaire ». C'est le cas de tout le trafic non
 * publicitaire, et aussi d'un routage qui a échoué : le défaut est le comportement d'avant ce lot.
 */
export async function processRoutagePub(
  payload: unknown,
  deps: RoutagePubDeps,
  /**
   * Les messages que Meta nous REDÉLIVRE (`insertEvent` a dit « déjà vu »).
   *
   * 🔴 ON NE REPREND PAS LE FIL UNE SECONDE FOIS. `noterIssue` protège l'HISTOIRE (« le premier routage
   * gagne »), pas le GESTE : un second `take` reposerait `app_workflow` sur un fil qu'un opérateur aurait
   * pu reprendre entre-temps, donc lui arracherait une conversation qu'il est en train de mener.
   *
   * ⚠️ ET ON NE DEVINE PAS CE QUE LA PREMIÈRE LIVRAISON A OBTENU. La restriction d'un rejeu vaut donc
   * `aucun` : aucune automation ordinaire ne ramasse le lead (elles ne devaient pas y toucher), et le
   * scénario ne repart pas (il est parti la première fois, ou il avait été refusé). Voir la note sur
   * `repriseReussie` dans la boucle : c'est là que la fiction inverse a coûté deux fautes certaines.
   */
  dejaVus?: ReadonlySet<string>,
): Promise<ReadonlyMap<string, RoutageDuMessage>> {
  const routes = new Map<string, RoutageDuMessage>();
  for (const m of extractInbound(payload)) {
    const a = arriveeDepuisMessage(m);
    if (!a) continue;
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (!tenantId) continue;

      const campagneId = await campagneDuLead(tenantId, a.adId, a.sourceType, deps);
      const pub = campagneId === null ? null : await deps.publiciteDeLaCampagne(tenantId, campagneId);

      /**
       * ⚠️ LES DEUX ÉTATS DU CONTACT NE SE LISENT QUE QUAND ILS PEUVENT CHANGER QUELQUE CHOSE, c'est-à-dire
       * pour une pub qui nous confie ses leads. Sans cette condition, chaque message venu d'une publicité du
       * Gestionnaire (le cas le plus courant aujourd'hui) coûterait deux requêtes de plus sur le chemin
       * chaud. `routerLeLead` ne les lit pas dans ces branches-là, et un test pince cette indépendance :
       * c'est ce qui rend l'économie sûre au lieu de la rendre fragile.
       */
      const pourNous = pub !== null && pub.destination === 'scenario';
      const [bloque, desabonne] = pourNous
        ? await Promise.all([deps.contactBloque(tenantId, m.waId), deps.estDesabonne(tenantId, m.waId)])
        : [false, false];

      const decision = routerLeLead({ pub, bloque, desabonne, enStandby: a.enStandby });

      let repriseReussie = false;
      let repriseLe: Date | null = null;
      /**
       * 🔴 UN REJEU NE REFAIT RIEN, ET NE PRÉTEND RIEN. `repriseReussie` reste FAUX, ce qui vaut « on n'a
       * rien pris maintenant », et c'est la seule lecture sûre des deux côtés.
       *
       * ⚠️ CE QU'UNE FICTION « reprise acquise » COÛTAIT, et une relecture à froid l'a trouvé : elle
       * faisait poser `repris`, donc le handler RENDAIT à l'agent de Meta un fil sur lequel notre scénario
       * pouvait être en train de parler (au rejeu, l'automation est en anti-rebond, donc rien ne démarre,
       * donc le filet se déclenchait) ; et elle rendait la restriction `seule`, donc au rejeu d'un lead
       * dont la reprise avait été REFUSÉE, le scénario partait sur un fil que l'agent de Meta détenait,
       * c'est-à-dire les deux messages que tout ce lot s'emploie à éviter.
       *
       * ⚠️ CE QUE `false` COÛTE, ET C'EST ASSUMÉ : la restriction vaut `aucun`, donc un rejeu ne démarre
       * jamais le scénario. Ce n'est un manque que si la PREMIÈRE livraison a échoué APRÈS l'écriture de
       * l'événement, cas où le lead est perdu. C'est exactement la limite déjà assumée et documentée pour
       * « premier message d'un nouveau contact » (`handleWebhookJob`), pour la même raison : le signal ne
       * survit pas à un rejeu de job. Ce qu'on refuse, c'est d'échanger ce manque rare contre deux fautes
       * certaines.
       */
      if (decision.sorte === 'reprendre_puis_pub' && dejaVus?.has(m.messageId) !== true) {
        repriseReussie = await deps.reprendreLeFil(tenantId, m.waId);
        if (repriseReussie) repriseLe = new Date();
      }

      const issue: IssueRoutage = decision.sorte === 'reprendre_puis_pub'
        ? (repriseReussie ? 'reprise_reussie' : 'reprise_refusee')
        : decision.issue;

      routes.set(m.messageId, {
        restriction: restrictionDuRoutage(decision, repriseReussie),
        campagneId,
        // On ne retient QUE les prises réussies : il n'y a que celles-là qu'on puisse avoir à rendre.
        repris: repriseReussie ? { tenantId, waId: m.waId } : null,
      });
      await deps.noterIssue(tenantId, m.messageId, { campagneId, issue, repriseLe });

      if (issue === 'reprise_refusee') {
        // 🔴 LE SEUIL DU PLAN B PASSE PAR CETTE LIGNE (spec, tableau des arbitrages) : une seule reprise
        // refusée pendant le pilote suffit à basculer sur l'aiguillage par liste autorisée. Elle doit donc
        // être VISIBLE dans le journal, pas seulement comptée dans une colonne que personne ne regarde.
        // eslint-disable-next-line no-console
        console.warn(`routage pub : Meta a refusé de rendre le fil pour le lead ${m.messageId} (campagne ${campagneId ?? 'inconnue'}), son agent garde ce lead`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processRoutagePub: lead ignoré:', messageDe(err));
    }
  }
  return routes;
}

/**
 * La campagne d'une pub : nos tables d'abord, Meta seulement pour une pub jamais vue.
 *
 * ⚠️ UN ÉCHEC REND `null`, ET `null` VEUT DIRE « campagne inconnue », donc « comme avant ce lot ». C'est le
 * bon repli : un lead qu'on ne sait pas router doit rester routable par les automations ordinaires, plutôt
 * que de tomber dans un silence que personne ne verrait.
 */
async function campagneDuLead(
  tenantId: string,
  adId: string,
  sourceType: string | null,
  deps: RoutagePubDeps,
): Promise<string | null> {
  const connue = await deps.campagneConnue(tenantId, adId);
  if (connue !== null) return connue;
  if (sourceType === SOURCE_PUBLICATION) return null;
  try {
    return await deps.resoudreChezMeta(tenantId, adId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`routage pub : campagne de la publicité ${adId} non résolue chez Meta :`, messageDe(err));
    return null;
  }
}

/**
 * REND LES FILS QU'ON A PRIS POUR RIEN.
 *
 * 🔴 CE QU'IL FERME, ET POURQUOI L'ORDRE DU JOB L'IMPOSE. Le fil se prend AVANT les déclencheurs, parce
 * qu'un scénario ne démarre pas sur un fil tenu par l'agent de Meta. On ne peut donc pas savoir, au moment
 * de le prendre, si quelque chose va réellement parler : l'automation de la publicité peut encore être
 * retenue par son anti-rebond, ou refuser parce que son scénario a disparu. Quand c'est le cas, le fil nous
 * reste et PERSONNE ne répond : le seul filet est le balayage de contrôle, vingt-quatre heures plus tard,
 * quand la fenêtre de service de Meta est déjà fermée. Sur un clic PAYÉ, c'est un silence complet.
 *
 * ⚠️ IL NE REND QUE CE QU'ON A PRIS, et seulement si rien n'a démarré. Rendre un fil sur lequel un scénario
 * vient de parler le donnerait à l'agent de Meta au milieu d'une conversation qu'il ne connaît pas.
 *
 * ⚠️ ISOLÉ, et il ne lève jamais : son appelant est le job webhook, partagé avec les accusés, l'inbox et
 * les flows. Un fil non rendu est rattrapé par le balayage ; un job en DLQ emporte tout le reste.
 */
export async function rendreLesFilsSansReponse(
  routes: ReadonlyMap<string, RoutageDuMessage>,
  demarres: ReadonlySet<string>,
  deps: Pick<RoutagePubDeps, 'rendreLeFil'>,
): Promise<void> {
  for (const [messageId, route] of routes) {
    if (route.repris === null || demarres.has(messageId)) continue;
    try {
      await deps.rendreLeFil(route.repris.tenantId, route.repris.waId);
      // eslint-disable-next-line no-console
      console.warn(`routage pub : fil repris pour le lead ${messageId} mais aucun scénario n’a démarré, il est rendu à l’agent de Meta`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('routage pub : fil non rendu :', messageDe(err));
    }
  }
}
