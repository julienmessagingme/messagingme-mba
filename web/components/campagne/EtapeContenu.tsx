'use client';

import { useState } from 'react';
import type { RcsSuggestion } from '@/lib/api';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import type { CanalEtage, EtageAssistant } from '@/lib/campagne-chaine';
import { champEmailEffectif } from '@/lib/campagne-repartition';
import type { CapacitesEspace, ContenuEtage, Devenir, EtatCampagne, ReferencesContenu } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 3 : le contenu de chaque étage, puis le devenir de la conversation.
 *
 * 🔴 LES CADRES SONT EMPILÉS, JAMAIS CÔTE À CÔTE, ET C'EST DE LA CONCEPTION, PAS DE LA DÉCORATION.
 * Trois cadres à 320 px avec leurs gouttières ne tiennent pas dans les ~990 px utiles d'un 13 pouces, et
 * une grille qui se réorganise sous un seuil produit exactement les chevauchements qu'on cherche à
 * éviter. Un empilement n'a pas de seuil : il ne peut pas se réorganiser, donc il ne peut pas se
 * chevaucher. `web/e2e/campagne-assistant-contenu.spec.ts` le mesure, en plus de mesurer le débordement.
 *
 * 🔴 LE DEVENIR DE LA CONVERSATION EST DEMANDÉ UNE SEULE FOIS, POUR TOUTE LA CAMPAGNE. Le poser par étage
 * serait à la fois faux et impossible à tenir : c'est le MÊME fil de conversation quel que soit le canal
 * par lequel le message est parti, et un contact joint au second étage ne doit pas tomber dans un autre
 * traitement que son voisin joint au premier.
 *
 * ⚠️ ET IL VAUT POUR LES DEUX FORMULES, modèle seul comme modèle plus scénario. Un scénario finit, lui
 * aussi, et la conversation doit alors aller quelque part. Ne poser la question que pour la campagne
 * simple laisserait le cas « scénario » sans réponse, c'est-à-dire des conversations qui retombent dans
 * un défaut que personne n'a choisi.
 *
 * ⚠️ TOUS LES CADRES SONT REPLIÉS À L'ARRIVÉE, un seul s'ouvre à la fois. Deux raisons, et la seconde est
 * la plus utile : on voit d'abord la FORME de sa chaîne (combien d'étages, dans quel ordre) avant de
 * plonger dans l'un d'eux ; et un cadre replié se résume à son en-tête, donc le cadre entier est une
 * cible de clic sans ambiguïté, pour un utilisateur comme pour un test.
 */

const LIBELLE_CANAL: Record<CanalEtage, string> = {
  whatsapp: 'WhatsApp',
  rcs: 'RCS',
  email: 'E-mail',
};

export function EtapeContenu({
  etat,
  chaine,
  references,
  capacites,
  nbDestinataires,
  onChange,
}: {
  etat: EtatCampagne;
  chaine: EtageAssistant[];
  references: ReferencesContenu;
  capacites: CapacitesEspace;
  /**
   * Le nombre de destinataires, quand il est connu.
   *
   * 🔴 `null` À CETTE ÉTAPE, ET C'EST LA CONSÉQUENCE DE L'ORDRE CHOISI : l'audience est demandée à
   * l'étape 4, donc après celle-ci. On ne peut donc pas afficher un compte ici, et en inventer un serait
   * pire que de ne pas l'afficher. La phrase de l'assignation dit alors ce qu'elle sait, « toutes »,
   * et renvoie au récapitulatif, qui est précisément l'écran qui rachète cet ordre.
   */
  nbDestinataires: number | null;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  /** Le cadre déplié, ou `null`. Un seul à la fois : l'état est local, il ne décrit pas la campagne. */
  const [ouvert, setOuvert] = useState<number | null>(null);

  const majContenu = (rang: number, patch: Partial<ContenuEtage>): void => {
    const courant = etat.contenus[rang] ?? contenuVide();
    onChange({ contenus: { ...etat.contenus, [rang]: { ...courant, ...patch } } });
  };

  return (
    <section data-testid="etape-contenu" className="w-full">
      <h2 className="text-lg font-semibold text-ink-800">Que reçoivent les contacts ?</h2>
      <p className="mt-1 text-sm text-ink-500">
        Un cadre par étage de la chaîne, dans l&apos;ordre d&apos;envoi. Ouvrez celui que vous voulez
        remplir.
      </p>

      {chaine.map((etage) => (
        <CadreEtage
          key={etage.rang}
          etage={etage}
          ouvert={ouvert === etage.rang}
          onToggle={() => setOuvert((o) => (o === etage.rang ? null : etage.rang))}
          contenu={etat.contenus[etage.rang] ?? contenuVide()}
          references={references}
          onChange={(patch) => majContenu(etage.rang, patch)}
        />
      ))}

      <BlocDevenir
        etat={etat}
        references={references}
        capacites={capacites}
        nbDestinataires={nbDestinataires}
        onChange={onChange}
      />
    </section>
  );
}

/** Un contenu d'étage vierge. Les suggestions partent VIDES : cf. `CadreRcs`. */
export function contenuVide(): ContenuEtage {
  return { formule: 'seul', suggestions: [] };
}

function CadreEtage({
  etage,
  ouvert,
  onToggle,
  contenu,
  references,
  onChange,
}: {
  etage: EtageAssistant;
  ouvert: boolean;
  onToggle: () => void;
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  const titreId = `etage-titre-${etage.rang}`;
  return (
    /**
     * ⚠️ `role="group"` PORTÉ PAR UN `div`, ET NON PAR UN `fieldset` AVEC SA `legend`. Une `legend` est
     * rendue DANS la bordure, au-dessus du contenu : replié, le cadre aurait alors deux zones, et son
     * centre géométrique tomberait entre les deux. Ici, replié, le cadre ne contient QUE son en-tête,
     * donc cliquer le cadre c'est cliquer l'en-tête, sans dépendre d'un pixel.
     */
    <div
      role="group"
      aria-labelledby={titreId}
      data-testid={`etage-${etage.rang}`}
      className="mt-3 w-full overflow-hidden rounded-xl border border-ink-200"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={ouvert}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-ink-50"
      >
        <span id={titreId} className="min-w-0 break-words text-sm font-medium text-ink-800">
          Étage {etage.rang} · {LIBELLE_CANAL[etage.canal]}
        </span>
        <span aria-hidden className="shrink-0 text-ink-400">{ouvert ? '–' : '+'}</span>
      </button>

      {ouvert && (
        <div className="border-t border-ink-100 px-4 py-4">
          {etage.canal === 'whatsapp' && <CadreWhatsApp contenu={contenu} references={references} onChange={onChange} />}
          {etage.canal === 'rcs' && <CadreRcs contenu={contenu} references={references} onChange={onChange} />}
          {etage.canal === 'email' && <CadreEmail contenu={contenu} references={references} onChange={onChange} />}
        </div>
      )}
    </div>
  );
}

function CadreWhatsApp({
  contenu,
  references,
  onChange,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div className="w-full space-y-3">
      <Formule
        groupe="formule-whatsapp"
        seul="Modèle seul"
        avecScenario="Modèle et scénario"
        contenu={contenu}
        onChange={onChange}
      />
      <Selecteur
        libelle="Modèle"
        valeur={contenu.templateName ?? ''}
        onChange={(v) => {
          const tpl = references.templates.find((t) => t.name === v);
          onChange({ templateName: v, templateLanguage: tpl?.language ?? '' });
        }}
        options={references.templates.map((t) => ({ valeur: t.name, libelle: `${t.name} (${t.language})` }))}
        vide="Aucun modèle approuvé sur cet espace."
      />
      {contenu.formule === 'avec_scenario' && <SelecteurScenario contenu={contenu} references={references} onChange={onChange} />}
    </div>
  );
}

function CadreRcs({
  contenu,
  references,
  onChange,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div className="w-full space-y-3">
      <Formule
        groupe="formule-rcs"
        seul="Message seul"
        avecScenario="Message et scénario"
        contenu={contenu}
        onChange={onChange}
      />
      <label className="block text-sm">
        <span className="block font-medium text-ink-700">Message</span>
        <textarea
          value={contenu.texteRcs ?? ''}
          onChange={(e) => onChange({ texteRcs: e.target.value })}
          rows={3}
          data-testid="rcs-texte"
          className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
        />
      </label>
      {/* 🔴 LE RCS NE SE RÉDUIT PAS À UN LIEN : ses suggestions sont ce qui le distingue d'un SMS enrichi,
          et l'éditeur partagé est celui des trois autres écrans, pas une quatrième copie.
          ⚠️ On part de ZÉRO suggestion : une suggestion posée d'office serait un bouton vide envoyé à des
          clients par celui qui n'aurait pas pensé à la retirer. */}
      <div>
        <p className="text-sm font-medium text-ink-700">Suggestions</p>
        <div className="mt-1 w-full">
          <RcsButtonsEditor
            boutons={contenu.suggestions}
            onChange={(b: RcsSuggestion[]) => onChange({ suggestions: b })}
            testIdPrefix="campagne-rcs"
            libelleAjout="Ajouter une suggestion"
            compact
          />
        </div>
      </div>
      {contenu.formule === 'avec_scenario' && <SelecteurScenario contenu={contenu} references={references} onChange={onChange} />}
    </div>
  );
}

function CadreEmail({
  contenu,
  references,
  onChange,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div className="w-full space-y-3">
      {/* ⚠️ PAS DE SCÉNARIO À CET ÉTAGE, et ce n'est pas un oubli : un scénario est une CONVERSATION, et
          l'e-mail n'en ouvre pas. Proposer le choix ici promettrait un enchaînement qui n'existe pas. */}
      <Selecteur
        libelle="Modèle d'e-mail"
        valeur={contenu.emailTemplateId ?? ''}
        onChange={(v) => onChange({ emailTemplateId: v })}
        options={references.emailTemplates.map((t) => ({ valeur: t.id, libelle: t.name }))}
        vide="Aucun modèle d'e-mail sur cet espace."
      />
      {/*
        🔴 QUEL CHAMP PORTE L'ADRESSE ? LA QUESTION SE POSE PARCE QU'IL N'Y A AUCUNE CONVENTION. `contacts`
        n'a PAS de colonne `email` (vérifié : 0001, puis les `alter table contacts` qui ont suivi) :
        l'adresse vit dans le jsonb `fields`, sous la clé que le client a créée dans « Champs perso ». Le
        dépôt porte déjà la trace d'un espace qui l'appelait « mail » quand un autre l'appelait « email »
        (`src/workflow/wiring.ts`, cas du 2026-08-25, où le bloc visait un champ vide). Deviner la clé,
        c'est se tromper une fois sur deux, EN SILENCE, sur un envoi réel.

        ⚠️ La valeur est SUGGÉRÉE et non imposée (`champEmailEffectif`, le MÊME point de passage que le
        comptage du récapitulatif) : on épargne un clic quand un champ
        ressemble à une adresse, et l'opérateur garde la main. Sans suggestion, le sélecteur reste vide et
        le récapitulatif le dit au lieu d'inventer un compte.
      */}
      <Selecteur
        libelle="Champ qui porte l'adresse e-mail"
        valeur={champEmailEffectif(contenu.emailChamp, references.userFields) ?? ''}
        onChange={(v) => onChange({ emailChamp: v })}
        options={references.userFields.map((f) => ({ valeur: f.key, libelle: `${f.label} (${f.key})` }))}
        vide="Aucun champ perso sur cet espace : créez-en un dans Contacts > Champs perso."
      />
      <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        L&apos;e-mail part à l&apos;adresse portée par ce champ. Un contact dont le champ est vide sort de
        la chaîne avant cet étage.
      </p>
    </div>
  );
}

function Formule({
  groupe,
  seul,
  avecScenario,
  contenu,
  onChange,
}: {
  groupe: string;
  seul: string;
  avecScenario: string;
  contenu: ContenuEtage;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div className="w-full space-y-2">
      <Radio groupe={groupe} libelle={seul} coche={contenu.formule === 'seul'} onCheck={() => onChange({ formule: 'seul' })} />
      <Radio
        groupe={groupe}
        libelle={avecScenario}
        coche={contenu.formule === 'avec_scenario'}
        onCheck={() => onChange({ formule: 'avec_scenario' })}
      />
    </div>
  );
}

function SelecteurScenario({
  contenu,
  references,
  onChange,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <Selecteur
      libelle="Scénario"
      valeur={contenu.workflowId ?? ''}
      onChange={(v) => onChange({ workflowId: v })}
      options={references.workflows.map((w) => ({ valeur: w.id, libelle: w.name }))}
      vide="Aucun scénario lançable en campagne sur cet espace."
    />
  );
}

/**
 * LE DEVENIR DE LA CONVERSATION, posé une fois pour toute la campagne.
 */
function BlocDevenir({
  etat,
  references,
  capacites,
  nbDestinataires,
  onChange,
}: {
  etat: EtatCampagne;
  references: ReferencesContenu;
  capacites: CapacitesEspace;
  nbDestinataires: number | null;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  const sansAgent = references.agents.length === 0;
  return (
    <div data-testid="bloc-devenir" className="mt-6 w-full rounded-xl border border-ink-200 p-4">
      <p className="text-sm font-medium text-ink-800">Que se passe-t-il quand le contact répond ?</p>
      <div className="mt-3 space-y-2">
        <Radio
          groupe="devenir"
          libelle="L'agent de Meta prend la main"
          coche={etat.devenir === 'mba'}
          desactive={!capacites.mbaEnabled}
          onCheck={() => onChange({ devenir: 'mba' })}
        />
        <Radio
          groupe="devenir"
          libelle="Un agent IA prend la main"
          coche={etat.devenir === 'agent'}
          desactive={sansAgent}
          onCheck={() => onChange({ devenir: 'agent' })}
        />
        <Radio
          groupe="devenir"
          libelle="La conversation arrive dans l'Inbox"
          coche={etat.devenir === 'inbox'}
          onCheck={() => onChange({ devenir: 'inbox' })}
        />
      </div>
      {/* ⚠️ GRISÉ AVEC SA RAISON, comme les canaux de l'étape précédente : une option absente ferait croire
          que la fonctionnalité n'existe pas. */}
      {sansAgent && (
        <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          Aucun agent IA actif sur cet espace.
        </p>
      )}

      {etat.devenir === 'agent' && !sansAgent && (
        <div className="mt-3">
          <Selecteur
            libelle="Agent"
            valeur={etat.agentId ?? ''}
            onChange={(v) => onChange({ agentId: v })}
            options={references.agents.map((a) => ({ valeur: a.id, libelle: a.label }))}
            vide="Aucun agent IA actif sur cet espace."
          />
        </div>
      )}

      {etat.devenir === 'inbox' && (
        <div className="mt-4 border-t border-ink-100 pt-4">
          <p className="text-sm font-medium text-ink-700">À qui va la conversation ?</p>
          <div className="mt-2 space-y-2">
            <Radio
              groupe="assignation"
              libelle="Sans assignation"
              coche={etat.assignation === 'aucune'}
              onCheck={() => onChange({ assignation: 'aucune' })}
            />
            <Radio
              groupe="assignation"
              libelle="Assignée à une personne"
              coche={etat.assignation === 'personne'}
              onCheck={() => onChange({ assignation: 'personne' })}
            />
            <Radio
              groupe="assignation"
              libelle="Répartie à tour de rôle"
              coche={etat.assignation === 'tour_de_role'}
              onCheck={() => onChange({ assignation: 'tour_de_role' })}
            />
          </div>

          {etat.assignation === 'personne' && (
            <div className="mt-3 space-y-2">
              <Selecteur
                libelle="Personne"
                valeur={etat.assignationUserId ?? ''}
                onChange={(v) => onChange({ assignationUserId: v })}
                options={references.membres.map((m) => ({ valeur: m.id, libelle: m.nom }))}
                vide="Aucun collaborateur sur cet espace."
              />
              {/* 🔴 LE NOMBRE AVANT DE VALIDER. Assigner cinq mille conversations à quelqu'un doit se voir
                  au moment où on le décide, pas le lendemain matin quand il ouvre sa liste.
                  ⚠️ À CETTE ÉTAPE, L'AUDIENCE N'EST PAS ENCORE CHOISIE (elle vient à l'étape 4) : on dit
                  donc ce qu'on sait, « toutes », et on renvoie au récapitulatif. Afficher un chiffre
                  inventé serait la seule faute vraiment grave ici. */}
              <p className="text-xs text-ink-600">
                {nbDestinataires === null
                  ? 'Toutes les conversations lui seront attribuées ; leur nombre s’affiche au récapitulatif, une fois l’audience choisie.'
                  : `${nbDestinataires.toLocaleString('fr-FR')} conversations lui seront attribuées.`}
              </p>
            </div>
          )}

          {etat.assignation === 'tour_de_role' && (
            // ⚠️ LE TOUR DE RÔLE SE JOUE À L'ARRIVÉE DE LA RÉPONSE, PAS AU LANCEMENT. Répartir cinq mille
            // conversations d'avance attribuerait des conversations qui n'existeront jamais (la plupart
            // des destinataires ne répondront pas) et fausserait tous les compteurs de charge.
            <p className="mt-3 text-xs text-ink-600">
              Chaque conversation est attribuée au suivant de l&apos;équipe au moment où elle arrive, jamais
              d&apos;avance.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Un `select` étiqueté, borné à la largeur de son parent (`w-full`), avec son cas vide. */
function Selecteur({
  libelle,
  valeur,
  onChange,
  options,
  vide,
}: {
  libelle: string;
  valeur: string;
  onChange: (v: string) => void;
  options: Array<{ valeur: string; libelle: string }>;
  vide: string;
}) {
  return (
    <label className="block w-full text-sm">
      <span className="block font-medium text-ink-700">{libelle}</span>
      {options.length === 0 ? (
        <span className="mt-1 block text-xs text-ink-500">{vide}</span>
      ) : (
        <select
          value={valeur}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
        >
          <option value="">Choisir...</option>
          {options.map((o) => (
            <option key={o.valeur} value={o.valeur}>{o.libelle}</option>
          ))}
        </select>
      )}
    </label>
  );
}

/**
 * Un bouton radio dont le NOM ACCESSIBLE est exactement son libellé.
 *
 * ⚠️ C'est le même invariant que dans l'étape Canal : rien d'autre que le libellé ne rentre dans le
 * `<label>`, sinon aucune requête par rôle ne peut plus désigner la commande sans réciter sa phrase.
 */
function Radio({
  groupe,
  libelle,
  coche,
  desactive,
  onCheck,
}: {
  groupe: string;
  libelle: string;
  coche: boolean;
  desactive?: boolean;
  onCheck: () => void;
}) {
  return (
    <label className={`flex w-full items-center gap-2 text-sm text-ink-800 ${desactive ? 'opacity-50' : ''}`}>
      <input
        type="radio"
        name={groupe}
        checked={coche}
        disabled={desactive === true}
        onChange={onCheck}
        className="h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0 break-words">{libelle}</span>
    </label>
  );
}

export type { Devenir };
