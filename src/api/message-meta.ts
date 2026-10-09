import { z } from 'zod';
import { schemaClesFiche } from './fiche';

/**
 * L'ENVOI AU FORMAT DE META (lot 13, domaine 2, spec `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 4) :
 * l'objet message de la Cloud API, tel que la documentation de Meta le décrit, pour les types courants (décision de
 * Julien du 2026-10-09). Le corps validé part TEL QUEL chez Meta, son destinataire remplacé par l'adresse de la fiche.
 *
 * 🔴 Strict partout : un champ inconnu est refusé, sinon il partirait chez Meta sans que personne l'ait relu. Les
 * bornes sont celles de Meta, annoncées ici pour qu'un refus vienne de nous, avec le champ fautif, et pas d'un 400 de
 * Meta sans contexte. Les médias ne passent que par une URL publique https (`link`) : Meta va chercher le fichier, rien
 * ne transite chez nous. Le dépôt d'un fichier (un `id`) viendra plus tard.
 */

export const TYPES_MESSAGE_META = ['text', 'image', 'video', 'audio', 'document', 'location', 'reaction', 'interactive'] as const;
export type TypeMessageMeta = (typeof TYPES_MESSAGE_META)[number];

/** Les bornes de Meta, en un seul endroit : la doc et les tests les lisent ici. */
export const BORNES_META = {
  texte: 4096,
  legende: 1024,
  nomDeFichier: 240,
  url: 2048,
  lieuTexte: 1000,
  emoji: 16,
  identifiantMessage: 200,
  corpsInteractif: 1024,
  corpsListe: 4096,
  enTete: 60,
  pied: 60,
  boutons: 3,
  idBouton: 256,
  titreBouton: 20,
  libelleListe: 20,
  sections: 10,
  lignes: 10,
  titreSection: 24,
  idLigne: 200,
  titreLigne: 24,
  descriptionLigne: 72,
  libelleLien: 20,
} as const;

const B = BORNES_META;
const texte = (max: number) => z.string().min(1).max(max);
/** Une URL publique en https : Meta va la chercher, elle doit donc être joignable depuis Internet. */
const lienPublic = z.string().max(B.url).url().refine((u) => u.startsWith('https://'), { message: 'une adresse https:// est attendue' });

const mediaLegende = z.strictObject({ link: lienPublic, caption: texte(B.legende).optional() });

/**
 * 🔴 Les préfixes que le moteur des scénarios lit dans la réponse d'un bouton ou d'une ligne (`btn:`, `row:`, `card:`,
 * et `sortie:` qu'il pose lui-même, `src/workflow/executor.ts`) : un id choisi par le client qui en porterait un ferait
 * avancer un parcours en attente sur une branche qu'il n'a pas choisie.
 */
const PREFIXES_RESERVES = /^(btn:|row:|card:|sortie:)/;
const idLibre = (max: number) => texte(max).refine((v) => !PREFIXES_RESERVES.test(v), {
  message: 'les préfixes btn:, row:, card: et sortie: sont réservés aux scénarios',
});

/** Une coordonnée : un nombre, ou une chaîne décimale comme dans l'exemple de Meta, envoyée en nombre. */
const coordonnee = (max: number) => z.preprocess(
  (v) => (typeof v === 'string' && /^-?\d{1,3}(\.\d{1,20})?$/.test(v) ? Number(v) : v),
  z.number().min(-max).max(max),
);

const enTeteMedia = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: texte(B.enTete) }),
  z.strictObject({ type: z.literal('image'), image: z.strictObject({ link: lienPublic }) }),
  z.strictObject({ type: z.literal('video'), video: z.strictObject({ link: lienPublic }) }),
  z.strictObject({ type: z.literal('document'), document: z.strictObject({ link: lienPublic, filename: texte(B.nomDeFichier).optional() }) }),
]);
const pied = z.strictObject({ text: texte(B.pied) });

const boutons = z.strictObject({
  type: z.literal('button'),
  header: enTeteMedia.optional(),
  body: z.strictObject({ text: texte(B.corpsInteractif) }),
  footer: pied.optional(),
  action: z.strictObject({
    buttons: z.array(z.strictObject({
      type: z.literal('reply'),
      reply: z.strictObject({ id: idLibre(B.idBouton), title: texte(B.titreBouton) }),
    })).min(1).max(B.boutons),
  }),
}).superRefine((m, ctx) => {
  // Meta refuse deux boutons au même identifiant ou au même titre : c'est par eux que la réponse revient.
  const ids = m.action.buttons.map((b) => b.reply.id);
  const titres = m.action.buttons.map((b) => b.reply.title);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['action', 'buttons'], message: 'deux boutons ont le même id' });
  if (new Set(titres).size !== titres.length) ctx.addIssue({ code: 'custom', path: ['action', 'buttons'], message: 'deux boutons ont le même titre' });
});

const liste = z.strictObject({
  type: z.literal('list'),
  header: z.strictObject({ type: z.literal('text'), text: texte(B.enTete) }).optional(),
  body: z.strictObject({ text: texte(B.corpsListe) }),
  footer: pied.optional(),
  action: z.strictObject({
    button: texte(B.libelleListe),
    sections: z.array(z.strictObject({
      title: texte(B.titreSection).optional(),
      rows: z.array(z.strictObject({
        id: idLibre(B.idLigne), title: texte(B.titreLigne), description: texte(B.descriptionLigne).optional(),
      })).min(1),
    })).min(1).max(B.sections),
  }),
}).superRefine((m, ctx) => {
  const lignes = m.action.sections.flatMap((s) => s.rows);
  if (lignes.length > B.lignes) ctx.addIssue({ code: 'custom', path: ['action', 'sections'], message: `${B.lignes} lignes au plus, toutes sections confondues` });
  if (new Set(lignes.map((l) => l.id)).size !== lignes.length) ctx.addIssue({ code: 'custom', path: ['action', 'sections'], message: 'deux lignes ont le même id' });
  // Meta exige un titre à chaque section dès qu'il y en a plusieurs.
  if (m.action.sections.length > 1 && m.action.sections.some((s) => s.title === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['action', 'sections'], message: 'chaque section porte un title dès qu’il y en a plusieurs' });
  }
});

const lien = z.strictObject({
  type: z.literal('cta_url'),
  header: enTeteMedia.optional(),
  body: z.strictObject({ text: texte(B.corpsInteractif) }),
  footer: pied.optional(),
  action: z.strictObject({
    name: z.literal('cta_url'),
    parameters: z.strictObject({ display_text: texte(B.libelleLien), url: lienPublic }),
  }),
});

const interactif = z.discriminatedUnion('type', [boutons, liste, lien]);

/** Le contenu de chaque type, sous la clé qui porte son nom (le format de Meta). */
const CONTENUS = {
  text: z.strictObject({ body: texte(B.texte), preview_url: z.boolean().optional() }),
  image: mediaLegende,
  video: mediaLegende,
  // Meta n'accepte pas de légende sur un audio ; `voice` : un message vocal (lecture comme un vocal enregistré).
  audio: z.strictObject({ link: lienPublic, voice: z.boolean().optional() }),
  document: z.strictObject({ link: lienPublic, caption: texte(B.legende).optional(), filename: texte(B.nomDeFichier).optional() }),
  location: z.strictObject({
    latitude: coordonnee(90), longitude: coordonnee(180),
    name: texte(B.lieuTexte).optional(), address: texte(B.lieuTexte).optional(),
  }),
  // Un emoji vide RETIRE la réaction (comportement de Meta) : il est donc permis.
  reaction: z.strictObject({ message_id: texte(B.identifiantMessage), emoji: z.string().max(B.emoji) }),
  interactive: interactif,
} as const satisfies Record<TypeMessageMeta, z.ZodTypeAny>;

/** Les champs du contenu : le type, et un contenu possible par type, sous la clé qui porte son nom. */
const CHAMPS_CONTENU = {
  type: z.enum(TYPES_MESSAGE_META),
  text: CONTENUS.text.optional(),
  image: CONTENUS.image.optional(),
  video: CONTENUS.video.optional(),
  audio: CONTENUS.audio.optional(),
  document: CONTENUS.document.optional(),
  location: CONTENUS.location.optional(),
  reaction: CONTENUS.reaction.optional(),
  interactive: CONTENUS.interactive.optional(),
};

/** Le contenu est sous la clé du type, et SEULEMENT là : avec deux contenus, Meta n'en enverrait qu'un, sans le dire. */
function unSeulContenu(m: { type: TypeMessageMeta } & Partial<Record<TypeMessageMeta, unknown>>, ctx: z.RefinementCtx): void {
  for (const t of TYPES_MESSAGE_META) {
    const present = m[t] !== undefined;
    if (t === m.type && !present) ctx.addIssue({ code: 'custom', path: [t], message: `« ${t} » est requis pour un message de type ${t}` });
    if (t !== m.type && present) ctx.addIssue({ code: 'custom', path: [t], message: `« ${t} » n’a pas sa place dans un message de type ${m.type}` });
  }
}

/**
 * Le corps de `POST /v1/messages` : celui de Meta (`messaging_product`, `recipient_type`, `to`, `type` et le contenu
 * sous la clé du type), et, à la place de `to`, `contactId` ou `externalId` (décision de Julien). Strict.
 */
export const schemaMessageMeta = z.strictObject({
  messaging_product: z.literal('whatsapp').optional(),
  recipient_type: z.literal('individual').optional(),
  /**
   * Le numéro AVEC l'indicatif du pays, chiffres seulement, comme chez Meta (« 33612345678 ») ; le « + » est toléré. Lu
   * comme un numéro international, jamais comme un numéro français : `447911123456` est britannique.
   */
  to: z.string().regex(/^\+?\d{8,15}$/, { message: 'le numéro avec l’indicatif du pays, chiffres seulement (comme chez Meta)' }).optional(),
  // Les mêmes clés que les autres routes (`schemaClesFiche`) : un uuid, et l'identifiant externe jusqu'à 512 caractères.
  contactId: schemaClesFiche.shape.contactId,
  externalId: schemaClesFiche.shape.externalId,
  ...CHAMPS_CONTENU,
}).superRefine((m, ctx) => {
  unSeulContenu(m, ctx);
  if (m.to === undefined && m.contactId === undefined && m.externalId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'désignez la personne : to (son numéro), contactId ou externalId' });
  }
});

/**
 * Le message SANS destinataire : ce que Claude envoie dans une conversation (`send_message`), le même contenu.
 * `messaging_product` et `recipient_type` sont acceptés (un exemple de Meta recopié tel quel) et ne partent pas.
 */
export const schemaContenuMeta = z.strictObject({
  messaging_product: z.literal('whatsapp').optional(),
  recipient_type: z.literal('individual').optional(),
  ...CHAMPS_CONTENU,
}).superRefine(unSeulContenu);
export type ContenuMeta = z.infer<typeof schemaContenuMeta>;

/** Ce qui part chez Meta : le type et son contenu, rien d'autre (le destinataire est posé par le client Meta). */
export function corpsPourMeta(m: ContenuMeta): Record<string, unknown> {
  return { type: m.type, [m.type]: m[m.type] };
}

/**
 * Ce que l'Inbox affiche du message parti : le texte, la légende d'un média (sinon son type entre crochets, comme un
 * média reçu), le corps d'un interactif, le lieu, l'emoji d'une réaction.
 */
export function apercuDuMessage(m: ContenuMeta): string {
  switch (m.type) {
    case 'text': return m.text?.body ?? '';
    case 'image': return m.image?.caption ?? '[image]';
    case 'video': return m.video?.caption ?? '[vidéo]';
    case 'audio': return '[audio]';
    case 'document': return m.document?.caption ?? m.document?.filename ?? '[document]';
    case 'location': {
      const l = m.location;
      const lieu = [l?.name, l?.address].filter((x): x is string => typeof x === 'string' && x !== '').join(', ');
      return lieu !== '' ? `[lieu] ${lieu}` : `[lieu] ${l?.latitude ?? ''}, ${l?.longitude ?? ''}`;
    }
    case 'reaction': return m.reaction?.emoji ?? '';
    case 'interactive': {
      const i = m.interactive;
      if (!i) return '';
      if (i.type === 'button') return `${i.body.text}\n${i.action.buttons.map((b) => `[${b.reply.title}]`).join(' ')}`;
      if (i.type === 'list') return `${i.body.text}\n[${i.action.button}]`;
      return `${i.body.text}\n[${i.action.parameters.display_text}]`;
    }
  }
}
