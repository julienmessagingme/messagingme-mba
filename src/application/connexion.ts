import { refus, type Issue } from '../lib/issue';
import type { ClientApplication } from './client';
import type { CompteApplication, ComptesApplication, RefusPreparation, StatutCompte } from './comptes';

/**
 * RELIER UN COMPTE DE L'APPLICATION WHATSAPP BUSINESS (plan 2026-10-22, tâche 6), depuis la page du lien. La page appelle
 * `relierApplication` à l'ouverture (et pour un QR code neuf), puis relit `qrApplication` jusqu'à « relié ».
 *
 * Son propre numéro : Claude a préparé le compte (`start_whatsapp_connection`, qui reçoit le numéro). Un numéro fourni :
 * le compte se prépare ici, sur le numéro que la réserve a attribué à l'espace après le paiement.
 */
export interface DepsConnexionApplication {
  comptes: Pick<ComptesApplication, 'parEspace' | 'preparer'>;
  /** `null` : le service n'est pas configuré, la filière est fermée. */
  client: ClientApplication | null;
  /** Le numéro de la réserve attribué à l'espace, s'il y en a un (`PgNumerosFournisStore.numeroDeLEspace`). */
  numeroFourni(tenantId: string): Promise<{ id: string; numero: string } | null>;
  /** Le crédit offert au premier numéro (une fois par espace et par numéro). Ne lève jamais. */
  offrirCredit(tenantId: string): Promise<void>;
  /** Le QR code en image (`data:` d'un SVG), pour la page. */
  qrEnImage(texte: string): Promise<string>;
}

const SANS_NUMERO = 'Aucun numéro à relier pour cet espace : redemandez le lien à Claude, dans Claude Code, avec votre numéro.';
const SERVICE_FERME = 'La connexion de l’application WhatsApp Business n’est pas disponible pour le moment : réessayez dans un instant.';
const DEJA_RELIE = 'Ce numéro est déjà relié à cet espace : il n’y a rien à relier.';
const BANNI = 'WhatsApp a coupé ce numéro : il ne peut plus être relié. Demandez à Claude la suite (un autre numéro, ou l’API WhatsApp).';

/** Un compte qu'on rouvre tel quel (son QR code, ou sa session endormie) ; les autres se préparent de nouveau. */
const ROUVRABLES: ReadonlySet<StatutCompte> = new Set(['en_attente', 'sommeil']);

export async function relierApplication(d: DepsConnexionApplication, tenantId: string): Promise<Issue<{ compteId: string }>> {
  let compte = await d.comptes.parEspace(tenantId);
  if (compte?.statut === 'relie') return refus(409, DEJA_RELIE);
  const fourni = await d.numeroFourni(tenantId);
  // 🔴 Un numéro banni ne se relie jamais de lui-même (relevé de wagroups) : seul un autre numéro rouvre la filière.
  if (compte?.statut === 'banni' && (fourni === null || fourni.numero === compte.numero)) return refus(409, BANNI);
  // Un numéro fourni remplacé depuis la préparation : le compte suit le numéro attribué.
  const aPreparer = !compte || !ROUVRABLES.has(compte.statut) || (fourni !== null && compte.numero !== fourni.numero);
  if (aPreparer) {
    const numero = fourni?.numero ?? (compte && !ROUVRABLES.has(compte.statut) ? compte.numero : null);
    if (!numero) return refus(409, SANS_NUMERO);
    const p = await d.comptes.preparer(tenantId, { numero, fourniId: fourni?.id ?? null });
    if (!p.ok) return refus(409, phraseDuRefusDePreparation(p.raison));
    compte = p.compte;
  }
  if (!compte) return refus(409, SANS_NUMERO);
  if (!d.client) return refus(503, SERVICE_FERME);
  const r = await d.client.relier(compte.id);
  if (!r.ok) return refus(503, SERVICE_FERME);
  return { ok: true, valeur: { compteId: compte.id } };
}

export async function qrApplication(d: DepsConnexionApplication, tenantId: string): Promise<{ statut: StatutCompte | null; qr: string | null; relie: boolean }> {
  const compte = await d.comptes.parEspace(tenantId);
  if (!compte) return { statut: null, qr: null, relie: false };
  if (compte.statut === 'relie') {
    await d.offrirCredit(tenantId);
    return { statut: 'relie', qr: null, relie: true };
  }
  if (!d.client) return { statut: compte.statut, qr: null, relie: false };
  const r = await d.client.qr(compte.id);
  const texte = r.ok ? r.qr : null;
  return { statut: compte.statut, qr: texte ? await d.qrEnImage(texte) : null, relie: false };
}

/** Ce qu'un refus de préparation dit à la personne (la page) ou à Claude (l'outil). */
export function phraseDuRefusDePreparation(raison: RefusPreparation): string {
  switch (raison) {
    case 'numero_pris': return 'Ce numéro est déjà relié à un autre espace Messaging Me.';
    case 'deja_relie': return DEJA_RELIE;
    case 'filiere_api': return 'Cet espace a déjà un numéro de l’API WhatsApp : la filière application ne s’y ajoute pas.';
    case 'numero_invalide': return 'Numéro invalide : il faut le numéro international, indicatif compris (8 à 15 chiffres).';
  }
}

/**
 * « Abandonner » un numéro fourni de la filière application (relecture du lot, 🔴 2) : un numéro qui porte peut-être un
 * compte WhatsApp Business ne retourne JAMAIS à la réserve, sans quoi l'espace suivant qui le recevrait reprendrait ce
 * compte et ses clients. Il le porte si un compte de l'application de l'espace le tient, ou, pour un lien de la filière,
 * dès que son code de vérification a été capté (le compte de l'application peut exister avant que la page ne le
 * prépare). La filière API garde son comportement.
 */
export function numeroFourniAGarder(o: {
  filiereDuLien: 'application' | undefined;
  compte: CompteApplication | null;
  fourni: { numero: string };
  codeCapte: boolean;
}): boolean {
  const compteVivant = o.compte !== null && o.compte.statut !== 'retire';
  if (compteVivant && o.compte!.numero === o.fourni.numero) return true;
  return (o.filiereDuLien === 'application' || compteVivant) && o.codeCapte;
}

/**
 * Le crédit offert au premier numéro, servi à la LECTURE de l'état de connexion dès qu'un compte de l'application y est
 * relié (essai réel du 2026-10-22) : la page bascule sur « connecté » dès que l'état le dit, avant que le bloc du QR code
 * ne lise « relié », et l'attente de Claude ne lit que l'état. L'offre est idempotente (une fois par espace, jamais deux
 * fois pour un même téléphone) et `offrir` ne lève jamais. Rend l'état tel quel.
 */
export async function servirLeCreditSiRelie<E extends { application?: { statut: StatutCompte } }>(
  etat: E, tenantId: string, offrir: (tenantId: string) => Promise<void>,
): Promise<E> {
  if (etat.application?.statut === 'relie') await offrir(tenantId);
  return etat;
}
