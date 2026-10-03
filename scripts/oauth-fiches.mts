/**
 * LES DEUX FICHES D'IDENTITÉ DES CLIENTS OAUTH, RELUES CHEZ ANTHROPIC (tâche 7 du plan `2026-10-03-oauth-mcp.md`).
 *
 * `src/oauth/clients.ts` RECOPIE les fiches de Claude Code et de claude.ai (Client ID Metadata Documents) au lieu
 * de les récupérer à chaque autorisation : pas de requête sortante vers une adresse fournie par un tiers, pas de
 * dépendance au Cloudflare de claude.ai. Le prix de la copie est qu'elle peut vieillir : le jour où Anthropic
 * change une adresse de retour (`claude.com`, par exemple), nos autorisations échouent en silence. Ce script relit
 * les fiches publiées et dit si elles divergent de la copie.
 *
 * 🔴 IL TOUCHE LE RÉSEAU, donc il vit hors de `npm test` (la CI ne doit pas dépendre de claude.ai). Il se lance à
 * chaque déploiement de l'API (`DEPLOY.md`), depuis le poste. Lecture seule : deux GET publics, rien d'autre.
 *
 * Ce qui compte comme divergence : un `client_id` qui n'est plus l'adresse de la fiche, des adresses de retour
 * différentes (ajoutée ou retirée), une méthode d'authentification autre que `none` (le serveur n'accepte que des
 * clients publics), ou un `authorization_code` absent des `grant_types`. Le nom affiché n'en est pas une : le
 * nôtre est celui de la page de consentement.
 *
 * Code de sortie : 0 conformes, 1 au moins une divergence, 2 une fiche illisible ou injoignable.
 *
 * Usage : npm run oauth:fiches
 */
import { z } from 'zod';
import { CLIENTS_OAUTH } from '../src/oauth/clients';

const Fiche = z.object({
  client_id: z.string(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

/** Les mêmes adresses, dans n'importe quel ordre. */
const memes = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

let code = 0;
for (const client of CLIENTS_OAUTH) {
  let brut: unknown;
  try {
    const res = await fetch(client.id, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    brut = JSON.parse(await res.text());
  } catch (err) {
    console.error(`ILLISIBLE  ${client.nom} (${client.id}) : ${err instanceof Error ? err.message : String(err)}`);
    code = Math.max(code, 2);
    continue;
  }
  const lu = Fiche.safeParse(brut);
  if (!lu.success) {
    console.error(`ILLISIBLE  ${client.nom} (${client.id}) : la fiche n'a pas la forme attendue`);
    code = Math.max(code, 2);
    continue;
  }
  const f = lu.data;
  const ecarts: string[] = [];
  if (f.client_id !== client.id) ecarts.push(`client_id publié « ${f.client_id} »`);
  if (!memes(f.redirect_uris, client.adressesDeRetour)) {
    ecarts.push(`adresses de retour publiées ${JSON.stringify(f.redirect_uris)}, copie ${JSON.stringify(client.adressesDeRetour)}`);
  }
  if ((f.token_endpoint_auth_method ?? 'none') !== 'none') ecarts.push(`authentification « ${f.token_endpoint_auth_method} » (seul « none » est accepté)`);
  if (f.grant_types !== undefined && !f.grant_types.includes('authorization_code')) ecarts.push(`grant_types ${JSON.stringify(f.grant_types)}`);
  if (ecarts.length === 0) {
    console.log(`CONFORME   ${client.nom} (${client.id})${f.client_name ? `, publiée sous « ${f.client_name} »` : ''}`);
  } else {
    console.error(`DIVERGENTE ${client.nom} (${client.id}) :\n  - ${ecarts.join('\n  - ')}`);
    code = Math.max(code, 1);
  }
}
if (code === 1) {
  console.error('\nMettre à jour `CLIENTS_OAUTH` (src/oauth/clients.ts), et le CHECK `oauth_autorisations_client_chk` si un identifiant change.');
}
process.exitCode = code;
