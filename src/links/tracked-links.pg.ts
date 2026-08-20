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
      `insert into tracked_links (code, tenant_id, template_name, template_language, card_index, button_index, destination)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, template_name, template_language, coalesce(card_index, -1), button_index)
         do update set destination = excluded.destination, confirmed_at = null
       returning code`,
      [code, tenantId, cible.templateName, cible.templateLanguage, cible.cardIndex, cible.buttonIndex, destination],
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

  /** Enregistre un clic. Appelée en BEST-EFFORT : un échec ne doit jamais empêcher la redirection. */
  async recordClick(code: string, tenantId: string): Promise<void> {
    await this.pool.query(
      `insert into tracked_link_clicks (code, tenant_id) values (lower($1), $2)`,
      [code, tenantId],
    );
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
      code: string; template_name: string; template_language: string; card_index: number | null; button_index: number; destination: string;
    }>(
      // CONFIRMÉS seulement : une ligne réservée dont Meta a refusé le template ne décrit aucun lien réel,
      // et l'exposer ferait apparaître une mesure qui resterait à zéro pour toujours.
      `select code, template_name, template_language, card_index, button_index, destination
         from tracked_links
        where tenant_id = $1 and template_name = any($2::text[]) and confirmed_at is not null`,
      [tenantId, [...new Set(noms)]],
    );
    return res.rows.map((r) => ({
      code: r.code,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      cardIndex: r.card_index,
      buttonIndex: r.button_index,
      destination: r.destination,
    }));
  }

  /**
   * TOUS les liens tracés de l'espace, avec leurs clics sur la plage.
   *
   * C'est la lecture « tous envois confondus » : un lien ne sait pas qui l'a envoyé, et c'est justement ce
   * qui la rend juste. Un template utilisé UNIQUEMENT en campagne n'a aucun bloc de scénario où s'accrocher,
   * donc il n'apparaîtrait nulle part dans une lecture par scénario ; ici, il est compté comme les autres.
   *
   * `left join` et non `join` : un lien sans aucun clic sur la période doit apparaître à ZÉRO. Le masquer
   * laisserait croire qu'il n'existe pas, alors qu'il est bien en circulation dans des messages.
   */
  async listAvecClics(tenantId: string, range: DateRange): Promise<Array<LienTrace & { clics: number }>> {
    const res = await this.pool.query<{
      code: string; template_name: string; template_language: string; card_index: number | null;
      button_index: number; destination: string; n: string;
    }>(
      // Les bornes sont lues en SOUS-REQUÊTES et non par une jointure sur `bounds` : écrit
      // `from tracked_links l, bounds b left join ...`, le LEFT JOIN s'accroche à `bounds` et non à `l`,
      // et la condition ne peut plus référencer `l`.
      `with ${BOUNDS_CTE}
       select l.code, l.template_name, l.template_language, l.card_index, l.button_index, l.destination,
              count(c.id)::int as n
         from tracked_links l
         left join tracked_link_clicks c
           on c.code = l.code
          and c.at >= (select start_ts from bounds)
          and c.at < (select end_ts from bounds)
        where l.tenant_id = $1 and l.confirmed_at is not null
        group by l.code, l.template_name, l.template_language, l.card_index, l.button_index, l.destination
        order by n desc, l.template_name asc, l.card_index asc nulls first, l.button_index asc`,
      [tenantId, range.from, range.to, STATS_TZ],
    );
    return res.rows.map((r) => ({
      code: r.code,
      templateName: r.template_name,
      templateLanguage: r.template_language,
      cardIndex: r.card_index,
      buttonIndex: r.button_index,
      destination: r.destination,
      clics: Number(r.n),
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
}
