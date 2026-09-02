import type { Pool } from 'pg';
import type { DateRange } from '../stats/range';
import { STATS_TZ, BOUNDS_CTE } from '../stats/range';

/**
 * Liens de redirection tracés : la destination d'origine d'un bouton URL, et les clics qu'il a reçus.
 *
 * ⚠️ Cette table est la SEULE mémoire de la destination d'origine. Une fois le template approuvé chez Meta,
 * c'est notre lien qui y figure, et le lien du client n'existe plus nulle part ailleurs.
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
   *
   * 🔴 C'est cette colonne, et elle seule, qui dit à l'ENVOI s'il doit fournir un composant de bouton. Se
   * tromper fait échouer l'appel dans les DEUX sens (132000) : un composant pour une URL sans variable, comme
   * une variable sans composant. `false` pour tous les liens d'avant le 2026-09-02, dont l'adresse est figée
   * chez Meta et ne pourra jamais en porter.
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
   * Réserve (ou retrouve) le code d'un bouton et enregistre sa destination. Rend le code à mettre dans l'URL
   * soumise à Meta.
   *
   * Ré-appelée sur le MÊME bouton (template supprimé puis recréé sous le même nom, template resoumis), elle
   * garde le code et met à jour la destination : les messages déjà livrés continuent de fonctionner et
   * suivent la nouvelle cible. Attribuer un nouveau code les aurait laissés pointer une ligne orpheline.
   */
  async allocate(tenantId: string, code: string, cible: CibleLien, destination: string): Promise<string> {
    const res = await this.pool.query<{ code: string }>(
      // `confirmed_at = null` remis à chaque réservation : une nouvelle soumission n'est confirmée que si
      // Meta l'accepte à son tour. Sans cette remise à zéro, un template resoumis puis refusé garderait la
      // confirmation de sa version précédente.
      // `avec_jeton = true` : depuis le 2026-09-02, tout lien RESERVE ici porte le suffixe variable qui fera
      // voyager le jeton du destinataire. C est cette colonne, et elle seule, qui dit a l ENVOI s il doit
      // fournir un composant de bouton : la deduire de la date de creation serait une regle qui se casse au
      // premier retard de deploiement, et se tromper dans un sens comme dans l autre fait echouer l envoi
      // avec un 132000.
      `insert into tracked_links (code, tenant_id, template_name, template_language, card_index, button_index, destination, avec_jeton)
       values ($1, $2, $3, $4, $5, $6, $7, true)
       on conflict (tenant_id, template_name, template_language, coalesce(card_index, -1), button_index)
         where template_name is not null
         do update set destination = excluded.destination, confirmed_at = null, avec_jeton = true
       returning code`,
      [code, tenantId, cible.templateName, cible.templateLanguage, cible.cardIndex, cible.buttonIndex, destination],
    );
    return res.rows[0]!.code;
  }

  /**
   * Réserve (ou retrouve) le code d'une ADRESSE tracée en RCS. Rend le code à mettre dans l'URL envoyée.
   *
   * 🔴 CLÉ SUR LA DESTINATION, PAS SUR UN BOUTON (migration 0107). Un message RCS n'est soumis à personne : il
   * est composé à l'envoi, donc il n'y a aucune réservation à rendre idempotente, seulement un code stable par
   * adresse. Le raisonnement complet est en tête de la 0107.
   *
   * `confirmed_at` posé TOUT DE SUITE, contrairement au chemin WhatsApp : là-bas la confirmation attend
   * l'accord de Meta, parce qu'un template refusé ne portera jamais notre lien. Ici il n'y a personne à
   * attendre : le lien part dans le message qui suit immédiatement cet appel.
   *
   * `do update` sur un conflit plutôt que `do nothing` : c'est ce qui garantit le `returning code` dans les
   * deux cas. Sans lui, un envoi sur une adresse déjà connue ne rendrait aucune ligne, et le message partirait
   * avec son adresse d'origine, non mesuré, sans que rien ne le dise.
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
   * Confirme les liens d'un template : Meta l'a accepté, il porte donc bien nos adresses. Tant que ce n'est
   * pas fait, les mesures ignorent ces liens (cf. le commentaire de `confirmed_at` dans la migration 0066).
   */
  async confirm(tenantId: string, codes: readonly string[]): Promise<void> {
    if (codes.length === 0) return;
    await this.pool.query(
      `update tracked_links set confirmed_at = now() where tenant_id = $1 and code = any($2::text[])`,
      [tenantId, [...new Set(codes)]],
    );
  }

  /**
   * Destination d'un code, pour la redirection publique. Le code arrive d'une URL : on le normalise en
   * minuscules plutôt que de faire confiance à la casse tapée (ou recopiée) par un client.
   *
   * ⚠️ Ne filtre PAS sur `confirmed_at`, et c'est VOLONTAIRE : si Meta a accepté le template mais que notre
   * confirmation a échoué, le lien circule déjà dans des messages livrés. Un lien qui marche sans être
   * mesuré vaut mieux qu'un lien mort proprement comptabilisé.
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
   * Enregistre un clic. Appelée en BEST-EFFORT : un échec ne doit jamais empêcher la redirection.
   *
   * `contactId` = QUI a cliqué (migration 0106), `null` quand l'URL ne portait pas de jeton. C'est le cas de
   * tous les templates approuvés avant le 2026-09-02 : leur adresse est figée chez Meta et ne pourra jamais
   * en porter. Compter ces clics-là sans savoir qui vaut mieux que ne pas les compter.
   */
  async recordClick(code: string, tenantId: string, contactId?: string | null): Promise<void> {
    await this.pool.query(
      `insert into tracked_link_clicks (code, tenant_id, contact_id) values (lower($1), $2, $3)`,
      [code, tenantId, contactId ?? null],
    );
  }

  /**
   * Résout un jeton public en identifiant de contact, DANS un espace donné.
   *
   * 🔴 `tenant_id = $1` alors que le jeton est unique globalement, et ce n'est pas redondant : l'espace vient
   * du LIEN cliqué, pas de l'URL. Sans ce filtre, un jeton d'un autre client se verrait attribuer ce clic-ci,
   * ce qui mêlerait deux clientèles dans une même mesure.
   *
   * ⚠️ Un contact ANONYMISÉ garde sa ligne mais son jeton est effacé par la purge : il ne se résout donc
   * plus, et ses clics futurs redeviennent anonymes. C'est le comportement voulu du droit à l'effacement.
   */
  async contactParJeton(tenantId: string, jeton: string): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and jeton_public = $2`,
      [tenantId, jeton],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Le jeton public de CES contacts, fabriqué pour ceux qui n'en ont pas encore.
   *
   * 🔴 POSÉ À L'ENVOI, PAS À LA CRÉATION DU CONTACT. On ne fabrique pas d'identifiants pour des gens à qui on
   * n'envoie jamais de lien tracé, et une campagne qui n'en contient pas n'écrit donc rien du tout.
   *
   * `on conflict do nothing` sur l'index unique global : deux envois simultanés au même contact peuvent tirer
   * deux jetons, un seul entre, et la lecture qui suit rend celui qui a gagné. Sans ça, l'un des deux lèverait
   * en pleine campagne.
   *
   * Rend une map identifiant -> jeton. Les contacts absents de la map (aucun, en pratique) partiront sans
   * jeton, donc avec un lien anonyme : dégrader vaut mieux que faire échouer un envoi.
   */
  async jetonsPourContacts(tenantId: string, contactIds: readonly string[], fabriquer: () => string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (contactIds.length === 0) return out;

    const manquants = await this.pool.query<{ id: string }>(
      `select id from contacts where tenant_id = $1 and id = any($2::uuid[]) and jeton_public is null`,
      [tenantId, [...contactIds]],
    );
    if (manquants.rowCount && manquants.rowCount > 0) {
      // Un seul énoncé pour tous : autant d'allers-retours que de contacts ferait de l'attribution un coût
      // proportionnel à la taille de la campagne, sur le chemin d'envoi.
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
   * Le jeton public du contact qui porte CE numéro, fabriqué s'il n'en a pas encore.
   *
   * Le pendant UNITAIRE de `jetonsPourContacts`, pour les chemins qui envoient à une personne à la fois (un
   * bloc de scénario, une réponse depuis l'inbox) et qui connaissent un numéro, pas un identifiant de contact.
   * Le chemin de MASSE garde son chargement en un seul énoncé : une requête par destinataire y ferait de
   * l'attribution un coût proportionnel à la taille de la campagne.
   *
   * ⚠️ Les deux formes de stockage du numéro sont couvertes par une liste de valeurs (`in ($2, $3)`) et non
   * par une fonction sur la colonne : `regexp_replace(phone_e164, …)` rendrait inutilisable l'index unique
   * (tenant_id, phone_e164), donc un balayage complet des contacts par envoi. Même leçon que `isOptedOut`.
   *
   * `null` = numéro inconnu de la base. Le lien part alors sans jeton, donc anonyme : dégrader la mesure vaut
   * mieux que faire échouer un envoi.
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

    // `jeton_public is null` dans le WHERE : deux envois simultanés au même contact tirent deux jetons, un
    // seul entre, et la relecture rend celui du gagnant. Sans cette garde, le second écraserait le premier,
    // ce qui rendrait anonymes les clics des messages déjà partis avec l'ancien.
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
   * Les liens tracés de CES templates. Sert à deux choses : ré-habiller l'affichage (remontrer le lien
   * d'origine à l'utilisateur) et savoir quels boutons sont mesurables.
   *
   * Liste vide -> aucune requête : `= any('{}')` ne matcherait rien, autant ne pas déranger la base.
   */
  async listByTemplates(tenantId: string, noms: readonly string[]): Promise<LienTrace[]> {
    if (noms.length === 0) return [];
    const res = await this.pool.query<{
      code: string; template_name: string; template_language: string; card_index: number | null; button_index: number; destination: string; avec_jeton: boolean;
    }>(
      // CONFIRMÉS seulement : une ligne réservée dont Meta a refusé le template ne décrit aucun lien réel,
      // et l'exposer ferait apparaître une mesure qui resterait à zéro pour toujours.
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
   * Clics par code sur la plage (bornes Europe/Paris, `to` inclus), pour les codes demandés.
   *
   * Rend UNIQUEMENT les codes qui ont au moins un clic : c'est l'appelant qui sait quels codes existent et
   * doit afficher zéro pour les autres. Une mesure choisie qui vaut zéro est une information, et c'est à lui
   * de la produire, pas à cette requête d'inventer des lignes.
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
   * Purge les CLICS plus vieux que la rétention.
   *
   * 🔴 LES CLICS, JAMAIS LES LIENS. `tracked_links` est une porte à SENS UNIQUE (cf. CLAUDE.md) : dès qu'un
   * template portant un lien `/r/<code>` est approuvé et ENVOYÉ, son adresse circule dans des messages déjà
   * livrés. Supprimer une ligne de `tracked_links` casserait ces liens-là définitivement, chez des contacts
   * qui les ont encore sous les yeux. Une purge qui remonterait la cascade `on delete cascade` depuis les
   * clics serait donc une catastrophe silencieuse : elle ne remonte pas, ce `delete` ne touche que les clics.
   *
   * Cette table ne porte AUCUNE donnée personnelle (un code, un espace, une date) : ce balayage répond à la
   * croissance, pas au RGPD. D'où une rétention longue, qui garde les mesures d'une année sur l'autre.
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
