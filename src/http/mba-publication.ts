import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  planifierPublication, descriptionPourMeta, authTypeMeta, authConfigMeta, pertesChezMeta, OutilNonPubliable,
  type Geste, type SourceAPublier, type OutilAPublier, type EtatMeta,
} from '../mba/publication';
import type { RequeteConnecteur } from '../agent/requetes';
import { scopeTenant } from './scope';

/**
 * Publier le catalogue d'outils de l'espace chez Meta.
 *
 * 🔴 DEUX ROUTES, ET LA PREMIÈRE N'ÉCRIT RIEN. « Engage Me fait foi, la publication écrase » est la décision
 * de Julien du 2026-09-10 : écraser n'est acceptable que si l'on montre QUOI avant de le faire. Le `GET`
 * rend le plan en toutes lettres, le `POST` l'exécute. Une publication sans aperçu serait une promesse tenue
 * dans le dos du client.
 *
 * ⚠️ LE PLAN EST RECALCULÉ AU MOMENT D'APPLIQUER, jamais transmis par le navigateur. Le lui faire porter
 * ouvrirait une fenêtre où Meta a changé entre l'aperçu et le clic, et où l'on exécuterait des gestes
 * calculés sur un état périmé, en croyant montrer ce qu'on allait faire.
 */

export interface MbaPublicationDeps {
  /** Numéro Meta du client, résolu côté serveur. `null` = aucun numéro, donc rien à publier. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Les sources de l'espace, sans secret. */
  sources(tenantId: string): Promise<SourceAPublier[]>;
  /** Les outils EXPOSÉS au MBA, déjà résolus avec leur méthode et leur chemin. */
  outilsExposes(tenantId: string, phoneNumberId: string): Promise<OutilAPublier[]>;
  /** L'état actuel chez Meta. */
  etatMeta(tenantId: string, phoneNumberId: string): Promise<EtatMeta>;
  /**
   * Applique UN geste. Isolé pour rester testable sans réseau.
   *
   * ⚠️ `ctx` EST UN BAC À MÉMOIRE PARTAGÉ PAR TOUTE UNE PUBLICATION, et il n'est pas décoratif : sans lui,
   * l'implémentation relisait la liste des connecteurs CHEZ META et les sources EN BASE à chaque geste. Sur
   * un plan de vingt gestes, cela faisait quarante lectures dont la moitié sur le réseau, pour un état qui
   * ne change qu'aux gestes qu'on vient d'appliquer. La route le crée vide et le passe tel quel.
   */
  appliquer(tenantId: string, phoneNumberId: string, geste: Geste, ctx: Map<string, unknown>): Promise<void>;
}

export function registerMbaPublication(app: FastifyInstance, deps: MbaPublicationDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/mba-publication';

  /**
   * Le plan, et les outils exposés qui n'en font PAS partie parce que Meta en recevrait une version creuse.
   *
   * ⚠️ LES SECONDS VOYAGENT AVEC LE PLAN, jamais seuls : l'écran doit pouvoir dire « Publié, sauf add_tag,
   * parce que… » au lieu de « Meta est à jour », qui était exactement le mensonge du 2026-09-21.
   */
  async function planifier(tenantId: string, pn: string): Promise<{ gestes: Geste[]; nonPubliables: NonPubliable[] }> {
    const [sources, outils, meta] = await Promise.all([
      deps.sources(tenantId),
      deps.outilsExposes(tenantId, pn),
      deps.etatMeta(tenantId, pn),
    ]);
    return {
      gestes: planifierPublication(sources, outils, meta),
      nonPubliables: outils.filter((o) => o.pertes.length > 0).map((o) => ({ nom: o.name, pertes: o.pertes })),
    };
  }

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(200).send({ gestes: [], phoneNumberId: null, nonPubliables: [] });
    return reply.code(200).send({ ...(await planifier(tenant, pn)), phoneNumberId: pn });
  });

  /**
   * Exécute le plan.
   *
   * 🔴 ON S'ARRÊTE AU PREMIER ÉCHEC, et on rend ce qui a été fait. Continuer laisserait un état à moitié
   * publié dont personne ne connaîtrait la forme ; s'arrêter en le disant permet de rejouer, et la
   * publication étant IDEMPOTENTE, rejouer ne refait pas ce qui a réussi.
   */
  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta où publier.' });
    }
    const { gestes, nonPubliables } = await planifier(tenant, pn);
    const faits: Geste[] = [];
    // Vit le temps de CETTE publication, et meurt avec elle : deux publications ne partagent jamais un état
    // lu, ce qui serait précisément la façon d'agir sur une photo périmée.
    const ctx = new Map<string, unknown>();
    for (const g of gestes) {
      try {
        await deps.appliquer(tenant, pn, g, ctx);
        faits.push(g);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-publication: ${g.type} « ${g.nom} » a échoué (${tenant}):`, err instanceof Error ? err.message : err);
        // Un refus qui vient de NOUS ne se présente pas comme un refus de Meta.
        const cause = err instanceof OutilNonPubliable ? err.message : `Meta a refusé « ${g.nom} » (${g.type}).`;
        return reply.code(409).send({
          error: `${cause} ${faits.length} geste(s) déjà appliqué(s), le reste n’a pas été tenté. Relancez : ce qui a réussi ne sera pas refait.`,
          faits,
          nonPubliables,
        });
      }
    }
    return reply.code(200).send({ faits, nonPubliables });
  });
}

/** Un outil exposé au MBA que la publication laisse de côté, et ce que Meta n'en recevrait pas. */
export interface NonPubliable { nom: string; pertes: string[] }

/**
 * Le corps d'un outil chez Meta, construit depuis le nôtre.
 *
 * ⚠️ `request_definition` reste MINIMAL : méthode et chemin. Les macros, `transformation_spec` et
 * `user_auth_required: true` de Meta ne sont PAS gérés au premier lot, et on ne prétend pas le contraire :
 * un outil qui les utiliserait serait modifié dans WhatsApp Manager, donc écrasé, et l'aperçu le montre.
 *
 * 🔴 IL PREND LA REQUÊTE ELLE-MÊME, ET REFUSE DE CONSTRUIRE UN OUTIL CREUX (2026-09-21). Le plan écarte
 * déjà ces outils ; la garde est répétée ICI parce que c'est la seule fonction qui fabrique ce qui part
 * chez Meta, et qu'elle calcule les pertes sur la requête qu'elle publie, pas sur un drapeau qu'on lui
 * aurait passé. Aucun appelant ne peut donc lui faire publier un outil creux, pas même par oubli.
 */
export function corpsOutilMeta(
  o: Pick<OutilAPublier, 'name' | 'description' | 'nePasUtiliser'>,
  req: Pick<RequeteConnecteur, 'methode' | 'chemin' | 'parametres' | 'entetes' | 'corps'>,
): {
  name: string; description: string; request_definition: unknown; user_auth_required: boolean;
} {
  const pertes = pertesChezMeta(req);
  if (pertes.length > 0) throw new OutilNonPubliable(o.name, pertes);
  return {
    name: o.name,
    description: descriptionPourMeta(o),
    request_definition: { method: req.methode, path: req.chemin },
    // Exigé par le schéma de Meta. `false` est le seul choix honnête : nous ne collectons aucun jeton par
    // utilisateur final. L'omettre ferait échouer la création.
    user_auth_required: false,
  };
}

/**
 * Le corps d'un connecteur, construit depuis une source.
 *
 * 🔴 `auth_config` EST DÉLIBÉRÉMENT ABSENT, et ce n'est pas un oubli : la documentation de Meta impose
 * d'OMETTRE ce champ quand `auth_type` vaut `NONE` (400 sinon), et pour les autres cas nous passons par
 * `upsertApiKey`, seul chemin qui sache faire TOURNER un secret sans recréer le connecteur. Un secret qui
 * n'a qu'un chemin d'écriture n'a qu'un endroit à auditer.
 *
 * ⚠️ IL NE DEMANDE QUE LES TROIS CHAMPS QU'IL CONSOMME, et ce `Pick` est du bon côté de la règle du dépôt :
 * ses membres sont lus SUR PLACE, donc un oubli serait une erreur au point d'usage. Le faire porter une
 * `SourceAPublier` entière obligeait ses deux appelants à recopier la source champ par champ, liste qui
 * dérive dès qu'on y ajoute un champ (ce qui vient d'arriver avec `secretPublie`).
 */
/**
 * 🔴 `auth_config` VOYAGE AVEC LE CONNECTEUR, ET C'EST NON NÉGOCIABLE CÔTÉ META (mesuré le 2026-09-18).
 * Sans lui, une création en `auth_type: API_KEY` rend 400 « Invalid connector request », et un changement
 * d'`auth_type` rend « auth_config is required when changing auth_type ». Le secret arrive donc ici en
 * PARAMÈTRE : c'est l'exécuteur de la publication qui le déchiffre, exactement là où il le déchiffrait déjà
 * pour poser la clé. Ce n'est pas un nouveau chemin pour le secret, c'est le même, une ligne plus haut.
 *
 * ⚠️ CE FICHIER N'EST PAS UN LECTEUR DE SOURCE, et la nuance compte pour `tests/sources-kind.test.ts` :
 * ce garde-fou inventorie les fichiers qui DÉCHIFFRENT un secret, en cherchant l'identifiant de la méthode
 * n'importe où, commentaires compris. Le citer ici ferait entrer ce fichier dans un inventaire dont il ne
 * relève pas, et un inventaire qui contient un faux devient un inventaire qu'on n'ose plus lire.
 *
 * ⚠️ `secret` ABSENT SUR UNE SOURCE AUTHENTIFIÉE REND UN CORPS EN `NONE`, jamais un corps `API_KEY` sans
 * configuration : le second est refusé par Meta, donc il ferait échouer la publication entière au lieu de
 * publier ce qui est publiable. Le geste `secret_poser` du plan suivant remettra l'authentification.
 */
export function corpsConnecteurMeta(
  s: Pick<SourceAPublier, 'label' | 'baseUrl' | 'authKind' | 'authHeaderName'>,
  secret?: string | null,
): { name: string; description: string; base_url: string; auth_type: string; auth_config?: unknown } {
  const authentifie = s.authKind !== 'none' && typeof secret === 'string' && secret !== '';
  return {
    name: s.label,
    description: `Système « ${s.label} » déclaré dans Engage Me.`,
    base_url: s.baseUrl,
    auth_type: authentifie ? authTypeMeta(s.authKind) : 'NONE',
    ...(authentifie ? { auth_config: authConfigMeta(s, secret) } : {}),
  };
}

export { authConfigMeta };
