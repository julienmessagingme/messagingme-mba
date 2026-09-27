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
 * La route du relais : Meta l'appelle à la place du système du client. La moitié pure vit dans `src/mba/relais.ts`.
 * 🔴 L'espace vient de la clé `mba:relais` (posée chez Meta par la publication), jamais de l'adresse : son porteur
 * agit au nom de n'importe quel contact de l'espace (l'en-tête désigne le contact).
 * Un outil de connecteur passe par `creerAppelConnecteur`, comme pour un agent IA (mêmes gardes, journal sous
 * l'appelant `mba`). Un outil maison n'appelle personne : son geste s'exécute ici (`src/mba/executer-maison.ts`).
 * Un échec métier sort en 200 `{ succes: false, erreur }` pour que le modèle de Meta puisse le dire au client (un
 * 4xx ou 5xx risquerait d'être lu comme une panne de transport). Seule la garde de clé répond avant la route :
 * 401, 403 (droit, `tenant_locked`), 429. Un envoi qui échoue après `DELAI_REPONSE_ENVOI_MS` est signalé par un
 * événement (`signalerEchecTardif`). Un corps vide passe.
 */
export interface MbaRelaisDeps {
  /** Le numéro Meta de l'espace, `null` = aucun, donc aucun outil exposé. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Les outils actifs pour un consommateur, filtrés sur l'espace (`listActifsConsommateur`). */
  outilsActifs(
    tenantId: string,
    consommateur: string,
  ): Promise<Array<Pick<OutilDefini, 'id' | 'name' | 'origin' | 'requestId' | 'timeoutMs' | 'maxBytes' | 'binding'>>>;
  requete(tenantId: string, id: string): Promise<Pick<RequeteConnecteur, 'variables'> | null>;
  /** La projection du contact `{nom, tags, champs}`, ou `null` s'il est inconnu. Jamais la ligne brute. */
  contact(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
  appeler(p: AppelConnecteur): Promise<SortieResolveur>;
  journal: JournalAppels;
  /** La forme de l'en-tête du numéro, tant que la macro n'est pas mesurée. Jamais sa valeur. */
  journaliserForme(forme: string): void;
  /** Les gestes maison (tag, information), exécutés sans système tiers. */
  maison: DepsMaison;
  /**
   * Attendre, en millisecondes : borne l'attente d'un envoi avant de répondre à Meta. Injectée et requise : un test
   * doit pouvoir dire « le délai est écoulé » sans dormir, et « l'envoi a fini avant » sans course.
   */
  attendre(ms: number): Promise<void>;
  /**
   * Dit à l'agent de Meta qu'un envoi a échoué après qu'il a lu « C'est parti » (`src/mba/signaler-echec-tardif.ts`).
   * Requise : sans elle, un refus tardif laisserait l'agent muet et le client sans réponse.
   */
  signalerEchecTardif(tenantId: string, waId: string, raison: string): Promise<void>;
}

/**
 * Combien de temps le relais attend un envoi (bloc, scénario) avant de répondre « c'est parti » à Meta.
 * Meta coupe un outil vers trois secondes (mesuré : 3 005 ms traités comme un échec, et l'agent annonce une reprise
 * humaine). Un envoi fait deux appels à Meta, sa durée n'est pas à nous : 1,5 s laisse la marge des lectures qui
 * précèdent. Le refus d'un bloc arrive avant tout appel à Meta et tient dans ce délai ; celui d'un scénario non
 * (`runFrom` prend le fil avant ses autres refus), d'où `signalerEchecTardif`.
 */
export const DELAI_REPONSE_ENVOI_MS = 1500;

export function registerMbaRelais(app: FastifyInstance, deps: MbaRelaisDeps, garde: Guard): void {
  app.post<{ Params: { outilId: string } }>(`${CHEMIN_RELAIS}/outils/:outilId`, { preHandler: garde }, async (req, reply) => {
    const tenant = req.auth?.tenantId;
    if (!tenant) return reply.code(401).send({ error: 'clé d’API requise' });
    const refus = (erreur: string) => reply.code(200).send({ succes: false, erreur });

    // 1. L'outil : un outil de cet espace, exposé et actif pour son agent de Meta. Deux familles : un appel de
    //    connecteur (`http`), ou un geste maison dont la cible se relit et se valide (`mba`). Un autre handler est
    //    refusé, jamais joué.
    const PAS_PROPOSE = 'cet outil n’est pas proposé à l’agent de Meta';
    const pn = await deps.numeroDuTenant(tenant);
    const outil = pn === null
      ? undefined
      : (await deps.outilsActifs(tenant, consommateurMba(pn))).find((o) => o.id === req.params.outilId);
    if (!outil) return refus(PAS_PROPOSE);
    const cible = outil.origin === 'mba' ? lireCibleMaison(outil.binding) : null;
    if (cible === null && (outil.origin !== 'http' || !outil.requestId)) return refus(PAS_PROPOSE);

    // 2. Le contact, désigné par l'en-tête que Meta remplit lui-même (macro `WHATSAPP_PHONE_NUMBER`). On
    //    n'appelle jamais le système du client sans contact identifié.
    const brut = req.headers[ENTETE_CONTACT_META.toLowerCase()];
    const valeur = Array.isArray(brut) ? brut[0] : brut;
    deps.journaliserForme(formeEntete(valeur));
    const waId = waIdDepuisEntete(valeur);
    if (waId === null) return refus('le client n’est pas identifié : son numéro WhatsApp manque');
    const contact = await deps.contact(tenant, waId);
    if (contact === null) return refus('ce client est introuvable dans le carnet de contacts');

    // 2 bis. Un geste maison : exécuté ici, journalisé comme un appel de connecteur (même table, même appelant).
    if (cible !== null) {
      if (cible.handler === 'champ_fixe' && corpsIllisible((req as { rawBody?: unknown }).rawBody)) {
        return refus('le corps de la requête n’est pas du JSON lisible');
      }
      const debut = Date.now();
      const ligne = await deps.journal.ouvrir({
        tenantId: tenant, sessionId: null, toolId: outil.id, toolName: outil.name, origin: 'mba',
        // Aucune valeur du client dans le journal : seule la nature du geste, que l'administrateur a fixée.
        argsRediges: { geste: cible.handler },
        source: 'mba',
      }).catch(() => null);
      // Le geste entier, journal compris : il ne rejette jamais, donc il peut continuer seul après la réponse.
      const geste: Promise<IssueMaison> = executerOutilMaison(deps.maison, { tenantId: tenant, waId, outilId: outil.id, cible, corps: req.body })
        .then((issue) => ({ issue, panne: false }), (err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`mba-relais: geste ${outil.name} en échec :`, messageDe(err));
          const issue: IssueMaison = { ok: false, erreur: erreurDePanne(cible) };
          return { issue, panne: true };
        })
        .then(async ({ issue, panne }) => {
          // Clos sur l'issue réelle, même quand Meta a déjà eu sa réponse : c'est la seule trace d'un envoi qui
          // aurait échoué après le délai.
          if (ligne !== null) {
            await deps.journal.clore({
              tenantId: tenant, id: ligne, status: issue.ok ? 'ok' : panne ? 'erreur_outil' : 'refuse',
              dureeMs: Date.now() - debut, ...(issue.ok ? {} : { erreur: issue.erreur }),
            }).catch(() => {});
          }
          return issue;
        });
      // Un envoi n'est attendu que `DELAI_REPONSE_ENVOI_MS` (au-delà, Meta coupe l'outil et son agent croit à un
      // échec). Un tag ou une information, écritures locales, sont attendus jusqu'au bout.
      const rendre = (issue: IssueMaison) => (issue.ok ? reply.code(200).send({ succes: true, reponse: issue.reponse }) : refus(issue.erreur));
      if (cible.handler === 'bloc_fixe' || cible.handler === 'scenario_fixe') {
        const premier = await Promise.race([geste, deps.attendre(DELAI_REPONSE_ENVOI_MS).then(() => null)]);
        if (premier !== null) return rendre(premier);
        // L'agent de Meta a déjà sa réponse : un échec qui arrive maintenant lui est dit par un événement. `geste` ne
        // rejette jamais ; le signalement peut échouer, et rien ne l'attend : il est rattrapé ici.
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

    // 3. Les valeurs du modèle, validées contre les variables `modele` déclarées, et elles seules. Le lecteur JSON
    //    rend `{}` sur un corps illisible : on relit le corps brut (`rawBody`) pour ne pas le confondre avec un
    //    corps vide. Seulement si l'outil lit un corps : sinon ce que Meta envoie n'est pas mesuré, et le refuser
    //    casserait l'outil pour rien.
    const requete = await deps.requete(tenant, outil.requestId);
    if (requete === null) return refus('cet outil n’est pas configuré');
    const litUnCorps = requete.variables.some((v) => v.origine.type === 'modele');
    if (litUnCorps && corpsIllisible((req as { rawBody?: unknown }).rawBody)) {
      return refus('le corps de la requête n’est pas du JSON lisible');
    }
    const lu = lireValeursModele(requete.variables, req.body);
    if (!lu.ok) return refus(lu.erreur);

    // 4. L'appel, par le point de passage partagé.
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
