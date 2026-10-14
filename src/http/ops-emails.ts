import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { journaliser } from '../lib/journal';
import { ResendError, type SendEmailInput } from '../support/resend';
import {
  CATALOGUE, LANGUES, modeleDe, variablesDe, variablesInconnues, type Langue, type ModeleEmail, type TexteEmail,
} from '../emails-produit/catalogue';
import { rendre, valeursExemple } from '../emails-produit/rendu';
import type { PgEmailsProduitStore } from '../emails-produit/store.pg';
// Le même seuil que les autres écritures de `/ops` : importé, pas recopié.
import { MIN_NOTE } from './ops';

/**
 * LA SECTION « E-MAILS » DE /ops (lot 7, spec `docs/superpowers/specs/2026-10-14-emails-produit-design.md`) : Julien y
 * maîtrise les e-mails du produit. La liste des modèles avec leurs chiffres du mois, l'interrupteur de chacun, ses textes
 * français et anglais (sujet, texte, bouton), l'aperçu rendu et l'essai envoyé à sa propre adresse.
 *
 * Même autorité que le reste de `/ops` (la session d'exploitation nominative, second facteur relu à chaque requête),
 * même note obligatoire sur chaque écriture, signée de l'adresse de son auteur. Réglages GLOBAUX, sans `:tenantId` : un
 * texte vaut pour tous les espaces. 🔴 Une variable inconnue est refusée à l'enregistrement (422, la liste dite), jamais
 * découverte à l'envoi.
 */

export interface OpsEmailsDeps {
  store: Pick<PgEmailsProduitStore,
    'textesModifies' | 'texteModifie' | 'ecrireTexte' | 'retablir' | 'interrupteurs' | 'poserInterrupteur' | 'chiffresDuMois'>;
  /** Resend, `null` = pas configuré : l'essai rend 503, le reste marche. */
  envoyer: ((m: Omit<SendEmailInput, 'from'>) => Promise<{ id: string }>) | null;
}

/** Les bornes des CHECK de la migration 0234, pour refuser avant la base avec un message qui dit quoi. */
export const BORNES_TEXTE = { sujet: 200, corps: 5000, boutonLibelle: 60, boutonLien: 500 } as const;

const texteSchema = z.object({
  sujet: z.string().trim().min(1).max(BORNES_TEXTE.sujet),
  corps: z.string().trim().min(1).max(BORNES_TEXTE.corps),
  bouton: z.object({
    libelle: z.string().trim().min(1).max(BORNES_TEXTE.boutonLibelle),
    lien: z.string().trim().min(1).max(BORNES_TEXTE.boutonLien),
  }).nullable(),
});

const langueSchema = z.enum(LANGUES);
const parametresSchema = z.object({ cle: z.string().max(80), langue: langueSchema });
const noteDe = (corps: unknown): string => {
  const n = (corps as { note?: unknown } | null)?.note;
  return typeof n === 'string' ? n.trim().slice(0, 500) : '';
};

/** Un lien de bouton : une adresse http(s), ou une seule variable du modèle (`{{lien_credit}}`). */
function lienAcceptable(lien: string): boolean {
  return /^https?:\/\/\S+$/i.test(lien) || /^\{\{\s*[^{}\s]+\s*\}\}$/.test(lien);
}

/** Le texte d'un corps de requête, validé contre le modèle : 400 de forme, 422 de variable inconnue. */
function lireTexte(m: ModeleEmail, corps: unknown):
  | { ok: true; texte: TexteEmail }
  | { ok: false; code: 400 | 422; error: string; inconnues?: string[] } {
  const lu = texteSchema.safeParse(corps);
  if (!lu.success) {
    return {
      ok: false, code: 400,
      error: `texte invalide : sujet (1 à ${BORNES_TEXTE.sujet}), texte (1 à ${BORNES_TEXTE.corps}), bouton facultatif (libellé 1 à ${BORNES_TEXTE.boutonLibelle}, lien 1 à ${BORNES_TEXTE.boutonLien})`,
    };
  }
  const texte: TexteEmail = lu.data;
  if (texte.bouton && !lienAcceptable(texte.bouton.lien)) {
    return { ok: false, code: 400, error: 'le lien du bouton doit être une adresse https:// ou une variable du modèle' };
  }
  const inconnues = variablesInconnues(m, texte);
  if (inconnues.length > 0) {
    return { ok: false, code: 422, error: `variable inconnue de ce modèle : ${inconnues.join(', ')}`, inconnues };
  }
  return { ok: true, texte };
}

export function registerOpsEmails(app: FastifyInstance, deps: OpsEmailsDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };

  /** Le texte en vigueur d'un modèle dans une langue : celui de `/ops`, sinon celui d'origine. */
  const texteEnVigueur = async (m: ModeleEmail, langue: Langue): Promise<TexteEmail> =>
    (await deps.store.texteModifie(m.cle, langue)) ?? m.textes[langue];

  app.get('/ops/emails', opts, async (_req, reply) => {
    const [modifies, interrupteurs, chiffres] = await Promise.all([
      deps.store.textesModifies(), deps.store.interrupteurs(), deps.store.chiffresDuMois(),
    ]);
    const chiffresPar = new Map(chiffres.map((c) => [c.cle, c]));
    const modeles = CATALOGUE.map((m) => {
      const textes = Object.fromEntries(LANGUES.map((l) => {
        const mod = modifies.find((t) => t.cle === m.cle && t.langue === l);
        return [l, {
          origine: m.textes[l],
          modifie: mod ? { sujet: mod.sujet, corps: mod.corps, bouton: mod.bouton, par: mod.modifiePar, le: mod.modifieLe.toISOString() } : null,
        }];
      }));
      const inter = interrupteurs.get(m.cle);
      return {
        cle: m.cle, categorie: m.categorie, nom: m.nom, quand: m.quand,
        variables: Object.entries(variablesDe(m)).map(([nom, v]) => ({ nom, description: v.description, forme: v.forme })),
        actif: inter?.actif ?? true,
        interrupteur: inter ? { par: inter.modifiePar, le: inter.modifieLe.toISOString() } : null,
        textes,
        chiffres: chiffresPar.get(m.cle) ?? {
          cle: m.cle, emis: 0, envoyes: 0, echecs: 0, ignores: 0, livres: 0, ouverts: 0, cliques: 0, rebonds: 0, plaintes: 0,
        },
      };
    });
    return reply.code(200).send({ modeles, essaiPossible: deps.envoyer !== null, bornes: BORNES_TEXTE });
  });

  app.put('/ops/emails/:cle/:langue', opts, async (req, reply) => {
    const p = parametresSchema.safeParse(req.params);
    const m = p.success ? modeleDe(p.data.cle) : null;
    if (!p.success || m === null) return reply.code(404).send({ error: 'modèle inconnu' });
    const note = noteDe(req.body);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce texte' });
    const t = lireTexte(m, req.body);
    if (!t.ok) return reply.code(t.code).send({ error: t.error, ...(t.inconnues ? { inconnues: t.inconnues } : {}) });
    const par = auteurOps(req);
    await deps.store.ecrireTexte(m.cle, p.data.langue, t.texte, par);
    journaliser('warn', 'ops_email_texte', { cle: m.cle, langue: p.data.langue, par, note, at: new Date().toISOString() });
    return reply.code(200).send({ ok: true });
  });

  app.post('/ops/emails/:cle/:langue/retablir', opts, async (req, reply) => {
    const p = parametresSchema.safeParse(req.params);
    const m = p.success ? modeleDe(p.data.cle) : null;
    if (!p.success || m === null) return reply.code(404).send({ error: 'modèle inconnu' });
    const note = noteDe(req.body);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi rétablir' });
    const etait = await deps.store.retablir(m.cle, p.data.langue);
    journaliser('warn', 'ops_email_retabli', { cle: m.cle, langue: p.data.langue, etait, par: auteurOps(req), note, at: new Date().toISOString() });
    return reply.code(200).send({ ok: true, etait });
  });

  app.put('/ops/emails/:cle/actif', opts, async (req, reply) => {
    const cle = (req.params as { cle?: unknown }).cle;
    const m = typeof cle === 'string' ? modeleDe(cle) : null;
    if (m === null) return reply.code(404).send({ error: 'modèle inconnu' });
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif (vrai ou faux) requis' });
    const note = noteDe(req.body);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: actif ? 'note requise : pourquoi le rallumer' : 'note requise : pourquoi le couper' });
    const par = auteurOps(req);
    await deps.store.poserInterrupteur(m.cle, actif, par);
    journaliser('warn', 'ops_email_interrupteur', { cle: m.cle, actif, par, note, at: new Date().toISOString() });
    return reply.code(200).send({ ok: true, actif });
  });

  /**
   * L'aperçu d'un texte : celui du corps s'il est donné (le brouillon de l'écran), sinon celui en vigueur, rendu avec
   * les valeurs d'exemple du modèle. N'écrit rien.
   */
  app.post('/ops/emails/:cle/apercu', opts, async (req, reply) => {
    const cle = (req.params as { cle?: unknown }).cle;
    const m = typeof cle === 'string' ? modeleDe(cle) : null;
    if (m === null) return reply.code(404).send({ error: 'modèle inconnu' });
    const corps = (req.body ?? {}) as { langue?: unknown; texte?: unknown };
    const langue = langueSchema.safeParse(corps.langue);
    if (!langue.success) return reply.code(400).send({ error: 'langue (fr ou en) requise' });
    let texte: TexteEmail;
    if (corps.texte === undefined || corps.texte === null) {
      texte = await texteEnVigueur(m, langue.data);
    } else {
      const t = lireTexte(m, corps.texte);
      if (!t.ok) return reply.code(t.code).send({ error: t.error, ...(t.inconnues ? { inconnues: t.inconnues } : {}) });
      texte = t.texte;
    }
    const exemple = m.categorie === 'service' ? {} : { desinscription: 'https://api.messagingme.app/e/desinscription/exemple' };
    const r = rendre(m, texte, valeursExemple(m), langue.data, exemple);
    return reply.code(200).send({ sujet: r.sujet, text: r.text, html: r.html });
  });

  /**
   * L'essai : le texte en vigueur (ou le brouillon), rendu avec les valeurs d'exemple, envoyé à l'adresse de
   * l'exploitant connecté, et à elle seule. Hors du journal : un essai ne compte pas dans les chiffres. 4xx, jamais 5xx,
   * sur un refus de Resend : Cloudflare remplacerait le corps, et l'exploitant ne saurait pas ce que Resend a dit.
   */
  app.post('/ops/emails/:cle/essai', opts, async (req, reply) => {
    const cle = (req.params as { cle?: unknown }).cle;
    const m = typeof cle === 'string' ? modeleDe(cle) : null;
    if (m === null) return reply.code(404).send({ error: 'modèle inconnu' });
    if (deps.envoyer === null) return reply.code(503).send({ error: 'Resend n’est pas configuré sur ce serveur' });
    const corps = (req.body ?? {}) as { langue?: unknown; texte?: unknown };
    const langue = langueSchema.safeParse(corps.langue);
    if (!langue.success) return reply.code(400).send({ error: 'langue (fr ou en) requise' });
    let texte: TexteEmail;
    if (corps.texte === undefined || corps.texte === null) {
      texte = await texteEnVigueur(m, langue.data);
    } else {
      const t = lireTexte(m, corps.texte);
      if (!t.ok) return reply.code(t.code).send({ error: t.error, ...(t.inconnues ? { inconnues: t.inconnues } : {}) });
      texte = t.texte;
    }
    const a = auteurOps(req);
    const r = rendre(m, texte, valeursExemple(m), langue.data);
    try {
      await deps.envoyer({ to: a, subject: `[Essai] ${r.sujet}`, text: r.text, html: r.html, tags: [{ name: 'modele', value: `essai_${m.cle}` }] });
    } catch (err) {
      journaliser('error', 'ops_email_essai_refuse', { err, cle: m.cle, par: a });
      return reply.code(422).send({ error: err instanceof ResendError ? `Resend a refusé : ${err.message}` : 'Resend injoignable' });
    }
    journaliser('info', 'ops_email_essai', { cle: m.cle, langue: langue.data, par: a });
    return reply.code(200).send({ ok: true, a });
  });
}
