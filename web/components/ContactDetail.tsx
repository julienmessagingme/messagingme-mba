'use client';

/**
 * Fiche contact : l'écran de détail d'un contact, avec ses champs, ses tags, son consentement et son
 * historique.
 *
 * EXTRAIT de `app/contacts/page.tsx` sans changement de comportement, pour être utilisable AILLEURS : l'Inbox
 * l'ouvre au clic sur le nom du contact. Il n'existait qu'à un seul endroit, ce qui obligeait à quitter la
 * conversation pour consulter une fiche, ou à en réécrire une seconde.
 */
import { useState } from 'react';
import { ContactHistoryPanel } from '@/components/ContactHistoryPanel';
import { MbaTabs } from '@/components/MbaTabs';
import { useT, useLocale } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { fieldValue } from '@/lib/fields';
import { formatDate } from '@/lib/day';
import {
  updateContact,
  createUserField,
  contactIdentity,
  type Contact,
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
  const { locale } = useLocale();
  const badge = OPT_IN_LABEL[contact.optInStatus] ?? OPT_IN_LABEL.unknown!;
  const defByKey = new Map(userFields.map((d) => [d.key, d]));
  // 'prenom' est déjà affiché dans le bloc fixe ci-dessus -> l'exclure de la section Champs (pas de doublon).
  const fieldEntries = Object.entries(contact.fields ?? {}).filter(([k, v]) => k !== 'prenom' && v != null && String(v).trim() !== '');
  const filledKeys = new Set([...fieldEntries.map(([k]) => k), 'prenom']);
  const addable = userFields.filter((d) => !filledKeys.has(d.key));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newTag, setNewTag] = useState('');
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{contact.profileName ?? contactIdentity(contact) ?? '-'}</h3>
            <p className="font-mono text-xs text-ink-400">{contactIdentity(contact) ?? '-'}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>

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
        <div className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <span className="text-ink-400">{t('Nom', 'Name')}</span>
          <EditableField value={contact.profileName ?? ''} busy={busy} onSave={(v) => apply({ profileName: v.trim() === '' ? null : v.trim() })} />
          <span className="text-ink-400">{t('Prénom', 'First name')}</span>
          <EditableField value={fieldValue(contact, 'prenom') ?? ''} type="text" busy={busy} onSave={(v) => saveSocleField('prenom', v)} onDelete={() => apply({ removeFields: ['prenom'] })} />
          <span className="text-ink-400">{t('Téléphone', 'Phone')}</span>
          <span className="font-mono text-ink-900" title={t("Le numéro (identité/routage WhatsApp) n'est pas modifiable", "The number (WhatsApp identity/routing) can't be changed")}>{contact.phoneE164 ?? '-'}</span>
          {contact.bsuid && (
            <>
              <span className="text-ink-400">{t('Compte WhatsApp', 'WhatsApp account')}</span>
              <span className="font-mono text-ink-900" title={t("BSUID : identifiant WhatsApp unique d'un client qui n'a pas partagé son numéro (non modifiable)", "BSUID: unique WhatsApp identifier for a customer who hasn't shared their number (not editable)")}>{contact.bsuid}</span>
            </>
          )}
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
          <span className="text-ink-400">{t('Ajouté le', 'Added on')}</span>
          <span className="text-ink-900">{formatDate(contact.createdAt, locale)}</span>
        </div>

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
            {(contact.tags ?? []).length === 0 && <span className="text-sm text-ink-400">{t('Aucun tag.', 'No tags.')}</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              list="tag-suggestions"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addTag(); }}
              placeholder={t('Ajouter un tag…', 'Add a tag…')}
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
