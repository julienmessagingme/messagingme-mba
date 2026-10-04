/**
 * LA transition du consentement WhatsApp d'une fiche, écrite une fois : qui peut lever un STOP, ce que deviennent le
 * statut, la date du désabonnement (`opt_out_at`) et la source (`opt_in_source`), et quelles fiches sont réellement
 * PASSÉES à `opted_out`, donc à annoncer au système du client.
 *
 * Les six écritures de `PgContactStore` qui posent un consentement la composent, quelle que soit la forme de leur
 * requête ; aucune ne réécrit un `case` de consentement. Elle a existé en six copies dont deux ont réabonné un contact
 * qui avait dit STOP (738a7c3d). Plan : `docs/superpowers/plans/2026-10-03-transition-consentement.md`.
 *
 * Trois règles, décidées par Julien le 2026-10-03 :
 * 1. 🔴 **Un statut inchangé ne réécrit RIEN**, partout : ni la date (elle répond à « depuis quand ? »), ni la source
 *    (relue pour pousser le signal, `completerSignal`, elle dit le canal du STOP ; un outil qui renvoie le même
 *    consentement ne remplace pas la preuve d'origine), ni `updated_at` quand l'écriture ne porte que le consentement.
 *    Et rien ne s'annonce : un seul STOP, une seule annonce.
 * 2. 🔴 **Un STOP (`opted_out` vers `opted_in`) ne se lève que par une autorité de `LEVE_UN_STOP`.** Ailleurs il est
 *    gardé ENTIER : statut, date et source du refus.
 * 3. `unknown` n'est jamais une destination : il veut dire « rien n'a jamais été enregistré », le réécrire après coup
 *    falsifierait le registre. Seule une création le pose.
 *
 * Ce qui ne passe PAS par ici : le STOP RCS (`rcs_optout_at`), le blocage, la purge (qui garde ce qui dit non), et
 * `upsertFromInbound`, qui ne crée qu'en `unknown` et ne touche jamais au consentement d'une fiche existante.
 * ⚠️ Aucun chemin ne CRÉE une fiche `opted_out` (mesuré le 2026-10-03), et seuls les types l'empêchent :
 * `ContactUpsert` et `LotContacts` ne demandent que `opted_in` ou `unknown`. La branche `insert` d'un upsert écrit le
 * statut et la source demandés mais jamais `opt_out_at` : une fiche créée `opted_out` par là n'aurait PAS de date.
 * L'API publique crée en `unknown` (`creerFicheApi`) puis écrit le consentement par `ecrireConsentementParId`, qui
 * passe par ici : la date est posée, et le passage s'annonce au système du client (décision de Julien du 2026-10-03).
 */

/** Les trois statuts de `contacts.opt_in_status` (CHECK de 0001). */
export type StatutConsentement = 'unknown' | 'opted_in' | 'opted_out';
const STATUTS: readonly StatutConsentement[] = ['unknown', 'opted_in', 'opted_out'];

/**
 * QUI écrit le consentement : une valeur par appelant, jamais une chaîne libre. Une écriture dont l'autorité varie
 * l'exige de son appelant (`setOptInByWaId`, `upsertManyByPhone`) ; les autres portent la leur.
 */
export type AutoriteConsentement =
  /** La fiche contact de la console : un opérateur devant la personne (`applyEdits`). */
  | 'fiche'
  /** L'action en masse du mini-CRM (`applyEditsMany`). */
  | 'action_en_masse'
  /** L'import CSV, case « opt-in » cochée : l'opérateur l'affirme pour tout le fichier (`upsertManyByPhone`). */
  | 'import_csv_coche'
  /** L'import CSV sans la case, et l'import d'une liste HubSpot (`upsertManyByPhone`). */
  | 'import'
  /** Le webhook entrant (un outil tiers) et la création à la main dans la console (`upsertByPhoneReturningId`). */
  | 'webhook_ou_saisie'
  /** La personne elle-même : son mot STOP, ou un formulaire WhatsApp coché (`setOptInByWaId`, `markOptedIn`). */
  | 'personne'
  /** Le bloc « Action » d'un scénario (`setOptInByWaId`). */
  | 'scenario'
  /** L'API publique (`ecrireConsentementParId`), qui rend alors `refuse`. */
  | 'api';

/**
 * 🔴 LA TABLE « qui peut lever un STOP ». Oui : un opérateur devant la fiche, l'opérateur qui coche la case d'un
 * import CSV (décision du 2026-09-26), la personne, et le bloc « Action » d'un scénario. Non : l'action en masse
 * (décision du 2026-10-03 : un geste sur une liste ne doit pas annuler en série des refus exprimés un par un),
 * l'import sans case et HubSpot (une liste qui contenait quelqu'un qui avait dit STOP le réabonnait), le webhook
 * entrant et la création à la main, et l'API publique (une synchronisation périmée réabonnerait quelqu'un).
 */
export const LEVE_UN_STOP = {
  fiche: true,
  import_csv_coche: true,
  personne: true,
  scenario: true,
  action_en_masse: false,
  import: false,
  webhook_ou_saisie: false,
  api: false,
} as const satisfies Record<AutoriteConsentement, boolean>;

/** Les autorités d'un import par lot : la case cochée, ou non. */
export type AutoriteImport = Extract<AutoriteConsentement, 'import_csv_coche' | 'import'>;
/** Les autorités d'un upsert, qui ne demande jamais que `opted_in` ou `unknown`. */
export type AutoriteUpsert = AutoriteImport | 'webhook_ou_saisie';
/** Les autorités d'une écriture par `wa_id`. */
export type AutoriteParWaId = Extract<AutoriteConsentement, 'personne' | 'scenario'>;

/** Ce que l'écriture fait d'une fiche : écrire le statut voulu, ne rien toucher, ou garder un STOP. */
export type IssueDeLaTransition = 'ecrit' | 'inchange' | 'stop_garde';

/**
 * LA règle, en TypeScript. Le SQL plus bas en est DÉPLIÉ (`couples`), jamais réécrit à la main : la règle ne vit
 * qu'ici, et ses neuf cas par autorité se testent sans base.
 */
export function issueDeLaTransition(
  avant: StatutConsentement,
  voulu: StatutConsentement,
  autorite: AutoriteConsentement,
): IssueDeLaTransition {
  if (voulu === 'unknown' || voulu === avant) return 'inchange';
  if (avant === 'opted_out' && !LEVE_UN_STOP[autorite]) return 'stop_garde';
  return 'ecrit';
}

/**
 * Ce qu'une écriture demande, en SQL : le statut voulu et la source à écrire s'il change. Deux expressions TYPÉES
 * (`$3::text`, `excluded.opt_in_status`) : un paramètre nu peut ne pas se typer dans un `case`. Une source `null`
 * garde la source actuelle (`coalesce`).
 */
export interface DemandeConsentement {
  voulu: string;
  source: string;
  autorite: AutoriteConsentement;
}

/**
 * Où lire l'état d'AVANT l'écriture : `''` dans un `update` (une affectation lit la ligne d'avant), `contacts.` dans
 * un `on conflict do update` (la ligne existante y porte ce nom), `avant.` dans la copie verrouillée de
 * `ecritureDuConsentement`.
 */
export type LigneDAvant = '' | 'contacts.' | 'avant.';

/** Les couples (statut d'avant, statut voulu) que `garder` retient, en SQL : la règle dépliée sur ses neuf cas. */
function couples(ligne: LigneDAvant, voulu: string, garder: (avant: StatutConsentement, voulu: StatutConsentement) => boolean): string {
  const liste = STATUTS.flatMap((a) => STATUTS.filter((v) => garder(a, v)).map((v) => `('${a}', '${v}')`));
  return liste.length === 0 ? 'false' : `((${ligne}opt_in_status, ${voulu}) in (${liste.join(', ')}))`;
}

/** Les fragments de la transition, lus sur la ligne d'avant nommée par `ligne`. Exportée pour ses tests. */
export function transition(ligne: LigneDAvant, d: DemandeConsentement): {
  /** Le statut change : la SEULE condition à laquelle statut, date et source s'écrivent. */
  change: string;
  /** La fiche passe à `opted_out` par cette écriture : l'annonce part pour elle, et pour elle seule. */
  passe: string;
  /** Un STOP gardé : `opted_in` demandé sur une fiche `opted_out`, par une autorité qui ne le lève pas. */
  garde: string;
  /** Les trois affectations, chacune gardée par `change`, à poser dans un `set` qui peut écrire autre chose. */
  affectations: string;
} {
  const issue = (a: StatutConsentement, v: StatutConsentement): IssueDeLaTransition => issueDeLaTransition(a, v, d.autorite);
  const change = couples(ligne, d.voulu, (a, v) => issue(a, v) === 'ecrit');
  return {
    change,
    passe: couples(ligne, d.voulu, (a, v) => issue(a, v) === 'ecrit' && v === 'opted_out'),
    garde: couples(ligne, d.voulu, (a, v) => issue(a, v) === 'stop_garde'),
    // La date suit le statut (0138) : posée au passage à `opted_out`, remise à null au passage à `opted_in`. Les trois
    // affectations lisent l'état d'avant : leur ordre est indifférent.
    affectations: [
      `opt_in_status = case when ${change} then ${d.voulu} else ${ligne}opt_in_status end`,
      `opt_out_at = case when ${change} then (case when ${d.voulu} = 'opted_out' then now() end) else ${ligne}opt_out_at end`,
      `opt_in_source = case when ${change} then coalesce(${d.source}, ${ligne}opt_in_source) else ${ligne}opt_in_source end`,
    ].join(',\n         '),
  };
}

/**
 * Les affectations du consentement d'un upsert (`insert ... on conflict do update`), demande lue dans `excluded`.
 * Le nom, les champs et les étiquettes s'y écrivent quand même : la transition ne garde que le consentement. Un upsert
 * ne demande jamais `opted_out` (types `ContactUpsert` et `LotContacts`), il n'a donc rien à annoncer.
 */
export function affectationsDUpsert(autorite: AutoriteUpsert): string {
  return transition('contacts.', { voulu: 'excluded.opt_in_status', source: 'excluded.opt_in_source', autorite }).affectations;
}

/** Une fiche ciblée par `ecritureDuConsentement` en rendu `par_fiche`. */
export interface FicheDeLEcriture {
  id: string;
  phone_e164: string | null;
  bsuid: string | null;
  /** L'écriture l'a touchée : son statut a changé (ou, avec `autres`, une autre colonne s'est écrite). */
  ecrite: boolean;
  /** Elle est passée à `opted_out` : à annoncer, APRÈS le `commit`. */
  passe: boolean;
  /** Son STOP a été gardé. */
  garde: boolean;
}

/** Le rendu `compte` : une seule ligne, quel que soit le nombre de fiches (une action en masse en vise des milliers). */
export interface CompteDeLEcriture {
  ecrites: number;
  gardes: number;
  /** Les identités des seules fiches passées à `opted_out`, à annoncer. */
  passes: Array<{ phone_e164: string | null; bsuid: string | null }>;
}

/**
 * L'instruction qui écrit le consentement des fiches que désigne `cible`, en UNE instruction :
 * - `avant` lit l'état d'avant SOUS VERROU (`for update`) : deux STOP simultanés liraient sinon tous deux « abonné » et
 *   annonceraient deux fois. Le second attend le verrou, relit `opted_out`, et ne passe plus ;
 * - `ecrit` n'écrit que si le statut change (`change` dans son `where`) : un statut en place ne bouge ni sa date, ni sa
 *   source, ni `updated_at`. Avec `autres` (action en masse qui pose aussi une étiquette ou un champ), toute fiche
 *   ciblée s'écrit, et le consentement reste gardé par les `case` de `affectations` ;
 * - le `select` final dit, pour chaque fiche ciblée, si elle a été écrite, si elle est passée à `opted_out` et si son
 *   STOP a été gardé, lus sur la copie verrouillée : exactement l'état que l'écriture a vu.
 *
 * `cible` est la fin d'un `select ... from contacts` (son `where`, et son `order by ... limit` s'il en a) : elle porte
 * le filtre d'espace, et `deleted_at is null` quand l'écriture en a besoin. Ses paramètres sont ceux de l'appelant.
 * `espace` est celui de ces paramètres qui porte l'espace (`$1` ici, `$2` là : c'est l'appelant qui numérote).
 * 🔴 `ecrit` le repose, alors qu'elle ne vise que des fiches de `avant`, déjà filtrées : sans lui, Postgres ne sert
 * pas l'index d'espace sur une masse large, et l'écriture ne tient plus l'isolation que par `cible`. Typé `$<n>` : on
 * y passe une référence de paramètre, jamais une valeur recopiée dans le SQL.
 * L'annonce n'est pas faite ici : elle part APRÈS le `commit`, jamais dedans (un `rollback` l'annulerait).
 */
export function ecritureDuConsentement(o: DemandeConsentement & {
  cible: string;
  espace: `$${number}`;
  autres?: readonly string[];
  rendu: 'par_fiche' | 'compte';
}): string {
  const ecr = transition('', o);
  const av = transition('avant.', o);
  const autres = o.autres ?? [];
  const avec = `with avant as (
         select id, opt_in_status, phone_e164, bsuid from contacts ${o.cible}
         for update
       ),
       ecrit as (
         update contacts set ${[...autres, ecr.affectations, 'updated_at = now()'].join(',\n         ')}
          where tenant_id = ${o.espace} and id in (select id from avant)${autres.length === 0 ? ` and ${ecr.change}` : ''}
         returning id
       )`;
  const depuis = 'from avant left join ecrit on ecrit.id = avant.id';
  if (o.rendu === 'par_fiche') {
    return `${avec}
       select avant.id, avant.phone_e164, avant.bsuid, ecrit.id is not null as ecrite,
              ${av.passe} as passe, ${av.garde} as garde
         ${depuis}`;
  }
  // Une ligne, pas une par fiche : remonter chaque fiche d'une action en masse serait un coût d'egress invisible.
  return `${avec}
       select count(ecrit.id)::int as ecrites,
              (count(*) filter (where ${av.garde}))::int as gardes,
              coalesce(json_agg(json_build_object('phone_e164', avant.phone_e164, 'bsuid', avant.bsuid))
                         filter (where ${av.passe}), '[]'::json) as passes
         ${depuis}`;
}
