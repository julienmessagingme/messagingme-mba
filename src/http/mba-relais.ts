import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilDefini, JournalAppels } from '../agent/catalog';
import type { RequeteConnecteur } from '../agent/requetes';
import type { AppelConnecteur } from '../agent/resolvers/http';
import type { SortieResolveur } from '../agent/executor';
import { consommateurMba } from '../agent/consommateur';
import { lireCibleMaison } from '../mba/outils-maison';
import { erreurDePanne, executerOutilMaison, type DepsMaison, type IssueMaison } from '../mba/executer-maison';
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
 * ce qui ne va pas. Un 4xx ou un 5xx risquerait d'être lu comme une panne de transport (non documenté chez
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
}

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
      let issue: IssueMaison;
      let panne = false;
      try {
        issue = await executerOutilMaison(deps.maison, { tenantId: tenant, waId, outilId: outil.id, cible, corps: req.body });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-relais: geste ${outil.name} en échec :`, err instanceof Error ? err.message : err);
        panne = true;
        issue = { ok: false, erreur: erreurDePanne(cible) };
      }
      if (ligne !== null) {
        await deps.journal.clore({
          tenantId: tenant, id: ligne, status: issue.ok ? 'ok' : panne ? 'erreur_outil' : 'refuse',
          dureeMs: Date.now() - debut, ...(issue.ok ? {} : { erreur: issue.erreur }),
        }).catch(() => {});
      }
      return issue.ok ? reply.code(200).send({ succes: true, reponse: issue.reponse }) : refus(issue.erreur);
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
