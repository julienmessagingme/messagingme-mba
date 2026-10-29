import { z } from 'zod';
import type { HttpGet } from '../lib/http-get';

/**
 * LE COÛT SCALEWAY DU MOIS (refonte de /ops, lot 3) : la consommation lue par l'API de facturation (`v2beta1`), sa
 * projection au rythme du mois, et son détail par poste. Une clé DÉDIÉE (application IAM `ops-facturation`,
 * `BillingReadOnly` au niveau de l'organisation, `SCW_FACTURATION_CLE` dans les secrets du conteneur de l'API), jamais
 * celle de `claude-code` ni celle du déploiement.
 *
 * 🔴 LA FORME A ÉTÉ MESURÉE, PAS LUE (2026-10-29, par la CLI) : `{ consumptions: [{ value: { currency_code, units,
 * nanos }, product_name, resource_name, sku, category_name, unit, billed_quantity, ... }], total_count,
 * total_discount_untaxed_value, updated_at }`, le mois entier en une page (38 lignes, 103,28 € HT au 29). Une autre forme
 * ne se devine pas : la lecture rend `null`, l'écran dit « indisponible ».
 *
 * La projection est AU RYTHME DU MOIS (la spec) : le coût depuis le 1er, rapporté aux jours que couvrent les données
 * (jusqu'à la mise à jour de Scaleway, pas l'heure murale : un retard de quelques heures fausserait le début de mois),
 * étendu au mois entier. Une réduction faite en cours de mois n'y entre qu'en partie : l'écran le dit.
 *
 * Le chiffre couvre TOUTE l'organisation (la facturation est portée par elle, pas par un projet) : un second projet
 * s'y ajouterait. Le mois est demandé explicitement (`billing_period`), et le cache tombe quand le mois change.
 */

export const API_FACTURATION = 'https://api.scaleway.com/billing/v2beta1/consumptions';

/** Un nombre fini, écrit en nombre ou en texte (les `int64` de Scaleway peuvent arriver en texte) ; rien d'autre. */
const nombre = z.union([z.number(), z.string()]).transform(Number).refine(Number.isFinite, 'nombre fini attendu');
const montant = z.object({
  currency_code: z.string(),
  units: nombre,
  // Un zéro peut être omis ou nul : il vaut zéro.
  nanos: nombre.nullish(),
});
const page = z.object({
  consumptions: z.array(z.object({
    value: montant,
    product_name: z.string(),
    category_name: z.string(),
  })),
  total_discount_untaxed_value: nombre.nullish(),
  updated_at: z.string().nullish(),
});

export interface PosteCout { categorie: string; montantHt: number }
export interface LigneCout { produit: string; categorie: string; montantHt: number }

export interface CoutScaleway {
  /** Le mois facturé, `AAAA-MM` (UTC, comme Scaleway). */
  periode: string;
  /** Depuis le 1er, hors taxes, avant remise. */
  totalHt: number;
  /** La remise que Scaleway annonce sur la période (un avoir, une offre de bienvenue) ; 0 sans remise. */
  remiseHt: number;
  /** Au rythme du mois ; `null` le premier jour, trop tôt pour projeter. */
  projectionHt: number | null;
  joursEcoules: number;
  joursDuMois: number;
  /** Par poste de la facture (`category_name`), du plus cher au moins cher. */
  postes: PosteCout[];
  /** Les lignes les plus chères, pour savoir quoi réduire. */
  lignes: LigneCout[];
  /** Quand Scaleway a mis la consommation à jour. */
  majLe: string | null;
}

const arrondi = (n: number): number => Math.round(n * 100) / 100;
// La formule du SDK (`ToFloat`) : `units` et `nanos` portent le même signe, un avoir est négatif dans les deux.
const valeur = (m: z.infer<typeof montant>): number => m.units + (m.nanos ?? 0) / 1e9;
/** Le mois de facturation de Scaleway, en UTC. */
export const periodeDe = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Pure : la consommation lue, rapportée à l'instant. Testée sans réseau. */
export function synthetiser(lignes: z.infer<typeof page>['consumptions'], remise: number, majLe: string | null, maintenant: Date): CoutScaleway {
  const debut = Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1);
  const fin = Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() + 1, 1);
  const joursDuMois = Math.round((fin - debut) / 86_400_000);
  // Les jours que couvrent les DONNÉES : jusqu'à la mise à jour de Scaleway quand elle est lisible et dans le mois.
  const maj = majLe ? Date.parse(majLe) : NaN;
  const couvertJusqua = Number.isFinite(maj) && maj > debut && maj <= maintenant.getTime() ? maj : maintenant.getTime();
  const joursEcoules = (couvertJusqua - debut) / 86_400_000;
  const parPoste = new Map<string, number>();
  for (const l of lignes) parPoste.set(l.category_name, (parPoste.get(l.category_name) ?? 0) + valeur(l.value));
  const total = [...parPoste.values()].reduce((t, v) => t + v, 0);
  return {
    periode: periodeDe(maintenant),
    totalHt: arrondi(total),
    remiseHt: arrondi(Math.max(0, remise)),
    projectionHt: joursEcoules >= 1 ? arrondi((total / joursEcoules) * joursDuMois) : null,
    joursEcoules: Math.round(joursEcoules * 10) / 10,
    joursDuMois,
    // Un poste négatif (un avoir) reste : sans lui, les postes ne s'additionneraient plus au total.
    postes: [...parPoste.entries()].map(([categorie, m]) => ({ categorie, montantHt: arrondi(m) }))
      .filter((p) => p.montantHt !== 0).sort((a, b) => b.montantHt - a.montantHt),
    lignes: lignes.map((l) => ({ produit: l.product_name, categorie: l.category_name, montantHt: arrondi(valeur(l.value)) }))
      .filter((l) => l.montantHt > 0).sort((a, b) => b.montantHt - a.montantHt).slice(0, 8),
    majLe,
  };
}

export interface LecteurFacture {
  /** `null` : la lecture a échoué (refus, réseau, autre forme). */
  lire(): Promise<CoutScaleway | null>;
}

/** Scaleway met la consommation à jour quelques fois par jour : trois heures de cache ; un échec, cinq minutes. */
const MS_SUCCES = 3 * 3600_000;
const MS_ECHEC = 5 * 60_000;
/** Une lecture qui échoue garde la dernière bonne valeur jusqu'à ce délai : la mise à jour affichée dit son âge. */
const MS_GARDE = 24 * 3600_000;
const TAILLE_PAGE = 100;
const PAGES_MAX = 10;

export function creerLecteurFacture(o: {
  cle: string;
  organisationId: string;
  http: HttpGet;
  maintenant?: () => Date;
  delaiMs?: number;
  /** Un échec : le statut seul, jamais la clé ni le corps. */
  signaler?: (detail: { status: number | null; raison: string }) => void;
}): LecteurFacture {
  const maintenant = o.maintenant ?? (() => new Date());
  /** Ce que rend la lecture jusqu'à `jusqua`, pour ce mois-là. */
  let cache: { jusqua: number; periode: string; valeur: CoutScaleway | null } | null = null;
  let bon: { a: number; periode: string; valeur: CoutScaleway } | null = null;
  let enVol: Promise<CoutScaleway | null> | null = null;

  async function lireTout(periode: string): Promise<CoutScaleway | null> {
    const lignes: z.infer<typeof page>['consumptions'] = [];
    let remise = 0;
    let majLe: string | null = null;
    for (let n = 1; ; n++) {
      // Au-delà du plafond, un total partiel serait un montant faux affiché comme vrai : rien plutôt que lui.
      if (n > PAGES_MAX) { o.signaler?.({ status: null, raison: 'tronqué' }); return null; }
      let r;
      try {
        r = await o.http.get(
          `${API_FACTURATION}?organization_id=${encodeURIComponent(o.organisationId)}&billing_period=${periode}`
            + `&order_by=category_name_asc&page_size=${TAILLE_PAGE}&page=${n}`,
          { 'x-auth-token': o.cle },
          { signal: AbortSignal.timeout(o.delaiMs ?? 10_000) },
        );
      } catch {
        o.signaler?.({ status: null, raison: 'appel impossible' });
        return null;
      }
      if (r.status < 200 || r.status >= 300) { o.signaler?.({ status: r.status, raison: 'refus' }); return null; }
      const p = page.safeParse(r.json);
      if (!p.success) { o.signaler?.({ status: r.status, raison: 'autre forme' }); return null; }
      // Une autre devise ne s'additionne pas à des euros.
      if (p.data.consumptions.some((l) => l.value.currency_code !== 'EUR')) { o.signaler?.({ status: r.status, raison: 'devise' }); return null; }
      lignes.push(...p.data.consumptions);
      remise = p.data.total_discount_untaxed_value ?? 0;
      majLe = p.data.updated_at ?? majLe;
      // La fin se lit sur une page incomplète, pas sur `total_count` (dont le sens, page ou total, n'est pas mesuré).
      if (p.data.consumptions.length < TAILLE_PAGE) break;
    }
    return synthetiser(lignes, remise, majLe, maintenant());
  }

  async function rafraichir(t: number, periode: string): Promise<CoutScaleway | null> {
    const lue = await lireTout(periode);
    if (lue) {
      bon = { a: t, periode, valeur: lue };
      cache = { jusqua: t + MS_SUCCES, periode, valeur: lue };
      return lue;
    }
    // Un échec garde la dernière bonne valeur du même mois, un jour au plus (la mise à jour affichée dit son âge), et se
    // relit cinq minutes plus tard, qu'il ait gardé une valeur ou non.
    const garde = bon && bon.periode === periode && t - bon.a < MS_GARDE ? bon.valeur : null;
    cache = { jusqua: t + MS_ECHEC, periode, valeur: garde };
    return garde;
  }

  return {
    async lire() {
      const t = maintenant().getTime();
      const periode = periodeDe(new Date(t));
      if (cache && cache.periode === periode && t < cache.jusqua) return cache.valeur;
      // Deux ouvertures simultanées de l'onglet : une seule lecture.
      if (!enVol) enVol = rafraichir(t, periode).finally(() => { enVol = null; });
      return enVol;
    },
  };
}
