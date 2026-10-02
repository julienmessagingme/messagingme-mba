import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { WidgetRow } from '../widgets/store.pg';
import type { NumeroDuWidget } from '../widgets/adresses';
import {
  LIMITE_WIDGETS_PAR_ESPACE, creerWidget, modifierWidget, supprimerWidget, vueDuWidget,
  type DepsGestionWidgets, type VueWidget,
} from '../widgets/gestion';
import { espaceVerifie } from './scope';

/**
 * Les widgets WhatsApp d'un espace, côté console (lot 4 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md).
 *
 * Une route MINCE : les contrôles vivent dans `src/widgets/gestion.ts`, que les outils MCP du lot 5 appelleront
 * aussi. Elle n'ajoute que ce qui est propre au HTTP : la garde (le module est monté sous `g.admin`, lecture
 * comprise, comme l'écran qui n'est ouvert qu'aux administrateurs) et la traduction des refus en statuts.
 */
export interface WidgetsRouteDeps {
  gestion: DepsGestionWidgets;
  /** Le numéro principal de l'espace (`PgPhoneStatusStore.getPhoneNumber`), pour le lien `wa.me` de la bulle. */
  numero(tenantId: string): Promise<NumeroDuWidget | null>;
  /**
   * La base des routes d'API (`adressesPubliques(...).avecPrefixe`), celle de l'adresse du script. La route ne la
   * recompose jamais : l'écran reçoit l'adresse et la balise prêtes à copier.
   */
  baseApi: string;
}

export function registerWidgets(app: FastifyInstance, deps: WidgetsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/widgets';

  /**
   * La mise en vue des widgets d'un espace. Le numéro est lu AVANT toute écriture : lu après, sa panne rendrait une
   * 500 sur un widget pourtant créé, et le client qui réessaierait se ferait refuser sa propre phrase.
   */
  const enVue = async (tenant: string): Promise<(w: WidgetRow) => VueWidget> => {
    const numero = await deps.numero(tenant);
    return (w) => vueDuWidget(w, deps.baseApi, numero);
  };

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const [widgets, vue] = await Promise.all([deps.gestion.widgets.lister(tenant), enVue(tenant)]);
    return reply.code(200).send({ widgets: widgets.map(vue), limite: LIMITE_WIDGETS_PAR_ESPACE });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const vue = await enVue(tenant);
    const r = await creerWidget(deps.gestion, tenant, req.body);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(201).send({ widget: vue(r.valeur) });
  });

  app.patch<{ Params: { id: string } }>(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const vue = await enVue(tenant);
    const r = await modifierWidget(deps.gestion, tenant, req.params.id, req.body);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(200).send({ widget: vue(r.valeur) });
  });

  /**
   * Supprimer ne casse pas le site du client : sa balise rend désormais le script inerte, la bulle disparaît. Les
   * conversations déjà arrivées gardent leur étiquette `widget-<code>`.
   */
  app.delete<{ Params: { id: string } }>(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await supprimerWidget(deps.gestion, tenant, req.params.id);
    if (!r.ok) return reply.code(r.statut).send({ error: r.erreur });
    return reply.code(200).send({ ok: true });
  });
}
