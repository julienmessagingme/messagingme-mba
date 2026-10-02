import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { journaliser } from '../lib/journal';
import { lienDuWidget, ROUTE_SCRIPT } from '../widgets/adresses';
import { ClesResolues, avertissementBorne, type RateLimiter } from '../auth/rate-limit';
import type { WidgetRow } from '../widgets/store.pg';
import type { PhoneNumberRecord } from '../account/types';
import { construireScript, SCRIPT_INERTE, type ConfigScript } from '../widgets/script';

/**
 * Le script de la bulle WhatsApp : `GET /widget/<code>.js`, la balise que le client colle sur son site (lot 2 de
 * docs/superpowers/plans/2026-10-02-widget-whatsapp.md). Route non authentifiée, chargée par le navigateur de
 * n'importe quel visiteur, d'où quatre règles :
 *  1. 🔴 Le code de l'adresse EST l'autorité, et c'est le widget qui rend l'espace, jamais l'appelant.
 *  2. 🔴 L'ADRESSE EST UNE PORTE À SENS UNIQUE : dès qu'une balise est posée, elle doit répondre pour toujours.
 *     Ni le chemin, ni le suffixe `.js`, ni la forme du code ne se changent.
 *  3. Jamais de 5xx, ni même d'erreur : la réponse s'exécute dans la page d'un client, où une erreur se lirait
 *     dans SA console. Tout ce qui n'affiche rien rend 200 et `SCRIPT_INERTE`.
 *  4. Rien de secret dans le script : il est construit champ par champ (`construireScript`), jamais depuis la ligne.
 */

export interface WidgetPublicRouteDeps {
  /** Le widget d'un code, `null` s'il n'existe pas. Sans espace : c'est lui qui le rend (`PgWidgetStore.parCode`). */
  widgets: { parCode(code: string): Promise<WidgetRow | null> };
  /** Le numéro principal de l'espace (`PgPhoneStatusStore.getPhoneNumber`), `null` s'il n'en a aucun. */
  numero(tenantId: string): Promise<PhoneNumberRecord | null>;
  /** Le QR code d'un lien, en SVG (`src/widgets/qr.ts`). */
  qrSvg(lien: string): Promise<string>;
  /**
   * Le budget commun des codes jamais vus, pris avant la base (`CODES_INCONNUS_PAR_MINUTE`). Requis : il se
   * désactive par la configuration (0), pas en oubliant une dépendance.
   */
  budgetInconnus: RateLimiter;
}

/** Un code est 12 caractères base32 minuscules (`newTrackingCode`). Tout le reste est refusé sans toucher la base. */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;

/** Le paramètre d'URL, vérifié comme toute entrée externe. Fastify le rend sans le suffixe `.js`. */
const parametres = z.object({ code: z.string().trim().toLowerCase().regex(CODE_RE) });

/** Le cache d'une réponse ordinaire : assez pour absorber le trafic d'un site, assez court pour voir un réglage. */
const CACHE_PUBLIC = 'public, max-age=60';

/**
 * Le cache d'une réponse de REPLI (lecture en panne, budget épuisé) : `no-store`. Une bulle absente pour une
 * raison passagère ne doit pas le rester 60 secondes de plus dans le navigateur, ni chez Cloudflare.
 */
const SANS_CACHE = 'no-store';

function repondre(reply: FastifyReply, script: string, cache: string): FastifyReply {
  return reply.code(200)
    .header('content-type', 'application/javascript; charset=utf-8')
    .header('cache-control', cache)
    .send(script);
}

export function registerWidgetPublic(app: FastifyInstance, deps: WidgetPublicRouteDeps): void {
  // Les codes déjà résolus par ce process échappent au budget des codes jamais vus (`ClesResolues`), comme
  // `/w/:code`. Un widget ÉTEINT y entre aussi : son code existe, et la balise d'un widget éteint reste posée sur un
  // site qui peut être très fréquenté ; chacune de ses vues aurait sinon entamé le budget de tous les autres.
  const connus = new ClesResolues(1000);
  const avertirBudget = avertissementBorne(
    'widget : budget des codes jamais vus épuisé (CODES_INCONNUS_PAR_MINUTE), des codes inconnus reçoivent le script inerte',
  );

  // Le chemin vit à côté de `adresseDuScript`, qui fabrique l'adresse que la console et le MCP distribuent.
  app.get(ROUTE_SCRIPT, async (req, reply) => {
    const lu = parametres.safeParse(req.params);
    // Forme vérifiée avant la base : cette adresse reçoit des robots et des scans, aucune requête SQL par essai.
    if (!lu.success) return repondre(reply, SCRIPT_INERTE, CACHE_PUBLIC);
    const code = lu.data.code;

    // Le frein des codes jamais vus, avant la base : un code inventé bien formé coûte une lecture, et l'énumération
    // se paie sur un budget commun à clé constante, qu'aucun code inventé ne peut détourner vers un vrai. Épuisé, il
    // rend le script inerte et non un 429 : la réponse s'exécute dans la page d'un client.
    if (!connus.connait(code) && !deps.budgetInconnus.take('codes-inconnus')) {
      avertirBudget();
      return repondre(reply, SCRIPT_INERTE, SANS_CACHE);
    }

    let widget: WidgetRow | null;
    try {
      widget = await deps.widgets.parCode(code);
    } catch (err) {
      journaliser('error', 'widget_lecture_echouee', { err, code });
      return repondre(reply, SCRIPT_INERTE, SANS_CACHE);
    }
    if (widget === null) {
      // Un code qui ne se résout plus perd son laissez-passer.
      connus.oublier(code);
      return repondre(reply, SCRIPT_INERTE, CACHE_PUBLIC);
    }
    connus.retenir(code);
    // Éteint : le client garde sa balise, la bulle disparaît, et la réponse est la même que pour un code inconnu.
    if (!widget.actif) return repondre(reply, SCRIPT_INERTE, CACHE_PUBLIC);

    let numero: PhoneNumberRecord | null;
    try {
      numero = await deps.numero(widget.tenantId);
    } catch (err) {
      journaliser('error', 'widget_numero_illisible', { err, code, tenantId: widget.tenantId });
      return repondre(reply, SCRIPT_INERTE, SANS_CACHE);
    }

    // 🔴 GRISÉE SEULEMENT SANS NUMÉRO OU SUR UN NUMÉRO DÉLIÉ, JAMAIS SUR `health_status` À `BLOCKED` : la règle et
    // sa mesure sont dans `lienDuWidget`, que la console lit aussi pour annoncer une bulle grisée.
    const lien = lienDuWidget(numero, widget.phrase);

    let config: ConfigScript;
    if (lien === null) {
      config = { etat: 'grise', position: widget.position };
    } else {
      let svgQr: string | null = null;
      try {
        svgQr = await deps.qrSvg(lien);
      } catch (err) {
        // Le panneau garde le lien : une bulle sans QR vaut mieux qu'une bulle absente.
        journaliser('error', 'widget_qr_echoue', { err, code, tenantId: widget.tenantId });
      }
      // Champ par champ, sans spread : voir l'en-tête de `src/widgets/script.ts`.
      config = {
        etat: 'servi',
        lien,
        svgQr,
        couleur: widget.couleur,
        position: widget.position,
        libelle: widget.libelle,
        avatarUrl: widget.avatarUrl,
        badge: widget.badge,
      };
    }
    return repondre(reply, construireScript(config), CACHE_PUBLIC);
  });
}
