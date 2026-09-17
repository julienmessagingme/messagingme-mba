'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { reglerOutilMcp, type OutilMcp, type ParamMcp, type SourceParamMcp } from '@/lib/api-mcp-connecteurs';

/**
 * Le réglage d'UN outil importé : d'où vient chacun de ses paramètres.
 *
 * 🔴 C'EST L'ÉCRAN DE LA GARDE D'IDENTITÉ, et rien d'autre ne la pose. Un outil MCP arrive avec TOUS ses
 * paramètres remplis par le modèle, donc influençables par le contact qui écrit. Tant que le client n'a pas
 * cloué l'identifiant à la fiche, un contact peut demander la donnée de quelqu'un d'autre en changeant la
 * valeur. C'est pour ça que cet écran montre chaque paramètre un par un plutôt qu'un bouton « activer ».
 *
 * ⚠️ LE CLIENT RÈGLE LA SOURCE, PAS LE TYPE. Le type, la description et l'énumération viennent du serveur
 * distant et ne lui appartiennent pas : les rendre modifiables ferait envoyer au serveur une valeur qu'il
 * refuse, pour une raison invisible.
 */
/**
 * La valeur fixe, dans le type que le SERVEUR DISTANT a déclaré pour ce paramètre.
 *
 * 🔴 ELLE NE S'APPLIQUE QU'À L'ENREGISTREMENT, JAMAIS À LA FRAPPE, et la première version s'y trompait.
 * Le champ est CONTRÔLÉ : convertir à chaque touche faisait que taper « 3 » puis « . » rendait
 * `Number('3.') === 3`, donc réaffichait « 3 », donc effaçait le point. Un paramètre `number` cloué à 3,5
 * n'était tout simplement pas saisissable. La saisie reste une CHAÎNE dans l'état local, et c'est
 * `enregistrer` qui convertit.
 *
 * ⚠️ ELLE RETOMBE SUR LA CHAÎNE quand la saisie ne convient pas (un `number` qui n'en est pas un, un
 * `integer` avec une virgule, un `boolean` qui n'est ni vrai ni faux) : envoyer `NaN` ou `false`
 * inventerait une valeur que personne n'a saisie, quand la chaîne produit un refus du serveur que le
 * client peut lire et relier à ce qu'il a tapé.
 */
function valeurTypee(brut: unknown, type: string): string | number | boolean {
  if (typeof brut !== 'string') return brut as string | number | boolean;
  if (type === 'integer') {
    return /^-?\d+$/.test(brut.trim()) ? Number(brut) : brut;
  }
  if (type === 'number') {
    const n = Number(brut);
    return brut.trim() !== '' && Number.isFinite(n) ? n : brut;
  }
  if (type === 'boolean') {
    if (brut === 'true') return true;
    if (brut === 'false') return false;
    return brut;
  }
  return brut;
}

export function McpOutilReglage({ tenantId, outil, champs, champsContact, onChange }: {
  tenantId: string;
  outil: OutilMcp;
  /** Les clés de champs que le client a créées dans Bibliothèque > Champs. Viennent du serveur. */
  champs: string[];
  /** Les attributs de fiche auxquels on peut clouer. Liste FERMÉE côté serveur, jamais recopiée ici. */
  champsContact: string[];
  onChange: () => void;
}) {
  const t = useT();
  const [params, setParams] = useState<ParamMcp[]>(outil.params);
  const [risk, setRisk] = useState<OutilMcp['risk']>(outil.risk);
  const [nePasUtiliser, setNePasUtiliser] = useState(outil.nePasUtiliser);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  function poser(nom: string, patch: Partial<ParamMcp>): void {
    setEnregistre(false);
    setParams((v) => v.map((p) => {
      if (p.name !== nom) return p;
      const apres = { ...p, ...patch };
      /**
       * 🔴 CHOISIR « contact » POSE UN `contactPath`, SINON L'OPTION EST INERTE. L'exécuteur calcule
       * `p.contactPath ?? p.name` : pour un paramètre distant nommé `client_id`, il chercherait
       * `ctx.contact['client_id']`, qui n'existe pas, et enverrait `null`. Le client croirait avoir cloué
       * l'identifiant, l'appel partirait vide, et la réaction naturelle serait de repasser en « l'agent
       * décide », c'est-à-dire d'ouvrir exactement le trou qu'il cherchait à fermer.
       */
      if (apres.source === 'contact' && !apres.contactPath) apres.contactPath = champsContact[0] ?? 'wa_id';
      if (apres.source === 'champ' && !apres.cle) apres.cle = champs[0] ?? '';
      return apres;
    }));
  }

  async function enregistrer(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await reglerOutilMcp(tenantId, outil.id, {
        /**
         * 🔴 LE RISQUE PART AVEC, ET C'EST CE QUI LE REND CONFIRMÉ PAR UN HUMAIN. Il est PRÉ-REMPLI depuis
         * les annotations du serveur distant, que la spec MCP déclare NON FIABLES : sans cet envoi, un
         * serveur qui s'annonce `readOnlyHint` obtenait `risk: 'read'` sans aucun acte du client, donc
         * devenait appelable même sur un contact inconnu en lecture seule.
         */
        risk,
        /**
         * 🔴 IL PART AVEC LE RESTE, SINON LA CAPACITÉ EST OFFERTE ET INERTE. La route l'accepte depuis le
         * premier jour et l'import le pose à vide en disant « c'est au client de l'écrire » : aucun écran
         * ne le lui demandait, donc il restait vide pour toujours. C'est le motif que ce produit
         * s'interdit ailleurs (migration 0144), relevé par la revue à froid du 2026-09-17.
         */
        nePasUtiliser,
        params: params.map((p) => ({
          name: p.name,
          source: p.source,
          ...(p.cle ? { cle: p.cle } : {}),
          ...(p.contactPath ? { contactPath: p.contactPath } : {}),
          // 🔴 LA CONVERSION EST ICI, pas à la frappe, voir la fonction plus haut. Un champ contrôlé qui convertit
          // à chaque touche efface le point d'un décimal avant qu'on ait pu taper la suite.
          ...(p.value !== undefined ? { value: valeurTypee(p.value, p.type) } : {}),
        })),
      });
      setEnregistre(true);
      onChange();
    } catch (e) {
      // Le message du serveur : c'est lui qui dit « le champ X n'existe pas dans cet espace », et le
      // remplacer renverrait le client chercher une faute de frappe qu'on avait déjà identifiée.
      setErreur(e instanceof Error ? e.message : t('Le réglage n’a pas pu être enregistré.', 'The setting could not be saved.'));
    } finally { setBusy(false); }
  }

  const SOURCES: Array<{ v: SourceParamMcp; libelle: string }> = [
    { v: 'modele', libelle: t('l’agent décide', 'the agent decides') },
    { v: 'contact', libelle: t('le numéro WhatsApp du contact', 'the contact’s WhatsApp number') },
    { v: 'champ', libelle: t('un champ de la fiche contact', 'a contact field') },
    { v: 'fixe', libelle: t('une valeur fixe', 'a fixed value') },
  ];

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-3" data-testid={`mcp-outil-${outil.name}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium text-ink-900">{outil.title}</span>
        <code className="text-xs text-ink-500">{outil.name}</code>
        <span className="text-[11px] text-ink-400">{t('chez le serveur : ', 'on the server: ')}<code>{outil.nomDistant}</code></span>
        {outil.risk === 'irreversible' && (
          <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[11px] font-medium text-coral">
            {t('action irréversible', 'irreversible action')}
          </span>
        )}
      </div>
      {outil.description && <p className="mt-1 text-sm text-ink-600">{outil.description}</p>}

      {outil.indisponibleLe && (
        /* La ligne est CONSERVÉE, pas supprimée : c'est la trace de ce qui a tourné, et le journal des
           appels y renvoie. Le client doit pouvoir comprendre pourquoi son agent ne sait plus faire ça. */
        <p className="mt-1 text-xs text-coral" data-testid={`mcp-indisponible-${outil.name}`}>
          {t('Cet outil a disparu du serveur. Il n’est plus appelable.', 'This tool is gone from the server. It can no longer be called.')}
        </p>
      )}

      {outil.nonActivable ? (
        /* 🔴 LA RAISON EN CLAIR, TELLE QUE L'IMPORT L'A ÉTABLIE. Le client ne peut pas corriger un schéma
           distant, mais il doit pouvoir dire à son fournisseur ce qui bloque, et n'y revenir qu'une fois. */
        <p className="mt-2 rounded-lg bg-gold/10 px-3 py-2 text-xs text-ink-700" data-testid={`mcp-outil-non-activable-${outil.name}`}>
          {t('Cet outil ne peut pas être activé : ', 'This tool cannot be enabled: ')}{outil.nonActivable}
        </p>
      ) : (
        <>
          <ul className="mt-2 space-y-2">
            {params.length === 0 && (
              <li className="text-xs text-ink-500">{t('Cet outil ne prend aucun paramètre.', 'This tool takes no parameter.')}</li>
            )}
            {params.map((p) => (
              <li key={p.name} className="flex flex-wrap items-center gap-2" data-testid={`mcp-param-${p.name}`}>
                <code className="text-xs text-ink-700">{p.name}</code>
                <span className="text-[11px] text-ink-400">{p.type}</span>
                {p.required && (
                  /* ⚠️ L'AVERTISSEMENT SE POSE ICI, AU CLOUAGE, ET PAS À L'APPEL. Un champ vide part vide et
                     c'est le serveur qui décide : le client doit le savoir au moment où il choisit. */
                  <span className="text-[11px] text-ink-600" data-testid={`mcp-requis-${p.name}`}>
                    {t('obligatoire pour le serveur', 'required by the server')}
                  </span>
                )}
                <select className={inputCls} value={p.source} data-testid={`mcp-source-${p.name}`}
                  onChange={(e) => poser(p.name, { source: e.target.value as SourceParamMcp })}>
                  {SOURCES.map((s) => <option key={s.v} value={s.v}>{s.libelle}</option>)}
                </select>
                {p.source === 'champ' && (
                  /* ⚠️ UNE LISTE, PAS UNE SAISIE LIBRE. La clé doit désigner un champ qui EXISTE : le
                     serveur le vérifie, mais proposer un champ libre revient à inviter la faute de frappe
                     puis à la refuser. La liste vient du serveur, jamais d'une copie locale. */
                  <select className={inputCls} value={p.cle ?? ''} data-testid={`mcp-cle-${p.name}`}
                    onChange={(e) => poser(p.name, { cle: e.target.value })}>
                    {champs.length === 0 && <option value="">{t('aucun champ déclaré', 'no field declared')}</option>}
                    {champs.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                {p.source === 'contact' && (
                  <select className={inputCls} value={p.contactPath ?? ''} data-testid={`mcp-contact-${p.name}`}
                    onChange={(e) => poser(p.name, { contactPath: e.target.value })}>
                    {champsContact.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                {p.source === 'fixe' && (
                  /* 🔴 ELLE PART DANS LE TYPE QUE LE SERVEUR A DÉCLARÉ, pas en chaîne. Un paramètre
                     `integer` cloué à 42 partait comme "42", que le serveur distant refuse sur son propre
                     schéma, avec un message que le client ne pouvait relier à rien de ce qu'il avait
                     saisi. ⚠️ Une saisie qui n'est pas un nombre valide reste une CHAÎNE plutôt que de
                     devenir `NaN` : le refus du serveur est alors lisible, un `NaN` ne l'est pas. */
                  <input className={inputCls} value={String(p.value ?? '')} data-testid={`mcp-valeur-${p.name}`}
                    onChange={(e) => poser(p.name, { value: e.target.value })} />
                )}
                {p.cheminMcp && p.cheminMcp !== p.name && (
                  <span className="text-[11px] text-ink-400">{t('chemin distant : ', 'remote path: ')}<code>{p.cheminMcp}</code></span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-600">{t('Ce que cet outil fait :', 'What this tool does:')}</span>
            {/* 🔴 PROPOSÉ PAR LE SERVEUR, CONFIRMÉ PAR VOUS. La spec MCP dit que les annotations d'un outil
                sont à considérer comme NON FIABLES : un serveur qui se déclarerait « lecture seule »
                désarmerait sinon la garde d'autonomie sur une action irréversible. */}
            <select className={inputCls} value={risk} data-testid={`mcp-risque-${outil.name}`}
              onChange={(e) => { setEnregistre(false); setRisk(e.target.value as OutilMcp['risk']); }}>
              <option value="read">{t('il LIT seulement', 'it only READS')}</option>
              <option value="write">{t('il ÉCRIT quelque chose', 'it WRITES something')}</option>
              <option value="irreversible">{t('une action IRRÉVERSIBLE', 'an IRREVERSIBLE action')}</option>
            </select>
          </div>

          <div className="mt-2">
            <label className="block text-xs text-ink-600" htmlFor={`mcp-nepasutiliser-${outil.id}`}>
              {t('Quand NE PAS l’appeler (facultatif)', 'When NOT to call it (optional)')}
            </label>
            {/* 🔴 LE SEUL LEVIER QUI DÉCIDE QUAND UN OUTIL SE DÉCLENCHE, et le serveur distant n'en sait
                rien : sa description dit ce que l'outil FAIT, jamais quand s'en abstenir. */}
            <textarea id={`mcp-nepasutiliser-${outil.id}`} rows={2} maxLength={2000}
              data-testid={`mcp-nepasutiliser-${outil.name}`}
              className={`${inputCls} w-full`} value={nePasUtiliser}
              placeholder={t('ex. ne pas l’appeler si le contact n’a pas donné son numéro de commande',
                'e.g. do not call it if the contact has not given their order number')}
              onChange={(e) => { setEnregistre(false); setNePasUtiliser(e.target.value); }} />
          </div>

          {(
            <button type="button" disabled={busy} data-testid={`mcp-enregistrer-${outil.name}`}
              className="mt-2 rounded-lg bg-brand-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
              onClick={() => void enregistrer()}>
              {t('Enregistrer', 'Save')}
            </button>
          )}
        </>
      )}

      {erreur && <p className="mt-1 text-xs text-coral" data-testid={`mcp-reglage-erreur-${outil.name}`}>{erreur}</p>}
      {enregistre && <p className="mt-1 text-xs text-mint-700" data-testid={`mcp-reglage-ok-${outil.name}`}>{t('Enregistré.', 'Saved.')}</p>}
    </div>
  );
}
