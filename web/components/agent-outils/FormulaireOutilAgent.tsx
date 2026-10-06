'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { CibleBloc, CibleChamp, CibleScenario, CibleTag } from '@/components/mba-outils/CiblesOutil';
import { BORNES_OUTIL, consigneIncomplete, textesDuType } from '@/lib/mba-outils';
import {
  HANDLER_DU_TYPE, cibleComplete, cibleDeLOutil, corpsDeLaCible, normaliserNomOutil,
  type CibleSaisieAgent, type TypeACible,
} from '@/lib/agent-outils';
import {
  ajouterOutil, autonomieOutil, patchOutil, type GesteMoment, type ModeleOutil, type OutilAgent,
} from '@/lib/api-agent-tools';
import { AutonomieOutil, Gestes, SchemaModele } from './ReglagesOutil';

/** Une cible vide du type choisi. */
function cibleVide(type: TypeACible): CibleSaisieAgent {
  switch (type) {
    case 'tag': return { type: 'tag', tag: '' };
    case 'champ': return { type: 'champ', champ: '', valeurs: [] };
    case 'bloc': return { type: 'bloc', workflowId: '', code: '' };
    case 'scenario': return { type: 'scenario', workflowId: '' };
  }
}

/** Ce qui dépasse les bornes de la route, dit à l'écran plutôt qu'en 400 (`BORNES_CIBLE` du serveur). */
function horsBornes(c: CibleSaisieAgent): boolean {
  if (c.type === 'tag') return c.tag.trim().length > BORNES_OUTIL.tag;
  if (c.type === 'champ') return c.valeurs.length > BORNES_OUTIL.valeurs || c.valeurs.some((v) => v.length > BORNES_OUTIL.valeur);
  return false;
}

/**
 * POSER OU MODIFIER UN OUTIL À CIBLE D'UN AGENT IA (RC4) : un tag, une information, un bloc, un scénario, fixés par
 * l'administrateur, comme chez l'agent de Meta (`FormulaireOutilMba`, dont il reprend les cibles). Ce que l'agent IA a
 * en plus est gardé : l'autonomie d'une action irréversible, et, une fois l'outil posé, ses gestes et le schéma que le
 * modèle voit.
 *
 * 🔴 L'OUTIL NAÎT INACTIF, comme tout outil d'un agent IA : l'activation est un geste séparé, sur sa ligne.
 * ⚠️ Le formulaire ne se referme que sur un succès : le refermer sur un refus perdrait la saisie. Un outil créé dont les
 * mots n'ont pas pu suivre, lui, se referme (le recréer buterait sur son propre nom) et le parent le dit.
 */
export function FormulaireOutilAgent({
  tenantId, agentId, type, outil, modele, busy, onFini, onAnnuler, onGestes, onAutonomie,
}: {
  tenantId: string;
  agentId: string;
  type: TypeACible;
  /** L'outil modifié, ou `null` pour en poser un. */
  outil: OutilAgent | null;
  /** Le modèle du catalogue serveur : son risque décide de la case d'autonomie. */
  modele: ModeleOutil | undefined;
  /** Un geste du parent en cours (activation, retrait) : le formulaire attend. */
  busy: boolean;
  /** Enregistré. `erreur` : l'outil existe, mais une suite n'a pas abouti, et le parent le dit. */
  onFini: (erreur?: string) => Promise<void>;
  onAnnuler: () => void;
  /** Les gestes et l'autonomie d'un outil DÉJÀ posé, enregistrés sur-le-champ, comme dans « Régler ». */
  onGestes: (gestes: GesteMoment[]) => void;
  onAutonomie: (v: boolean) => void;
}) {
  const t = useT();
  const textes = textesDuType(type, 'agent');
  const depart = (outil ? cibleDeLOutil(outil.binding) : null) ?? cibleVide(type);
  const [cible, setCible] = useState<CibleSaisieAgent>(depart);
  // La cible d'origine : on ne la renvoie que si elle a CHANGÉ (un champ supprimé du mini-CRM ne doit pas faire
  // refuser une simple correction des mots).
  const [cibleDeDepart] = useState(() => JSON.stringify(depart));
  const [title, setTitle] = useState(outil?.title ?? '');
  const [name, setName] = useState(outil?.name ?? '');
  // Un nom technique retouché à la main ne suit plus le titre.
  const [nomTouche, setNomTouche] = useState(outil !== null);
  const [description, setDescription] = useState(outil?.description ?? t(textes.quand[0], textes.quand[1]));
  const [nePasUtiliser, setNePasUtiliser] = useState(outil?.nePasUtiliser ?? t(textes.pasQuand[0], textes.pasQuand[1]));
  const irreversible = (outil?.risk ?? modele?.risk) === 'irreversible';
  const [autonome, setAutonome] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const changerTitre = (v: string): void => {
    setTitle(v);
    if (!nomTouche) setName(normaliserNomOutil(v));
  };

  const manque: string | null =
    !cibleComplete(cible) ? t('Choisissez ce que vise l’outil.', 'Pick what the tool targets.')
      : horsBornes(cible) ? t(
        `Trop long : un tag fait ${BORNES_OUTIL.tag} caractères au plus, une liste ${BORNES_OUTIL.valeurs} valeurs de ${BORNES_OUTIL.valeur} caractères.`,
        `Too long: a tag is at most ${BORNES_OUTIL.tag} characters, a list ${BORNES_OUTIL.valeurs} values of ${BORNES_OUTIL.valeur} characters.`)
        : title.trim() === '' ? t('Donnez un titre lisible.', 'Give it a readable title.')
          : !/^[a-z0-9_]{1,64}$/.test(name) ? t('Un nom technique en minuscules, chiffres et tirets bas.', 'A technical name in lowercase, digits and underscores.')
            : description.trim() === '' || consigneIncomplete(description) ? t('Complétez « Quand l’appeler ».', 'Complete “When to call it”.')
              : nePasUtiliser.trim() === '' ? t('Dites quand ne pas l’appeler.', 'Say when not to call it.')
                : envoi ? t('Enregistrement en cours…', 'Saving…')
                  : busy ? t('Un autre geste est en cours : attendez qu’il se termine.', 'Another action is running: wait for it to end.')
                    : null;

  const enregistrer = async (): Promise<void> => {
    if (manque !== null) return;
    setEnvoi(true);
    setErreur(null);
    const mots = { title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim() };
    if (outil !== null) {
      const cibleChangee = JSON.stringify(cible) !== cibleDeDepart;
      try {
        await patchOutil(tenantId, agentId, outil.id, {
          ...mots, ...(name !== outil.name ? { name } : {}), ...(cibleChangee ? { cible: corpsDeLaCible(cible) } : {}),
        });
      } catch (e) {
        setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Saving failed'));
        setEnvoi(false);
        return;
      }
      setEnvoi(false);
      await onFini();
      return;
    }
    let cree: OutilAgent;
    try {
      cree = await ajouterOutil(tenantId, agentId, HANDLER_DU_TYPE[type], { name, cible: corpsDeLaCible(cible) });
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Saving failed'));
      setEnvoi(false);
      return;
    }
    // L'outil existe : ses mots et son autonomie suivent. Un échec ici ne le défait pas, et le dit.
    let suite: string | undefined;
    try {
      await patchOutil(tenantId, agentId, cree.id, mots);
      if (irreversible && autonome) await autonomieOutil(tenantId, agentId, cree.id, true);
    } catch (e) {
      suite = t(
        `L’outil est ajouté, mais ses réglages n’ont pas tous pu suivre (${e instanceof Error ? e.message : 'erreur'}) : corrigez-les avec « Modifier ».`,
        `The tool is added, but not all its settings went through (${e instanceof Error ? e.message : 'error'}): fix them with “Edit”.`,
      );
    }
    setEnvoi(false);
    await onFini(suite);
  };

  return (
    <section className="flex flex-col gap-3 rounded-carte border border-ink-200 bg-white p-4" data-testid="agent-outil-form">
      <p className="text-sm font-semibold text-ink-900">{t(textes.titre[0], textes.titre[1])}</p>
      {erreur !== null && <p className="text-xs text-danger" data-testid="agent-outil-form-erreur">{erreur}</p>}

      {cible.type === 'tag' && (
        <CibleTag pour="agent" tenantId={tenantId} valeur={cible.tag} onChange={(tag) => setCible({ type: 'tag', tag })} />
      )}
      {cible.type === 'champ' && (
        <CibleChamp pour="agent" tenantId={tenantId} champ={cible.champ} valeurs={cible.valeurs}
          onChange={(champ, valeurs) => setCible({ type: 'champ', champ, valeurs })} />
      )}
      {cible.type === 'bloc' && (
        <CibleBloc tenantId={tenantId} workflowId={cible.workflowId} code={cible.code}
          onChange={(workflowId, code, nom) => {
            setCible({ type: 'bloc', workflowId, code });
            if (title.trim() === '' && nom !== '') changerTitre(nom);
          }} />
      )}
      {cible.type === 'scenario' && (
        <CibleScenario pour="agent" tenantId={tenantId} workflowId={cible.workflowId}
          onChange={(workflowId, nom) => {
            setCible({ type: 'scenario', workflowId });
            if (title.trim() === '' && nom !== null) changerTitre(nom);
          }} />
      )}

      <label className="text-xs text-ink-500">
        {t('Titre', 'Title')}
        <input className={`${inputCls} mt-1`} data-testid="agent-outil-form-titre" value={title} maxLength={BORNES_OUTIL.titre}
          onChange={(e) => changerTitre(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Nom technique (vu par le modèle)', 'Technical name (seen by the model)')}
        <input className={`${inputCls} mt-1 font-mono`} data-testid="agent-outil-form-nom" value={name}
          onChange={(e) => { setNomTouche(true); setName(normaliserNomOutil(e.target.value) || e.target.value); }} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Quand l’appeler', 'When to call it')}
        <textarea className={`${inputCls} mt-1`} rows={3} data-testid="agent-outil-form-quand" value={description} maxLength={BORNES_OUTIL.texte}
          onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Quand ne pas l’appeler', 'When not to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="agent-outil-form-pasquand" value={nePasUtiliser} maxLength={BORNES_OUTIL.texte}
          onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>

      {/* À la pose, l'autonomie se coche ici et part juste après la création ; sur un outil posé, elle s'enregistre
          sur-le-champ, comme dans « Régler ». Non accordée, le tronc commun refuse chaque appel. */}
      {irreversible && outil === null && (
        <label data-testid="agent-outil-form-autonomie" className="flex items-start gap-2 rounded-controle border border-alerte-300 bg-alerte-50 px-3 py-2 text-sm text-ink-900">
          <input type="checkbox" className="mt-0.5" checked={autonome} disabled={envoi} onChange={(e) => setAutonome(e.target.checked)} />
          <span>
            {t(
              'Autoriser l’agent à faire ça seul. Non cochée, l’action est refusée à chaque appel : ce qui part, part vraiment chez le contact et ne se rappelle pas.',
              'Allow the agent to do this on its own. Unchecked, the action is refused on every call: it is irreversible, and the contact really receives it.',
            )}
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Bouton taille="petite" type="button" data-testid="agent-outil-form-enregistrer" disabled={manque !== null} title={manque ?? ''}
          onClick={() => { void enregistrer(); }}>
          {envoi ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
        {manque !== null && <span className="text-xs text-ink-500" data-testid="agent-outil-form-manque">{manque}</span>}
        <button type="button" data-testid="agent-outil-form-annuler" disabled={envoi} onClick={onAnnuler}
          className="text-xs text-ink-500 hover:underline disabled:opacity-40">
          {t('Annuler', 'Cancel')}
        </button>
      </div>

      {outil !== null && (
        <div className="flex flex-col gap-3 border-t border-ink-100 pt-3">
          {outil.risk === 'irreversible' && <AutonomieOutil id={outil.id} coche={outil.autonome} busy={busy || envoi} onChange={onAutonomie} />}
          <Gestes outil={outil} busy={busy || envoi} onSave={onGestes} />
          <SchemaModele outil={outil} />
        </div>
      )}
    </section>
  );
}
