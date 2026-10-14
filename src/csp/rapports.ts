import { z } from 'zod';

/**
 * LES RAPPORTS DE VIOLATION DE LA CSP DE LA CONSOLE, réduits à ce qu'on en garde (lot 6 du bilan des audits, B3).
 *
 * La console est en observation (`Content-Security-Policy-Report-Only`, `web/next.config.mjs`) : les navigateurs de nos
 * clients signalent ce que la politique interdirait une fois bloquante. Les e2e ne voient que ce qu'ils dessinent et
 * simulent les tiers (le SDK Meta, Google Sign-In) : seuls ces rapports disent ce qui se passe dans une vraie session.
 *
 * 🔴 RIEN DE PERSONNEL N'EN SORT. Un rapport porte l'adresse complète de la page (une requête peut contenir un jeton de
 * réinitialisation) et celle de la ressource bloquée : on n'en garde que le CHEMIN de la page, ses identifiants masqués,
 * et l'ORIGINE de ce qui a été bloqué (ou son mot-clé, `inline`, `eval`). Et seuls les rapports d'une page de NOS
 * origines comptent : n'importe qui peut poster un faux rapport, il ne doit pas remplir la table de son bruit.
 */
export interface RapportCsp {
  directive: string;
  bloque: string;
  page: string;
  disposition: 'report' | 'enforce';
}

/** Le plafond de lignes de la table : au-delà, une combinaison neuve n'entre plus, les existantes comptent toujours. */
export const MAX_LIGNES_CSP = 500;
/** Le plafond de rapports lus par requête : la Reporting API en regroupe plusieurs. */
export const MAX_RAPPORTS_PAR_REQUETE = 20;

const texte = (max: number) => z.string().max(max);

/** Le format historique (`report-uri`) : un objet sous la clé `csp-report`. */
const ReportUri = z.object({
  'csp-report': z.object({
    'document-uri': z.string(),
    'effective-directive': texte(200).optional(),
    'violated-directive': texte(200).optional(),
    'blocked-uri': z.string().optional(),
    disposition: texte(20).optional(),
  }),
});

/** La Reporting API (`report-to`) : une liste de rapports typés. */
const ReportTo = z.array(z.object({
  type: texte(60),
  body: z.object({
    documentURL: z.string().optional(),
    effectiveDirective: texte(200).optional(),
    blockedURL: z.string().optional(),
    disposition: texte(20).optional(),
  }),
})).max(100);

/**
 * Les règles qu'un navigateur peut nommer : une liste FERMÉE, pour qu'un faux rapport ne puisse pas inventer les siennes
 * (n'importe qui peut poster ici, la page déclarée n'est qu'une déclaration).
 */
export const DIRECTIVES_CSP = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr',
  'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src',
  'fenced-frame-src', 'form-action', 'frame-ancestors', 'base-uri', 'navigate-to', 'trusted-types', 'require-trusted-types-for',
]);
/** Les mots-clés que les navigateurs mettent à la place d'une adresse bloquée. */
const MOTS_CLES_BLOQUE = new Set(['inline', 'eval', 'wasm-eval', 'self', 'data', 'blob', 'trusted-types-policy', 'trusted-types-sink']);

/** Un segment de chemin qui ressemble à un identifiant (uuid, nombre, jeton) devient `:id`. */
const IDENTIFIANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{3,}|[0-9a-z_-]{24,})$/i;

export function normaliserChemin(chemin: string): string {
  const propre = chemin.split('/').map((s) => (IDENTIFIANT.test(s) ? ':id' : s)).join('/')
    // Hors de cet alphabet, rien ne se stocke tel quel : la table se lit par des requêtes écrites à la main.
    .replace(/[^A-Za-z0-9/_.:%~-]/g, '_');
  return (propre === '' ? '/' : propre).slice(0, 200);
}

/** L'origine de ce qui a été bloqué, ou son mot-clé (`inline`, `eval`, `data`, `blob`), jamais l'adresse entière. */
export function normaliserBloque(brut: string | undefined): string {
  const b = (brut ?? '').trim();
  if (b === '') return 'inconnu';
  try {
    const u = new URL(b);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol.slice(0, -1);
    const origine = `${u.protocol}//${u.host}`;
    return /^(https?|wss?):\/\/[a-z0-9.-]{1,180}(:\d{1,5})?$/.test(origine) ? origine : 'autre';
  } catch {
    return MOTS_CLES_BLOQUE.has(b) ? b : 'autre';
  }
}

function unRapport(
  document: string | undefined, directive: string | undefined, bloque: string | undefined, disposition: string | undefined,
  origines: readonly string[],
): RapportCsp | null {
  let page: URL;
  try {
    page = new URL(document ?? '');
  } catch {
    return null;
  }
  if (!origines.includes(page.origin)) return null;
  const regle = (directive ?? '').trim().split(/\s+/)[0]!.toLowerCase();
  if (!DIRECTIVES_CSP.has(regle)) return null;
  return {
    directive: regle,
    bloque: normaliserBloque(bloque),
    page: normaliserChemin(page.pathname),
    disposition: disposition === 'enforce' ? 'enforce' : 'report',
  };
}

/** Les rapports retenus d'un corps reçu, dans l'un ou l'autre format ; un corps illisible n'en donne aucun. */
export function extraireRapports(corps: unknown, origines: readonly string[]): RapportCsp[] {
  const uri = ReportUri.safeParse(corps);
  const bruts = uri.success
    ? [uri.data['csp-report']].map((r) => [r['document-uri'], r['effective-directive'] ?? r['violated-directive'], r['blocked-uri'], r.disposition] as const)
    : (() => {
      const to = ReportTo.safeParse(corps);
      return to.success
        ? to.data.filter((r) => r.type === 'csp-violation')
          .map((r) => [r.body.documentURL, r.body.effectiveDirective, r.body.blockedURL, r.body.disposition] as const)
        : [];
    })();
  const retenus: RapportCsp[] = [];
  for (const [document, directive, bloque, disposition] of bruts.slice(0, MAX_RAPPORTS_PAR_REQUETE)) {
    const r = unRapport(document, directive, bloque, disposition, origines);
    if (r) retenus.push(r);
  }
  return retenus;
}
