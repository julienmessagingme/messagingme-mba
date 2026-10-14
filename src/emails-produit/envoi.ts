import { journaliser } from '../lib/journal';
import { ResendError, type SendEmailInput } from '../support/resend';
import { estCoupable, modeleDe, type Langue, type TexteEmail } from './catalogue';
import { jetonDesinscription, lienDesinscription } from './desinscription';
import { jobEmailSchema, type JobEmail } from './emission';
import { rendre } from './rendu';
import type { EnvoiAFaire } from './store.pg';

/**
 * LE TRAVAIL DE LA FILE `emails-produit` (lot 7) : un job = UNE tentative d'un envoi du journal.
 *
 * Tout ce qui décide se relit AU MOMENT D'ENVOYER, jamais à l'émission (spec § « Une file du worker envoie ») :
 * l'interrupteur du modèle dans `/ops`, la désinscription de la personne, sa langue, son appartenance à l'espace, le
 * texte modifié. Changé entre l'émission et l'envoi : respecté.
 *
 * Un échec passager (429, 5xx de Resend, panne réseau) laisse l'envoi `a_envoyer` avec l'heure du prochain essai, que
 * le balayage du worker reprend ; après `DELAIS_REESSAI_MS.length` essais, ou sur un refus définitif de Resend (un 4xx
 * qui n'est pas 429), il passe `echec`. Aucune transaction n'est ouverte pendant l'appel.
 */

/** L'attente avant chaque nouvel essai : 5 min, 15 min, 1 h, 3 h. Au cinquième échec, l'envoi est un échec. */
export const DELAIS_REESSAI_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];

export interface DepsTravailEmail {
  pourEnvoi(tenantId: string, envoiId: string): Promise<EnvoiAFaire | null>;
  prendre(tenantId: string, envoiId: string, tentative: number): Promise<boolean>;
  noterEnvoye(tenantId: string, envoiId: string, resendId: string): Promise<void>;
  noterEchec(tenantId: string, envoiId: string, raison: string, reessayerLe: Date | null): Promise<void>;
  noterIgnore(tenantId: string, envoiId: string, raison: string): Promise<void>;
  /** L'interrupteur du modèle dans `/ops` (absent = actif). */
  actif(cle: string): Promise<boolean>;
  /** Le texte modifié dans `/ops` pour cette langue, `null` = le texte d'origine. */
  texteModifie(cle: string, langue: Langue): Promise<TexteEmail | null>;
  /** Resend, `null` = pas configuré sur l'instance : l'envoi est ignoré, rien n'échoue. */
  envoyer: ((m: Omit<SendEmailInput, 'from'>) => Promise<{ id: string }>) | null;
  /** Le secret des liens de désinscription (`AUTH_SECRET`). */
  secretDesinscription: string;
  /** La base publique de l'API, préfixe du proxy compris (`adressesPubliques(...).avecPrefixe`). */
  baseApi: string;
  now?: () => Date;
}

/** Un refus qu'un nouvel essai ne changera pas : un 4xx de Resend autre que 429 (adresse invalide, domaine...). */
function estDefinitif(err: unknown): boolean {
  return err instanceof ResendError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

function raisonDe(err: unknown): string {
  if (err instanceof ResendError) return `resend ${err.status} : ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function creerTravailEmail(d: DepsTravailEmail): (data: unknown) => Promise<void> {
  const maintenant = d.now ?? (() => new Date());
  return async (data) => {
    const lu = jobEmailSchema.safeParse(data);
    if (!lu.success) {
      journaliser('error', 'email_produit_job_illisible', { issues: lu.error.issues.length });
      return;
    }
    const job: JobEmail = lu.data;
    const e = await d.pourEnvoi(job.tenantId, job.envoiId);
    // Périmé : déjà parti, ignoré, en échec définitif, ou une autre tentative est passée avant ce job.
    if (e === null || e.statut !== 'a_envoyer' || e.tentatives !== job.tentative) return;

    const modele = modeleDe(e.cle);
    if (modele === null) return d.noterIgnore(e.tenantId, e.id, 'modele_inconnu');
    if (!(await d.actif(modele.cle))) return d.noterIgnore(e.tenantId, e.id, 'modele_coupe');
    if (estCoupable(modele.categorie) && e.desinscriptions.includes(modele.categorie)) {
      return d.noterIgnore(e.tenantId, e.id, 'desinscrit');
    }
    if (!e.membreActif) return d.noterIgnore(e.tenantId, e.id, 'plus_membre');
    if (d.envoyer === null) {
      journaliser('warn', 'email_produit_sans_resend', { tenantId: e.tenantId, cle: e.cle });
      return d.noterIgnore(e.tenantId, e.id, 'sans_resend');
    }
    if (!(await d.prendre(e.tenantId, e.id, job.tentative))) return;

    // 🔴 Tout ce qui suit la prise est dans le `try` : une exception hors de lui laisserait la ligne `a_envoyer` sous
    // bail, reprise toutes les dix minutes sans jamais finir en échec (relecture du lot 7).
    try {
      const texte = (await d.texteModifie(modele.cle, e.langue)) ?? modele.textes[e.langue];
      const desinscription = estCoupable(modele.categorie)
        ? lienDesinscription(d.baseApi, jetonDesinscription(e.identityId, modele.categorie, d.secretDesinscription))
        : undefined;
      const rendu = rendre(modele, texte, { ...e.valeurs, espace: e.espace }, e.langue, desinscription ? { desinscription } : {});
      const { id } = await d.envoyer({
        to: e.email,
        subject: rendu.sujet,
        text: rendu.text,
        html: rendu.html,
        ...(desinscription
          ? { headers: { 'List-Unsubscribe': `<${desinscription}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
          : {}),
        tags: [{ name: 'modele', value: modele.cle }],
        // Resend renvoie la même réponse pour la même clé pendant 24 h : un essai repris après un délai dépassé, alors
        // que Resend avait accepté, ne part pas deux fois.
        cleIdempotence: `emails-produit/${e.id}`,
      });
      await d.noterEnvoye(e.tenantId, e.id, id);
    } catch (err) {
      const faites = job.tentative + 1;
      const delai = DELAIS_REESSAI_MS[faites - 1];
      const reessayerLe = estDefinitif(err) || delai === undefined ? null : new Date(maintenant().getTime() + delai);
      journaliser(reessayerLe === null ? 'error' : 'warn', 'email_produit_echec', {
        err, tenantId: e.tenantId, cle: e.cle, tentative: faites, definitif: reessayerLe === null,
      });
      await d.noterEchec(e.tenantId, e.id, raisonDe(err), reessayerLe);
    }
  };
}

/** Le balayage : remet en file les envois jamais enfilés et ceux dont l'heure du prochain essai est passée. */
export async function reprendreLesEnvois(d: {
  aReprendre(limite: number): Promise<Array<{ id: string; tenantId: string; tentatives: number }>>;
  enfiler(job: JobEmail): Promise<void>;
}, limite = 200): Promise<number> {
  const lignes = await d.aReprendre(limite);
  for (const l of lignes) await d.enfiler({ envoiId: l.id, tenantId: l.tenantId, tentative: l.tentatives });
  return lignes.length;
}
