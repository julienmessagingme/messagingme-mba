'use client';

/**
 * Fiche contact : l'écran de détail d'un contact, avec ses champs, ses tags, son consentement et son
 * historique.
 *
 * EXTRAIT de `app/contacts/page.tsx` sans changement de comportement, pour être utilisable AILLEURS : l'Inbox
 * l'ouvre au clic sur le nom du contact. Il n'existait qu'à un seul endroit, ce qui obligeait à quitter la
 * conversation pour consulter une fiche, ou à en réécrire une seconde.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ContactHistoryPanel } from '@/components/ContactHistoryPanel';
import { useT, useLocale } from '@/lib/i18n';
import { fieldValue, SOCLE_CLES, waIdDuContact } from '@/lib/fields';
import { formatDate } from '@/lib/day';
import { verdictWhatsApp, type Verdict } from '@/lib/joignabilite';
import { etatResume, phraseResumeAbsent } from '@/lib/resume-conversation';
import {
  updateContact,
  createUserField,
  setContactBlocked,
  contactIdentity,
  getContactResume,
  ouvrirConversationDuContact,
  type Contact,
  type ResumeContact,
  type UserFieldDef,
  type UserFieldKind,
} from '@/lib/api';

// text porte les DEUX langues [fr, en] (résolu au rendu via t(...badge.text)) : cette const vit au niveau
// module, où useT() est inappelable. opt-in / opt-out sont identiques dans les deux langues.
export const OPT_IN_LABEL: Record<string, { text: [string, string]; cls: string }> = {
  opted_in: { text: ['opt-in', 'opt-in'], cls: 'bg-emerald-50 text-emerald-700' },
  opted_out: { text: ['opt-out', 'opt-out'], cls: 'bg-red-50 text-red-700' },
  unknown: { text: ['inconnu', 'unknown'], cls: 'bg-ink-100 text-ink-600' },
};

/**
 * Les trois verdicts de joignabilité, à l'écran.
 *
 * 🔴 « JAMAIS TESTÉ » ET NON « INJOIGNABLE » POUR UN INCONNU. C'est le même défaut que confondre `null` et
 * `false` en base, transposé à l'affichage, et il est PIRE ici : l'opérateur, lui, agit sur ce qu'il lit. Un
 * contact jamais sollicité affiché « injoignable » ne sera jamais recontacté par personne, et rien dans
 * l'écran ne dira que c'était une supposition. Gris, donc, comme le consentement inconnu juste au-dessus.
 */
export const JOIGNABILITE_BADGE: Record<Verdict, { text: [string, string]; cls: string }> = {
  oui: { text: ['joignable', 'reachable'], cls: 'bg-emerald-50 text-emerald-700' },
  non: { text: ['injoignable', 'unreachable'], cls: 'bg-red-50 text-red-700' },
  inconnu: { text: ['Jamais testé', 'Never tested'], cls: 'bg-ink-100 text-ink-600' },
};


/** Input adapté au type d'un user field. */
function FieldValueInput({ type, value, onChange }: { type: UserFieldKind; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const cls = 'flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
  if (type === 'boolean') {
    // Valeurs stockées de façon canonique ('true'/'false'). On tolère l'affichage des valeurs héritées
    // ('oui'/'non'/'1'/'0') pour qu'une ancienne fiche reste correctement présélectionnée (pas de backfill).
    const low = value.trim().toLowerCase();
    const display = ['true', 'oui', '1'].includes(low) ? 'true' : ['false', 'non', '0'].includes(low) ? 'false' : '';
    return (
      <select value={display} onChange={(e) => onChange(e.target.value)} className={`${cls} bg-white`}>
        <option value="">-</option>
        <option value="true">{t('oui', 'yes')}</option>
        <option value="false">{t('non', 'no')}</option>
      </select>
    );
  }
  const inputType = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : type === 'url' ? 'url' : 'text';
  return <input type={inputType} value={value} onChange={(e) => onChange(e.target.value)} className={cls} placeholder={type === 'url' ? 'https://…' : t('valeur', 'value')} />;
}

/**
 * Valeur éditable EN PLACE (Nom, Prénom, champs perso) : affichage + « modifier »/« supprimer » au survol,
 * bascule en input avec ✓/✗. `type` fourni -> input typé (FieldValueInput) ; sinon input texte simple (Nom).
 * `onDelete` absent -> non supprimable. onSave/onDelete renvoient un booléen de succès (reste en édition si échec).
 */
function EditableField({ value, type, mono, busy, editable = true, onSave, onDelete }: {
  value: string;
  type?: UserFieldKind;
  mono?: boolean;
  busy: boolean;
  /** false -> valeur en lecture seule (pas de « modifier ») ; la suppression reste possible si onDelete fourni.
   *  Sert aux champs « orphelins » (sans définition) : les éditer échouerait en 400, mais on peut les retirer. */
  editable?: boolean;
  onSave: (v: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const begin = () => { setDraft(value); setEditing(true); };
  const commit = async () => { if (await onSave(draft)) setEditing(false); };
  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        {type ? (
          <FieldValueInput type={type} value={draft} onChange={setDraft} />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
            className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        )}
        <button onClick={() => void commit()} disabled={busy} className="shrink-0 text-brand-600 hover:text-brand-700 disabled:opacity-50" aria-label={t('Enregistrer', 'Save')}>✓</button>
        <button onClick={() => setEditing(false)} className="shrink-0 text-ink-400 hover:text-ink-700" aria-label={t('Annuler', 'Cancel')}>×</button>
      </span>
    );
  }
  return (
    <span className="group flex items-center gap-2">
      <span className={`${mono ? 'font-mono ' : ''}break-words text-ink-900`}>{value !== '' ? value : '-'}</span>
      {editable && (
        <button onClick={begin} data-testid="champ-modifier" className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700" aria-label={t('Modifier', 'Edit')}>{t('modifier', 'edit')}</button>
      )}
      {onDelete && value !== '' && (
        <button onClick={() => void onDelete()} disabled={busy} data-testid="champ-supprimer" className="shrink-0 text-xs text-ink-400 underline decoration-dotted transition hover:text-coral disabled:opacity-50" aria-label={t('Supprimer', 'Delete')}>{t('supprimer', 'delete')}</button>
      )}
    </span>
  );
}

/** Fiche détail d'un contact : attributs, champs perso (libellé + valeur), tags. Éditable : Nom, Prénom, valeurs
 *  de champs (modif/suppression), ajout d'un champ, affecter/retirer un tag. Téléphone + BSUID en lecture seule. */
export function ContactDetail({
  contact,
  userFields,
  tagSuggestions,
  tenantId,
  onUpdated,
  onFieldCreated,
  onClose,
}: {
  contact: Contact;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  tenantId: string;
  onUpdated: (c: Contact) => void;
  onFieldCreated: (def: UserFieldDef) => void;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const { locale } = useLocale();
  const badge = OPT_IN_LABEL[contact.optInStatus] ?? OPT_IN_LABEL.unknown!;
  /**
   * 🔴 LE VERDICT VIENT DU MODULE PARTAGÉ, il n'est pas recalculé ici. Écrire `contact.whatsappJoignable
   * === false ? 'injoignable' : ...` à l'écran donnerait une SECONDE définition de « joignable », qui
   * dériverait de celle du filtre d'audience et de celle du SQL : la fiche dirait « injoignable » sur une
   * mesure que le filtre, lui, aurait déjà périmée.
   */
  const verdict = verdictWhatsApp(
    contact.whatsappJoignable ?? null,
    contact.whatsappJoignableLe ? new Date(contact.whatsappJoignableLe) : null,
    new Date(),
  );
  const defByKey = new Map(userFields.map((d) => [d.key, d]));
  // Les champs SOCLE ont leur ligne DÉDIÉE dans le bloc fixe ci-dessus (toujours visible, même vide) : les
  // exclure d'ici, sinon ils s'afficheraient deux fois dès qu'ils sont remplis, et seraient re-proposés à
  // l'ajout alors qu'ils sont déjà là. Source unique : `SOCLE_CLES`, miroir de `SOCLE_FIELDS` côté serveur.
  const fieldEntries = Object.entries(contact.fields ?? {}).filter(([k, v]) => !SOCLE_CLES.includes(k) && v != null && String(v).trim() !== '');
  const filledKeys = new Set([...fieldEntries.map(([k]) => k), ...SOCLE_CLES]);
  const addable = userFields.filter((d) => !filledKeys.has(d.key));

  /**
   * LE RÉSUMÉ DE LA DERNIÈRE CONVERSATION ANALYSÉE, chargé à l'ouverture de la fiche.
   *
   * ⚠️ APPEL À PART, ET SON ÉCHEC EST SILENCIEUX (il reste `null`, donc le bloc ne s'affiche pas). Même
   * arbitrage que le bilan dans l'onglet Historique : une instance qui ne sert pas cette route (503) doit
   * continuer d'ouvrir des fiches. Une fiche qui refuserait de s'ouvrir pour un bloc en plus échangerait
   * l'essentiel contre l'accessoire.
   *
   * ⚠️ SUR `contact.id`, PAS SUR `contact` : la fiche se ré-rend à CHAQUE édition de champ ou de tag, et
   * dépendre de l'objet entier rappellerait la route à chaque frappe enregistrée, pour une valeur qu'aucune
   * édition de fiche ne peut changer.
   */
  const [resume, setResume] = useState<ResumeContact | null>(null);
  useEffect(() => {
    let alive = true;
    getContactResume(tenantId, contact.id)
      .then((r) => { if (alive) setResume(r); })
      .catch(() => { if (alive) setResume(null); });
    return () => { alive = false; };
  }, [tenantId, contact.id]);
  const etat = etatResume(resume);
  const phraseAbsent = phraseResumeAbsent(etat, t);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newTag, setNewTag] = useState('');
  // « Copié » (ou « Copie impossible ») pendant deux secondes : sans retour, on reclique en croyant que rien
  // ne s'est passé. L'échec a le sien : presse-papiers absent (contexte non sécurisé) ou écriture refusée.
  const [idCopie, setIdCopie] = useState<'ok' | 'echec' | null>(null);
  // Création d'un NOUVEAU champ (pas seulement piocher dans l'existant) depuis la fiche.
  const [creatingField, setCreatingField] = useState(false);
  const [cLabel, setCLabel] = useState('');
  const [cType, setCType] = useState<UserFieldKind>('text');
  const [cVal, setCVal] = useState('');
  // Champ déjà créé mais dont la pose de valeur a échoué : on le réutilise au retry (évite un 409).
  const [createdRef, setCreatedRef] = useState<UserFieldDef | null>(null);
  // Onglet courant. L'historique se charge au premier affichage seulement (le panneau fait son propre fetch,
  // et n'est monté que quand l'onglet est actif).
  const [tab, setTab] = useState<'fiche' | 'historique'>('fiche');

  const selectedDef = defByKey.get(newKey);

  /**
   * Bloque ou débloque. Confirmation demandée au BLOCAGE seulement : c'est lui qui a des conséquences
   * (plus aucun envoi, conversation masquée). Débloquer ne fait que rendre les choses à leur état normal.
   */
  async function basculerBlocage(bloquer: boolean): Promise<void> {
    if (bloquer && !window.confirm(t(
      'Bloquer ce contact ? Plus aucun message ne lui sera envoyé et sa conversation disparaîtra de l’inbox. Ses messages continueront d’être enregistrés, et vous pourrez le débloquer depuis les paramètres.',
      'Block this contact? No message will be sent to them and their conversation will disappear from the inbox. Their messages will still be recorded, and you can unblock them from settings.',
    ))) return;
    setBusy(true);
    setError(null);
    try {
      await setContactBlocked(tenantId, contact.id, bloquer);
      onUpdated({ ...contact, blockedAt: bloquer ? new Date().toISOString() : null });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Modification impossible', 'Update failed'));
    } finally {
      setBusy(false);
    }
  }

  async function apply(patch: {
    fields?: Record<string, string>; removeFields?: string[]; addTags?: string[]; removeTags?: string[];
    profileName?: string | null; optInStatus?: 'opted_in' | 'opted_out';
  }) {
    setBusy(true);
    setError(null);
    try {
      const { contact: updated } = await updateContact(tenantId, contact.id, patch);
      onUpdated(updated);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Modification impossible', 'Update failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Enregistre la valeur d'un champ SOCLE (Prénom). Valeur vide -> on retire la valeur (pas de champ vide).
   *
   * Il y avait ici un contournement : créer le user field avant d'écrire, parce que la route répondait « champ
   * inconnu : prenom » sur un espace neuf. Il ne pouvait PAS marcher, et masquait pourquoi : la création d'un
   * champ dont la clé est celle d'un champ de base est refusée en 409, et le `catch` l'avalait en silence. Le
   * serveur matérialise désormais le champ socle à la première écriture (cf. `src/crm/fields.ts` SOCLE_FIELDS).
   */
  async function saveSocleField(key: string, value: string): Promise<boolean> {
    const v = value.trim();
    return v === '' ? apply({ removeFields: [key] }) : apply({ fields: { [key]: v } });
  }

  async function addField() {
    if (!newKey || newVal.trim() === '') return;
    if (await apply({ fields: { [newKey]: newVal.trim() } })) { setNewKey(''); setNewVal(''); }
  }
  // Crée un nouveau user field (POST) PUIS pose sa valeur sur ce contact, en une fois. Si la pose de
  // valeur échoue (ex. valeur invalide pour le type), on garde le champ créé : un retry corrige juste la
  // valeur sans recréer le champ (donc pas de 409 « existe déjà »).
  async function createAndAddField() {
    const label = cLabel.trim();
    if (label === '' || cVal.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      let def = createdRef && createdRef.label === label ? createdRef : null;
      if (!def) {
        def = await createUserField(tenantId, { label, type: cType });
        onFieldCreated(def);
        setCreatedRef(def);
      }
      const ok = await apply({ fields: { [def.key]: cVal.trim() } });
      if (ok) { setCreatingField(false); setCLabel(''); setCVal(''); setCType('text'); setCreatedRef(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création du champ impossible', 'Failed to create the field'));
    } finally {
      setBusy(false);
    }
  }
  async function addTag() {
    const tag = newTag.trim();
    if (tag === '') return;
    if (await apply({ addTags: [tag] })) setNewTag('');
  }

  /**
   * OUVRIR LA CONVERSATION DE CE CONTACT (demande de Julien du 2026-09-23).
   *
   * 🔴 LE FIL EST CRÉÉ S'IL N'EXISTE PAS, et c'est le serveur qui le fait : un contact qu'on vient
   * d'importer n'a jamais écrit, donc n'a aucune conversation, et c'est précisément quand on veut lui
   * parler qu'on ouvre sa fiche. Sans création, le bouton n'aurait servi qu'aux contacts qui ont déjà
   * répondu, c'est-à-dire ceux pour qui on n'en a pas besoin.
   *
   * ⚠️ `router.push` ET PAS UN LIEN : l'identifiant du fil n'est connu qu'APRÈS la réponse du serveur. Un
   * `<a>` demanderait de le connaître avant le clic, donc d'appeler la route à l'ouverture de CHAQUE fiche.
   *
   * ⚠️ L'ÉCHEC SE DIT SUR PLACE plutôt que de laisser un bouton inerte : une instance dont l'API n'est pas
   * encore déployée rend 503, et un contact sans numéro ni identifiant WhatsApp rend 404. Dans les deux cas
   * il n'y a pas de fil possible, et le silence se lirait comme une panne de l'écran.
   */
  const [ouverture, setOuverture] = useState(false);
  const [erreurOuverture, setErreurOuverture] = useState<string | null>(null);
  async function ouvrirLaConversation() {
    setOuverture(true);
    setErreurOuverture(null);
    try {
      const { conversationId } = await ouvrirConversationDuContact(tenantId, contact.id);
      router.push(`/inbox?c=${encodeURIComponent(conversationId)}`);
    } catch (err) {
      setErreurOuverture(err instanceof Error ? err.message : t('Conversation indisponible', 'Conversation unavailable'));
      setOuverture(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{contact.profileName ?? contactIdentity(contact) ?? '-'}</h3>
            <p className="font-mono text-xs text-ink-400">{contactIdentity(contact) ?? '-'}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void ouvrirLaConversation()}
              disabled={ouverture}
              data-testid="fiche-ouvrir-conversation"
              className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
            >
              {ouverture ? t('Ouverture…', 'Opening…') : t('Ouvrir la conversation', 'Open conversation')}
            </button>
            <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
          </div>
        </div>
        {erreurOuverture && (
          <p className="mt-2 rounded-lg bg-coral/10 px-3 py-2 text-xs text-coral" data-testid="fiche-ouvrir-erreur">{erreurOuverture}</p>
        )}

        <div className="mt-4 flex gap-1 border-b border-ink-100 text-sm">
          {(['fiche', 'historique'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-1.5 transition ${tab === k ? 'border-brand-500 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'}`}
            >
              {k === 'fiche' ? t('Fiche', 'Details') : t('Historique', 'History')}
            </button>
          ))}
        </div>

        {tab === 'historique' ? (
          <ContactHistoryPanel tenantId={tenantId} contactId={contact.id} />
        ) : (
        <>
        {/* Les champs de BASE de la fiche : toujours rendus, même vides. Le testid sert à les cibler sans
            ambiguïté (« Prénom » existe aussi en en-tête de la liste des contacts). */}
        <div data-testid="fiche-champs-base" className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <span className="text-ink-400">{t('Nom', 'Name')}</span>
          <EditableField value={contact.profileName ?? ''} busy={busy} onSave={(v) => apply({ profileName: v.trim() === '' ? null : v.trim() })} />
          <span className="text-ink-400">{t('Prénom', 'First name')}</span>
          <EditableField value={fieldValue(contact, 'prenom') ?? ''} type="text" busy={busy} onSave={(v) => saveSocleField('prenom', v)} onDelete={() => apply({ removeFields: ['prenom'] })} />
          {/* Email : champ SOCLE au même titre que Prénom (cf. `SOCLE_FIELDS`, src/crm/fields.ts), donc TOUJOURS
              présent sur la fiche, même vide. Il n'apparaissait qu'une fois rempli, et il n'était même pas
              proposé à l'ajout : la liste des champs ajoutables vient de `user_fields`, où un champ socle
              n'existe pas tant que personne ne l'a écrit. Un contact sans email était donc impossible à
              compléter depuis sa fiche. Signalé par Julien le 2026-08-25. */}
          <span className="text-ink-400">{t('Email', 'Email')}</span>
          <EditableField value={fieldValue(contact, 'email') ?? ''} type="text" busy={busy} onSave={(v) => saveSocleField('email', v)} onDelete={() => apply({ removeFields: ['email'] })} />
          <span className="text-ink-400">{t('Téléphone', 'Phone')}</span>
          <span className="font-mono text-ink-900" title={t("Le numéro (identité/routage WhatsApp) n'est pas modifiable", "The number (WhatsApp identity/routing) can't be changed")}>{contact.phoneE164 ?? '-'}</span>
          {/* BSUID et identifiant WhatsApp : TOUJOURS affichés, même absents. Ils ne se remplissent pas à la
              main (ce sont des identités de routage, pas des données de fiche), mais les masquer quand ils
              sont vides empêchait de comprendre POURQUOI un contact ne reçoit rien, ou de les recopier pour
              un diagnostic. Demandé par Julien le 2026-08-25. */}
          <span className="text-ink-400">{t('Compte WhatsApp', 'WhatsApp account')}</span>
          <span className="font-mono text-ink-900" title={t("BSUID : identifiant WhatsApp unique d'un client qui n'a pas partagé son numéro. Non modifiable, et absent tant que le client a partagé son numéro.", "BSUID: unique WhatsApp identifier for a customer who hasn't shared their number. Not editable, and absent as long as the customer shared their number.")}>
            {contact.bsuid ?? <span className="font-sans text-ink-300">{t('aucun', 'none')}</span>}
          </span>
          {/* L'identifiant WhatsApp n'est PAS stocké : il est DÉRIVÉ, exactement comme le fait la résolution
              serveur (`MATCH_BY_WAID_SQL`) : les chiffres du numéro, ou le BSUID à défaut. Le montrer évite de
              le recalculer de tête quand on cherche une conversation ou un parcours. */}
          <span className="text-ink-400">{t('Identifiant WhatsApp', 'WhatsApp ID')}</span>
          <span className="font-mono text-ink-900" title={t("Dérivé du numéro (chiffres seuls) ou du BSUID. C'est la clé qui relie ce contact à sa conversation et à ses parcours. Non modifiable.", "Derived from the number (digits only) or the BSUID. It is the key linking this contact to its conversation and journeys. Not editable.")}>
            {waIdDuContact(contact) ?? <span className="font-sans text-ink-300">{t('aucun', 'none')}</span>}
          </span>
          {/* L'IDENTIFIANT API : la valeur que l'API publique appelle `contactId` (spec du 2026-09-24, § 10).
              Toujours affiché, avec un bouton Copier : c'est ce qu'un intégrateur vient chercher ici. */}
          <span className="text-ink-400">{t('Identifiant API', 'API ID')}</span>
          <span className="flex min-w-0 items-center gap-2">
            {/* `break-all` et pas `truncate` : sur un écran étroit, un UUID coupé par une ellipse ne se lit plus
                en entier, et c'est la seule issue quand la copie échoue. */}
            <span data-testid="fiche-identifiant-api" className="min-w-0 break-all font-mono text-xs text-ink-900" title={t('La valeur que l’API appelle « contactId ».', 'The value the API calls “contactId”.')}>
              {contact.id}
            </span>
            <button
              type="button"
              data-testid="fiche-copier-identifiant"
              onClick={() => {
                const signaler = (etat: 'ok' | 'echec'): void => { setIdCopie(etat); setTimeout(() => setIdCopie(null), 2000); };
                if (!navigator.clipboard) { signaler('echec'); return; }
                navigator.clipboard.writeText(contact.id).then(() => signaler('ok'), () => signaler('echec'));
              }}
              className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700"
            >
              {idCopie === 'ok' ? t('Copié', 'Copied') : idCopie === 'echec' ? t('Copie impossible', 'Copy failed') : t('Copier', 'Copy')}
            </button>
          </span>
          {/* L'IDENTIFIANT EXTERNE n'apparaît que s'il existe : il ne se remplit que par l'API, une ligne vide
              se lirait « à remplir ». */}
          {contact.externalId ? (
            <>
              <span className="text-ink-400">{t('Identifiant externe', 'External ID')}</span>
              <span data-testid="fiche-identifiant-externe" className="break-all font-mono text-xs text-ink-900" title={t('L’identifiant de cette personne dans l’outil qui appelle l’API.', 'This person’s identifier in the tool that calls the API.')}>
                {contact.externalId}
              </span>
            </>
          ) : null}
          <span className="text-ink-400">{t('Consentement', 'Consent')}</span>
          {/* Modifiable À LA MAIN, et ce n'est pas du confort : le garde-fou de campagne exige un opt-in
              EXPLICITE pour le marketing, donc un contact « inconnu » est écarté des envois en silence. Sans ce
              réglage sur la fiche, rien ne permettait de le rattraper au cas par cas.
              Pas de retour à « inconnu » : ce statut veut dire « rien n'a jamais été enregistré ». */}
          <span className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{t(...badge.text)}</span>
            {contact.optInStatus !== 'opted_in' && (
              <button onClick={() => void apply({ optInStatus: 'opted_in' })} disabled={busy} data-testid="fiche-optin"
                className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700 disabled:opacity-50">
                {t('passer en opt-in', 'mark opted in')}
              </button>
            )}
            {contact.optInStatus !== 'opted_out' && (
              <button onClick={() => void apply({ optInStatus: 'opted_out' })} disabled={busy} data-testid="fiche-optout"
                className="shrink-0 text-xs text-ink-400 underline decoration-dotted transition hover:text-coral disabled:opacity-50">
                {t('passer en opt-out', 'mark opted out')}
              </button>
            )}
          </span>
          {/* MODÉRATION, juste sous le consentement : même famille de question, « qu'a-t-on le droit
              d'envoyer à ce contact ». Bloquer va plus loin qu'un opt-out : plus rien ne part, ET sa
              conversation disparaît de l'inbox. C'est pour ça qu'on demande confirmation. */}
          <span className="text-ink-400">{t('Modération', 'Moderation')}</span>
          <span className="flex flex-wrap items-center gap-2">
            {contact.blockedAt ? (
              <>
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">{t('bloqué', 'blocked')}</span>
                <button onClick={() => void basculerBlocage(false)} disabled={busy} data-testid="fiche-debloquer"
                  className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700 disabled:opacity-50">
                  {t('débloquer', 'unblock')}
                </button>
              </>
            ) : (
              <button onClick={() => void basculerBlocage(true)} disabled={busy} data-testid="fiche-bloquer"
                className="shrink-0 text-xs text-ink-400 underline decoration-dotted transition hover:text-coral disabled:opacity-50">
                {t('bloquer ce contact', 'block this contact')}
              </button>
            )}
          </span>
          {/* JOIGNABILITÉ, juste après la modération : même famille de question, « ce message a-t-il une
              chance d'arriver ». Elle vient de ce qu'on a MESURÉ (migration 0133), jamais d'une supposition. */}
          <span className="text-ink-400">{t('Joignabilité', 'Reachability')}</span>
          <span className="flex flex-wrap items-center gap-2" data-testid="fiche-joignabilite">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${JOIGNABILITE_BADGE[verdict].cls}`}>
              {t(...JOIGNABILITE_BADGE[verdict].text)}
            </span>
            {/* La DATE de la mesure, et seulement quand il y en a une : c'est elle qui rend le verdict
                lisible (« injoignable » d'hier et « injoignable » d'il y a trois mois ne se valent pas), et
                sans elle personne ne peut juger s'il faut réessayer. */}
            {verdict !== 'inconnu' && contact.whatsappJoignableLe && (
              <span className="text-xs text-ink-400">{t('mesuré le', 'measured on')} {formatDate(contact.whatsappJoignableLe, locale)}</span>
            )}
          </span>
          <span className="text-ink-400">{t('Ajouté le', 'Added on')}</span>
          <span className="text-ink-900">{formatDate(contact.createdAt, locale)}</span>
        </div>

        {/*
          LE RÉSUMÉ DE LA CONVERSATION, EN CHAMP DE BASE DU MINI-CRM (demande de Julien : « ça serait un
          champ de base à partir du moment où il y a une conversation »).

          🔴 IL N'APPARAÎT PAS TANT QU'IL N'Y A PAS DE CONVERSATION, et c'est la demande au mot près. Un
          bloc « Résumé : - » sur un contact importé d'un CSV qui n'a jamais rien échangé promettrait un
          contenu à venir sur une fiche où il ne viendra jamais.

          🔴 EN LECTURE SEULE, ET SANS BOUTON MODIFIER. C'est un CONSTAT posé par un modèle, recalculé à
          chaque analyse : le rendre modifiable ferait disparaître la retouche au passage suivant, sans
          cause visible. Même séparation que celle déjà tenue entre `conversation_analysis.abusive` (constat)
          et `contacts.blocked_at` (décision).

          ⚠️ HORS de la grille des champs de base : deux à trois phrases dans une colonne de valeur large de
          110 px se liraient en escalier. Le bloc garde le libellé, il change de forme.
        */}
        {etat !== 'aucune-conversation' && (
          <div className="mt-4 rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2" data-testid="fiche-contact-resume">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
                {t('Résumé de la conversation', 'Conversation summary')}
              </span>
              {/* La DATE de l'analyse, et le lien vers le fil. Sans la date, un résumé de mars et un résumé
                  d'hier se lisent pareil ; sans le lien, il faut retrouver la conversation à la main. */}
              <span className="flex items-center gap-2 text-xs text-ink-400">
                {resume?.analyseLe && <span>{t('analysé le', 'analyzed on')} {formatDate(resume.analyseLe, locale)}</span>}
                {resume?.conversationId && (
                  <Link href={`/inbox?c=${resume.conversationId}`} className="text-brand-600 underline decoration-dotted hover:text-brand-700">
                    {t('voir le fil', 'open thread')}
                  </Link>
                )}
              </span>
            </div>
            {etat === 'resume' ? (
              <p className="mt-1 whitespace-pre-line text-sm text-ink-700" data-testid="fiche-contact-resume-texte">{resume?.texte}</p>
            ) : (
              <p className="mt-1 text-sm italic text-ink-400" data-testid="fiche-contact-resume-absent">{phraseAbsent}</p>
            )}
            {/* PÉRIMÉ : l'analyse existe, mais un message est arrivé depuis. Le dire vaut mieux que de
                présenter un résumé partiel comme s'il couvrait tout le fil. Même mot que dans l'onglet
                Historique, pour que les deux écrans ne décrivent pas le même état de deux façons. */}
            {resume?.perime && (
              <p className="mt-1 text-xs text-amber-700" data-testid="fiche-contact-resume-perime">
                {t('Un message est arrivé depuis : ce résumé ne couvre pas la fin de la conversation.',
                   'A message has arrived since: this summary does not cover the end of the conversation.')}
              </p>
            )}
          </div>
        )}

        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Tags</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {(contact.tags ?? []).map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                {tag}
                <button onClick={() => void apply({ removeTags: [tag] })} disabled={busy} className="text-brand-400 hover:text-coral" aria-label={`${t('Retirer', 'Remove')} ${tag}`}>×</button>
              </span>
            ))}
            {(contact.tags ?? []).length === 0 && <span className="text-sm text-ink-400">{t('Aucune étiquette.', 'No tags.')}</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              list="tag-suggestions"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addTag(); }}
              placeholder={t('Ajouter une étiquette…', 'Add a tag…')}
              className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <datalist id="tag-suggestions">{tagSuggestions.map((tag) => <option key={tag} value={tag} />)}</datalist>
            <button onClick={addTag} disabled={busy || newTag.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{t('Ajouter', 'Add')}</button>
          </div>
        </div>

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{t('Champs', 'Fields')}</h4>
          {fieldEntries.length === 0 ? (
            <p className="text-sm text-ink-400">{t('Aucun champ perso.', 'No custom fields.')}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-ink-200">
              {fieldEntries.map(([k, v], i) => (
                <div key={k} className={`grid grid-cols-[130px_1fr] items-center gap-3 px-3 py-1.5 text-sm ${i % 2 ? 'bg-ink-50' : 'bg-white'}`}>
                  <span className="truncate text-ink-500">{defByKey.get(k)?.label ?? k}</span>
                  <EditableField
                    value={String(v)}
                    type={defByKey.get(k)?.type ?? 'text'}
                    busy={busy}
                    editable={defByKey.has(k)}
                    onSave={(nv) => (nv.trim() === '' ? apply({ removeFields: [k] }) : apply({ fields: { [k]: nv.trim() } }))}
                    onDelete={() => apply({ removeFields: [k] })}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-2">
            {addable.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <select value={newKey} onChange={(e) => { setNewKey(e.target.value); setNewVal(''); }} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
                  <option value="">{t('Ajouter un champ existant…', 'Add an existing field…')}</option>
                  {addable.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
                {selectedDef && (
                  <>
                    <FieldValueInput type={selectedDef.type} value={newVal} onChange={setNewVal} />
                    <button onClick={addField} disabled={busy || newVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{t('Ajouter', 'Add')}</button>
                  </>
                )}
              </div>
            )}
            {!creatingField ? (
              <button onClick={() => setCreatingField(true)} className="text-sm font-medium text-brand-600 hover:text-brand-700">+ {t('Créer un nouveau champ', 'Create a new field')}</button>
            ) : (
              <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input value={cLabel} onChange={(e) => setCLabel(e.target.value)} placeholder={t('Nom du champ (ex. Métier)', 'Field name (e.g. Job)')} className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
                  <select value={cType} onChange={(e) => setCType(e.target.value as UserFieldKind)} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
                    <option value="text">{t('texte', 'text')}</option>
                    <option value="number">{t('nombre', 'number')}</option>
                    <option value="date">{t('date', 'date')}</option>
                    <option value="datetime">{t('date et heure', 'date & time')}</option>
                    <option value="boolean">{t('oui/non', 'yes/no')}</option>
                    <option value="url">{t('lien', 'link')}</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FieldValueInput type={cType} value={cVal} onChange={setCVal} />
                  <button onClick={createAndAddField} disabled={busy || cLabel.trim() === '' || cVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{t('Créer et ajouter', 'Create and add')}</button>
                  <button onClick={() => { setCreatingField(false); setCLabel(''); setCVal(''); setCreatedRef(null); }} className="text-sm text-ink-400 hover:text-ink-700">{t('Annuler', 'Cancel')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
