import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilDefini, JournalAppels } from '../agent/catalog';
import type { RequeteConnecteur } from '../agent/requetes';
import type { AppelConnecteur } from '../agent/resolvers/http';
import type { SortieResolveur } from '../agent/executor';
import { consommateurMba } from '../agent/consommateur';
import { REPONSE_EN_COURS, lireCibleMaison } from '../mba/outils-maison';
import { erreurDePanne, executerOutilMaison, type DepsMaison, type IssueMaison } from '../mba/executer-maison';
import { messageDe } from '../lib/erreur';
import {
  ENTETE_CONTACT_META, CHEMIN_RELAIS, waIdDepuisEntete, formeEntete, lireValeursModele, texteErreur,
  corpsIllisible,
} from '../mba/relais';

/**
 * LA ROUTE DU RELAIS : Meta l'appelle à la place du système du client (spec
 * docs/superpowers/specs/2026-09-21-relais-mba-design.md). La moitié pure vit dans `src/mba/relais.ts`.
 *
 * 🔴 L'ESPACE VIENT DE LA CLÉ, JAMAIS DE L'ADRESSE. La clé `mba:relais` est posée chez Meta par la
 * publication ; son porteur peut appeler les outils de l'espace au nom de n'importe lequel de ses contacts
 * (c'est l'en-tête qui désigne le contact), d'où un droit qu'aucun écran ne sait attribuer.
 *
 * 🔴 L'APPEL PASSE PAR `creerAppelConnecteur`, exactement comme pour un agent IA : mêmes gardes (adresse de
 * base, résolution publique, variables requises), mêmes variables du mini-CRM, et le journal sous l'appelant
 * `mba`. Pour un outil de connecteur, ce module ne fait que traduire la demande de Meta en appel.
 *
 * 🔴 UN OUTIL MAISON DE L'AGENT DE META N'APPELLE PERSONNE (spec 2026-09-21-outils-maison-mba) : le geste
 * (poser un tag, écrire un champ) s'exécute ici, par les fonctions qui le font déjà ailleurs
 * (`src/mba/executer-maison.ts`), et se journalise dans la même table sous le même appelant.
 *
 * ⚠️ UN ÉCHEC MÉTIER SORT EN 200 `{ succes: false, erreur }` : le modèle de Meta doit pouvoir dire au client
 * ce qui ne va pas. Un ENVOI qui échoue après `DELAI_REPONSE_ENVOI_MS` ne peut plus sortir ainsi (Meta a déjà sa
 * réponse) : il lui est dit par un événement (`signalerEchecTardif`). Un 4xx ou un 5xx risquerait d'être lu comme une panne de transport (non documenté chez
 * Meta, à mesurer au premier essai). Ce que la ROUTE décide sort donc toujours en 200, y compris un JSON
 * illisible (`corpsIllisible`). Seule la garde de clé répond AVANT elle : 401, 403 sans le droit, 403
 * `tenant_locked`, 429 au-delà du plafond de la clé. Un corps VIDE passe, et un test le garde.
 */
export interface MbaRelaisDeps {
  /** Le numéro Meta de l'espace, `null` = aucun, donc aucun outil exposé. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Les outils ACTIFS pour un consommateur, filtrés sur l'espace (`listActifsConsommateur`). */
  outilsActifs(
    tenantId: string,
    consommateur: string,
  ): Promise<Array<Pick<OutilDefini, 'id' | 'name' | 'origin' | 'requestId' | 'timeoutMs' | 'maxBytes' | 'binding'>>>;
  requete(tenantId: string, id: string): Promise<Pick<RequeteConnecteur, 'variables'> | null>;
  /** La PROJECTION du contact `{nom, tags, champs}`, ou `null` s'il est inconnu. Jamais la ligne brute. */
  contact(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
  appeler(p: AppelConnecteur): Promise<SortieResolveur>;
  journal: JournalAppels;
  /** La FORME de l'en-tête du numéro, tant que la macro n'est pas mesurée. Jamais sa valeur. */
  journaliserForme?(forme: string): void;
  /** Les gestes maison (tag, information), exécutés sans système tiers (spec 2026-09-21-outils-maison-mba). */
  maison: DepsMaison;
  /**
   * Attendre, en millisecondes : borne l'attente d'un ENVOI avant de répondre à Meta (`DELAI_REPONSE_ENVOI_MS`).
   * INJECTÉE et requise, comme dans `controle-du-fil.ts` : un test doit pouvoir dire « le délai est écoulé » sans
   * dormir, et « l'envoi a fini avant » sans course.
   */
  attendre(ms: number): Promise<void>;
  /**
   * Dit à l'agent de Meta qu'un envoi a échoué APRÈS qu'il ait lu « C'est parti » (`src/mba/signaler-echec-tardif.ts`).
   * Requise : sans elle, un lancement de scénario refusé tardivement laissait l'agent muet et le client sans réponse.
   */
  signalerEchecTardif(tenantId: string, waId: string, raison: string): Promise<void>;
}

/**
 * Combien de temps le relais attend un ENVOI (bloc, scénario) avant de répondre « c'est parti » à Meta.
 *
 * 🔴 META COUPE UN OUTIL VERS TROIS SECONDES, et c'est mesuré, pas lu (essai réel du 2026-09-22) : un envoi de bloc
 * de 3 005 ms a été traité comme un échec, et l'agent de Meta a annoncé au client qu'un humain reprenait la
 * conversation. Un envoi fait DEUX appels à Meta (prendre le fil, envoyer) : sa durée n'est pas à nous. 1,5 s
 * laisse la marge du trajet et des lectures qui précèdent (outil, clé, journal). Le refus d'un BLOC arrive avant
 * tout appel à Meta (bloc disparu, fenêtre fermée, contact bloqué) : il tient dans ce délai et l'agent de Meta le
 * lit. Celui d'un SCÉNARIO, non : `runFrom` reprend le fil AVANT ses autres refus. Un refus tardif est donc dit à
 * l'agent par un événement (`signalerEchecTardif`), puisqu'il a déjà sa réponse.
 */
export const DELAI_REPONSE_ENVOI_MS = 1500;

export function registerMbaRelais(app: FastifyInstance, deps: MbaRelaisDeps, garde: Guard): void {
  app.post<{ Params: { outilId: string } }>(`${CHEMIN_RELAIS}/outils/:outilId`, { preHandler: garde }, async (req, reply) => {
    const tenant = req.auth?.tenantId;
    if (!tenant) return reply.code(401).send({ error: 'clé d’API requise' });
    const refus = (erreur: string) => reply.code(200).send({ succes: false, erreur });

    // 1. L'OUTIL : un outil de CET espace, exposé ET actif pour SON agent de Meta. Deux familles : un appel de
    //    connecteur (`http`), ou un geste maison dont la cible se relit et se valide (`mba`). Une action d'agent
    //    IA exposée au MBA par l'ancienne route a un handler inconnu ici : refusée, jamais jouée.
    const PAS_PROPOSE = 'cet outil n’est pas proposé à l’agent de Meta';
    const pn = await deps.numeroDuTenant(tenant);
    const outil = pn === null
      ? undefined
      : (await deps.outilsActifs(tenant, consommateurMba(pn))).find((o) => o.id === req.params.outilId);
    if (!outil) return refus(PAS_PROPOSE);
    const cible = outil.origin === 'mba' ? lireCibleMaison(outil.binding) : null;
    if (cible === null && (outil.origin !== 'http' || !outil.requestId)) return refus(PAS_PROPOSE);

    // 2. LE CONTACT, désigné par l'en-tête que Meta remplit lui-même (macro `WHATSAPP_PHONE_NUMBER`). On
    //    n'appelle JAMAIS le système du client sans contact identifié.
    const brut = req.headers[ENTETE_CONTACT_META.toLowerCase()];
    const valeur = Array.isArray(brut) ? brut[0] : brut;
    deps.journaliserForme?.(formeEntete(valeur));
    const waId = waIdDepuisEntete(valeur);
    if (waId === null) return refus('le client n’est pas identifié : son numéro WhatsApp manque');
    const contact = await deps.contact(tenant, waId);
    if (contact === null) return refus('ce client est introuvable dans le carnet de contacts');

    // 2 bis. UN GESTE MAISON : exécuté ici, journalisé comme un appel de connecteur (même table, même appelant).
    if (cible !== null) {
      if (cible.handler === 'champ_fixe' && corpsIllisible((req as { rawBody?: unknown }).rawBody)) {
        return refus('le corps de la requête n’est pas du JSON lisible');
      }
      const debut = Date.now();
      const ligne = await deps.journal.ouvrir({
        tenantId: tenant, sessionId: null, toolId: outil.id, toolName: outil.name, origin: 'mba',
        // ⚠️ Aucune valeur du client dans le journal : seule la nature du geste, que l'administrateur a fixé.
        argsRediges: { geste: cible.handler },
        source: 'mba',
      }).catch(() => null);
      // Le geste ENTIER, journal compris : il ne rejette jamais, donc il peut continuer seul après la réponse.
      const geste: Promise<IssueMaison> = executerOutilMaison(deps.maison, { tenantId: tenant, waId, outilId: outil.id, cible, corps: req.body })
        .then((issue) => ({ issue, panne: false }), (err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`mba-relais: geste ${outil.name} en échec :`, messageDe(err));
          const issue: IssueMaison = { ok: false, erreur: erreurDePanne(cible) };
          return { issue, panne: true };
        })
        .then(async ({ issue, panne }) => {
          // Clos sur l'issue RÉELLE, même quand Meta a déjà eu sa réponse : c'est la seule trace d'un envoi qui
          // aurait échoué après le délai.
          if (ligne !== null) {
            await deps.journal.clore({
              tenantId: tenant, id: ligne, status: issue.ok ? 'ok' : panne ? 'erreur_outil' : 'refuse',
              dureeMs: Date.now() - debut, ...(issue.ok ? {} : { erreur: issue.erreur }),
            }).catch(() => {});
          }
          return issue;
        });
      // 🔴 UN ENVOI N'EST ATTENDU QUE `DELAI_REPONSE_ENVOI_MS` : au-delà, Meta coupe l'outil et son agent croit à un
      // échec. Un tag ou une information, écritures locales, sont attendus jusqu'au bout.
      const rendre = (issue: IssueMaison) => (issue.ok ? reply.code(200).send({ succes: true, reponse: issue.reponse }) : refus(issue.erreur));
      if (cible.handler === 'bloc_fixe' || cible.handler === 'scenario_fixe') {
        const premier = await Promise.race([geste, deps.attendre(DELAI_REPONSE_ENVOI_MS).then(() => null)]);
        if (premier !== null) return rendre(premier);
        // 🔴 L'AGENT DE META A DÉJÀ SA RÉPONSE : un échec qui arrive maintenant lui est dit par un événement, sans
        // quoi il resterait muet (« n'écris rien de plus ») et le client sans réponse. `geste` ne rejette jamais ;
        // le signalement, lui, peut échouer, et rien ne l'attend : il est rattrapé ici.
        void geste
          .then((issue) => (issue.ok ? undefined : deps.signalerEchecTardif(tenant, waId, issue.erreur)))
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error(`mba-relais: l'échec tardif de ${outil.name} n'a pas pu être dit à l'agent de Meta :`, messageDe(err));
          });
        return reply.code(200).send({ succes: true, reponse: REPONSE_EN_COURS[cible.handler] });
      }
      return rendre(await geste);
    }
    if (!outil.requestId) return refus(PAS_PROPOSE);

    // 3. LES VALEURS DU MODÈLE, validées contre les variables `modele` déclarées, et elles seules. Le lecteur
    //    de JSON du serveur rend `{}` sur un corps illisible : on relit le corps BRUT pour ne pas le confondre
    //    avec un corps vide (`rawBody` est posé par ce lecteur, `src/webhooks/receiver.ts`). ⚠️ Seulement si
    //    l'outil LIT un corps : un outil sans variable du modèle n'en a pas, et ce que Meta envoie alors n'est
    //    pas mesuré ; le refuser pour un corps qu'on n'aurait pas lu casserait l'outil pour rien.
    const requete = await deps.requete(tenant, outil.requestId);
    if (requete === null) return refus('cet outil n’est pas configuré');
    const litUnCorps = requete.variables.some((v) => v.origine.type === 'modele');
    if (litUnCorps && corpsIllisible((req as { rawBody?: unknown }).rawBody)) {
      return refus('le corps de la requête n’est pas du JSON lisible');
    }
    const lu = lireValeursModele(requete.variables, req.body);
    if (!lu.ok) return refus(lu.erreur);

    // 4. L'APPEL, par le point de passage partagé.
    const sortie = await deps.appeler({
      tenantId: tenant, waId, contact, requestId: outil.requestId, maxBytes: outil.maxBytes, args: lu.valeurs,
      signal: AbortSignal.timeout(outil.timeoutMs),
      journal: { journal: deps.journal, source: 'mba', nom: outil.name, sessionId: null, toolId: outil.id },
      lecture: { nature: 'entier' },
    });
    if (sortie.ok === false) return refus(texteErreur(sortie.contenu));
    const reponse = (sortie.contenu as { reponse?: unknown } | null)?.reponse ?? null;
    return reply.code(200).send({ succes: true, statut: sortie.httpStatus ?? null, reponse });
  });
}
