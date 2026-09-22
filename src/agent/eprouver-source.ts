import type { SourceAppel } from './sources';
import { construireCible, enTetesAuthSource } from './http-cible';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { fetchPublic, estRefusAdresseInterne, estRedirectionRefusee } from '../lib/connexion-publique';

export interface EprouverSourceDeps {
  pourAppel(tenantId: string, id: string): Promise<SourceAppel | null>;
  marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void>;
  /** Injectée pour éprouver la garde sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
  /** Défaut : le `fetch` VÉRIFIÉ À LA CONNEXION (DNS rebinding), `src/lib/connexion-publique.ts`. */
  fetchImpl?: typeof fetch;
}

export interface ResultatEpreuve { ok: boolean; httpStatus?: number; erreur?: string }

const INTERNE = 'cette adresse n est pas joignable depuis notre infrastructure';

/**
 * ÉPROUVER une source : un appel réel, et le résultat écrit sur la ligne.
 *
 * C'est le seul moyen de voir un jeton mort AVANT qu'un contact ne le découvre : un jeton expiré ne produit
 * aucune erreur applicative côté client, l'agent se dégrade en silence au milieu d'une conversation. On passe
 * par les MÊMES gardes que le résolveur (`construireCible`), sinon l'épreuve validerait une adresse que l'appel
 * refusera.
 *
 * ⚠️ SORTIE DU CÂBLAGE DE `src/index.ts` LE 2026-09-21, pour être TESTÉE : ses verdicts (adresse interne à la
 * connexion, redirection refusée) n'étaient éprouvés par rien. Le comportement n'a pas bougé, sauf la
 * redirection, qui s'affichait « injoignable ».
 */
export function creerEprouverSource(deps: EprouverSourceDeps): (tenant: string, id: string, chemin: string) => Promise<ResultatEpreuve> {
  const verifier = deps.verifierResolution ?? resolutionPublique;
  const appeler = deps.fetchImpl ?? fetchPublic;
  return async (tenant, id, chemin) => {
    const src = await deps.pourAppel(tenant, id);
    // 🔴 `kind === 'http'` ICI AUSSI, et pas seulement sur la route. Une garde posée au montage, dans un autre
    // fichier, n'en est une que tant que personne ne monte un second appelant : c'est exactement la fragilité
    // que `scopeTenant` a payée le 2026-09-03.
    if (!src || src.kind !== 'http') return { ok: false, erreur: 'source introuvable' };
    const cible = construireCible({ baseUrl: src.baseUrl, binding: { methode: 'GET', chemin }, args: {} });
    if (!cible.ok) return { ok: false, erreur: cible.raison };
    /**
     * 🔴 OÙ CE NOM MÈNE-T-IL VRAIMENT ? `construireCible` lit le TEXTE de l'hôte : elle refuse `localhost` et
     * les littéraux privés, et elle ne peut RIEN contre `crm.exemple.fr` dont l'enregistrement A pointe sur
     * `169.254.169.254` (les métadonnées du fournisseur) ou sur `172.18.x.x` (le réseau Docker du VPS).
     *
     * ⚠️ Ce bouton était le QUATRIÈME chemin de ce genre quand le CLAUDE.md en affirmait TROIS, tous gardés.
     * L'inventaire est désormais tenu par un test (`tests/lib-adresse-privee.test.ts`).
     */
    const resolution = await verifier(cible.url);
    if (!resolution.ok) {
      await deps.marquerEpreuve(tenant, id, false, 'adresse non joignable');
      return { ok: false, erreur: INTERNE };
    }
    // MÊME construction d'en-têtes que l'appel réel : une épreuve qui authentifierait autrement dirait « ça
    // répond » d'une source que les appels ne savent pas authentifier.
    const headers = enTetesAuthSource(src);
    try {
      const res = await appeler(cible.url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const auth = res.status === 401 || res.status === 403;
      const ok = res.ok;
      await deps.marquerEpreuve(tenant, id, ok, auth ? 'authentification refusee' : `HTTP ${res.status}`);
      return { ok, httpStatus: res.status, ...(ok ? {} : { erreur: auth ? 'authentification refusee' : `HTTP ${res.status}` }) };
    } catch (err) {
      // Refus À LA CONNEXION (le nom a résolu vers l'intérieur entre la vérification ci-dessus et l'appel) :
      // même verdict que la vérification préalable, c'est la même cause.
      if (estRefusAdresseInterne(err)) {
        await deps.marquerEpreuve(tenant, id, false, 'adresse non joignable');
        return { ok: false, erreur: INTERNE };
      }
      // Même verdict que le résolveur de connecteur sur la même source.
      if (estRedirectionRefusee(err)) {
        await deps.marquerEpreuve(tenant, id, false, 'redirection refusée');
        return { ok: false, erreur: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur' };
      }
      // Le message d'exception n'est PAS repassé : il peut porter l'URL complète, donc parfois un jeton en
      // paramètre de requête sur un système mal conçu.
      await deps.marquerEpreuve(tenant, id, false, 'injoignable');
      return { ok: false, erreur: 'systeme injoignable' };
    }
  };
}
