import type { Pool } from 'pg';
import type { DateRange } from '../stats/range';
import { STATS_TZ, BOUNDS_CTE } from '../stats/range';
import { valeursDeLaFiche } from './champs-url';

/**
 * Liens de redirection tracés : la destination d'origine d'un bouton URL, et les clics qu'il a reçus.
 * Cette table est la seule mémoire de la destination d'origine : chez Meta, c'est notre lien qui figure.
 */

/** Le bouton visé, dans la numérotation de Meta. `cardIndex` non nul = bouton d'une carte de carousel. */
export interface CibleLien {
  templateName: string;
  templateLanguage: string;
  cardIndex: number | null;
  buttonIndex: number;
}

export interface LienTrace extends CibleLien {
  code: string;
  destination: string;
  /**
   * L'URL soumise à Meta porte-t-elle le suffixe variable qui fait voyager le jeton du destinataire ?
   * Cette colonne seule dit à l'envoi s'il doit fournir un composant de bouton : se tromper fait échouer l'appel
   * dans les deux sens (132000). `false` pour les liens dont l'adresse figée chez Meta n'en porte pas.
   */
  avecJeton: boolean;
}

/** Ce qu'il faut pour rediriger : où aller, et pour quel espace compter. */
export interface DestinationLien {
  tenantId: string;
  destination: string;
}

export class PgTrackedLinkStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Réserve (ou retrouve) le code d'un bouton et enregistre sa destination ; rend le code à mettre dans l'URL.
   * Ré-appelée sur le même bouton (template recréé ou resoumis), elle garde le code et met à jour la
   * destination : les messages déjà livrés suivent la nouvelle cible au lieu de pointer une ligne orpheline.
   */
  async allocate(tenantId: string, code: string, cible: CibleLien, destination: string, avecJeton: boolean): Promise<string> {
    const res = await this.pool.query<{ code: string }>(
      // `confirmed_at = null` à chaque réservation : une resoumission n'est confirmée que si Meta l'accepte à
      // son tour, sinon un template resoumis puis refusé garderait la confirmation précédente.
      // `avec_jeton`, décidé par l'appelant, est la seule source de vérité pour l'envoi (131008 si le composant
      // manque, 132000 s'il est fourni sans variable). Un bouton de carte de carousel n'est pas adressable par le
      // constructeur de composants : il ne reçoit jamais de `{{1}}` (règle dans `src/http/templates.ts`).
      `insert into tracked_links (code, tenant_id, template_name, template_language, card_index, button_index, destination, avec_jeton)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tenant_id, template_name, template_language, coalesce(card_index, -1), button_index)
         where template_name is not null
         do update set destination = excluded.destination, confirmed_at = null, avec_jeton = excluded.avec_jeton
       returning code`,
      [code, tenantId, cible.templateName, cible.templateLanguage, cible.cardIndex, cible.buttonIndex, destination, avecJeton],
    );
    return res.rows[0]!.code;
  }

  /**
   * Réserve (ou retrouve) le code d'une adresse tracée en RCS ; rend le code à mettre dans l'URL envoyée.
   *
   * Clé sur la destination, pas sur un bouton (0107) : un message RCS est composé à l'envoi, il faut seulement
   * un code stable par adresse. `confirmed_at` est posé tout de suite : aucun accord de Meta à attendre.
   * `do update` plutôt que `do nothing` pour garantir le `returning code` : sans lui, une adresse déjà connue ne
   * rendrait aucune ligne et le message partirait non mesuré, en silence.
   */
  async allocateRcs(tenantId: string, code: string, destination: string): Promise<string> {
    const res = await this.pool.query<{ code: string }>(
      `insert into tracked_links (code, tenant_id, template_name, template_language, card_index, button_index, destination, avec_jeton, confirmed_at)
       values ($1, $2, null, null, null, null, $3, true, now())
       on conflict (tenant_id, destination) where template_name is null
         do update set confirmed_at = coalesce(tracked_links.confirmed_at, now())
       returning code`,
      [code, tenantId, destination],
    );
    return res.rows[0]!.code;
  }

  /**
   * Confirme les liens d'un template accepté par Meta. Tant que ce n'est pas fait, les mesures ignorent ces
   * liens (cf. `confirmed_at` dans la migration 0066).
   */
  async confirm(tenantId: string, codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return;
    await this.pool.query(
      `update tracked_links set confirmed_at = now() where tenant_id = $1 and code = any($2::text[])`,
      [tenantId, [...new Set(codes)]],
    );
  }

  /**
   * Ces liens ne décrivent plus ce que Meta porte (bouton retiré ou déplacé par une édition, adresse soumise sans
   * traçage) : les mesures et l'envoi les ignorent. 🔴 La ligne reste, et son code continue de rediriger : une
   * adresse `/r/<code>` déjà envoyée doit résoudre pour toujours.
   */
  async deconfirmer(tenantId: string, codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return;
    await this.pool.query(
      `update tracked_links set confirmed_at = null where tenant_id = $1 and code = any($2::text[])`,
      [tenantId, [...new Set(codes)]],
    );
  }

  /**
   * Destination d'un code, pour la redirection publique. Le code arrive d'une URL : normalisé en minuscules.
   * Ne filtre pas sur `confirmed_at` : si notre confirmation a échoué, le lien circule déjà dans des messages
   * livrés, et un lien qui marche sans être mesuré vaut mieux qu'un lien mort.
   */
  async getByCode(code: string): Promise<DestinationLien | null> {
    const res = await this.pool.query<{ tenant_id: string; destination: string }>(
      `select tenant_id, destination from tracked_links where code = lower($1)`,
      [code],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, destination: r.destination } : null;
  }

  /**
   * Enregistre un clic, en best-effort : un échec ne doit jamais empêcher la redirection.
   * `contactId` = qui a cliqué, `null` quand l'URL ne portait pas de jeton (adresse figée chez Meta) : compter
   * ces clics sans savoir qui vaut mieux que ne pas les compter.
   */
  async recordClick(code: string, tenantId: string, contactId?: string | null): Promise<void> {
    await this.pool.query(
      `insert into tracked_link_clicks (code, tenant_id, contact_id) values (lower($1), $2, $3)`,
      [code, tenantId, contactId ?? null],
    );
  }

  /**
   * Résout un jeton public en identifiant de contact, dans un espace donné.
   *
   * 🔴 `tenant_id = $1` bien que le jeton soit unique globalement : l'espace vient du lien cliqué, et sans ce
   * filtre un jeton d'un autre client se verrait attribuer ce clic.
   * La purge efface le jeton d'un contact anonymisé : ses clics futurs redeviennent anonymes (droit à
   * l'effacement).
   */
  async contactParJeton(tenantId: string, jeton: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and jeton_public = $2`,
      [tenantId, jeton],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Les valeurs qu'un contact offre à l'adresse d'un bouton à champs (`valeursDeLaFiche`), retrouvé par son jeton
   * public. `null` = aucun contact actif de cet espace ne porte ce jeton.
   *
   * 🔴 `tenant_id = $1`, l'espace du LIEN cliqué, jamais un espace venu de l'URL : sans ce filtre, le jeton d'un
   * contact d'un autre client ferait écrire SA fiche dans l'adresse. Une fiche supprimée (`deleted_at`) ne prête
   * plus ses valeurs ; une fiche purgée n'a plus de jeton.
   */
  async champsParJeton(tenantId: string, jeton: string): Promise<Record<string, string | null> | null> {
    const res = await this.pool.query<{ profile_name: string | null; phone_e164: string | null; fields: Record<string, unknown> | null }>(
      `select profile_name, phone_e164, fields from contacts
        where tenant_id = $1 and jeton_public = $2 and deleted_at is null`,
      [tenantId, jeton],
    );
    const r = res.rows[0];
    return r ? valeursDeLaFiche(r) : null;
  }

  /**
   * Le jeton public de ces contacts, fabriqué pour ceux qui n'en ont pas encore.
   *
   * Posé à l'envoi, pas à la création du contact : pas d'identifiant pour qui ne reçoit jamais de lien tracé.
   * Une collision de deux envois simultanés est absorbée, et la relecture rend le jeton du gagnant. Un contact
   * absent de la map part avec un lien anonyme : dégrader vaut mieux que faire échouer un envoi.
   */
  async jetonsPourContacts(tenantId: string, contactIds: readonly string[], fabriquer: () => string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (contactIds.length === 0) return out;

    const manquants = await this.pool.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and id = any($2::uuid[]) and jeton_public is null`,
      [tenantId, [...contactIds]],
    );
    if (manquants.rowCount && manquants.rowCount > 0) {
      // Un seul énoncé pour tous : une requête par contact rendrait le coût proportionnel à la campagne.
      const paires = manquants.rows.map((r) => [r.id, fabriquer()] as const);
      await this.pool.query(
        `update contacts as c set jeton_public = v.jeton
           from (select * from unnest($2::uuid[], $3::text[]) as t(id, jeton)) as v
          where c.id = v.id and c.tenant_id = $1 and c.jeton_public is null`,
        [tenantId, paires.map((p) => p[0]), paires.map((p) => p[1])],
      ).catch(() => { /* collision d'unicité : la relecture ci-dessous rendra le jeton du gagnant */ });
    }

    const res = await this.pool.query<{ id: string; jeton_public: string | null }>(
      `select id, jeton_public from contacts where tenant_id = $1 and id = any($2::uuid[])`,
      [tenantId, [...contactIds]],
    );
    for (const r of res.rows) if (r.jeton_public) out.set(r.id, r.jeton_public);
    return out;
  }

  /**
   * Le jeton public du contact qui porte ce numéro, fabriqué s'il n'en a pas encore : le pendant unitaire de
   * `jetonsPourContacts`, pour les chemins qui envoient à une personne à la fois et connaissent un numéro.
   *
   * Les deux formes de stockage du numéro passent par `in ($2, $3)` et non par une fonction sur la colonne, qui
   * rendrait inutilisable l'index unique (tenant_id, phone_e164). Même leçon que `isOptedOut`.
   * `null` = numéro inconnu : le lien part anonyme plutôt que l'envoi n'échoue.
   */
  async jetonPourE164(tenantId: string, e164: string, fabriquer: () => string): Promise<string | null> {
    const nu = e164.replace(/[^0-9]/g, '');
    const lire = async (): Promise<{ id: string; jeton: string | null } | null> => {
      const res = await this.pool.query<{ id: string; jeton_public: string | null }>(
        `select id, jeton_public from contacts where tenant_id = $1 and phone_e164 in ($2, $3) limit 1`,
        [tenantId, `+${nu}`, nu],
      );
      const r = res.rows[0];
      return r ? { id: r.id, jeton: r.jeton_public } : null;
    };

    const contact = await lire();
    if (!contact) return null;
    if (contact.jeton) return contact.jeton;

    // `jeton_public is null` dans le WHERE : de deux envois simultanés, le second n'écrase pas le premier (les
    // clics des messages déjà partis avec l'ancien deviendraient anonymes) ; la relecture rend le gagnant.
    const pose = await this.pool.query<{ jeton_public: string }>(
      `update contacts set jeton_public = $3
        where id = $2 and tenant_id = $1 and jeton_public is null
       returning jeton_public`,
      [tenantId, contact.id, fabriquer()],
    ).catch(() => null); // collision d'unicité globale : la relecture ci-dessous tranche
    const gagne = pose?.rows[0]?.jeton_public;
    if (gagne) return gagne;
    return (await lire())?.jeton ?? null;
  }

  /**
   * Les liens tracés de ces templates, pour ré-habiller l'affichage et savoir quels boutons sont mesurables.
   * Liste vide : aucune requête.
   */
  async listByTemplates(tenantId: string, noms: readonly string[]): Promise<LienTrace[]> {
    if (noms.length === 0) return [];
    const res = await this.pool.query<{
      code: string; template_name: string; template_language: string; card_index: number | null; button_index: number; destination: string; avec_jeton: boolean;
    }>(
      // Confirmés seulement : une ligne dont Meta a refusé le template ne décrit aucun lien réel, et sa mesure
      // resterait à zéro pour toujours.
      `select code, template_name, template_language, card_index, button_index, destination, avec_jeton
         from tracked_links
        where tenant_id = $1 and template_name = any($2::text[]) and confirmed_at is not null`,
      [tenantId, [...new Set(noms)]],
    );
    return res.rows.map((r) => ({
      code: r.code,
      avecJeton: r.avec_jeton,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      cardIndex: r.card_index,
      buttonIndex: r.button_index,
      destination: r.destination,
    }));
  }

  /**
   * Les codes des liens RCS de ces adresses (`adresse -> code`), pour les mesures. Une adresse absente n'a
   * jamais été envoyée (le code naît au premier envoi) : l'appelant l'affiche à zéro, ce qui est exact.
   */
  async codesRcsParDestination(tenantId: string, destinations: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (destinations.length === 0) return out;
    const res = await this.pool.query<{ code: string; destination: string }>(
      `select code, destination from tracked_links
        where tenant_id = $1 and template_name is null and destination = any($2::text[])`,
      [tenantId, [...new Set(destinations)]],
    );
    for (const r of res.rows) out.set(r.destination, r.code);
    return out;
  }

  /**
   * Les clics d'une campagne sur des codes donnés, séparés en attribués et anonymes.
   *
   * Un lien dont l'URL porte le jeton du destinataire sait qui a cliqué (`tracked_link_clicks.contact_id`).
   * L'attribution est celle des envois et des événements de bloc : la dernière campagne scénario réclamée pour
   * ce numéro avant le clic (une autre heuristique donnerait une troisième vérité).
   * Les clics sans jeton (URL figée chez Meta) sont comptés à part en `anonymes`, bornés au premier
   * `claimed_at` de la campagne ; ils ne sont pas pour autant les siens, et l'écran ne le prétend pas.
   */
  async clicsAttribuesCampagne(
    tenantId: string, campaignId: string, codes: readonly string[],
  ): Promise<{ attribues: Record<string, number>; anonymes: number }> {
    if (codes.length === 0) return { attribues: {}, anonymes: 0 };
    const res = await this.pool.query<{ code: string; attribues: string; anonymes: string }>(
      `with debut as (
         select min(coalesce(r.claimed_at, r.sent_at)) as le
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = $2 and r.sent_at is not null
       ),
       clics as (
         select k.code as code, k.at as at, k.contact_id as contact_id,
                regexp_replace(ct.phone_e164, '[^0-9]', '', 'g') as wa
           from tracked_link_clicks k
           left join contacts ct on ct.id = k.contact_id and ct.tenant_id = $1, debut d
          where k.tenant_id = $1 and k.code = any($3::text[])
            and d.le is not null and k.at >= d.le
       )
       select code,
              count(*) filter (
                where wa is not null and $2::uuid = (
                  select r3.campaign_id
                    from campaign_recipients r3 join campaigns c3 on c3.id = r3.campaign_id
                   where c3.tenant_id = $1 and c3.workflow_id is not null and r3.sent_at is not null
                     and coalesce(r3.claimed_at, r3.sent_at) <= clics.at
                     and clics.wa = regexp_replace(r3.to_e164, '[^0-9]', '', 'g')
                   order by coalesce(r3.claimed_at, r3.sent_at) desc
                   limit 1
                )
              )::int as attribues,
              count(*) filter (where contact_id is null)::int as anonymes
         from clics group by code`,
      [tenantId, campaignId, [...new Set(codes)]],
    );
    const attribues: Record<string, number> = {};
    let anonymes = 0;
    for (const r of res.rows) {
      attribues[r.code] = Number(r.attribues);
      anonymes += Number(r.anonymes);
    }
    return { attribues, anonymes };
  }

  /**
   * Clics par code sur la plage (bornes Europe/Paris, `to` inclus), pour les codes demandés. Ne rend que les
   * codes qui ont au moins un clic : c'est l'appelant qui sait quels codes existent et affiche zéro.
   */
  async countClicks(tenantId: string, codes: readonly string[], range: DateRange): Promise<Record<string, number>> {
    if (codes.length === 0) return {};
    const res = await this.pool.query<{ code: string; n: string }>(
      `with ${BOUNDS_CTE}
       select c.code, count(*)::int as n
         from tracked_link_clicks c, bounds b
        where c.tenant_id = $1 and c.code = any($5::text[])
          and c.at >= b.start_ts and c.at < b.end_ts
        group by c.code`,
      [tenantId, range.from, range.to, STATS_TZ, [...new Set(codes)]],
    );
    const out: Record<string, number> = {};
    for (const r of res.rows) out[r.code] = Number(r.n);
    return out;
  }

  /**
   * Purge les clics plus vieux que la rétention.
   *
   * 🔴 Les clics, jamais les liens : `tracked_links` est une porte à sens unique. Une adresse `/r/<code>`
   * envoyée circule dans des messages livrés, et supprimer sa ligne casserait ces liens définitivement.
   * Rétention longue, pour garder les mesures d'une année sur l'autre.
   */
  async purgeClicsOlderThan(days: number, maxParPassage = 50_000): Promise<number> {
    if (days <= 0) return 0;
    const res = await this.pool.query(
      `delete from tracked_link_clicks
        where id in (select id from tracked_link_clicks where at < now() - make_interval(days => $1) limit $2)`,
      [Math.floor(days), Math.max(1, maxParPassage)],
    );
    return res.rowCount ?? 0;
  }
}
