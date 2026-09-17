'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { cardCls, inputCls, inputClsAuto } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { AgentConnecteurs } from '@/components/AgentConnecteurs';
import { normaliserNomOutil } from '@/lib/agent-outils';
import { listNodes, type NodeListItem } from '@/lib/api/scenarios';
import {
  activerOutil, ajouterOutil, autonomieOutil, getBibliothequeOutils, listOutils, patchOutil,
  rattacherOutil, retirerOutil,
  type ModeleOutil, type OutilAgent, type OutilBibliotheque, type TexteBilingue,
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
/**
 * ⚠️ `onChange` EXISTE PARCE QUE LE BANDEAU D'AVERTISSEMENT VIT AILLEURS. Ce panneau écrit dans SA table,
 * sans passer par `enregistrer` de la page ; or c'est `enregistrer` qui relisait les manques. Activer un
 * outil laissait donc « Aucun outil actif » à l'écran alors que l'outil venait d'être activé, jusqu'à ce
 * qu'on quitte l'agent et qu'on y revienne. Signalé par Julien le 2026-09-11, et il a d'abord cru que
 * c'était l'activation qui n'avait pas pris.
 */
export function AgentOutils({ tenantId, agentId, onChange }: { tenantId: string; agentId: string; onChange?: () => void }) {
  const t = useT();
  const [vue, setVue] = useState<{ outils: OutilAgent[]; catalogue: ModeleOutil[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [bibliotheque, setBibliotheque] = useState<OutilBibliotheque[]>([]);

  const charger = useCallback(async () => {
    try {
      /**
       * 🔴 DEUX LECTURES, ET LA SECONDE EST CE QUI REND LES OUTILS MCP ATTEIGNABLES. `listOutils` fait une
       * jointure INTERNE sur les consommateurs (délibéré : cet écran montre ce que CET agent utilise, pas
       * tout le catalogue), donc un outil importé mais jamais rattaché n'y figure PAS. Et l'import n'écrit
       * aucune ligne de consommateur. Sans la bibliothèque de l'espace, la section « Vos serveurs MCP »
       * était donc vide POUR TOUJOURS : une porte de plus sans producteur, la troisième de ce chantier.
       *
       * ⚠️ BEST-EFFORT : la bibliothèque n'est qu'une aide au rattachement. Si elle échoue, l'écran
       * continue de montrer ce qui est déjà rattaché plutôt que de ne rien montrer du tout.
       */
      const [v, bib] = await Promise.all([
        listOutils(tenantId, agentId),
        // ⚠️ `?? []` ET PAS SEULEMENT UN `catch` : un serveur qui rend 200 avec un corps vide ne LEVE
        // pas, donc `outils` vaut `undefined` et le `filter` plus bas faisait planter tout le rendu de
        // l onglet. Attrape par un test existant, pas par la relecture.
        getBibliothequeOutils(tenantId).then((r) => r.outils ?? []).catch(() => []),
      ]);
      setVue(v);
      setBibliotheque(bib);
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
      // Le bandeau de la page se calcule sur CET inventaire : sans ce rappel, il annonce l'état d'avant.
      onChange?.();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
    } finally {
      setBusy(false);
    }
  }

  const poses = new Set((vue?.outils ?? []).map((o) => String(o.binding.handler ?? '')));
  const restants = (vue?.catalogue ?? []).filter((m) => !poses.has(m.handler));
  /**
   * Les outils MCP de l'ESPACE que cet agent n'a pas encore. Le jumeau exact de `restants` pour les outils
   * maison, et de « + donner cet appel à l'agent » pour les connecteurs API.
   *
   * ⚠️ ON RAPPROCHE PAR IDENTIFIANT, jamais par nom : le nom exposé est réécrit par le client.
   */
  const rattaches = new Set((vue?.outils ?? []).map((o) => o.id));
  const mcpARattacher = bibliotheque.filter((o) => o.origin === 'mcp' && !rattaches.has(o.id));

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
          tenantId={tenantId}
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

      {/**
        * 🔴 SANS CETTE SECTION, UN OUTIL MCP N'APPARAÎT NULLE PART SUR CET ÉCRAN, et le chemin de
        * consentement que le produit annonce n'existe pas. La section « Vos systèmes » groupe par REQUÊTE
        * de la bibliothèque d'appels API ; un outil MCP n'a pas de requête (`requestId` à `null`), donc
        * il ne tombait dans aucune des deux listes. On pouvait l'importer, le régler, le voir dans
        * Tools > Outils, et jamais l'autoriser pour un agent : c'est le même défaut que « déclarer un
        * serveur », relevé par la première revue à froid, une porte de plus sans producteur.
        *
        * ⚠️ TROISIÈME SECTION ET PAS UNE FUSION avec « Vos systèmes » : un serveur MCP n'est pas un
        * connecteur API, il n'a ni méthode, ni chemin, ni requête à nommer, et les ranger ensemble
        * obligerait à inventer une ligne vide pour chacun.
        */}
      {((vue?.outils ?? []).some((o) => o.origin === 'mcp') || mcpARattacher.length > 0) && (
        <div className="border-t border-ink-200 pt-4" data-testid="agent-outils-mcp">
          <p className="text-sm font-semibold text-ink-800">{t('Vos serveurs MCP', 'Your MCP servers')}</p>
          <p className="mb-2 text-xs text-ink-500">
            {t(
              'Importés depuis Tools > Connecteurs MCP, et partagés par tous vos agents. Ici, vous dites ce que CET agent a le droit d’appeler. Les paramètres se règlent là-bas.',
              'Imported from Tools > MCP connectors, and shared by all your agents. Here you say what THIS agent may call. Parameters are set over there.',
            )}
          </p>
          <div className="flex flex-col gap-3">
            {mcpARattacher.length > 0 && (
              <div data-testid="mcp-a-rattacher" className="rounded-lg border border-dashed border-ink-300 p-3">
                <p className="text-xs text-ink-600">
                  {t('Importés dans l’espace, pas encore donnés à cet agent :', 'Imported in the workspace, not yet given to this agent:')}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {mcpARattacher.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 text-sm text-ink-700">
                      <span className="min-w-0 truncate">{o.title} <code className="text-[11px] text-ink-500">{o.name}</code></span>
                      <button
                        data-testid={`mcp-rattacher-${o.id}`}
                        disabled={busy}
                        onClick={() => agir(async () => { await rattacherOutil(tenantId, agentId, o.id, true); })}
                        className="shrink-0 text-xs text-brand-600 hover:underline disabled:opacity-40"
                      >
                        {t('+ donner cet outil à l’agent', '+ give this tool to the agent')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(vue?.outils ?? []).filter((o) => o.origin === 'mcp').map((o) => (
              <Outil
                key={o.id}
                tenantId={tenantId}
                outil={o}
                // ⚠️ AUCUN MODÈLE MAISON : les mots d'un outil MCP viennent du serveur distant.
                modele={undefined}
                busy={busy}
                onSave={(patch) => agir(async () => { await patchOutil(tenantId, agentId, o.id, patch); })}
                onActiver={(v) => agir(async () => { await activerOutil(tenantId, agentId, o.id, v); })}
                onAutonomie={(v) => agir(async () => { await autonomieOutil(tenantId, agentId, o.id, v); })}
                onRetirer={() => agir(async () => { await retirerOutil(tenantId, agentId, o.id); })}
              />
            ))}
          </div>
        </div>
      )}
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
  if (risk === 'write') return <Etiquette classe="bg-sky/10 text-sky">{t('écriture', 'write')}</Etiquette>;
  return <Etiquette classe="bg-amber-50 text-amber-800">{t('irréversible', 'irreversible')}</Etiquette>;
}

function Etiquette({ classe, children }: { classe: string; children: React.ReactNode }) {
  return <span className={`ml-1 rounded-full px-2 py-0.5 align-middle text-[11px] font-medium ${classe}`}>{children}</span>;
}

function Outil({ tenantId, outil, modele, busy, onSave, onActiver, onAutonomie, onRetirer }: {
  tenantId: string;
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
            /**
             * ⚠️ PAS CLIQUABLE SUR UN OUTIL QUE LE BANDEAU VIENT DE DÉCLARER MORT. Le serveur refuse déjà
             * (409 avec sa raison), donc rien ne cassait ; mais proposer un geste dont on vient d'écrire
             * qu'il est impossible est le motif « offert-et-inerte » que ce produit s'interdit ailleurs.
             * ⚠️ La DÉSACTIVATION reste possible : c'est le seul geste qui reste au client sur un outil
             * qu'un rafraîchissement a rendu inappelable alors qu'il était actif.
             */
            disabled={busy || (!outil.actif && Boolean(outil.mcpNonActivable || outil.mcpIndisponibleLe))}
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

      {/* 🔴 UN OUTIL MORT NE SE PRÉSENTE PAS COMME UN OUTIL VIVANT sur l'écran où l'on décide de
          l'autoriser. La raison vient du serveur distant : le client ne peut pas la corriger, mais il
          doit pouvoir la montrer à son fournisseur. */}
      {(outil.mcpIndisponibleLe || outil.mcpNonActivable) && (
        <p data-testid={`outil-mcp-mort-${outil.id}`}
          className="rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-sm text-ink-800">
          {outil.mcpIndisponibleLe
            ? t('Cet outil a disparu du serveur MCP : il n’est plus appelable.',
              'This tool is gone from the MCP server: it can no longer be called.')
            : t('Cet outil n’est pas activable : ', 'This tool cannot be activated: ') + (outil.mcpNonActivable ?? '')}
        </p>
      )}

      {/**
        * ⚠️ POUR UN OUTIL MCP, « à quoi ça sert » APPARTIENT AU SERVEUR DISTANT. Un rafraîchissement en
        * `schema_change` réécrit `title` et `description` depuis l'annonce (`store.pg.ts`), donc un texte
        * soigné ici disparaît au prochain import, sans cause visible, pendant que `features.md` promet par
        * ailleurs que « vos choix SURVIVENT aux rafraîchissements ». `nePasUtiliser`, lui, est PRÉSERVÉ :
        * c'est le seul des deux qui vous appartient, et c'est le seul qu'on propose.
        */}
      {outil.origin === 'mcp' && (
        <p className="text-xs text-ink-500" data-testid={`outil-mcp-mots-${outil.id}`}>
          {t(
            'Le nom et la description viennent du serveur MCP et sont réécrits à chaque import. Seul « Quand ne pas l’appeler » vous appartient.',
            'The name and description come from the MCP server and are rewritten on every import. Only "When NOT to call it" is yours.',
          )}
        </p>
      )}

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
        /* 🔴 LE CODE D'UN BLOC NE SE TAPE PAS, IL SE CHOISIT. Ce paramètre demandait des codes « nod_… »
           que le client ne voit NULLE PART dans la console : la question de Julien, le 2026-09-11, était
           littéralement « comment le user choisit le bloc ? ». La réponse était : il ne pouvait pas. Les
           autres énumérations (les champs de contact) restent en saisie libre, elles n'ont pas de liste
           d'où sortir. */
        String(outil.binding.handler ?? '') === 'envoyer_bloc' && p.name === 'code' ? (
          <ChoixDeBlocs
            key={p.name}
            tenantId={tenantId}
            outilId={outil.id}
            valeurs={valeursDe(outil, p.name)}
            busy={busy}
            onSave={(valeurs) => onSave({ enums: { [p.name]: valeurs } })}
          />
        ) : (
          <ListeValeurs
            key={p.name}
            outilId={outil.id}
            nom={p.name}
            aide={p.aideEnum}
            valeurs={valeursDe(outil, p.name)}
            busy={busy}
            onSave={(valeurs) => onSave({ enums: { [p.name]: valeurs } })}
          />
        )
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

/**
 * CHOISIR LES BLOCS que l'agent a le droit d'envoyer, dans une LISTE, au lieu de taper des codes.
 *
 * 🔴 POURQUOI IL FALLAIT LE FAIRE. Le paramètre `code` de « Envoyer un bloc de votre scénario » réclamait
 * des codes « nod_… ». Ils existent, ils sont justes, et ils ne sont écrits NULLE PART dans la console :
 * personne ne pouvait en connaître un. Julien, le 2026-09-11 : « comment le user choisit le bloc ? ».
 * Il ne pouvait pas.
 *
 * 🔴 SEULS LES SCÉNARIOS QUI CONTIENNENT UN BLOC AGENT SONT PROPOSÉS, et ce n'est pas du rangement.
 * L'outil envoie un bloc du scénario où le contact se trouve DÉJÀ (`envoyerBlocDepuisAgent` refuse tout
 * autre parcours, et la raison est écrite dans l'exécuteur : passer par `runFrom` tuerait le run de
 * l'agent qui appelle). Un bloc pris dans un scénario sans agent ne pourrait donc JAMAIS partir, et le
 * proposer serait promettre un geste qui échouera toujours.
 *
 * ⚠️ QUATRE TYPES DE BLOCS SONT ÉCARTÉS, parce que l'exécuteur les refuse à coup sûr : un bloc Agent (une
 * seconde session lèverait sur l'index « une seule session vivante par parcours »), un bloc Inbox (le fil
 * basculerait en laissant le run planté), une Attente (son échéance n'est écrite nulle part, donc la suite
 * ne partirait jamais) et un envoi RCS. ⚠️ Le filtre est SÛR, pas COMPLET : l'exécuteur refuse sur le REPOS
 * du parcours, qu'on ne peut pas calculer ici. Un bloc proposé peut donc encore être refusé s'il mène à
 * l'un de ces quatre ; l'inverse, lui, ne peut pas arriver.
 */
function ChoixDeBlocs({ tenantId, outilId, valeurs, busy, onSave }: {
  tenantId: string; outilId: string; valeurs: string[]; busy: boolean; onSave: (v: string[]) => void;
}) {
  const t = useT();
  const [blocs, setBlocs] = useState<NodeListItem[] | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    void listNodes(tenantId)
      .then((r) => { if (vivant) setBlocs(r.nodes); })
      // Un échec ne doit pas rendre le paramètre INMODIFIABLE : on retombe sur la liste brute des codes déjà
      // choisis, qui reste retirable. Perdre le choisisseur est gênant, perdre le réglage serait grave.
      .catch(() => { if (vivant) setErreur(true); });
    return () => { vivant = false; };
  }, [tenantId]);

  const REPOS_REFUSES = ['agent', 'inbox', 'wait', 'rcs_message'];
  const avecAgent = new Set((blocs ?? []).filter((n) => n.type === 'agent').map((n) => n.workflowId));
  const proposables = (blocs ?? []).filter(
    (n) => n.code !== null && avecAgent.has(n.workflowId) && !REPOS_REFUSES.includes(n.type),
  );
  const parScenario = new Map<string, NodeListItem[]>();
  for (const n of proposables) parScenario.set(n.workflowName, [...(parScenario.get(n.workflowName) ?? []), n]);
  const connus = new Map(proposables.map((n) => [n.code!, n]));
  const bascule = (code: string) => onSave(valeurs.includes(code) ? valeurs.filter((v) => v !== code) : [...valeurs, code]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-ink-700">{t('Blocs que l’agent peut envoyer', 'Blocks the agent may send')}</label>
      <p className="text-xs leading-relaxed text-ink-500">
        {t(
          'Cochez les blocs. L’agent ne pourra envoyer que ceux-là, et seulement dans le scénario où se trouve déjà le contact.',
          'Tick the blocks. The agent may send only these, and only within the scenario the contact is already in.',
        )}
      </p>

      {valeurs.length === 0 && (
        <span className="text-xs text-amber-800">
          {t('Aucun bloc coché : l’agent ne peut en envoyer aucun.', 'No block ticked: the agent cannot send any.')}
        </span>
      )}

      {/* 🔴 UN CODE CHOISI QUI N'EXISTE PLUS RESTE VISIBLE, ET SE DIT. Un bloc supprimé, ou dont le scénario
          a perdu son agent, disparaîtrait de la liste : le code resterait enregistré et invisible, donc
          impossible à retirer, sur un outil qui échouerait en silence. */}
      {valeurs.filter((v) => !connus.has(v)).map((v) => (
        <span key={v} data-testid={`outil-bloc-inconnu-${v}`} className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
          <span className="font-mono">{v}</span>
          <span>{t('ce bloc n’existe plus, ou son scénario n’a plus d’agent', 'this block no longer exists, or its scenario has no agent')}</span>
          <button disabled={busy} onClick={() => bascule(v)} className="ml-auto text-coral disabled:opacity-40">✕</button>
        </span>
      ))}

      {blocs === null && !erreur && <p className="text-xs text-ink-500">{t('Chargement des scénarios…', 'Loading scenarios…')}</p>}
      {erreur && <p className="text-xs text-coral">{t('Scénarios illisibles : réessayez en rouvrant cet onglet.', 'Scenarios unreadable: reopen this tab to retry.')}</p>}
      {blocs !== null && proposables.length === 0 && (
        <p className="text-xs text-ink-500" data-testid="outil-blocs-aucun">
          {t(
            'Aucun bloc disponible : cet outil n’envoie que des blocs d’un scénario qui contient un bloc Agent IA.',
            'No block available: this tool only sends blocks from a scenario containing an AI Agent block.',
          )}
        </p>
      )}

      {[...parScenario.entries()].map(([scenario, liste]) => (
        <div key={scenario} className="rounded-lg border border-ink-200 px-3 py-2">
          <p className="text-xs font-semibold text-ink-700">{scenario}</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {liste.map((n) => (
              <label key={n.code!} data-testid={`outil-bloc-${outilId}-${n.code}`} className="flex items-start gap-2 text-sm text-ink-800">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={busy}
                  checked={valeurs.includes(n.code!)}
                  onChange={() => bascule(n.code!)}
                />
                <span>
                  {n.name.trim() === '' ? n.summary : n.name}
                  <span className="ml-1 font-mono text-[11px] text-ink-400">{n.code}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
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
