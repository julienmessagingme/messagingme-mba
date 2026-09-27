import { arriveeDepuisMessage } from './arrivees-pub';
import type { EntrantRattache } from './rattachement';
import { routerLeLead, restrictionDuRoutage } from '../pubs/routage';
import type { IssueRoutage, PubDuLead, RoutageDuMessage } from '../pubs/routage';
import { messageDe } from '../lib/erreur';

/**
 * Le routage d'un lead publicitaire, câblé ; la règle, pure, vit dans `src/pubs/routage.ts`. Ce fichier
 * rassemble les faits, applique la décision, et dit aux déclencheurs ce qu'ils ont le droit de faire de chaque
 * message. Sa place dans le job fait la moitié de son comportement : après `processArriveesPub` (dont il annote
 * la ligne) et avant `processTriggers` (qu'il restreint). Il ne passe pas par `consumed`, qui retirerait aussi le
 * message à l'avance de parcours : un lead qui répond à un scénario en cours doit continuer d'y répondre. Isolé
 * par message : un routage en échec n'entre dans aucune restriction et suit le chemin ordinaire.
 */
export interface RoutagePubDeps {
  /**
   * La campagne de cette publicité, d'après nos tables (`pubs_connues`) ; `null` = jamais vue. Le routage ne lit
   * que nos tables, sauf pour une copie inconnue (`resoudreChezMeta`) : sur le chemin chaud d'un message entrant,
   * un appel à un tiers par lead ferait dépendre la réponse au client de la disponibilité de Meta.
   */
  campagneConnue(tenantId: string, adId: string): Promise<string | null>;
  /**
   * Demande à Meta la campagne de cette publicité et la mémorise ; `null` = pas de réponse, refus ou délai. Un
   * échec ne se mémorise pas : il figerait une panne réseau en verdict permanent.
   */
  resoudreChezMeta(tenantId: string, adId: string): Promise<string | null>;
  /** La publicité que nous pilotons pour cette campagne. `null` = campagne qui n'est pas à nous. */
  publiciteDeLaCampagne(tenantId: string, campagneId: string): Promise<PubDuLead | null>;
  contactBloque(tenantId: string, waId: string): Promise<boolean>;
  /**
   * 🔴 Le contact a-t-il dit STOP ? Requise, jamais optionnelle : une garde optionnelle oubliée par un câblage
   * compile et écrit à un contact désabonné. Les fixtures disent leur hypothèse avec `jamaisDesabonne`
   * (`tests/consentement.ts`).
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Reprend le fil à l'agent de Meta et pose le contrôle local à `app_workflow` ; `false` = Meta a refusé. C'est
   * `reprendreLeFilPourLApp` (`src/workflow/wiring.ts`), câblé et non réécrit.
   */
  reprendreLeFil(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Rend le fil à l'agent de Meta, quand on l'a pris et que personne n'a finalement parlé. C'est
   * `remiseMbaSiPersonneNeSuit` (`src/workflow/wiring.ts`), qui porte déjà ses gardes (agent éteint, parcours en
   * attente) : câblé, non réécrit.
   */
  rendreLeFil(tenantId: string, waId: string): Promise<void>;
  /**
   * Inscrit sur l'arrivée déjà écrite ce que le routage a décidé, seulement si l'issue est encore nulle : un
   * webhook redélivré ne doit pas réécrire l'histoire d'un lead déjà routé, ni déplacer l'heure de reprise.
   */
  noterIssue(tenantId: string, messageId: string, v: {
    campagneId: string | null; issue: IssueRoutage; repriseLe: Date | null;
  }): Promise<void>;
}

/**
 * `referral.source_type` que Meta pose sur une publication, pas sur une publicité : on ne demande pas sa
 * campagne à Meta (un 400 à chaque lead). L'absence de `source_type` ne prouve rien : on tente, pour qu'un champ
 * disparu ne coupe pas le routage en silence.
 */
const SOURCE_PUBLICATION = 'post';

/**
 * Route chaque message entrant qui porte un `referral`, et rend la carte `messageId -> restriction` que
 * `processTriggers` consulte. Un message absent de la carte suit le chemin ordinaire (trafic non publicitaire,
 * ou routage en échec).
 */
export async function processRoutagePub(
  entrants: readonly EntrantRattache[],
  deps: RoutagePubDeps,
  /**
   * Les messages que Meta nous redélivre (`insertEvent` a dit « déjà vu »). On ne reprend pas le fil une seconde
   * fois : `noterIssue` protège l'histoire, pas le geste, et un second `take` arracherait la conversation à un
   * opérateur qui l'aurait reprise. On ne devine pas non plus ce que la première livraison a obtenu : la
   * restriction d'un rejeu vaut `aucun`.
   */
  dejaVus?: ReadonlySet<string>,
): Promise<ReadonlyMap<string, RoutageDuMessage>> {
  const routes = new Map<string, RoutageDuMessage>();
  for (const { message: m, tenantId } of entrants) {
    const a = arriveeDepuisMessage(m);
    // Numéro inconnu : aucune campagne à chercher, le message suit le chemin ordinaire.
    if (!a || !tenantId) continue;
    try {
      const campagneId = await campagneDuLead(tenantId, a.adId, a.sourceType, deps);
      const pub = campagneId === null ? null : await deps.publiciteDeLaCampagne(tenantId, campagneId);

      /**
       * Les deux états du contact ne se lisent que quand ils peuvent changer quelque chose (une pub qui nous confie
       * ses leads) : sinon deux requêtes de plus par lead sur le chemin chaud. `routerLeLead` ne les lit pas ailleurs,
       * et un test tient cette indépendance.
       */
      const pourNous = pub !== null && pub.destination === 'scenario';
      const [bloque, desabonne] = pourNous
        ? await Promise.all([deps.contactBloque(tenantId, m.waId), deps.estDesabonne(tenantId, m.waId)])
        : [false, false];

      const decision = routerLeLead({ pub, bloque, desabonne, enStandby: a.enStandby });

      let repriseReussie = false;
      let repriseLe: Date | null = null;
      /**
       * Un rejeu ne refait rien et ne prétend rien : `repriseReussie` reste faux (« rien pris maintenant »). Le
       * prétendre acquis ferait rendre à l'agent de Meta un fil où notre scénario parle, ou partir le scénario sur un
       * fil que l'agent détient. Prix assumé : la restriction vaut `aucun`, un rejeu ne démarre jamais le scénario ;
       * le lead n'est perdu que si la première livraison a échoué après l'écriture de l'événement.
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
        // La reprise refusée doit rester visible dans le journal : une seule pendant le pilote suffit à basculer sur
        // l'aiguillage par liste autorisée.
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
 * La campagne d'une pub : nos tables d'abord, Meta seulement pour une pub jamais vue. Un échec rend `null`
 * (« campagne inconnue ») : un lead qu'on ne sait pas router reste routable par les automations ordinaires.
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
 * Rend les fils qu'on a pris pour rien. Le fil se prend avant les déclencheurs (un scénario ne démarre pas sur un
 * fil tenu par l'agent de Meta), sans savoir si quelque chose parlera : l'automation peut être en anti-rebond, ou
 * son scénario avoir disparu. Sans ce rendu, personne ne répondrait avant le balayage, fenêtre de service
 * fermée, sur un clic payé. Ne rend que ce qu'on a pris, et seulement si rien n'a démarré. Isolé, ne lève jamais.
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
