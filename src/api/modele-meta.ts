import { z } from 'zod';
import { isValidTemplateLanguage } from '../meta/languages';
import { isSendableButtonUrl } from '../../web/lib/partage/button-url';
import type { CreateTemplateInput, TemplateButton } from '../meta/templates';

/**
 * LA CRÉATION D'UN MODÈLE AU FORMAT DE META (lot 13, domaine 3, spec `docs/superpowers/specs/2026-10-08-api-complete-design.md`
 * § 5) : le corps de la Cloud API (`name`, `language`, `category`, `components`), pour les modèles utility et marketing
 * (décision de Julien du 2026-10-09), TRADUIT vers la création de la console (`versModeleConsole`) : les liens tracés et les
 * gardes de la console s'appliquent, rien ne part chez Meta sans passer par elles.
 *
 * 🔴 Strict partout : un champ inconnu est refusé. Les bornes sont celles de Meta, annoncées ici pour qu'un refus vienne de
 * nous, avec le champ fautif. Un seul écart au format de Meta, et il est dit : l'en-tête image, vidéo ou document se donne
 * par l'ADRESSE du fichier (`example.header_url`), que notre serveur télécharge et dépose chez Meta. Un `header_handle`
 * obtenu par une autre application ne vaudrait rien chez nous.
 *
 * Hors lot : carrousel, bouton Flow, téléphone ou copie de code, variables nommées, variable dans l'en-tête, variable
 * `{{1}}` dans l'adresse d'un bouton (le lien est tracé par nous ; les champs `{cle}` de la console restent admis).
 */

/** Les bornes de Meta, en un seul endroit : la doc et les tests les lisent ici. */
export const BORNES_MODELE = {
  nom: 512,
  enTete: 60,
  corps: 1024,
  pied: 60,
  exemple: 200,
  boutons: 10,
  boutonsLien: 2,
  texteBouton: 25,
  url: 2000,
} as const;

const B = BORNES_MODELE;
const texte = (max: number) => z.string().min(1).max(max);
const sansVariable = /\{\{/;
/** Une URL publique en https : notre serveur ou Meta la lit, elle doit être joignable depuis Internet. */
const lienPublic = z.string().max(B.url).url().refine((u) => u.startsWith('https://'), { message: 'une adresse https:// est attendue' });

const enTete = z.strictObject({
  type: z.literal('HEADER'),
  format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
  text: texte(B.enTete).optional(),
  example: z.strictObject({
    header_url: z.array(lienPublic).length(1).optional(),
    // Lu pour le refuser avec une phrase utile, plutôt qu'en clé inconnue.
    header_handle: z.unknown().optional(),
  }).optional(),
}).superRefine((h, ctx) => {
  if (h.example?.header_handle !== undefined) {
    ctx.addIssue({
      code: 'custom', path: ['example', 'header_handle'],
      message: 'donnez l’adresse https du fichier dans example.header_url : nous le déposons chez Meta',
    });
  }
  if (h.format === 'TEXT') {
    if (h.text === undefined) ctx.addIssue({ code: 'custom', path: ['text'], message: 'le texte de l’en-tête est requis' });
    else if (sansVariable.test(h.text)) ctx.addIssue({ code: 'custom', path: ['text'], message: 'pas de variable dans l’en-tête : un texte fixe' });
    if (h.example?.header_url !== undefined) ctx.addIssue({ code: 'custom', path: ['example'], message: 'un en-tête texte n’a pas de fichier' });
    return;
  }
  if (h.text !== undefined) ctx.addIssue({ code: 'custom', path: ['text'], message: 'un en-tête média n’a pas de texte' });
  if (h.example?.header_url === undefined && h.example?.header_handle === undefined) {
    ctx.addIssue({ code: 'custom', path: ['example', 'header_url'], message: 'l’adresse https du fichier est requise dans example.header_url' });
  }
});

/** Les positions `{{n}}` du texte. Une variable nommée (`{{prenom}}`) est repérée à part, pour la refuser en clair. */
const positions = (t: string): number[] => [...t.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
const variableNommee = /\{\{\s*[^\d\s}][^}]*\}\}/;

const corps = z.strictObject({
  type: z.literal('BODY'),
  text: texte(B.corps),
  example: z.strictObject({ body_text: z.array(z.array(z.string().max(B.exemple))).length(1) }).optional(),
}).superRefine((c, ctx) => {
  if (variableNommee.test(c.text)) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'variables nommées hors lot : écrivez {{1}}, {{2}}…' });
    return;
  }
  const vues = new Set(positions(c.text));
  const n = vues.size === 0 ? 0 : Math.max(...vues);
  if (n === 0) return;
  // Meta exige des variables qui se suivent ; `{{1}} {{3}}` attendrait trois valeurs à l'envoi et n'en recevrait que deux.
  if (vues.size !== n || vues.has(0)) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'les variables doivent être contiguës à partir de {{1}}' });
    return;
  }
  const exemples = c.example?.body_text[0];
  if (exemples === undefined) {
    ctx.addIssue({ code: 'custom', path: ['example'], message: `${n} variable(s) : example.body_text est requis, une valeur par variable` });
    return;
  }
  if (exemples.length !== n) {
    ctx.addIssue({ code: 'custom', path: ['example', 'body_text', 0], message: `${n} exemple(s) attendu(s), un par variable` });
    return;
  }
  // Meta refuse un exemple vide (132012).
  const vide = exemples.findIndex((e) => e.trim() === '');
  if (vide >= 0) ctx.addIssue({ code: 'custom', path: ['example', 'body_text', 0, vide], message: 'un exemple ne peut pas être vide' });
});

const pied = z.strictObject({
  type: z.literal('FOOTER'),
  text: texte(B.pied).refine((t) => !sansVariable.test(t), { message: 'pas de variable dans le pied de page' }),
});

const bouton = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('QUICK_REPLY'), text: texte(B.texteBouton) }),
  z.strictObject({
    type: z.literal('URL'),
    text: texte(B.texteBouton),
    url: lienPublic
      .refine((u) => !sansVariable.test(u), { message: 'pas de {{1}} dans l’adresse : le lien est tracé par nous, et les champs {cle} de la console sont admis' })
      .refine(isSendableButtonUrl, { message: 'adresse de bouton invalide' }),
  }),
]);

const boutons = z.strictObject({
  type: z.literal('BUTTONS'),
  buttons: z.array(bouton).min(1).max(B.boutons),
}).superRefine((b, ctx) => {
  if (b.buttons.filter((x) => x.type === 'URL').length > B.boutonsLien) {
    ctx.addIssue({ code: 'custom', path: ['buttons'], message: `${B.boutonsLien} boutons lien au plus` });
  }
});

const composant = z.discriminatedUnion('type', [enTete, corps, pied, boutons]);

export const schemaModeleMeta = z.strictObject({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, { message: 'minuscules, chiffres et _ seulement (comme chez Meta), 512 caractères au plus' }),
  language: z.string().refine(isValidTemplateLanguage, { message: 'langue hors de la liste WhatsApp (fr, en_US, es…)' }),
  category: z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(['UTILITY', 'MARKETING'])),
  parameter_format: z.literal('POSITIONAL').optional(),
  components: z.array(composant).min(1).max(4),
}).superRefine((m, ctx) => {
  const vus = new Set<string>();
  for (const [i, c] of m.components.entries()) {
    if (vus.has(c.type)) ctx.addIssue({ code: 'custom', path: ['components', i], message: `${c.type} ne peut figurer qu’une seule fois` });
    vus.add(c.type);
  }
  if (!vus.has('BODY')) ctx.addIssue({ code: 'custom', path: ['components'], message: 'un composant BODY est requis' });
});

export type ModeleMeta = z.infer<typeof schemaModeleMeta>;

/** Ce que la console sait créer, plus l'en-tête média qui reste à déposer chez Meta avant (`entete-par-url.ts`). */
export interface ModeleTraduit {
  input: CreateTemplateInput;
  enteteMedia?: { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; url: string };
}

/** La traduction vers `CreateTemplateInput`, sur un corps déjà validé par `schemaModeleMeta`. */
export function versModeleConsole(m: ModeleMeta): ModeleTraduit {
  const de = <T extends ModeleMeta['components'][number]['type']>(t: T) =>
    m.components.find((c): c is Extract<ModeleMeta['components'][number], { type: T }> => c.type === t);
  const h = de('HEADER');
  const c = de('BODY')!;
  const p = de('FOOTER');
  const b = de('BUTTONS');
  const exemple = c.example?.body_text[0];
  const input: CreateTemplateInput = {
    name: m.name, language: m.language, category: m.category, body: c.text,
    ...(h?.format === 'TEXT' && h.text !== undefined ? { header: { format: 'TEXT' as const, text: h.text } } : {}),
    ...(exemple && positions(c.text).length > 0 ? { example: exemple } : {}),
    ...(p ? { footer: p.text } : {}),
    ...(b ? {
      buttons: b.buttons.map((x): TemplateButton => (x.type === 'URL' ? { type: 'URL', text: x.text, url: x.url } : { type: 'QUICK_REPLY', text: x.text })),
    } : {}),
  };
  const url = h?.example?.header_url?.[0];
  return h && h.format !== 'TEXT' && url !== undefined ? { input, enteteMedia: { format: h.format, url } } : { input };
}
