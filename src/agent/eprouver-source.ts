import type { SourceAppel } from './sources';
import { construireCible, enTetesAuthSource } from './http-cible';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { fetchPublic, estRefusAdresseInterne, estRedirectionRefusee } from '../lib/connexion-publique';

export interface EprouverSourceDeps {
  pourAppel(tenantId: string, id: string): Promise<SourceAppel | null>;
  marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void>;
  /** Injectée pour éprouver la garde sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
  /** Défaut : le `fetch` vérifié à la connexion (DNS rebinding), `src/lib/connexion-publique.ts`. */
  fetchImpl?: typeof fetch;
}

export interface ResultatEpreuve { ok: boolean; httpStatus?: number; erreur?: string }

const INTERNE = 'cette adresse n est pas joignable depuis notre infrastructure';

/**
 * Éprouver une source : un appel réel, et le résultat écrit sur la ligne. Seul moyen de voir un jeton mort
 * avant qu'un contact ne le découvre. Passe par les mêmes gardes que le résolveur (`construireCible`), sinon
 * l'épreuve validerait une adresse que l'appel refusera.
 */
export function creerEprouverSource(deps: EprouverSourceDeps): (tenant: string, id: string, chemin: string) => Promise<ResultatEpreuve> {
  const verifier = deps.verifierResolution ?? resolutionPublique;
  const appeler = deps.fetchImpl ?? fetchPublic;
  return async (tenant, id, chemin) => {
    const src = await deps.pourAppel(tenant, id);
    // 🔴 `kind === 'http'` ici aussi, pas seulement sur la route : une garde posée au montage ne tient que
    // tant qu'aucun second appelant n'apparaît.
    if (!src || src.kind !== 'http') return { ok: false, erreur: 'source introuvable' };
    const cible = construireCible({ baseUrl: src.baseUrl, binding: { methode: 'GET', chemin }, args: {} });
    if (!cible.ok) return { ok: false, erreur: cible.raison };
    /**
     * 🔴 Où ce nom mène-t-il vraiment ? `construireCible` lit le texte de l'hôte et ne peut rien contre
     * `crm.exemple.fr` dont l'enregistrement A pointe sur `169.254.169.254` (métadonnées du fournisseur) ou sur
     * le réseau Docker du VPS.
     */
    const resolution = await verifier(cible.url);
    if (!resolution.ok) {
      await deps.marquerEpreuve(tenant, id, false, 'adresse non joignable');
      return { ok: false, erreur: INTERNE };
    }
    // Même construction d'en-têtes que l'appel réel, sinon l'épreuve dirait « ça répond » d'une source que
    // les appels ne savent pas authentifier.
    const headers = enTetesAuthSource(src);
    try {
      const res = await appeler(cible.url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const auth = res.status === 401 || res.status === 403;
      const ok = res.ok;
      await deps.marquerEpreuve(tenant, id, ok, auth ? 'authentification refusee' : `HTTP ${res.status}`);
      return { ok, httpStatus: res.status, ...(ok ? {} : { erreur: auth ? 'authentification refusee' : `HTTP ${res.status}` }) };
    } catch (err) {
      // Refus à la connexion (le nom a résolu vers l'intérieur entre la vérification et l'appel) : même verdict.
      if (estRefusAdresseInterne(err)) {
        await deps.marquerEpreuve(tenant, id, false, 'adresse non joignable');
        return { ok: false, erreur: INTERNE };
      }
      // Même verdict que le résolveur de connecteur sur la même source.
      if (estRedirectionRefusee(err)) {
        await deps.marquerEpreuve(tenant, id, false, 'redirection refusée');
        return { ok: false, erreur: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur' };
      }
      // Le message d'exception n'est pas repassé : il peut porter l'URL complète, donc parfois un jeton.
      await deps.marquerEpreuve(tenant, id, false, 'injoignable');
      return { ok: false, erreur: 'systeme injoignable' };
    }
  };
}
