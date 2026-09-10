'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { cardCls, inputCls, inputClsAuto } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { AgentConnecteurs } from '@/components/AgentConnecteurs';
import { normaliserNomOutil } from '@/lib/agent-outils';
import {
  activerOutil, ajouterOutil, autonomieOutil, listOutils, patchOutil, retirerOutil,
  type ModeleOutil, type OutilAgent, type TexteBilingue,
} from '@/lib/api-agent-tools';

/**
 * L'onglet OUTILS d'un agent IA.
 *
 * 🔴 CE QUE CET ÉCRAN ACCORDE. Un outil actif est exposé au modèle et exécutable par lui, donc par un texte
 * qu'un contact influence. Trois choses en découlent dans la mise en page, et aucune n'est décorative :
 *
 *  - **l'activation est un geste séparé**, parce que la spec MCP demande un consentement humain avant
 *    l'invocation d'un outil et que notre agent n'a aucun humain au runtime : le consentement est déplacé
 *    ici, et il porte le nom de qui l'a donné ;
 *  - **l'autonomie sur une action irréversible est un second geste**, parce qu'un message parti chez un
 *    contact ne se rappelle pas ;
 *  - **le schéma réellement envoyé au modèle est montré**, parce que les mots du client pilotent un appel de
 *    fonction : il ne peut vérifier ce qu'il a écrit que dans sa forme réelle.
 */
export function AgentOutils({ tenantId, agentId }: { tenantId: string; agentId: string }) {
  const t = useT();
  const [vue, setVue] = useState<{ outils: OutilAgent[]; catalogue: ModeleOutil[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      setVue(await listOutils(tenantId, agentId));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [tenantId, agentId, t]);
  useEffect(() => { void charger(); }, [charger]);

  async function agir(travail: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await travail();
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
    } finally {
      setBusy(false);
    }
  }

  const poses = new Set((vue?.outils ?? []).map((o) => String(o.binding.handler ?? '')));
  const restants = (vue?.catalogue ?? []).filter((m) => !poses.has(m.handler));

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'Un outil n’est utilisable par l’agent qu’une fois ACTIVÉ ici. Tant qu’il ne l’est pas, l’agent ne sait même pas qu’il existe.',
          'A tool is only usable by the agent once ACTIVATED here. Until then, the agent does not even know it exists.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="outils-erreur">{erreur}</MbaNotice>}

      {vue === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}
      {vue?.outils.length === 0 && (
        <p data-testid="outils-vide" className="text-sm text-ink-500">
          {t('Aucun outil. Sans outil, l’agent peut parler mais ne peut rien faire, pas même terminer.', 'No tool. Without tools, the agent can talk but cannot act, not even finish.')}
        </p>
      )}

      {(vue?.outils ?? []).filter((o) => o.origin === 'mba').map((o) => (
        <Outil
          key={o.id}
          outil={o}
          modele={(vue?.catalogue ?? []).find((m) => m.handler === String(o.binding.handler ?? ''))}
          busy={busy}
          onSave={(patch) => agir(async () => { await patchOutil(tenantId, agentId, o.id, patch); })}
          onActiver={(v) => agir(async () => { await activerOutil(tenantId, agentId, o.id, v); })}
          onAutonomie={(v) => agir(async () => { await autonomieOutil(tenantId, agentId, o.id, v); })}
          onRetirer={() => agir(async () => { await retirerOutil(tenantId, agentId, o.id); })}
        />
      ))}

      {/* 🔴 DEUX SECTIONS DISTINCTES, et ce n'est pas cosmétique : le client ne doit pas confondre ce qu'on
          GARANTIT (les outils maison, dont nous écrivons le comportement) et ce qu'il BRANCHE lui-même (son
          système, dont nous ne savons rien). Les connecteurs vivent donc dans leur propre bloc, sous le
          catalogue maison. */}
      {restants.length > 0 && (
        <div className={`${cardCls} flex flex-col gap-3`}>
          <p className="text-sm font-medium text-ink-700">{t('Donner un outil de plus', 'Give one more tool')}</p>
          {restants.map((m) => (
            <div key={m.handler} data-testid={`outil-dispo-${m.handler}`} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-800">
                  <Bilingue texte={m.titre} /> <Risque risk={m.risk} />
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500"><Bilingue texte={m.description} /></p>
              </div>
              <button
                data-testid={`outil-ajouter-${m.handler}`}
                disabled={busy}
                onClick={() => void agir(async () => { await ajouterOutil(tenantId, agentId, m.handler); })}
                className="shrink-0 rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
              >
                {t('Ajouter', 'Add')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 🔴 DEUX SECTIONS DISTINCTES, et ce n'est pas cosmétique : le client ne doit pas confondre ce qu'on
          GARANTIT (les outils maison, dont nous écrivons le comportement) et ce que ses AGENTS vont chercher
          dans SES systèmes. Les systèmes eux-mêmes ne se déclarent pas ici : ils vivent dans Tools >
          Connecteurs API, parce qu'ils appartiennent au workspace et que plusieurs agents tapent dedans. */}
      <div className="border-t border-ink-200 pt-4">
        <p className="text-sm font-semibold text-ink-800">{t('Vos systèmes', 'Your systems')}</p>
        <p className="mb-2 text-xs text-ink-500">
          {t(
            'Déclarés une fois pour le workspace dans Tools > Connecteurs API, et partagés par tous vos agents. Ici, vous dites ce que CET agent a le droit d’y appeler.',
            'Declared once for the workspace in Tools > API connectors, and shared by all your agents. Here you say what THIS agent may call there.',
          )}
        </p>
        <AgentConnecteurs tenantId={tenantId} agentId={agentId} outils={vue?.outils ?? []} onChange={charger} />
      </div>
    </div>
  );
}

function Bilingue({ texte }: { texte: TexteBilingue }) {
  const { locale } = useLocale();
  return <>{locale === 'en' ? texte.en : texte.fr}</>;
}

/** Le risque est une PROPRIÉTÉ de l'outil, pas un réglage : il vient du catalogue serveur. Ce qui se règle,
 *  c'est l'autonomie, et seulement sur l'irréversible. */
function Risque({ risk }: { risk: OutilAgent['risk'] }) {
  const t = useT();
  if (risk === 'read') return <Etiquette classe="bg-ink-100 text-ink-600">{t('lecture', 'read')}</Etiquette>;
  if (risk === 'write') return <Etiquette classe="bg-sky-50 text-sky-800">{t('écriture', 'write')}</Etiquette>;
  return <Etiquette classe="bg-amber-50 text-amber-800">{t('irréversible', 'irreversible')}</Etiquette>;
}

function Etiquette({ classe, children }: { classe: string; children: React.ReactNode }) {
  return <span className={`ml-1 rounded-full px-2 py-0.5 align-middle text-[11px] font-medium ${classe}`}>{children}</span>;
}

function Outil({ outil, modele, busy, onSave, onActiver, onAutonomie, onRetirer }: {
  outil: OutilAgent;
  modele: ModeleOutil | undefined;
  busy: boolean;
  onSave: (patch: { name?: string; description?: string; nePasUtiliser?: string; enums?: Record<string, string[]> }) => void;
  onActiver: (v: boolean) => void;
  onAutonomie: (v: boolean) => void;
  onRetirer: () => void;
}) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  return (
    <div data-testid={`outil-${outil.id}`} className={`${cardCls} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-800">
            {outil.title} <Risque risk={outil.risk} />
            {outil.actif
              ? <Etiquette classe="bg-emerald-50 text-emerald-700">{t('actif', 'active')}</Etiquette>
              : <Etiquette classe="bg-ink-100 text-ink-600">{t('inactif', 'inactive')}</Etiquette>}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-500">{outil.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            data-testid={`outil-activer-${outil.id}`}
            disabled={busy}
            onClick={() => onActiver(!outil.actif)}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
          >
            {outil.actif ? t('Désactiver', 'Deactivate') : t('Activer', 'Activate')}
          </button>
          <button
            data-testid={`outil-retirer-${outil.id}`}
            disabled={busy}
            onClick={onRetirer}
            // ⚠️ « DE CET AGENT », et la précision compte depuis la migration 0127 : la définition reste
            // dans l'espace et les autres agents qui s'en servent ne sont pas touchés. Sans ces trois mots,
            // un opérateur croit détruire un outil partagé et n'ose plus cliquer.
            title={t('Retirer cet outil de cet agent (il reste dans l’espace)', 'Remove this tool from this agent (it stays in the workspace)')}
            className="rounded px-2 py-1 text-sm text-coral hover:bg-red-50 disabled:opacity-40"
          >
            ✕
          </button>
        </div>
      </div>

      {outil.risk === 'irreversible' && (
        <label data-testid={`outil-autonomie-${outil.id}`} className="flex items-start gap-2 rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-ink-800">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={outil.autonome}
            disabled={busy}
            onChange={(e) => onAutonomie(e.target.checked)}
          />
          <span>
            {t(
              'Autoriser l’agent à faire ça SEUL. Non cochée, l’action est refusée à chaque appel : c’est irréversible, et le contact le reçoit vraiment.',
              'Allow the agent to do this ON ITS OWN. Unchecked, the action is refused on every call: it is irreversible, and the contact really receives it.',
            )}
          </span>
        </label>
      )}

      {outil.actif && outil.expose === null && (
        <MbaNotice kind="warning">
          {t(
            'Cet outil est actif mais le modèle n’en voit RIEN : il n’a aucune valeur possible. Déclarez au moins une règle d’arrêt dans l’onglet « Objectif et transferts ».',
            'This tool is active but the model sees NOTHING of it: it has no possible value. Declare at least one stop rule in the “Objective and handovers” tab.',
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
        label={t('Quand NE PAS l’appeler', 'When NOT to call it')}
        valeur={outil.nePasUtiliser} onSave={(v) => onSave({ nePasUtiliser: v })}
      />

      {(modele?.params ?? []).filter((p) => p.edition === 'enum').map((p) => (
        <ListeValeurs
          key={p.name}
          outilId={outil.id}
          nom={p.name}
          aide={p.aideEnum}
          valeurs={valeursDe(outil, p.name)}
          busy={busy}
          onSave={(valeurs) => onSave({ enums: { [p.name]: valeurs } })}
        />
      ))}
      {(modele?.params ?? []).some((p) => p.edition === 'derive_des_sorties') && (
        <p className="text-xs leading-relaxed text-ink-500">
          {t(
            'Les valeurs possibles de cet outil sont vos règles d’arrêt : elles se règlent dans l’onglet « Objectif et transferts », et se répercutent ici toutes seules.',
            'This tool’s possible values are your stop rules: set them in the “Objective and handovers” tab, and they carry over here on their own.',
          )}
        </p>
      )}

      <div>
        <button
          data-testid={`outil-schema-bouton-${outil.id}`}
          onClick={() => setOuvert(!ouvert)}
          className="text-xs text-brand-600 hover:underline"
        >
          {ouvert ? t('Masquer ce que le modèle voit', 'Hide what the model sees') : t('Voir ce que le modèle voit', 'See what the model sees')}
        </button>
        {ouvert && (
          <pre data-testid={`outil-schema-${outil.id}`} className="mt-2 max-h-64 overflow-auto rounded-lg bg-ink-50 p-3 text-[11px] leading-relaxed text-ink-700">
            {outil.expose === null
              ? t('Rien : cet outil n’a aucune valeur possible.', 'Nothing: this tool has no possible value.')
              : JSON.stringify(outil.expose, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Le nom sous lequel le MODÈLE appelle cet outil.
 *
 * Normalisé sous les yeux du client plutôt que refusé après coup : la base et la route n'acceptent que
 * `[a-z0-9_]`, et « Poser un tag » rendrait un 400 sur un champ que le client croyait bon.
 */
function NomExpose({ outil, busy, onSave }: { outil: OutilAgent; busy: boolean; onSave: (v: string) => void }) {
  const t = useT();
  const [v, setV] = useState(outil.name);
  useEffect(() => { setV(outil.name); }, [outil.name]);
  const propre = normaliserNomOutil(v);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-700">{t('Nom vu par le modèle', 'Name seen by the model')}</label>
      <input
        data-testid={`outil-nom-${outil.id}`}
        className={`${inputCls} font-mono`}
        value={v}
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (propre !== '' && propre !== outil.name) onSave(propre); else setV(outil.name); }}
      />
      {propre !== v.trim() && propre !== '' && (
        <span data-testid={`outil-nom-normalise-${outil.id}`} className="font-mono text-[11px] text-ink-500">{propre}</span>
      )}
      <p className="text-xs leading-relaxed text-ink-500">
        {t('Un nom parlant fait un meilleur agent. Minuscules, chiffres et tirets bas seulement.', 'A meaningful name makes a better agent. Lowercase, digits and underscores only.')}
      </p>
    </div>
  );
}

/** Les valeurs déjà autorisées pour un paramètre, lues DÉFENSIVEMENT : `params` est du jsonb, donc opaque. */
function valeursDe(outil: OutilAgent, nom: string): string[] {
  const liste = Array.isArray(outil.params) ? outil.params : [];
  for (const brut of liste) {
    if (!brut || typeof brut !== 'object') continue;
    const p = brut as { name?: unknown; enum?: unknown };
    if (p.name !== nom) continue;
    return Array.isArray(p.enum) ? p.enum.filter((v): v is string => typeof v === 'string') : [];
  }
  return [];
}

/** La liste fermée des valeurs qu'un paramètre accepte. Vide, elle n'impose rien, et l'écran le dit : c'est
 *  le seul garde-fou contre un modèle qui viserait le champ sur lequel une condition du scénario branche. */
function ListeValeurs({ outilId, nom, aide, valeurs, busy, onSave }: {
  outilId: string; nom: string; aide?: TexteBilingue; valeurs: string[]; busy: boolean;
  onSave: (v: string[]) => void;
}) {
  const t = useT();
  const [ajout, setAjout] = useState('');
  const propre = ajout.trim();
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-ink-700">
        {t('Valeurs autorisées pour', 'Allowed values for')} <span className="font-mono text-xs">{nom}</span>
      </label>
      {aide && <p className="text-xs leading-relaxed text-ink-500"><Bilingue texte={aide} /></p>}
      <div className="flex flex-wrap gap-2">
        {valeurs.map((v) => (
          <span key={v} data-testid={`outil-valeur-${outilId}-${v}`} className="flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-700">
            {v}
            <button
              data-testid={`outil-valeur-retirer-${outilId}-${v}`}
              disabled={busy}
              onClick={() => onSave(valeurs.filter((x) => x !== v))}
              className="text-coral disabled:opacity-40"
            >
              ✕
            </button>
          </span>
        ))}
        {valeurs.length === 0 && (
          <span className="text-xs text-amber-800">
            {t('Aucune restriction : l’agent peut y mettre ce qu’il veut.', 'No restriction: the agent can put whatever it wants.')}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          data-testid={`outil-valeur-saisie-${outilId}-${nom}`}
          className={`${inputClsAuto} w-56`}
          value={ajout}
          disabled={busy}
          onChange={(e) => setAjout(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && propre !== '' && !valeurs.includes(propre)) { onSave([...valeurs, propre]); setAjout(''); } }}
          placeholder={t('une valeur', 'a value')}
        />
        <button
          data-testid={`outil-valeur-ajouter-${outilId}-${nom}`}
          disabled={busy || propre === '' || valeurs.includes(propre)}
          onClick={() => { onSave([...valeurs, propre]); setAjout(''); }}
          className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        >
          {t('Ajouter', 'Add')}
        </button>
      </div>
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
      <label className="text-sm font-medium text-ink-700">{label}</label>
      {multi ? <textarea rows={3} {...commun} /> : <input {...commun} />}
      {aide && <p className="text-xs leading-relaxed text-ink-500">{aide}</p>}
    </div>
  );
}
