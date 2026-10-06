'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { cardCls, inputCls, inputClsAuto } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { normaliserNomOutil } from '@/lib/agent-outils';
import { Bouton } from '@/components/Bouton';
import type { GesteMoment, ModeleOutil, OutilAgent, TexteBilingue } from '@/lib/api-agent-tools';

/**
 * LES RÉGLAGES D'UN OUTIL POSÉ SUR UN AGENT IA : son nom vu par le modèle, ses deux consignes, ses gestes, l'autonomie
 * d'une action irréversible, et ce que le modèle en voit. Ouverts par « Régler » (section « Toujours là ») ou par
 * « Modifier » (outil MCP) ; un outil à cible (RC4) a son propre formulaire (`FormulaireOutilAgent`), qui reprend
 * l'autonomie, les gestes et le schéma d'ici.
 *
 * 🔴 CE QUE CET ÉCRAN ACCORDE. Un outil actif est exposé au modèle et exécutable par lui, donc par un texte qu'un
 * contact influence :
 *  - **l'autonomie sur une action irréversible est un geste séparé**, parce qu'un message parti chez un contact ne se
 *    rappelle pas ;
 *  - **le schéma réellement envoyé au modèle est montré**, parce que les mots du client pilotent un appel de fonction :
 *    il ne peut vérifier ce qu'il a écrit que dans sa forme réelle.
 *
 * L'activation et le retrait, eux, sont sur la ligne de l'outil (`LigneOutilAgent`, `ToujoursLa`), pas ici.
 */

export type PatchReglages = { name?: string; description?: string; nePasUtiliser?: string; gestes?: GesteMoment[] };

export function Bilingue({ texte }: { texte: TexteBilingue }) {
  const { locale } = useLocale();
  return <>{locale === 'en' ? texte.en : texte.fr}</>;
}

/**
 * Le risque est une PROPRIÉTÉ de l'outil, pas un réglage : il vient du catalogue serveur. Ce qui se règle, c'est
 * l'autonomie, et seulement sur le risque le plus haut.
 *
 * 🔴 IL DIT CE QUI SE PASSE, PLUS « IRRÉVERSIBLE » (Julien, 2026-09-24 : « ça veut rien dire, c'est confusant »).
 * « Envoyer un bloc » et « Lancer un scénario » (RC4) font PARTIR un message chez le contact : c'est ce que le client a
 * besoin de lire. ⚠️ `risk` NE BOUGE PAS, c'est la valeur du catalogue serveur, celle que la garde d'autonomie lit.
 */
export function Risque({ risk, handler }: { risk: OutilAgent['risk']; handler?: string }) {
  const t = useT();
  if (risk === 'read') return <Etiquette classe="bg-ink-100 text-ink-500">{t('lecture', 'read')}</Etiquette>;
  if (risk === 'write') return <Etiquette classe="bg-brand-50 text-brand-600">{t('écriture', 'write')}</Etiquette>;
  return (
    <Etiquette classe="bg-alerte-50 text-alerte-800">
      {handler === 'envoyer_bloc' || handler === 'lancer_scenario' ? t('part chez le client', 'reaches the customer') : t('sans retour', 'no undo')}
    </Etiquette>
  );
}

export function Etiquette({ classe, children }: { classe: string; children: React.ReactNode }) {
  return <span className={`ml-1 rounded-full px-2 py-0.5 align-middle text-xs font-medium ${classe}`}>{children}</span>;
}

/** La case d'autonomie d'une action irréversible. Non cochée, le tronc commun refuse l'appel à chaque fois. */
export function AutonomieOutil({ id, coche, busy, onChange }: { id: string; coche: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label data-testid={`outil-autonomie-${id}`} className="flex items-start gap-2 rounded-controle border border-alerte-300 bg-alerte-50 px-3 py-2 text-sm text-ink-900">
      <input type="checkbox" className="mt-0.5" checked={coche} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {t(
          'Autoriser l’agent à faire ça seul. Non cochée, l’action est refusée à chaque appel : ce qui part, part vraiment chez le contact et ne se rappelle pas.',
          'Allow the agent to do this on its own. Unchecked, the action is refused on every call: it is irreversible, and the contact really receives it.',
        )}
      </span>
    </label>
  );
}

/** « Voir ce que le modèle voit » : le schéma réel, ou rien quand l'outil n'a aucune valeur possible. */
export function SchemaModele({ outil }: { outil: OutilAgent }) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  return (
    <div>
      <button data-testid={`outil-schema-bouton-${outil.id}`} onClick={() => setOuvert(!ouvert)} className="text-xs text-brand-600 hover:underline">
        {ouvert ? t('Masquer ce que le modèle voit', 'Hide what the model sees') : t('Voir ce que le modèle voit', 'See what the model sees')}
      </button>
      {ouvert && (
        <pre data-testid={`outil-schema-${outil.id}`} className="mt-2 max-h-64 overflow-auto rounded-carte bg-ink-50 p-3 text-xs leading-relaxed text-ink-900">
          {outil.expose === null
            ? t('Rien : cet outil n’a aucune valeur possible, ou ce qu’il vise ne se lit plus.', 'Nothing: this tool has no possible value, or what it targets can no longer be read.')
            : JSON.stringify(outil.expose, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ReglagesOutil({ outil, modele, busy, onSave, onAutonomie }: {
  outil: OutilAgent;
  modele: ModeleOutil | undefined;
  busy: boolean;
  onSave: (patch: PatchReglages) => void;
  onAutonomie: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div data-testid={`outil-${outil.id}`} className={`${cardCls} flex flex-col gap-3`}>
      {/**
        * ⚠️ POUR UN OUTIL MCP, « à quoi ça sert » APPARTIENT AU SERVEUR DISTANT : un rafraîchissement réécrit le titre et
        * la description depuis l'annonce, donc un texte soigné ici disparaît au prochain import. Le nom exposé, lui, est
        * préservé (il est peut-être déjà écrit dans la consigne d'un agent).
        */}
      {outil.origin === 'mcp' && (
        <p className="text-xs text-ink-500" data-testid={`outil-mcp-mots-${outil.id}`}>
          {t(
            'Le titre et « À quoi ça sert » viennent du serveur MCP et sont réécrits à chaque import. Le nom d’appel et « Quand ne pas l’appeler » vous appartiennent, eux.',
            'The title and "What it does" come from the MCP server and are rewritten on every import. The call name and "When NOT to call it" are yours.',
          )}
        </p>
      )}

      {outil.risk === 'irreversible' && <AutonomieOutil id={outil.id} coche={outil.autonome} busy={busy} onChange={onAutonomie} />}

      {outil.actif && outil.expose === null && (
        <MbaNotice kind="warning">
          {t(
            'Cet outil est actif mais le modèle n’en voit rien : il n’a aucune valeur possible. Déclarez au moins une règle d’arrêt dans l’onglet « Objectif et transferts ».',
            'This tool is active but the model sees nothing of it: it has no possible value. Declare at least one stop rule in the “Objective and handovers” tab.',
          )}
        </MbaNotice>
      )}

      <NomExpose outil={outil} busy={busy} onSave={(name) => onSave({ name })} />
      <Champ
        testId={`outil-description-${outil.id}`} busy={busy} multi
        label={t('Quand l’appeler', 'When to call it')}
        aide={t('C’est ce texte que le modèle lit pour décider. Le soigner change beaucoup ce que fait l’agent.', 'This is the text the model reads to decide. Care here changes a lot of what the agent does.')}
        valeur={outil.description} onSave={(v) => onSave({ description: v })}
      />
      <Champ
        testId={`outil-nepasutiliser-${outil.id}`} busy={busy} multi
        label={t('Quand ne pas l’appeler', 'When not to call it')}
        valeur={outil.nePasUtiliser} onSave={(v) => onSave({ nePasUtiliser: v })}
      />

      <Gestes outil={outil} busy={busy} onSave={(gestes) => onSave({ gestes })} />

      {(modele?.params ?? []).some((p) => p.edition === 'derive_des_sorties') && (
        <p className="text-xs leading-relaxed text-ink-500">
          {t(
            'Les valeurs possibles de cet outil sont vos règles d’arrêt : elles se règlent dans l’onglet « Objectif et transferts », et se répercutent ici toutes seules.',
            'This tool’s possible values are your stop rules: set them in the “Objective and handovers” tab, and they carry over here on their own.',
          )}
        </p>
      )}

      <SchemaModele outil={outil} />
    </div>
  );
}

/**
 * Le nom sous lequel le MODÈLE appelle cet outil. Normalisé sous les yeux du client plutôt que refusé après coup : la
 * base et la route n'acceptent que `[a-z0-9_]`, et « Poser un tag » rendrait un 400 sur un champ que le client croyait bon.
 */
function NomExpose({ outil, busy, onSave }: { outil: OutilAgent; busy: boolean; onSave: (v: string) => void }) {
  const t = useT();
  const [v, setV] = useState(outil.name);
  useEffect(() => { setV(outil.name); }, [outil.name]);
  const propre = normaliserNomOutil(v);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-900">{t('Nom vu par le modèle', 'Name seen by the model')}</label>
      <input
        data-testid={`outil-nom-${outil.id}`}
        className={`${inputCls} font-mono`}
        value={v}
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (propre !== '' && propre !== outil.name) onSave(propre); else setV(outil.name); }}
      />
      {propre !== v.trim() && propre !== '' && (
        <span data-testid={`outil-nom-normalise-${outil.id}`} className="font-mono text-xs text-ink-500">{propre}</span>
      )}
      <p className="text-xs leading-relaxed text-ink-500">
        {t('Un nom parlant fait un meilleur agent. Minuscules, chiffres et tirets bas seulement.', 'A meaningful name makes a better agent. Lowercase, digits and underscores only.')}
      </p>
    </div>
  );
}

/** Champ texte enregistré à la sortie du champ, comme le reste des écrans d'agent. */
function Champ({ label, aide, valeur, multi, onSave, testId, busy }: {
  label: string; aide?: string; valeur: string; multi?: boolean; testId: string; busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(valeur);
  useEffect(() => { setV(valeur); }, [valeur]);
  const commun = {
    'data-testid': testId,
    className: inputCls,
    value: v,
    disabled: busy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => { if (v !== valeur) onSave(v); },
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-900">{label}</label>
      {multi ? <textarea rows={3} {...commun} /> : <input {...commun} />}
      {aide && <p className="text-xs leading-relaxed text-ink-500">{aide}</p>}
    </div>
  );
}

/**
 * LES GESTES DU MOMENT : ce que NOUS faisons quand il se produit, sans le demander au modèle (0158).
 *
 * 🔴 POURQUOI ILS NE SONT PAS DES OUTILS. « Quand le client veut un rendez-vous », il faut appeler l'ERP ET poser un
 * tag. Avec deux outils, le modèle voit deux surfaces décrivant la MÊME situation et en choisit une, ou les deux, ou
 * aucune. Ici le modèle appelle UN outil, et les effets de bord sont à nous.
 *
 * 🔴 L'ÉCRAN DIT QU'ILS PARTENT MÊME SI L'APPEL ÉCHOUE : c'est ce qui explique pourquoi un libellé doit dire « demandé »
 * et jamais « pris ».
 */
export function Gestes({ outil, busy, onSave }: {
  outil: OutilAgent;
  busy: boolean;
  onSave: (gestes: GesteMoment[]) => void;
}) {
  const t = useT();
  const [type, setType] = useState<GesteMoment['type']>('tag');
  const [valeur, setValeur] = useState('');
  const [champ, setChamp] = useState('');
  const gestes = outil.gestes ?? [];
  const prete = type === 'tag' ? valeur.trim() !== '' : champ.trim() !== '' && valeur.trim() !== '';

  function ajouter(): void {
    if (!prete) return;
    const g: GesteMoment = type === 'tag'
      ? { type: 'tag', valeur: valeur.trim() }
      : { type: 'variable', champ: champ.trim(), valeur: valeur.trim() };
    onSave([...gestes, g]);
    setValeur('');
    setChamp('');
  }

  return (
    <div data-testid={`outil-gestes-${outil.id}`} className="rounded-controle border border-ink-200 px-3 py-2">
      <p className="text-xs font-medium text-ink-900">{t('Et en plus, faire ceci', 'And also do this')}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
        {t(
          'Ce que nous faisons nous-mêmes quand ce moment se produit, sans le demander au modèle. Ces gestes partent même si l’appel ci-dessus échoue : ils marquent que la situation s’est produite, pas qu’elle a abouti. Écrivez donc « rendez-vous demandé » plutôt que « rendez-vous pris ».',
          'What we do ourselves when this moment happens, without asking the model. These fire even if the call above fails: they record that the situation happened, not that it succeeded. So write “appointment requested” rather than “appointment booked”.',
        )}
      </p>

      {gestes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {gestes.map((g, i) => (
            <li key={`${g.type}-${i}`} data-testid={`outil-geste-${outil.id}-${i}`} className="flex items-center justify-between gap-2 text-xs text-ink-900">
              <span className="min-w-0 truncate">
                {g.type === 'tag'
                  ? t(`Poser le tag « ${g.valeur} »`, `Tag with “${g.valeur}”`)
                  : t(`Écrire « ${g.valeur} » dans le champ « ${g.champ} »`, `Write “${g.valeur}” into field “${g.champ}”`)}
              </span>
              <Bouton variante="secondaire" taille="petite"
                data-testid={`outil-geste-retirer-${outil.id}-${i}`}
                disabled={busy}
                onClick={() => onSave(gestes.filter((_, j) => j !== i))}
                className="shrink-0"
              >
                {t('Retirer', 'Remove')}
              </Bouton>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          data-testid={`outil-geste-type-${outil.id}`}
          className={`${inputClsAuto} text-xs`}
          value={type}
          disabled={busy}
          onChange={(e) => setType(e.target.value as GesteMoment['type'])}
        >
          <option value="tag">{t('Poser un tag', 'Tag the contact')}</option>
          <option value="variable">{t('Écrire dans un champ', 'Write into a field')}</option>
        </select>
        {type === 'variable' && (
          <input
            data-testid={`outil-geste-champ-${outil.id}`}
            className={`${inputClsAuto} text-xs`}
            placeholder={t('nom du champ', 'field name')}
            value={champ}
            disabled={busy}
            onChange={(e) => setChamp(e.target.value)}
          />
        )}
        <input
          data-testid={`outil-geste-valeur-${outil.id}`}
          className={`${inputClsAuto} text-xs`}
          placeholder={type === 'tag' ? t('rendez_vous_demande', 'appointment_requested') : t('la valeur', 'the value')}
          value={valeur}
          disabled={busy}
          onChange={(e) => setValeur(e.target.value)}
        />
        <Bouton variante="secondaire" taille="petite"
          data-testid={`outil-geste-ajouter-${outil.id}`}
          disabled={busy || !prete}
          onClick={ajouter}
        >
          {t('Ajouter', 'Add')}
        </Bouton>
      </div>
    </div>
  );
}
