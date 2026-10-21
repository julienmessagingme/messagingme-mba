import type { AuditSink } from '../audit/journal';
import { tenter } from '../lib/tenter';
import { messageDe } from '../lib/erreur';
import type { ContactRow } from './contact-store.pg';
import { canonicalizeFieldValue, defPourEcriture, validateFieldValue, type ChampsPourEcriture } from './fields';
import { nettoyerEtiquettes, type PoseEtiquette } from './poser-etiquette';

/** L'écriture atomique fournie par le dépôt de contacts au cas d'usage opérateur. */
export interface ContactsEditionOperateur {
  applyEdits(
    tenantId: string,
    contactId: string,
    edits: {
      fields: Record<string, string>;
      removeFields?: string[];
      addTags: string[];
      removeTags: string[];
      profileName?: string | null;
      optInStatus?: 'opted_in' | 'opted_out';
    },
  ): Promise<{ contact: ContactRow; addedTags: string[]; consentementChange: boolean } | null>;
}

export interface DepsEditionFicheOperateur extends ChampsPourEcriture {
  contacts: ContactsEditionOperateur;
  audit: AuditSink;
  etiquettes: Pick<PoseEtiquette, 'apresPose'>;
}

export interface DemandeEditionFicheOperateur {
  tenantId: string;
  contactId: string;
  acteur: { userId: string | null; email: string | null };
  /** Corps venant de l'adapter. Le module le considère comme une donnée non fiable. */
  entree: unknown;
}

export type IssueEditionFicheOperateur =
  | { statut: 'modifiee'; contact: ContactRow }
  | { statut: 'inconnue' }
  | { statut: 'invalide'; erreur: string };

export interface EditionFicheOperateur {
  editer(demande: DemandeEditionFicheOperateur): Promise<IssueEditionFicheOperateur>;
}

interface EntreeBrute {
  fields?: unknown;
  removeFields?: unknown;
  addTags?: unknown;
  removeTags?: unknown;
  profileName?: unknown;
  optInStatus?: unknown;
}

/** Une liste d'étiquettes reçue de la console, nettoyée comme toute pose et bornée à 50. */
const etiquettesDe = (valeur: unknown): string[] =>
  Array.isArray(valeur) ? nettoyerEtiquettes(valeur.map(String), 50) : [];

/** Les clés à retirer restent permises sans définition : c'est la sortie d'un champ devenu orphelin. */
const champsARetirer = (valeur: unknown): string[] =>
  Array.isArray(valeur)
    ? [...new Set(valeur.map(String).map((cle) => cle.trim()).filter((cle) => cle !== ''))].slice(0, 50)
    : [];

/**
 * Le cas d'usage de l'édition opérateur d'une fiche. Il possède la préparation, l'écriture et les effets qui ne
 * doivent arriver qu'après son succès. L'adapter HTTP ne décide plus de leur ordre.
 */
export function creerEditionFicheOperateur(deps: DepsEditionFicheOperateur): EditionFicheOperateur {
  return {
    async editer({ tenantId, contactId, acteur, entree }) {
      const b: EntreeBrute = entree !== null && typeof entree === 'object' && !Array.isArray(entree)
        ? entree as EntreeBrute
        : {};
      const rawFields = b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)
        ? b.fields as Record<string, unknown>
        : {};
      const addTags = etiquettesDe(b.addTags);
      const removeTags = etiquettesDe(b.removeTags);
      const fields: Record<string, string> = {};

      for (const [key, raw] of Object.entries(rawFields)) {
        const def = await defPourEcriture(deps, tenantId, key);
        if (!def) return { statut: 'invalide', erreur: `champ inconnu : ${key}` };
        const valeur = String(raw);
        if (!validateFieldValue(def.type, valeur)) {
          return { statut: 'invalide', erreur: `valeur invalide pour « ${def.label} » (${def.type})` };
        }
        fields[key] = canonicalizeFieldValue(def.type, valeur);
      }

      const removeFields = champsARetirer(b.removeFields);
      let profileName: string | null | undefined;
      if (b.profileName !== undefined) {
        if (b.profileName !== null && typeof b.profileName !== 'string') {
          return { statut: 'invalide', erreur: 'profileName invalide' };
        }
        const nom = typeof b.profileName === 'string' ? b.profileName.trim().slice(0, 200) : '';
        profileName = nom === '' ? null : nom;
      }

      let optInStatus: 'opted_in' | 'opted_out' | undefined;
      if (b.optInStatus !== undefined) {
        if (b.optInStatus !== 'opted_in' && b.optInStatus !== 'opted_out') {
          return { statut: 'invalide', erreur: 'consentement invalide (opted_in | opted_out)' };
        }
        optInStatus = b.optInStatus;
      }

      if (Object.keys(fields).length === 0 && removeFields.length === 0 && addTags.length === 0
        && removeTags.length === 0 && profileName === undefined && optInStatus === undefined) {
        return { statut: 'invalide', erreur: 'rien à modifier (fields / removeFields / addTags / removeTags / profileName / optInStatus)' };
      }

      const updated = await deps.contacts.applyEdits(tenantId, contactId, {
        fields,
        removeFields,
        addTags,
        removeTags,
        ...(profileName !== undefined ? { profileName } : {}),
        ...(optInStatus !== undefined ? { optInStatus } : {}),
      });
      if (!updated) return { statut: 'inconnue' };

      if (optInStatus !== undefined && updated.consentementChange) {
        await tenter('audit ignoré:', () => deps.audit(
          tenantId,
          acteur,
          optInStatus === 'opted_in' ? 'contact.optin' : 'contact.optout',
          { kind: 'contact', id: contactId },
          { source: 'fiche' },
        ));
      }

      if (addTags.length > 0) {
        const pose = {
          posees: addTags.filter((tag) => updated.contact.tags.includes(tag)),
          nouvelles: updated.addedTags,
        };
        await deps.etiquettes.apresPose(tenantId, contactId, pose, { publier: true }).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('publication « tag ajouté » ignorée (best-effort):', messageDe(err));
        });
      }

      return { statut: 'modifiee', contact: updated.contact };
    },
  };
}
