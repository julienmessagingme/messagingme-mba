import type { Pool } from 'pg';
import { MOTIF_JETON } from './jeton';
import { compterParLien, type ConversationsDunLien } from './conversions';
import { MOTIF_ETIQUETTE_WIDGET, PREFIXE_ETIQUETTE_WIDGET } from '../widgets/arrivee';

/**
 * Une ligne de `channelsme_links`, telle que les routes et la console la lisent. Pas de champ `enabled`
 * stocké : l'état allumé du lien est le `enabled` de son automation compagnon, seule source de vérité ; une
 * copie ici divergerait au premier chemin qui n'écrirait qu'une des deux.
 */
export interface LienRow {
  id: string;
  tenantId: string;
  workflowId: string;
  startNodeId: string | null;
  token: string;
  phrase: string;
  automationId: string | null;
  /** Plafond horaire propre à ce lien. null = plafond global de l'instance, pas « zéro ». */
  maxParHeure: number | null;
  createdAt: string;
  /**
   * L'état allumé de l'automation compagnon, lu à sa source à chaque lecture, jamais copié. Sans lui l'état
   * n'est lisible nulle part : l'automation possédée est exclue de `GET /automations`. `null` = ce lien n'a
   * plus d'automation compagnon (ce que `/enable` et `/disable` refusent en 409), pas « éteint ».
   */
  enabled: boolean | null;
}

/** Liste tenue à la main : une colonne ajoutée ici doit l'être aussi dans `LienRowBrut` et `versLien`. */
const COLS = 'id, tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure, created_at';

/**
 * Les mêmes colonnes préfixées `l.`, plus l'état lu sur l'automation compagnon. 🔴 La jointure porte la même
 * garde miroir que `definirEtatAutomation` (`tenant_id` et `possede_par = 'channelsme_link'`) : on ne lit pas
 * plus largement qu'on n'écrit, et une automation d'un autre propriétaire ne joint pas.
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
    // `?? null` : filet pour une requête qui oublierait la colonne, qui retombe sur « on ne sait pas », jamais
    // sur `false`, qui serait une affirmation.
    enabled: r.enabled ?? null,
  };
}

/**
 * Combien de messages entrants récents on regarde pour juger si une phrase est trop banale : une borne de
 * coût, pas un seuil sémantique. Elle garde le contrôle gratuit quand la table grossit, sans index trigramme
 * sur le corps des messages pour une garde qui ne sert qu'à la création d'un lien.
 */
const MESSAGES_EXAMINES = 2000;

/**
 * Combien de messages entrants on relit pour compter ce que les boutons ont produit. Pas la même question
 * que `MESSAGES_EXAMINES` : celle-ci borne une mesure affichée à un client, où tronquer rend un chiffre faux.
 * D'où un plafond plus haut, et le drapeau `partiel`, pour que l'écran dise « au moins N ».
 */
const MESSAGES_CONVERSIONS = 20_000;

export class PgChannelsMeLinkStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les phrases des liens de ce tenant, telles qu'elles sont stockées. La comparaison se fait en JS avec
   * `normalizeText`, celle qui décide de la correspondance d'un message (en SQL, `lower` ne retire pas les
   * accents et `unaccent` n'est pas installé). La table est petite par nature : quelques liens par espace.
   */
  async phrasesDesLiens(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ phrase: string }>(
      // Pas de `limit` : un plafond sans `order by` rendrait un sous-ensemble arbitraire, une garde qui se dégrade
      // en silence.
      'select phrase from channelsme_links where tenant_id = $1',
      [tenantId],
    );
    return res.rows.map((r) => r.phrase);
  }

  /**
   * Ce que chaque bouton de chaîne de ce tenant a produit, compté en JS avec `normalizeText` (même raison que
   * `phrasesDesLiens` : un compteur qui compte autrement que ce qui déclenche est pire que pas de compteur).
   *
   * La lecture est bornée par la date du plus ancien lien de l'espace : elle ne perd rien, mais peut inclure
   * des messages antérieurs à la création d'un bouton donné (un abonné qui a écrit la phrase spontanément). Une
   * borne par lien coûterait une requête par lien ; l'écran dit qu'on compte des messages reçus.
   *
   * `not c.is_test` exclut pour toujours un contact qui a servi de cible de test (`is_test` n'est jamais remis
   * à false) : compter notre trafic de test gonflerait tous les liens. `partiel` dit que le plafond a été
   * atteint, donc que les chiffres sont des minimums.
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
   * Combien des messages entrants récents de ce tenant contiennent déjà cette phrase. Le danger d'une phrase
   * n'est pas d'être courte, c'est d'apparaître dans la conversation ordinaire (« Bonjour » déclencherait sur
   * tout) : on le compte. La comparaison ignore la casse, pas les accents : plus permissive que
   * `normalizeText`, parce qu'une garde qui refuse à tort la phrase d'un client est pire que celle qui rate un
   * cas rare.
   *
   * `horsArriveesDeWidget` : la garde d'un WIDGET (`gestionDesWidgetsEnBase`) écarte en plus les arrivées par un
   * widget, qui sont son propre succès et non de la conversation ordinaire. Sans elle, recréer un widget avec la
   * phrase d'un widget supprimé, raccourcir une phrase qui a servi ou retirer sa ponctuation finale était refusé à
   * cause des visiteurs que la bulle avait amenés. 🔴 Absente (le contrôle d'un lien de chaîne), la requête rend
   * EXACTEMENT ce qu'elle rendait : la condition ajoutée vaut vrai dès que le drapeau est faux.
   *
   * 🔴 UNE ARRIVÉE, PAS UN CONTACT ARRIVÉ, et c'est la règle qui compte. L'étiquette `widget-<code>` est posée sur
   * le contact dont un message contient la phrase d'un widget actif (`creerArriveeParWidget`). Écarter TOUS les
   * messages de ces contacts aveuglerait la garde sur un espace dont les contacts viennent surtout de ses bulles :
   * leur « Bonjour » de tous les jours est justement de la conversation ordinaire, et un widget « Bonjour » y
   * capterait tout. Un message n'est donc écarté que s'il est l'arrivée elle-même : son contact porte l'étiquette
   * d'un widget de l'espace ET le message contient la phrase ACTUELLE de ce widget. Un widget SUPPRIMÉ a perdu sa
   * phrase : les messages de ses contacts qui contiennent la phrase examinée sont alors présumés être ses
   * arrivées. C'est la seule imprécision de la règle, bornée aux contacts d'un widget supprimé et aux messages qui
   * contiennent la phrase examinée. Une étiquette se reconnaît à sa forme exacte (`MOTIF_ETIQUETTE_WIDGET`), pas à
   * son préfixe, sinon « widget-salon » posée à la main passerait pour un widget supprimé.
   */
  async messagesContenantLaPhrase(
    tenantId: string, phrase: string, options: { horsArriveesDeWidget?: boolean } = {},
  ): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from (
         select m.body, c.contact_id from conversation_messages m
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
       where strpos(lower(recents.body), lower($2)) > 0
         -- Les arrivees par un widget, quand la garde est celle d'un widget ($5) : la regle et sa raison sont
         -- dans le commentaire de la methode. Posee APRES la coupe, donc sur les seuls messages qui contiennent
         -- la phrase : la sous-requete ne tourne pas sur les deux mille derniers messages de l'espace. Faux, le
         -- drapeau rend toute la condition vraie, et la requete compte ce qu'elle comptait.
         and not ($5::boolean and exists (
           select 1
             from contacts ct
             cross join lateral unnest(ct.tags) as e(etiquette)
             left join widgets w
               on w.tenant_id = $1 and w.code = substr(e.etiquette, char_length($7::text) + 1)
            where ct.id = recents.contact_id
              and ct.tenant_id = $1
              and e.etiquette ~ $6
              -- un widget supprime (aucune ligne) a perdu sa phrase ; un widget present n'a amene que les
              -- messages qui contiennent la sienne
              and (w.id is null or strpos(lower(recents.body), lower(w.phrase)) > 0)
         ))`,
      [
        tenantId, phrase, MESSAGES_EXAMINES, MOTIF_JETON,
        options.horsArriveesDeWidget === true, MOTIF_ETIQUETTE_WIDGET, PREFIXE_ETIQUETTE_WIDGET,
      ],
    );
    return res.rows[0]?.n ?? 0;
  }

  /**
   * `automationId` est fourni à la création : l'automation compagnon se crée avant le lien (elle porte sa
   * marque de possession, pas de référence au lien), son id est donc connu ici.
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
    // Le `returning` lit l'état de l'automation compagnon (créée éteinte juste avant par la route) au lieu de le
    // supposer : sans lui `enabled` sortirait `null`, « plus d'automation », le contraire de la vérité. Même
    // garde miroir que partout ailleurs dans ce store.
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

  /** `order by created_at desc` : l'ordre de l'index `channelsme_links_tenant_idx` (tenant_id, created_at desc). */
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
   * Allume l'automation compagnon de ce lien, à la publication d'un post. Ce store écrit sa propre requête sur
   * `automations` : `PgAutomationStore` exclut toute ligne dont `possede_par` n'est pas nul. La clause
   * `possede_par = 'channelsme_link'` est une garde miroir : ce store ne touche qu'aux automations qui lui
   * appartiennent, comme l'écran Automation ne touche pas aux siennes.
   */
  async allumerAutomation(tenantId: string, linkId: string): Promise<void> {
    await this.definirEtatAutomation(tenantId, linkId, true);
  }

  /** Éteint l'automation compagnon. Même garde que `allumerAutomation`. */
  async eteindreAutomation(tenantId: string, linkId: string): Promise<void> {
    await this.definirEtatAutomation(tenantId, linkId, false);
  }

  /**
   * Défait l'automation compagnon qu'on vient de créer quand la création du lien échoue juste après (POST
   * /links) : sinon elle resterait possédée, invisible de l'écran Automation, sans lien qui la référence, et
   * personne ne pourrait la supprimer. Même garde miroir ; idempotent, et sans effet si l'id ne correspond à
   * rien.
   */
  async supprimerAutomationCompagnon(tenantId: string, automationId: string): Promise<void> {
    await this.pool.query(
      `delete from automations where tenant_id = $1 and id = $2 and possede_par = 'channelsme_link'`,
      [tenantId, automationId],
    );
  }

  /**
   * Partagée par `allumerAutomation` et `eteindreAutomation` : la sous-requête résout l'automation compagnon
   * du lien, scopée tenant, et la mise à jour porte elle-même `tenant_id` et `possede_par`. Sinon, zéro ligne
   * touchée en silence : ce n'est jamais une raison d'échouer la publication.
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
