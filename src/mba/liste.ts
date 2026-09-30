import { z } from 'zod';
import { MetaApiError } from '../meta/errors';
import { messageDe } from '../lib/erreur';

/**
 * La liste de l'agent de Meta, tenue par la plateforme (migration 0195).
 *
 * L'agent est toujours réglé en mode liste (`ai_audience = ALLOWLISTED_ONLY`, `modifierSettings`) : un contact
 * absent de sa liste ne l'entend jamais, même quand Meta lui a rendu le fil (mesuré le 2026-09-29). C'est le seul
 * interrupteur par contact que Meta nous donne, et `thread_control` n'en est pas un : son action `take` ne nous rend
 * rien. Deux gestes s'en servent, dans `src/inbox/fil.ts` : **confier** une conversation à l'agent (`ajouter`, puis
 * `release`) et la **reprendre** (`retirer`). La fabrique Meta retire aussi le destinataire avant tout modèle
 * (`retirerAvantUnModele`, `src/meta/factory.ts`), et la réception lit la liste pour savoir à qui parle un
 * message rangé en `standby` (`src/webhooks/standby-hors-liste.ts`).
 *
 * 🔴 NOTRE TABLE FAIT FOI SUR CE QUI EST SUR LA LISTE. Meta ne rend l'identifiant d'une entrée qu'à l'ajout, et
 * sans lui on ne peut plus retirer : la ligne s'écrit APRÈS l'ajout chez Meta, et l'ajout est défait si l'écriture
 * échoue. Un contact sur la liste que la table ignorerait recevrait nos modèles avec l'agent qui répond.
 *
 * Le module reçoit le client MBA par une fonction (`clientMba`), appelée au moment du geste : la fabrique Meta,
 * qui fournit ce client, dépend elle-même de ce module.
 */

/**
 * L'attente entre les deux tentatives d'un retrait quand Meta ne dit pas combien patienter, et son plafond : dans
 * la boucle d'envoi d'une campagne, une attente longue retarde tous les destinataires suivants.
 */
export const REJEU_ATTENTE_DEFAUT_MS = 500;
export const REJEU_ATTENTE_MAX_MS = 2000;
/** Le nombre total de tentatives d'un retrait : un essai, puis un rejeu. */
export const REJEU_TENTATIVES = 2;

/** Ce qu'il faut garder d'une entrée pour pouvoir la retirer. */
export interface EntreeDeLaListe {
  /** Le numéro business sur lequel l'entrée a été créée, celui qu'il faudra nommer pour la retirer. */
  phoneNumberId: string;
  /** L'identifiant rendu par Meta à l'ajout. */
  entreeId: string;
}

/** Une ligne supprimée par la purge d'un contact : de quoi retirer l'entrée chez Meta après la transaction. */
export interface LigneDeLaListe extends EntreeDeLaListe {
  waId: string;
}

/** La mémoire de la liste (`mba_liste`, `PgListeStore`). `waId` : chiffres nus. */
export interface ListeStore {
  /** Les contacts de `waIds` présents sur la liste de l'espace, en une lecture. */
  presents(tenantId: string, waIds: readonly string[]): Promise<Set<string>>;
  trouver(tenantId: string, waId: string): Promise<EntreeDeLaListe | null>;
  /** Idempotent : deux ajouts concurrents du même contact nomment la même entrée chez Meta. */
  poser(tenantId: string, waId: string, phoneNumberId: string, entreeId: string): Promise<void>;
  supprimer(tenantId: string, waId: string): Promise<void>;
}

/** Ce que ce module demande au client MBA (`src/mba/client.ts`). Les réponses sont lues par `safeParse`. */
export interface ClientListe {
  listAllowlist(phoneNumberId: string): Promise<unknown>;
  addToAllowlist(phoneNumberId: string, consumerPhoneNumber: string): Promise<unknown>;
  removeFromAllowlist(phoneNumberId: string, entryId: string): Promise<void>;
}

export interface DepsListe {
  store: ListeStore;
  /** Le client MBA de l'espace, demandé au moment du geste (jeton de l'espace, repli global). */
  clientMba(tenantId: string): Promise<ClientListe>;
  /**
   * Attendre, en millisecondes, entre deux tentatives de retrait. Injectée et requise : la durée d'attente est un
   * comportement observable, et un test doit pouvoir vérifier le plafond sans dormir.
   */
  attendre(ms: number): Promise<void>;
}

export interface ListeDeLAgent {
  /**
   * Met le contact sur la liste. Rien si notre table l'y a déjà (aucun appel). Sinon, dans l'ordre : l'ajout chez
   * Meta en E.164, puis la ligne. Rend `true` si le contact vient d'être ajouté, `false` s'il y était déjà. Lève si
   * Meta refuse, ou si la ligne n'a pas pu s'écrire (l'ajout est alors défait chez Meta).
   */
  ajouter(tenantId: string, phoneNumberId: string, waId: string): Promise<boolean>;
  /**
   * Retire le contact de la liste. `true` : il n'y est plus (retiré maintenant, absent de notre table sans aucun
   * appel, ou déjà absent chez Meta). `false` : Meta a refusé (ou son client est indisponible), journalisé, la ligne
   * reste. Un rejeu sur une erreur rejouable, jamais deux. Lève sur une panne de notre table : ce n'est pas un refus
   * de Meta, et le job ou la requête doit échouer pour se rejouer. Ne dépend pas de l'allumage de l'agent : une ligne
   * présente se retire même agent éteint, sinon l'agent répondrait à ce contact le jour où on le rallume.
   */
  retirer(tenantId: string, waId: string): Promise<boolean>;
  /** Les contacts de `waIds` présents sur la liste, en une lecture de notre table. */
  presents(tenantId: string, waIds: readonly string[]): Promise<Set<string>>;
  /**
   * Avant un modèle : retire le destinataire (numéro E.164 ou chiffres nus ; un BSUID n'est jamais sur la liste),
   * sous chacune des formes que Meta peut donner à son numéro (`formesDuNumero`) : la ligne porte le `wa_id` du
   * webhook, le destinataire vient de la fiche. Lève `RetraitDeLaListeRefuse`, que `classify` range en rejouable, si
   * le retrait est refusé : le modèle ne part pas, sinon l'agent répondrait à sa réponse.
   */
  retirerAvantUnModele(tenantId: string, destinataire: string): Promise<void>;
  /**
   * Retire chez Meta les entrées dont la purge d'un contact vient de supprimer la ligne. Au mieux : journalisé, ne
   * lève jamais. Le numéro d'un contact effacé n'a rien à faire chez Meta.
   */
  oublierChezMeta(tenantId: string, lignes: readonly LigneDeLaListe[]): Promise<void>;
}

/**
 * Le retrait d'un contact de la liste a été refusé avant un modèle : le modèle n'est pas parti. Une `MetaApiError`
 * en 503, donc rangée rejouable par `classify` et jamais prise pour un plafond du numéro (`estPlafondNumero`) :
 * le refus vise ce contact, pas le numéro. Le message est celui que l'Inbox affiche et que la campagne inscrit
 * sur le destinataire.
 */
export class RetraitDeLaListeRefuse extends MetaApiError {
  constructor() {
    // Sans le numéro : ce message s'inscrit sur le destinataire d'une campagne, que la purge RGPD ne réécrit pas.
    const message = 'retrait de la liste de l’agent de Meta refusé : le modèle n’est pas parti';
    super(503, {
      message,
      type: 'MbaListe',
      error_user_msg: 'Ce contact n’a pas pu être retiré de la liste de l’agent de Meta, le modèle n’est pas parti. Réessayez dans un instant.',
    });
    this.name = 'RetraitDeLaListeRefuse';
  }
}

/** Une entrée telle que Meta la rend (ajout, relecture). */
const entreeMeta = z.object({ id: z.string().min(1), consumer_phone_number: z.string().optional() });
/** La relecture : un tableau, ou `{ data: [...] }` comme d'autres listes de cette surface. */
const listeMeta = z.union([z.array(z.unknown()), z.object({ data: z.array(z.unknown()) })]);

/** Les chiffres d'un numéro, sans « + » ni séparateurs. */
const chiffresDe = (numero: string): string => numero.replace(/\D/g, '');

/**
 * Le destinataire d'un envoi ramené aux chiffres nus, ou `null` si ce n'est pas un numéro (BSUID) : les
 * séparateurs usuels d'un numéro sont retirés, rien d'autre, pour qu'un identifiant alphanumérique ne se réduise
 * jamais aux chiffres d'un numéro qui n'est pas le sien.
 */
export function numeroDuDestinataire(destinataire: string): string | null {
  const nu = destinataire.trim().replace(/[\s().+-]/g, '');
  return /^\d{1,15}$/.test(nu) ? nu : null;
}

/**
 * Les formes sous lesquelles Meta peut écrire le `wa_id` d'un même mobile, le numéro donné en tête. Au Brésil, un
 * compte créé avant l'ajout du 9 aux mobiles garde son `wa_id` sans lui (`55` + indicatif + 8 chiffres, contre 9
 * avec le 9) ; au Mexique, le `wa_id` d'un mobile garde le 1 que l'E.164 a perdu (`521` + 10 chiffres, contre `52`
 * + 10). Un modèle part vers le numéro de la fiche, la ligne de la liste porte le `wa_id` du webhook : sans ces
 * formes, le retrait avant un modèle ne verrait pas la ligne, et l'agent répondrait à la réponse du contact.
 * Seuls les mobiles brésiliens d'avant le 9 (premier chiffre de 6 à 9) sont concernés : un fixe n'a pas de variante.
 */
export function formesDuNumero(chiffres: string): string[] {
  const variantes: Array<[RegExp, string]> = [
    [/^55(\d{2})9([6-9]\d{7})$/, '55$1$2'],
    [/^55(\d{2})([6-9]\d{7})$/, '55$19$2'],
    [/^521(\d{10})$/, '52$1'],
    [/^52(\d{10})$/, '521$1'],
  ];
  const regle = variantes.find(([motif]) => motif.test(chiffres));
  return regle ? [chiffres, chiffres.replace(regle[0], regle[1])] : [chiffres];
}

export function creerListeDeLAgent(deps: DepsListe): ListeDeLAgent {
  const { store } = deps;

  /**
   * L'entrée de ce numéro dans une relecture de la liste de Meta, ou `null`. Meta répond au doublon d'ajout par un
   * 400 sans code qui le distingue d'un numéro invalide (mesuré le 2026-09-29) : seule la relecture tranche.
   */
  const retrouver = async (client: ClientListe, phoneNumberId: string, waId: string): Promise<string | null> => {
    const lu = listeMeta.safeParse(await client.listAllowlist(phoneNumberId));
    if (!lu.success) return null;
    const elements = Array.isArray(lu.data) ? lu.data : lu.data.data;
    for (const brut of elements) {
      const e = entreeMeta.safeParse(brut);
      if (e.success && e.data.consumer_phone_number !== undefined && chiffresDe(e.data.consumer_phone_number) === waId) return e.data.id;
    }
    return null;
  };

  /** Retire une entrée chez Meta, un rejeu sur une erreur rejouable. Un 404 vaut retrait. Lève le dernier refus. */
  const retirerChezMeta = async (client: ClientListe, entree: EntreeDeLaListe): Promise<void> => {
    for (let tentative = 0; ; tentative += 1) {
      try {
        await client.removeFromAllowlist(entree.phoneNumberId, entree.entreeId);
        return;
      } catch (err) {
        // Déjà absente chez Meta : c'est l'état voulu, et la ligne peut partir.
        if (err instanceof MetaApiError && err.httpStatus === 404) return;
        const rejouable = err instanceof MetaApiError && err.retryable;
        if (!rejouable || tentative >= REJEU_TENTATIVES - 1) throw err;
        await deps.attendre(Math.min(err.retryAfterMs ?? REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS));
      }
    }
  };

  const retirer = async (tenantId: string, waId: string): Promise<boolean> => {
    // Une panne de notre table lève, hors du `catch` : la déguiser en refus de Meta la cacherait, et l'appelant
    // traiterait comme définitif ce qu'un rejeu répare. Rejoué, un retrait déjà fait chez Meta rend 404, qui vaut retrait.
    const entree = await store.trouver(tenantId, waId);
    if (!entree) return true;
    try {
      await retirerChezMeta(await deps.clientMba(tenantId), entree);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`liste de l’agent de Meta : retrait REFUSÉ pour ${waId} (${tenantId}), le contact reste sur la liste :`, messageDe(err));
      return false;
    }
    await store.supprimer(tenantId, waId);
    return true;
  };

  return {
    async ajouter(tenantId, phoneNumberId, waId) {
      if (await store.trouver(tenantId, waId)) return false;
      const client = await deps.clientMba(tenantId);
      let entreeId: string | null = null;
      try {
        const lu = entreeMeta.safeParse(await client.addToAllowlist(phoneNumberId, `+${waId}`));
        if (lu.success) entreeId = lu.data.id;
      } catch (err) {
        // Seul un 400 peut être un doublon (le contact est déjà sur la liste chez Meta, pas chez nous).
        if (!(err instanceof MetaApiError && err.httpStatus === 400)) throw err;
        entreeId = await retrouver(client, phoneNumberId, waId);
        if (entreeId === null) throw err;
      }
      // Une réponse d'ajout illisible : l'entrée existe peut-être chez Meta, la relecture la retrouve.
      entreeId ??= await retrouver(client, phoneNumberId, waId);
      if (entreeId === null) throw new Error(`Meta n’a rendu aucun identifiant pour l’ajout de ${waId} à la liste de son agent`);
      try {
        await store.poser(tenantId, waId, phoneNumberId, entreeId);
      } catch (err) {
        // Sans ligne, plus rien ne retirerait ce contact : on défait l'ajout avant de relever l'erreur.
        await retirerChezMeta(client, { phoneNumberId, entreeId }).catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`liste de l’agent de Meta : ${waId} (${tenantId}) est sur la liste SANS ligne chez nous, le retrait de compensation a échoué :`, messageDe(e));
        });
        throw err;
      }
      return true;
    },

    retirer,

    presents: (tenantId, waIds) => store.presents(tenantId, waIds),

    async retirerAvantUnModele(tenantId, destinataire) {
      const waId = numeroDuDestinataire(destinataire);
      if (waId === null) return;
      // Une lecture pour toutes les formes du numéro, un retrait par ligne trouvée (presque toujours aucune).
      for (const forme of await store.presents(tenantId, formesDuNumero(waId))) {
        if (!(await retirer(tenantId, forme))) throw new RetraitDeLaListeRefuse();
      }
    },

    async oublierChezMeta(tenantId, lignes) {
      if (lignes.length === 0) return;
      let client: ClientListe;
      try {
        client = await deps.clientMba(tenantId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`liste de l’agent de Meta : ${lignes.length} contact(s) purgé(s) restent sur la liste (${tenantId}), client indisponible :`, messageDe(err));
        return;
      }
      for (const l of lignes) {
        try {
          await retirerChezMeta(client, l);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`liste de l’agent de Meta : l’entrée ${l.entreeId} d’un contact purgé reste chez Meta (${tenantId}) :`, messageDe(err));
        }
      }
    },
  };
}
