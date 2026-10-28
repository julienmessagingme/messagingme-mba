import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appliquerConsentement, depsConsentementDe, type DepsConsentement } from '../api/consentement';
import type { AuditSink } from '../audit/journal';
import { RateLimiter } from '../auth/rate-limit';
import { e164DepuisSaisie } from '../crm/phone';
import type { ContactUpsert } from '../crm/import';
import { texteDe } from '../lib/erreur';
import { ipIndicative } from '../ops/tentatives';
import { VITRINE, langueDe, routesDeFormulaire, uneLigne, type Langue } from './contact-vitrine';

/**
 * Le formulaire du livre blanc « Recruter sur WhatsApp » (vitrine, `site/livre-blanc/whatsapp-education/`). Spec :
 * `docs/superpowers/specs/2026-10-28-livre-blanc-education-design.md`.
 *
 * Même mécanique que `/vitrine/contact` : formulaire HTML natif, redirection 303 vers une page écrite ici. Chaque envoi
 * part dans HubSpot (le formulaire HubSpot de Messaging Me), et dans SANDBOX quand le visiteur a coché la case WhatsApp
 * et donné un mobile lisible.
 *
 * 🔴 LE VISITEUR A SON PDF DANS TOUS LES CAS. Ni une panne de HubSpot, ni un refus de SANDBOX, ni le plafond ne le
 * privent du téléchargement : la page « merci » porte le lien. Seul un formulaire invalide revient au formulaire.
 * 🔴 AUCUN PROSPECT PERDU EN SILENCE : HubSpot qui échoue (ou n'est pas configuré) fait partir le prospect par courriel
 * à l'équipe, par le même envoi que le formulaire de contact.
 */

export const PAGES_LIVRE_BLANC = {
  fr: { formulaire: '/livre-blanc/whatsapp-education/', merci: '/livre-blanc/whatsapp-education/merci/' },
  en: { formulaire: '/en/white-paper/whatsapp-education/', merci: '/en/white-paper/whatsapp-education/thanks/' },
} as const satisfies Record<Langue, { formulaire: string; merci: string }>;

/** Le tag sur lequel Julien lance ses scénarios de relance, dans SANDBOX. */
export const TAG_LIVRE_BLANC = 'livre-blanc-education';
/** D'où vient le consentement, lu sur la fiche (même forme que `webhook:<nom>`). */
export const SOURCE_CONSENTEMENT = 'vitrine:livre-blanc-education';

const ligne = (max: number) => z.string().transform(uneLigne).pipe(z.string().min(1).max(max));
const Demande = z.object({
  prenom: ligne(80),
  nom: ligne(80),
  email: z.string().transform(uneLigne).pipe(z.email().max(254)),
  etablissement: ligne(160),
  fonction: ligne(120),
  mobile: z.string().default('').transform(uneLigne).pipe(z.string().max(40)),
  /** La case « recontact sur WhatsApp » : absente si décochée, « oui » si cochée. */
  whatsapp: z.literal('oui').optional(),
  /** Le pot de miel : caché à l'écran, seul un robot le remplit. */
  site: z.string().default(''),
});
export type DemandeLivreBlanc = z.infer<typeof Demande>;

type Courriel = { sujet: string; texte: string; repondreA: string };

export interface LivreBlancVitrineDeps {
  /** null quand le formulaire HubSpot n'est pas configuré : chaque prospect part alors par courriel. Lève sur échec. */
  hubspot: { soumettre(d: DemandeLivreBlanc, langue: Langue): Promise<void> } | null;
  /** null quand aucun espace de dépôt n'est configuré. Lève sur échec (offre pleine, panne). */
  sandbox: { deposer(d: { nom: string; telephoneE164: string }): Promise<void> } | null;
  /** Le courriel de secours, le même envoi que le formulaire de contact. */
  secours: { enabled: boolean; envoyer(c: Courriel): Promise<void> };
}

/** Le prospect, par courriel, quand HubSpot ne l'a pas reçu. L'adresse est celle que le visiteur a TAPÉE. */
export function courrielDeSecours(d: DemandeLivreBlanc, langue: Langue): Courriel {
  return {
    sujet: `[Livre blanc éducation] ${d.prenom} ${d.nom}, ${d.etablissement}`,
    texte: [
      'Téléchargement du livre blanc « Recruter sur WhatsApp ». HubSpot ne l’a pas reçu : à saisir à la main.',
      '',
      `Prénom : ${d.prenom}`,
      `Nom : ${d.nom}`,
      `E-mail : ${d.email} (saisi par le visiteur, non vérifié)`,
      `Établissement : ${d.etablissement}`,
      `Fonction : ${d.fonction}`,
      `Mobile : ${d.mobile || 'non renseigné'}`,
      `Recontact sur WhatsApp : ${d.whatsapp === 'oui' ? 'accepté' : 'non'}`,
      ...(langue === 'en' ? ['Langue : anglais (page anglaise de la vitrine)'] : []),
    ].join('\n'),
    repondreA: d.email,
  };
}

/**
 * Le dépôt dans SANDBOX, comme `/v1/contacts` : la fiche par l'écriture de l'API publique (tags fusionnés, limite de
 * l'offre appliquée), puis le consentement par l'écriture dédiée, qui en laisse la trace `contact.optin` dans le
 * journal d'audit de l'espace, avec sa source. Un STOP n'y est PAS levé (`refuse`) : une case cochée ne réabonne pas
 * quelqu'un qui a dit STOP. Aucun événement d'automation n'est émis : rien ne part tout seul, les relances se lancent
 * sur le tag.
 */
export function depotSandbox(
  contacts: Pick<DepsConsentement, 'ecrireConsentementParId'> & {
    upsertByPhoneReturningId(c: ContactUpsert): Promise<{ id: string }>;
  },
  audit: AuditSink,
  tenantId: string,
): NonNullable<LivreBlancVitrineDeps['sandbox']> {
  const consentement = depsConsentementDe(contacts, audit);
  return {
    deposer: async ({ nom, telephoneE164 }) => {
      const { id } = await contacts.upsertByPhoneReturningId({
        tenantId, phoneE164: telephoneE164, profileName: nom, fields: {}, optInStatus: 'unknown', tags: [TAG_LIVRE_BLANC],
      });
      await appliquerConsentement(consentement, tenantId, id, 'opted_in', SOURCE_CONSENTEMENT);
    },
  };
}

/** Le point d'envoi public de l'API Forms de HubSpot : sans jeton, l'identifiant du formulaire suffit. */
export const SOUMISSION_HUBSPOT = 'https://api.hsforms.com/submissions/v3/integration/submit';
/** Au-delà, le prospect part par courriel : le visiteur attend sa page « merci » pendant l'appel. */
export const DELAI_HUBSPOT_MS = 8_000;

/**
 * Le nom interne de la propriété de contact HubSpot, champ par champ. 🔴 Le formulaire HubSpot doit les porter TOUS :
 * le point d'envoi public refuse un champ absent de sa définition (`FIELD_NOT_IN_FORM_DEFINITION`), et la soumission
 * partirait alors en courriel de secours à chaque fois. `recontact_whatsapp` est une propriété créée pour ce formulaire
 * (case à cocher unique : « true » ou « false »).
 */
export const CHAMPS_HUBSPOT = {
  prenom: 'firstname', nom: 'lastname', email: 'email', etablissement: 'company', fonction: 'jobtitle',
  mobile: 'mobilephone', whatsapp: 'recontact_whatsapp',
} as const;

/** Les `errorType` d'une réponse d'erreur de HubSpot (`FIELD_NOT_IN_FORM_DEFINITION`...), rien d'autre de son corps. */
const ReponseDErreur = z.object({ errors: z.array(z.object({ errorType: z.string().max(80) })).max(20) });
function typesDErreur(corps: string): string {
  let brut: unknown;
  try { brut = JSON.parse(corps); } catch { return ''; }
  const lu = ReponseDErreur.safeParse(brut);
  return lu.success && lu.data.errors.length > 0 ? ` : ${[...new Set(lu.data.errors.map((e) => e.errorType))].join(', ')}` : '';
}

/** La soumission au formulaire HubSpot. Lève sur tout statut autre que 2xx, et au-delà de `DELAI_HUBSPOT_MS`. */
export function soumissionHubspot(
  o: { portail: string; formulaire: string },
  envoyer: typeof fetch = fetch,
  vitrine: string = VITRINE,
): NonNullable<LivreBlancVitrineDeps['hubspot']> {
  return {
    soumettre: async (d, langue) => {
      const valeurs: Record<keyof typeof CHAMPS_HUBSPOT, string> = {
        prenom: d.prenom, nom: d.nom, email: d.email, etablissement: d.etablissement, fonction: d.fonction,
        mobile: d.mobile, whatsapp: d.whatsapp === 'oui' ? 'true' : 'false',
      };
      const fields = (Object.keys(valeurs) as Array<keyof typeof CHAMPS_HUBSPOT>)
        .filter((cle) => valeurs[cle] !== '')
        .map((cle) => ({ objectTypeId: '0-1', name: CHAMPS_HUBSPOT[cle], value: valeurs[cle] }));
      const res = await envoyer(`${SOUMISSION_HUBSPOT}/${encodeURIComponent(o.portail)}/${encodeURIComponent(o.formulaire)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fields,
          context: { pageUri: `${vitrine}${PAGES_LIVRE_BLANC[langue].formulaire}`, pageName: 'Livre blanc « Recruter sur WhatsApp »' },
        }),
        signal: AbortSignal.timeout(DELAI_HUBSPOT_MS),
      });
      // HubSpot est un hôte fixe et de confiance : son corps se lit d'un coup. Seuls ses types d'erreur passent dans le
      // message, qui finit au journal : le corps peut citer l'e-mail que le visiteur a saisi.
      if (!res.ok) throw new Error(`HubSpot HTTP ${res.status}${typesDErreur(await res.text())}`);
    },
  };
}

// eslint-disable-next-line no-console
const journal =(msg: string, err?: unknown) => console.error(JSON.stringify({ lvl: 'error', msg, ...(err === undefined ? {} : { err: texteDe(err) }) }));

export function registerLivreBlancVitrine(app: FastifyInstance, deps: LivreBlancVitrineDeps, vitrine: string = VITRINE): void {
  /**
   * Deux plafonds, et ils ne refusent pas le PDF : au-delà, le visiteur a sa page « merci » mais rien n'est transmis.
   * Par adresse (l'en-tête de Cloudflare, `ipIndicative`) pour qu'un robot ne remplisse pas HubSpot ; un plafond global
   * seul, comme celui du formulaire de contact, bloquerait les vrais visiteurs d'une campagne. Vingt par adresse, pas
   * cinq : tout un campus sort par une seule adresse, et HubSpot dédoublonne par e-mail. La clé étant choisie par
   * l'appelant, la table est bornée (`maxCles`, règle de `rate-limit.ts`). Le global reste en filet.
   */
  const parAdresse = new RateLimiter(20, 10 * 60_000, undefined, 20_000);
  const enTout = new RateLimiter(200, 10 * 60_000);

  routesDeFormulaire(app, (portee) => {
    portee.post('/vitrine/livre-blanc', async (req, reply) => {
      const langue = langueDe(req.body);
      const pages = PAGES_LIVRE_BLANC[langue];
      const merci = () => reply.redirect(`${vitrine}${pages.merci}`, 303);

      const lu = Demande.safeParse(req.body);
      if (!lu.success) return reply.redirect(`${vitrine}${pages.formulaire}?erreur=champs#formulaire`, 303);
      // Au robot, la même réponse qu'à un humain : lui dire qu'on l'a repéré lui apprendrait à contourner.
      if (lu.data.site !== '') return merci();
      if (!parAdresse.take(ipIndicative(req))) {
        journal('livre_blanc_plafond_adresse');
        return merci();
      }
      if (!enTout.take('livre-blanc')) {
        journal('livre_blanc_plafond_global');
        return merci();
      }

      const d = lu.data;
      const mobile = d.whatsapp === 'oui' && d.mobile !== '' ? e164DepuisSaisie(d.mobile) : null;
      const [hubspot, sandbox] = await Promise.allSettled([
        deps.hubspot ? deps.hubspot.soumettre(d, langue) : Promise.reject(new Error('formulaire HubSpot non configuré')),
        mobile && deps.sandbox ? deps.sandbox.deposer({ nom: `${d.prenom} ${d.nom}`, telephoneE164: mobile }) : Promise.resolve(),
      ]);
      if (sandbox.status === 'rejected') journal('livre_blanc_sandbox_echec', sandbox.reason);
      if (hubspot.status === 'rejected') {
        journal('livre_blanc_hubspot_echec', hubspot.reason);
        try {
          if (!deps.secours.enabled) throw new Error('courriel de secours non configuré');
          await deps.secours.envoyer(courrielDeSecours(d, langue));
        } catch (err) {
          journal('livre_blanc_prospect_perdu', err);
        }
      }
      return merci();
    });
  });
}
