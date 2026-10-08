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
 *
 * 🔴 LA LISTE TOURNE (2026-10-08). Meta la plafonne à 20 contacts par numéro, documenté le 2026-09-18 (page
 * agent-allowlist : « up to 20 allowlisted consumer phone numbers », 400 au-delà). Sans rotation, le 21e contact
 * confié était refusé, et l'agent ne prenait plus personne. Quand la liste du numéro est pleine, le contact dont la
 * conversation est la MOINS RÉCEMMENT ACTIVE sort avant l'ajout (`PLAFOND_LISTE`, `ListeStore.moinsActive`). S'il
 * réécrit, son message arrive en `standby` hors liste, la remise le confie de nouveau, et un autre sort à sa place.
 * C'est un pont : la cible est le routage de Meta (Conversation Routing), que nous ne pouvons pas encore régler.
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
  /**
   * Les contacts de la liste de l'espace, par `waId` croissant, strictement après `apres` (`null` = depuis le début),
   * au plus `limite`. Une pagination par clé et pas par rang : un contact qu'on n'a pas pu retirer reste sur la liste,
   * et une page par rang le rendrait à chaque tour.
   */
  lister(tenantId: string, apres: string | null, limite: number): Promise<string[]>;
  /**
   * Le contact de la liste de ce numéro dont la conversation est la moins récemment active (son dernier message,
   * sinon son entrée sur la liste, le plus tardif des deux), avec la taille de la liste du numéro dans cet espace.
   * `null` si l'espace n'a aucun contact sur la liste de ce numéro.
   */
  moinsActive(tenantId: string, phoneNumberId: string): Promise<{ waId: string; taille: number } | null>;
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
   * Met le contact sur la liste. Rien si notre table l'y a déjà (aucun appel). Sinon, dans l'ordre : la place (si la
   * liste du numéro est pleine, le contact le moins actif en sort), l'ajout chez Meta en E.164, puis la ligne. Si Meta
   * dit la liste pleine alors que notre table ne l'était pas, un autre contact sort et l'ajout est tenté UNE fois de
   * plus. Rend `true` si le contact vient d'être ajouté, `false` s'il y était déjà. Lève si Meta refuse, ou si la
   * ligne n'a pas pu s'écrire (l'ajout est alors défait chez Meta).
   *
   * `faireDeLaPlace` est REQUIS, et chaque appelant dit s'il a le droit de faire sortir quelqu'un. Faux pour le
   * balayage, qui confie en rafale des fils inactifs : il ferait sortir les contacts qui parlent à l'agent au profit
   * de contacts endormis, et brûlerait le quota de Meta, partagé par tous les espaces. Liste pleine sans ce droit, ou
   * pour un identifiant qui n'est pas un numéro (refusé par Meta à chaque ajout) : `ListePleine`, sans aucun appel.
   */
  ajouter(tenantId: string, phoneNumberId: string, waId: string, o: { faireDeLaPlace: boolean }): Promise<boolean>;
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
  /**
   * Retire TOUS les contacts de la liste de l'espace, par paquets (`PAQUET_LISTE`), chacun par `retirer` (un rejeu,
   * jamais deux). Un refus de Meta est journalisé par `retirer` et n'arrête pas les autres : le contact reste sur la
   * liste, compté dans `refuses`. Sert la désignation d'un agent IA répondeur (`src/repondeur/reglage.ts`) : sans elle,
   * Meta continuerait de ranger en `standby` les messages des contacts qu'il croyait encore tenir. Lève sur une panne
   * de notre table, comme `retirer`.
   */
  toutRetirer(tenantId: string): Promise<{ retires: number; refuses: number }>;
}

/** La taille d'un paquet de `toutRetirer` : une lecture de la table par paquet, un geste chez Meta par contact. */
export const PAQUET_LISTE = 100;

/**
 * Le nombre de contacts que Meta accepte sur la liste d'un numéro (page agent-allowlist, documenté le 2026-09-18).
 * Meta prévient que ce plafond peut changer. S'il monte, on garde 20 places sans rien casser. S'il baisse, l'ajout
 * au-delà est refusé (400) et remonte comme un refus, comme avant la rotation : la constante est à baisser. Le
 * détail de ce 400 « reports the current maximum » d'après la doc, sous une forme jamais mesurée, donc pas lue.
 */
export const PLAFOND_LISTE = 20;

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

/**
 * La liste du numéro est pleine, et ce geste n'a pas le droit d'en faire sortir quelqu'un (`ajouter`, option
 * `faireDeLaPlace`), ou le contact n'est pas un numéro. Aucun appel à Meta n'a été fait.
 */
export class ListePleine extends Error {
  constructor() {
    super('liste de l’agent de Meta pleine : personne n’en sort pour ce geste');
    this.name = 'ListePleine';
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
   * Une relecture de la liste de Meta : l'entrée de ce numéro (`null` si absente), et le nombre d'entrées du numéro.
   * Meta répond au doublon d'ajout comme à la liste pleine par un 400 sans code qui les distingue d'un numéro
   * invalide (mesuré le 2026-09-29 pour le doublon) : seule la relecture tranche. Illisible, elle vaut liste vide.
   */
  const relire = async (client: ClientListe, phoneNumberId: string, waId: string): Promise<{ entreeId: string | null; taille: number }> => {
    const lu = listeMeta.safeParse(await client.listAllowlist(phoneNumberId));
    if (!lu.success) return { entreeId: null, taille: 0 };
    const elements = Array.isArray(lu.data) ? lu.data : lu.data.data;
    for (const brut of elements) {
      const e = entreeMeta.safeParse(brut);
      if (e.success && e.data.consumer_phone_number !== undefined && chiffresDe(e.data.consumer_phone_number) === waId) {
        return { entreeId: e.data.id, taille: elements.length };
      }
    }
    return { entreeId: null, taille: elements.length };
  };

  /**
   * L'ajout chez Meta : l'identifiant de l'entrée, ou `pleine` (avec le refus de Meta) si la liste du numéro est au
   * plafond sans ce contact. Lève sur tout autre refus, et sur une réponse sans identifiant que la relecture ne
   * retrouve pas.
   */
  const ajouterChezMeta = async (client: ClientListe, phoneNumberId: string, waId: string): Promise<{ entreeId: string } | { pleine: unknown }> => {
    try {
      const lu = entreeMeta.safeParse(await client.addToAllowlist(phoneNumberId, `+${waId}`));
      if (lu.success) return { entreeId: lu.data.id };
    } catch (err) {
      // Seul un 400 peut être un doublon (le contact est déjà sur la liste chez Meta, pas chez nous) ou une liste pleine.
      if (!(err instanceof MetaApiError && err.httpStatus === 400)) throw err;
      const relu = await relire(client, phoneNumberId, waId);
      if (relu.entreeId !== null) return { entreeId: relu.entreeId };
      if (relu.taille >= PLAFOND_LISTE) return { pleine: err };
      throw err;
    }
    // Une réponse d'ajout illisible : l'entrée existe peut-être chez Meta, la relecture la retrouve.
    const relu = await relire(client, phoneNumberId, waId);
    if (relu.entreeId !== null) return { entreeId: relu.entreeId };
    throw new Error(`Meta n’a rendu aucun identifiant pour l’ajout de ${waId} à la liste de son agent`);
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

  /** Fait sortir un contact pour faire place à un autre, et le journalise : c'est la seule trace d'une rotation. */
  const faireSortir = async (tenantId: string, sortant: string, entrant: string): Promise<boolean> => {
    const ok = await retirer(tenantId, sortant);
    // eslint-disable-next-line no-console
    console.info(`liste de l’agent de Meta pleine (${tenantId}) : ${sortant} ${ok ? 'sort' : 'n’a pas pu sortir'} pour faire place à ${entrant}`);
    return ok;
  };

  return {
    async ajouter(tenantId, phoneNumberId, waId, o) {
      if (await store.trouver(tenantId, waId)) return false;
      // Un identifiant qui n'est pas un numéro (BSUID) est refusé par Meta à chaque ajout : faire sortir quelqu'un pour
      // lui couperait l'agent à un contact valide, sans rien gagner.
      const peutFaireSortir = o.faireDeLaPlace && numeroDuDestinataire(waId) !== null;
      // La liste du numéro est pleine dans notre table : le moins actif sort AVANT l'ajout, ou rien ne part du tout.
      // Un retrait refusé n'arrête rien : l'ajout dira si Meta a encore de la place.
      const avant = await store.moinsActive(tenantId, phoneNumberId);
      if (avant && avant.taille >= PLAFOND_LISTE) {
        if (!peutFaireSortir) throw new ListePleine();
        await faireSortir(tenantId, avant.waId, waId);
      }
      const client = await deps.clientMba(tenantId);
      let ajout = await ajouterChezMeta(client, phoneNumberId, waId);
      if ('pleine' in ajout) {
        // Meta la dit pleine, notre table ne l'était pas (un ajout concurrent, une entrée posée hors de nous) : un
        // contact de plus sort, et UN seul nouvel essai. Rien à faire sortir, ou un second refus : le refus remonte.
        if (!peutFaireSortir) throw ajout.pleine;
        const suivant = await store.moinsActive(tenantId, phoneNumberId);
        if (!suivant || !(await faireSortir(tenantId, suivant.waId, waId))) throw ajout.pleine;
        ajout = await ajouterChezMeta(client, phoneNumberId, waId);
        if ('pleine' in ajout) throw ajout.pleine;
      }
      const { entreeId } = ajout;
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

    async toutRetirer(tenantId) {
      let retires = 0;
      let refuses = 0;
      let apres: string | null = null;
      for (;;) {
        const paquet: string[] = await store.lister(tenantId, apres, PAQUET_LISTE);
        for (const waId of paquet) {
          if (await retirer(tenantId, waId)) retires += 1;
          else refuses += 1;
        }
        if (paquet.length < PAQUET_LISTE) return { retires, refuses };
        apres = paquet[paquet.length - 1] ?? null;
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
