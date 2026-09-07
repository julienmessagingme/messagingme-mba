import type { Pool } from 'pg';
import { MOTIF_JETON } from './jeton';
import { compterParLien, type ConversationsDunLien } from './conversions';

/**
 * Une ligne de `channelsme_links`, telle que les routes et la console la lisent.
 *
 * 🔴 Pas de champ `enabled`, et ce n est pas un oubli : l etat allume ou eteint du lien EST le `enabled` de
 * son automation compagnon, seule source de verite. Poser un second drapeau ici creerait deux copies du
 * meme etat, qui divergeraient au premier chemin qui n ecrirait qu une des deux.
 */
export interface LienRow {
  id: string;
  tenantId: string;
  workflowId: string;
  startNodeId: string | null;
  token: string;
  phrase: string;
  automationId: string | null;
  /** Plafond horaire PROPRE a ce lien. null veut dire « plafond global de l instance », pas « zero ». */
  maxParHeure: number | null;
  createdAt: string;
  /**
   * L etat ALLUME de l automation compagnon, LU a chaque lecture, jamais ecrit ici.
   *
   * 🔴 Ce n est pas le second drapeau que la note ci-dessus interdit. La regle interdit de COPIER l etat
   * (deux colonnes qui divergent au premier chemin qui n en ecrit qu une) ; elle n interdit pas de le LIRE
   * a sa source. Sans ce champ, l etat n est lisible NULLE PART : l automation compagnon est possedee
   * (`possede_par = 'channelsme_link'`), donc exclue du predicat de `PgAutomationStore`, donc absente de
   * `GET /automations`. La console affichait deux boutons (allumer, eteindre) sans jamais pouvoir dire
   * lequel des deux avait un sens.
   *
   * `null` veut dire « ce lien n a plus d automation compagnon », le cas que `/enable` et `/disable`
   * refusent deja en 409. Ce n est PAS « eteint ».
   */
  enabled: boolean | null;
}

/** ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `LienRowBrut` et `versLien`. */
const COLS = 'id, tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure, created_at';

/**
 * Les memes colonnes prefixees `l.`, plus l etat allume lu sur l automation compagnon.
 *
 * La jointure porte la MEME garde miroir que `definirEtatAutomation` (`tenant_id` ET
 * `possede_par = 'channelsme_link'`) : on ne lit pas plus largement qu on n ecrit. Une automation qui ne
 * nous appartient pas ne joint pas, et `enabled` sort a `null` plutot que de reveler l etat d une ligne
 * d un autre proprietaire.
 */
const COLS_AVEC_ETAT = `${COLS.split(', ').map((c) => `l.${c}`).join(', ')}, a.enabled as enabled`;
const JOINTURE_ETAT =
  `left join automations a on a.id = l.automation_id and a.tenant_id = l.tenant_id and a.possede_par = 'channelsme_link'`;

/** Forme brute d une ligne `channelsme_links` (colonnes de COLS) telle que Postgres la rend. */
interface LienRowBrut {
  id: string;
  tenant_id: string;
  workflow_id: string;
  start_node_id: string | null;
  token: string;
  phrase: string;
  automation_id: string | null;
  max_par_heure: number | null;
  created_at: Date;
  /** Absent des lignes rendues par `create` (aucune jointure a l insertion) : voir `versLien`. */
  enabled?: boolean | null;
}

function versLien(r: LienRowBrut): LienRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workflowId: r.workflow_id,
    startNodeId: r.start_node_id,
    token: r.token,
    phrase: r.phrase,
    automationId: r.automation_id,
    maxParHeure: r.max_par_heure,
    createdAt: r.created_at.toISOString(),
    // `?? null` couvre le seul cas ou la colonne est absente de la ligne brute : aucun aujourd hui, les
    // trois requetes de ce store la rendent. C est un filet pour une 4e requete qui l oublierait, et il
    // retombe alors sur `null`, c est-a-dire « on ne sait pas », jamais sur `false`, qui serait une
    // affirmation. Postgres rend deja `null` quand la sous-requete ou la jointure ne trouve rien.
    enabled: r.enabled ?? null,
  };
}

/**
 * Les liens de chaine d un tenant : un jeton, une phrase, un scenario, et l automation compagnon qui les
 * relie.
 *
 * Ce store ne sait ni allumer ni eteindre un lien : cet etat vit sur l automation, pas ici. Il ne sait pas
 * non plus repointer un lien vers un autre scenario, ce qui est une decision produit et pas une lacune (un
 * autre scenario veut un autre lien, donc un autre jeton, donc une autre mesure de conversion).
 */
/**
 * Combien de messages entrants RECENTS on regarde pour juger si une phrase est trop banale.
 *
 * ⚠️ C'est une borne de COUT, pas un seuil semantique, et il faut le dire : le controle repond a « cette
 * phrase apparait-elle dans la conversation ordinaire », et en examiner davantage ne changerait pas la
 * decision qu'il alimente. Une phrase vue il y a deux ans et jamais depuis n'est pas un risque vivant.
 *
 * Mesure du 2026-09-07 : `conversation_messages` contenait 221 lignes, donc le controle est aujourd'hui
 * gratuit. Cette borne existe pour qu'il le reste quand la table aura grossi, sans avoir a poser un index
 * trigramme sur le corps des messages du chemin chaud pour une garde qui ne sert qu'a la creation d'un lien.
 */
const MESSAGES_EXAMINES = 2000;

/**
 * Combien de messages entrants on relit pour COMPTER les conversations demarrees par les boutons.
 *
 * ⚠️ CE N'EST PAS `MESSAGES_EXAMINES`, ET LES DEUX BORNES NE REPONDENT PAS A LA MEME QUESTION. Celle-la
 * borne une GARDE (« cette phrase est-elle banale ? »), a laquelle en regarder plus ne changerait rien.
 * Celle-ci borne une MESURE affichee a un client : la tronquer rend un chiffre FAUX, pas approximatif.
 * D'ou le plafond plus haut, et surtout le drapeau `partiel` rendu avec le resultat, pour que l'ecran
 * puisse dire « au moins N » au lieu d'annoncer un total qu'il n'a pas.
 *
 * Mesure du 2026-09-07 sur la base de production : 89 messages entrants WhatsApp au total. Le plafond est
 * donc tres loin d'etre atteint aujourd'hui ; il existe pour que la lecture reste bornee quand la table
 * aura grossi.
 */
const MESSAGES_CONVERSIONS = 20_000;

export class PgChannelsMeLinkStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les phrases des liens de ce tenant, telles qu'elles sont stockees.
   *
   * 🔴 LA COMPARAISON SE FAIT EN JS, avec `normalizeText`, exactement celle qui decide de la correspondance
   * d'un message. La faire en SQL obligerait a la reecrire (`lower(btrim(...))` ne retire pas les accents, et
   * `unaccent` n'est pas installe ni immuable, donc inutilisable dans un index), et deux definitions de « la
   * meme phrase » divergeraient au premier accent. La table est petite par nature : quelques liens par
   * espace, un par post publie.
   */
  async phrasesDesLiens(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ phrase: string }>(
      // Pas de `limit` : un plafond sans `order by` rendrait un sous-ensemble ARBITRAIRE au-dela du
      // plafond, donc une garde qui se degrade en silence. La table est petite par nature, c'est
      // precisement l'argument qui autorise la comparaison en JS.
      'select phrase from channelsme_links where tenant_id = $1',
      [tenantId],
    );
    return res.rows.map((r) => r.phrase);
  }

  /**
   * Les conversations demarrees par CHAQUE bouton de chaine de ce tenant.
   *
   * 🔴 LE COMPTAGE SE FAIT EN JS, avec `normalizeText`, pour la meme raison que `phrasesDesLiens` : c'est
   * la seule definition de « ce message correspond a cette phrase », et c'est celle dont le moteur se sert
   * pour declencher. En SQL il aurait fallu la reecrire, et un compteur qui compte autrement que ce qui
   * declenche est pire que pas de compteur.
   *
   * 🔴 LA LECTURE EST BORNEE PAR LA DATE DU PLUS ANCIEN LIEN DE L'ESPACE. Aucun bouton n'a pu produire de
   * conversation avant d'exister, donc cette borne ne peut RIEN perdre, et elle retire tout l'historique
   * anterieur au premier lien.
   *
   * ⚠️ Elle est volontairement LARGE : c'est le plus ancien lien de l'espace, pas la date de CHAQUE lien.
   * Un lien recent relit donc des messages anterieurs a sa propre creation. C'est sans effet sur son compte
   * (ces messages ne peuvent pas contenir sa phrase, l'unicite de phrase etant garantie par la migration
   * 0116 et par la garde de creation), et une borne par lien couterait une requete par lien.
   *
   * ⚠️ `not c.is_test` EXCLUT DEFINITIVEMENT un contact qui a servi une fois de cible de test. Il n'y a
   * qu'UN fil par contact (unicite `(tenant_id, wa_id)`, migration 0058) et `is_test` n'est jamais remis a
   * false (migration 0053, qui le dit). Un vrai abonne sur lequel on a testé un scenario est donc absent du
   * compte, pour toujours. C'est le compromis retenu : compter notre propre trafic de test gonflerait le
   * chiffre de tous les liens, alors que ce trou-la ne touche que les quelques numeros qui nous servent
   * d'essai.
   *
   * `partiel` dit que le plafond a ete atteint, donc que les chiffres sont des MINIMUMS. Un ecran qui
   * afficherait un total tronque sans le dire mentirait.
   */
  async conversationsParLien(tenantId: string): Promise<{ parLien: ConversationsDunLien[]; partiel: boolean }> {
    const liens = await this.pool.query<{ id: string; phrase: string }>(
      'select id, phrase from channelsme_links where tenant_id = $1',
      [tenantId],
    );
    if (liens.rowCount === 0) return { parLien: [], partiel: false };

    const messages = await this.pool.query<{ wa_id: string; body: string }>(
      `select c.wa_id, m.body
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1
          and not c.is_test
          and m.direction = 'in'
          and m.channel = 'whatsapp'
          and m.body is not null
          and m.created_at >= (select min(created_at) from channelsme_links where tenant_id = $1)
        order by m.created_at desc
        limit $2`,
      [tenantId, MESSAGES_CONVERSIONS],
    );
    return {
      parLien: compterParLien(
        liens.rows,
        messages.rows.map((r) => ({ waId: r.wa_id, body: r.body })),
      ),
      partiel: messages.rowCount === MESSAGES_CONVERSIONS,
    };
  }

  /**
   * Combien des messages entrants RECENTS de ce tenant contiennent deja cette phrase.
   *
   * 🔴 CE CONTROLE REMPLACE UN SEUIL DE LONGUEUR INVENTE. Le danger d'une phrase n'est pas d'etre courte,
   * c'est d'apparaitre dans la conversation ordinaire : « Bonjour » declencherait sur tout. On le COMPTE au
   * lieu de le deviner.
   *
   * ⚠️ La comparaison SQL est `lower(...) like` : elle ignore la casse, pas les accents. C'est volontairement
   * plus PERMISSIF que `normalizeText` (elle laissera passer une phrase qui ne differe que par un accent
   * d'un message existant). Une garde qui rate un cas rare est acceptable ; une garde qui refuse a tort la
   * phrase d'un client ne l'est pas.
   */
  async messagesContenantLaPhrase(tenantId: string, phrase: string): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from (
         select m.body from conversation_messages m
           join conversations c on c.id = m.conversation_id
          where c.tenant_id = $1 and m.direction = 'in'
            -- 🔴 UNE FENETRE, EN PLUS DU PLAFOND. Le plafond seul s'applique APRES le tri de tous les
            -- entrants du tenant : quand la table grossira, le cout sera le TRI, pas la comparaison. La
            -- fenetre borne ce que le tri doit regarder. Elle borne aussi le SENS de la mesure : une phrase
            -- vue il y a deux ans et jamais depuis n'est pas un risque vivant.
            and m.created_at > now() - interval '90 days'
            -- Et on ecarte les messages qui portent un jeton de lien : ce sont des CLICS, pas de la
            -- conversation ordinaire. Sans ca, la garde compterait le succes du lien contre lui-meme.
            and m.body !~ $4
          order by m.created_at desc
          limit $3
       ) recents
       -- 🔴 strpos, PAS like. Un like traite les caracteres pourcent et souligne comme des JOKERS : la
       -- phrase « Je veux mes -20% » deviendrait un motif qui matche des messages ne la contenant pas, et
       -- la garde refuserait alors la phrase d'un client en lui annoncant un nombre FAUX. Une garde qui
       -- rate un cas rare est acceptable, une garde qui accuse a tort ne l'est pas.
       -- ⚠️ Aucun accent grave dans ce bloc : il vit dans un litteral de gabarit TypeScript, ou un accent
       -- grave termine la chaine. Deja rencontre deux fois dans ce depot.
       where strpos(lower(recents.body), lower($2)) > 0`,
      [tenantId, phrase, MESSAGES_EXAMINES, MOTIF_JETON],
    );
    return res.rows[0]?.n ?? 0;
  }

  /**
   * ⚠️ `automationId` est fourni A LA CREATION, il ne se pose pas apres coup : l automation compagnon se cree
   * AVANT le lien (elle ne reference pas le lien, elle porte juste sa marque de possession), donc son id est
   * deja connu quand on arrive ici.
   */
  async create(
    tenantId: string,
    l: {
      workflowId: string;
      startNodeId: string | null;
      token: string;
      phrase: string;
      automationId: string | null;
      maxParHeure: number | null;
    },
  ): Promise<LienRow> {
    // 🔴 LE `returning` LIT L ETAT DE L AUTOMATION COMPAGNON, il ne le suppose pas. Sans cette sous-requete,
    // `enabled` sortait a `null` pour un lien qui vient pourtant d en recevoir une (creee ETEINTE juste
    // avant par la route) : or `null` veut dire « plus d automation compagnon », donc la reponse de
    // POST /links affirmait le contraire de la verite, et l ecran ne marquait pas le lien neuf comme eteint.
    // Meme garde miroir que partout ailleurs dans ce store (tenant_id ET possede_par), et aucune requete de
    // plus : on ne relit jamais en 2e requete ce que l INSERT peut rendre.
    const { rows } = await this.pool.query<LienRowBrut>(
      `insert into channelsme_links
         (tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning ${COLS},
         (select a.enabled from automations a
           where a.id = $6 and a.tenant_id = $1 and a.possede_par = 'channelsme_link') as enabled`,
      [tenantId, l.workflowId, l.startNodeId, l.token, l.phrase, l.automationId, l.maxParHeure],
    );
    return versLien(rows[0]!);
  }

  /** 🔴 `order by created_at desc` : c est l ordre de l index channelsme_links_tenant_idx (tenant_id, created_at desc). */
  async list(tenantId: string): Promise<LienRow[]> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `select ${COLS_AVEC_ETAT} from channelsme_links l ${JOINTURE_ETAT}
         where l.tenant_id=$1 order by l.created_at desc`,
      [tenantId],
    );
    return rows.map(versLien);
  }

  async byId(tenantId: string, id: string): Promise<LienRow | null> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `select ${COLS_AVEC_ETAT} from channelsme_links l ${JOINTURE_ETAT}
         where l.tenant_id=$1 and l.id=$2`,
      [tenantId, id],
    );
    return rows[0] ? versLien(rows[0]) : null;
  }

  /**
   * Allume l automation compagnon de ce lien : chemin appele a la publication d un post (une chaine qui
   * publie doit se mettre a repondre a son jeton).
   *
   * 🔴 CE STORE ECRIT SA PROPRE REQUETE sur `automations`, il ne passe PAS par `PgAutomationStore`. Cette
   * classe exclut de `update`/`remove` toute ligne dont `possede_par` n est pas nul (meme patron que
   * `HORS_WEBHOOK` pour les webhooks entrants) : une automation possedee par un lien de chaine lui est donc
   * devenue INACCESSIBLE en ecriture depuis ce store-la, y compris pour l allumer. Le proprietaire ecrit ses
   * propres requetes, comme `PgWebhookStore.syncAutomation` le fait deja pour les siennes.
   *
   * La clause `possede_par = 'channelsme_link'` est une GARDE MIROIR : elle interdit a ce store de toucher
   * une automation qui ne lui appartient pas, exactement comme le predicat de `PgAutomationStore` interdit a
   * l ecran Automation de toucher les siennes. C est ce qui rend la frontiere etanche dans les deux sens, pas
   * seulement le fait que `PgAutomationStore` regarde ailleurs.
   */
  async allumerAutomation(tenantId: string, linkId: string): Promise<void> {
    await this.definirEtatAutomation(tenantId, linkId, true);
  }

  /** Eteint l automation compagnon. Meme garde que `allumerAutomation`, voir sa note. */
  async eteindreAutomation(tenantId: string, linkId: string): Promise<void> {
    await this.definirEtatAutomation(tenantId, linkId, false);
  }

  /**
   * Defait l automation compagnon qu on vient de creer, quand la creation du LIEN cense la referencer echoue
   * juste apres (POST /links, `src/http/channels-me.ts`) : sans ce rattrapage, l automation reste, POSSEDEE
   * (`possede_par = 'channelsme_link'`), donc exclue du predicat de `PgAutomationStore` (invisible et
   * inaccessible depuis l ecran Automation) SANS qu aucun lien ne la reference jamais. Une orpheline que
   * personne ne peut plus voir ni supprimer.
   *
   * Meme garde miroir que `allumerAutomation`/`eteindreAutomation` : bornee par `tenant_id` ET par
   * `possede_par = 'channelsme_link'`, pour ne jamais pouvoir toucher une automation qui ne serait pas la
   * notre. Idempotent et sans effet si l id ne correspond a rien (id deja rattrape, ou jamais possede par un
   * lien de chaine) : ce n est jamais une raison d echouer davantage.
   */
  async supprimerAutomationCompagnon(tenantId: string, automationId: string): Promise<void> {
    await this.pool.query(
      `delete from automations where tenant_id = $1 and id = $2 and possede_par = 'channelsme_link'`,
      [tenantId, automationId],
    );
  }

  /**
   * Partagee par `allumerAutomation` et `eteindreAutomation` : la sous-requete resout l automation compagnon
   * du lien, scopee tenant, et la mise a jour porte ELLE-MEME `tenant_id` ET `possede_par` en garde. Si le
   * lien n existe pas pour ce tenant, ou si son automation compagnon n est pas possedee par channelsme_link
   * (jamais cense arriver, mais pas suppose), la requete touche zero ligne, silencieusement : appeler cette
   * methode n est jamais une raison d echouer la publication qui l a declenchee.
   */
  private async definirEtatAutomation(tenantId: string, linkId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `update automations
          set enabled = $3, updated_at = now()
        where tenant_id = $1
          and possede_par = 'channelsme_link'
          and id = (select automation_id from channelsme_links where tenant_id = $1 and id = $2)`,
      [tenantId, linkId, enabled],
    );
  }
}
