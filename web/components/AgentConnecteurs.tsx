'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { listSources, type SourceAgent } from '@/lib/api-agent-sources';
import { listRequetes, testerBrouillon, type RequeteApi } from '@/lib/api-agent-requetes';
import { ajouterConnecteur, type NatureOutil, type OutilAgent } from '@/lib/api-agent-tools';
import { Bouton } from '@/components/Bouton';

/**
 * CE QUE CET AGENT A LE DROIT D'APPELER dans les systèmes du workspace.
 *
 * 🔴 IL NE DÉCRIT PLUS AUCUN APPEL. L'adresse, l'authentification, la méthode, le chemin, le corps et les
 * variables vivent dans la BIBLIOTHÈQUE du workspace (menu Tools > Connecteurs API), parce qu'ils
 * appartiennent au client et que plusieurs agents s'en servent. Un appel décrit ici était redécrit pour
 * chaque agent, et le corriger quelque part ne le corrigeait pas ailleurs.
 *
 * Ici on ne fait plus qu'une chose : choisir un appel déjà ÉPROUVÉ et lui donner les mots de CET agent. Deux
 * agents peuvent donc utiliser le même appel avec des consignes différentes, ce qui est le besoin réel.
 *
 * 🔴 CE QUE L'ÉCRAN DOIT RENDRE ÉVIDENT, et qui n'est pas décoratif : **ce qui partira dans la requête**. Le
 * client confirme au moment de brancher, parce que c'est le seul moment où il peut s'apercevoir qu'un appel
 * enverra le dernier message de ses contacts à un système tiers.
 */

export function AgentConnecteurs({ tenantId, agentId, outils, onChange }: {
  tenantId: string;
  agentId: string;
  /** Les outils déjà posés sur CET agent : on n'en garde que les connecteurs. */
  outils: OutilAgent[];
  onChange: () => Promise<void> | void;
}) {
  const t = useT();
  const [sources, setSources] = useState<SourceAgent[] | null>(null);
  const [requetes, setRequetes] = useState<RequeteApi[]>([]);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([listSources(tenantId), listRequetes(tenantId)]);
      // ⚠️ Défensif des DEUX côtés : une réponse mal formée doit dégrader, jamais blanchir l'écran. Un
      // `.map` sur `undefined` fait planter le rendu de TOUT l'onglet, y compris la liste des outils
      // maison, qui n'a rien à voir. Même précaution que la liste des conversations de l'inbox.
      setSources(Array.isArray(s) ? s : []);
      setRequetes(Array.isArray(r?.requetes) ? r.requetes : []);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [tenantId, t]);
  useEffect(() => { void charger(); }, [charger]);

  /** 🔴 REND UN VERDICT : c'est lui qui empêche un formulaire de se refermer sur une saisie perdue. */
  async function agir(travail: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setErreur(null);
    try {
      await travail();
      await charger();
      await onChange();
      return true;
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const appels = outils.filter((o) => o.origin !== 'mba');
  const libelleSource = (id: string): string => sources?.find((s) => s.id === id)?.label ?? '';

  return (
    <div className="flex flex-col gap-3">
      {erreur && <MbaNotice kind="error" testid="connecteurs-erreur">{erreur}</MbaNotice>}

      {sources === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}

      {/* Rien dans la bibliothèque : on ne propose pas d'y remédier ICI, on dit où ça se passe. Mettre au
          point un appel demande de l'éprouver, ce qui est un geste de workspace, pas un geste d'agent. */}
      {sources !== null && requetes.length === 0 && (
        <p data-testid="connecteurs-aucune-requete" className="text-sm text-ink-500">
          {t(
            'Aucun appel API n’est prêt sur ce workspace. Rendez-vous dans Tools > Connecteurs API pour en mettre un au point et l’éprouver ; il servira ensuite à tous vos agents.',
            'No API call is ready on this workspace. Go to Tools > API connectors to set one up and test it; it will then serve all your agents.',
          )}{' '}
          <a href="/connecteurs" className="text-brand-600 hover:underline">{t('Ouvrir Tools > Connecteurs API', 'Open Tools > API connectors')}</a>
        </p>
      )}

      {requetes.map((rq) => {
        const siens = appels.filter((o) => o.requestId === rq.id);
        return (
          <div key={rq.id} className={`${cardCls} flex flex-col gap-2`} data-testid={`agent-requete-${rq.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-ink-900">{rq.label}</p>
              <p className="text-xs text-ink-500">
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs">{rq.methode}</span>{' '}
                {libelleSource(rq.sourceId)} {rq.chemin}
              </p>
            </div>

            {siens.length === 0 ? (
              <p className="text-xs text-ink-500">{t('Cet agent ne s’en sert pas.', 'This agent does not use it.')}</p>
            ) : (
              <ul className="space-y-0.5">
                {siens.map((o) => (
                  <li key={o.id} className="text-xs text-ink-500">
                    <code>{o.name}</code>
                    {!o.actif && <span className="ml-1 text-ink-400">{t('(inactif)', '(inactive)')}</span>}
                  </li>
                ))}
              </ul>
            )}

            <button
              data-testid={`requete-nouvel-outil-${rq.id}`}
              onClick={() => setOuvert((v) => (v === rq.id ? null : rq.id))}
              className="self-start text-xs text-brand-600 hover:underline"
            >
              {ouvert === rq.id ? t('Annuler', 'Cancel') : t('+ donner cet appel à l’agent', '+ give this call to the agent')}
            </button>
            {ouvert === rq.id && (
              <NouvelAppel
                tenantId={tenantId}
                requete={rq}
                busy={busy}
                /**
                 * 🔴 LE FORMULAIRE NE SE FERME QUE SI ÇA A MARCHÉ. Il se refermait dans la foulée de l'appel,
                 * sans attendre son résultat : un refus du serveur affichait son message au-dessus d'un
                 * formulaire disparu, avec la saisie dedans. Même défaut que celui de l'écran des connecteurs,
                 * réparé le même jour, et pour la même raison : `agir` rend désormais un verdict.
                 */
                onCreer={(mots) => {
                  void agir(async () => { await ajouterConnecteur(tenantId, agentId, { ...mots, requeteId: rq.id }); })
                    .then((ok) => { if (ok) setOuvert(null); });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Le libellé français d'une origine de variable.
 *
 * ⚠️ Il DOUBLE `libelleOrigine` de `src/agent/variables.ts`, et c'est assumé : les deux builds ne partagent
 * aucun module, comme `web/lib/button-url.ts` double `src/meta/button-url.ts`. Le serveur reste la source de
 * vérité (il renvoie `envoi` à la création) ; celui-ci sert à montrer ce qui partira AVANT de valider, donc
 * quand il n'y a encore rien à demander au serveur.
 */
function libelleOrigine(o: RequeteApi['variables'][number]['origine']): [string, string] {
  if (o.type === 'modele') return ['décidée par l’agent', 'decided by the agent'];
  if (o.type === 'contact') return o.cle === 'wa_id' ? ['numéro WhatsApp du contact', 'contact’s WhatsApp number'] : ['nom du contact', 'contact’s name'];
  if (o.type === 'champ') return [`champ « ${o.cle} » du contact`, `contact field “${o.cle}”`];
  if (o.type === 'systeme') return o.cle === 'maintenant' ? ['date et heure courantes', 'current date and time'] : ['dernier message du contact', 'contact’s last message'];
  return [`valeur fixe « ${String(o.valeur)} »`, `fixed value “${String(o.valeur)}”`];
}

function NouvelAppel({ tenantId, requete, busy, onCreer }: {
  tenantId: string;
  requete: RequeteApi;
  busy: boolean;
  onCreer: (mots: {
    name: string; title: string; description: string; nePasUtiliser: string;
    nature: NatureOutil; outputPaths: string[];
  }) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [nePasUtiliser, setNePasUtiliser] = useState('');

  /**
   * 🔴 LA QUESTION QUI A REMPLACÉ LA CASE « C'EST BIEN CE QUE JE VEUX ENVOYER » (2026-09-15).
   *
   * Julien : « si on rajoute un outil c'est qu'on est d'accord pour l'utiliser. Par contre la question c'est
   * qu'est-ce que cet appel FAIT ? est-ce que c'est pour pousser de l'info quelque part, ou pour avoir un
   * retour de payload avec une information qui enrichirait la discussion ». La case demandait un
   * consentement qu'on a déjà par construction ; celle-ci demande un fait que seul le client connaît.
   *
   * ⚠️ PRÉ-REMPLIE PAR L'APPEL, JAMAIS VERROUILLÉE : la requête porte un défaut, et chaque agent peut s'en
   * écarter. C'est tout l'objet de la migration 0150.
   */
  const [nature, setNature] = useState<NatureOutil>(requete.outputPaths.length > 0 ? 'integre' : 'pousse');
  const [champs, setChamps] = useState<string[]>(requete.outputPaths);
  /** Les chemins que le dernier essai a réellement trouvés. Vides tant qu'on n'a pas essayé. */
  const [trouves, setTrouves] = useState<string[]>([]);
  const [essai, setEssai] = useState(false);
  const [erreurEssai, setErreurEssai] = useState<string | null>(null);

  const essayer = async (): Promise<void> => {
    setEssai(true);
    setErreurEssai(null);
    try {
      /**
       * ⚠️ LES VALEURS D'ESSAI VIENNENT DE L'APPEL, pas d'un vrai contact (choix de Julien du 2026-09-15).
       * Un essai qui prendrait les données d'un contact existant agirait pour de vrai sur lui : un
       * `add-tag` poserait vraiment l'étiquette sur quelqu'un.
       */
      const r = await testerBrouillon(tenantId, {
        sourceId: requete.sourceId, methode: requete.methode, chemin: requete.chemin,
        parametres: requete.parametres, entetes: requete.entetes, corps: requete.corps,
        variables: requete.variables, valeursTest: requete.valeursTest,
      });
      if (r.ok === false) { setErreurEssai(r.erreur ?? t('essai échoué', 'test failed')); return; }
      setTrouves(r.chemins ?? []);
    } catch (err) {
      setErreurEssai(err instanceof Error ? err.message : t('essai impossible', 'test failed'));
    } finally {
      setEssai(false);
    }
  };

  /**
   * CE QUI MANQUE, NOMMÉ, ou `null` quand tout est là.
   *
   * 🔴 UNE SEULE SOURCE POUR L'ÉTAT GRISÉ ET POUR LA RAISON. Deux listes tenues à la main divergeraient au
   * premier champ ajouté, et le bouton redeviendrait muet sans que personne le remarque. Il l'était, et il a
   * coûté une session à Julien le 2026-09-15 : cinq conditions, aucune nommée.
   */
  const manque: string | null =
    name.trim() === '' ? t('Donnez un nom technique.', 'Give it a technical name.')
      : title.trim() === '' ? t('Donnez un titre lisible.', 'Give it a readable title.')
        : description.trim() === '' ? t('Dites à quoi ça sert.', 'Say what it does.')
          : nePasUtiliser.trim() === '' ? t('Dites quand NE PAS l’appeler.', 'Say when NOT to call it.')
            : nature === 'integre' && champs.length === 0
              ? t('Choisissez au moins une information à récupérer, ou dites que cet appel pousse seulement.',
                'Pick at least one piece of information to read, or say this call only pushes.')
              : busy ? t('Enregistrement en cours…', 'Saving…')
                : null;

  /** Ce qu'on propose à cocher : ce que l'essai a trouvé, plus ce que l'appel déclarait déjà. */
  const proposes = [...new Set([...trouves, ...requete.outputPaths])];

  return (
    <div className="mt-1 flex flex-col gap-3 rounded-lg border border-ink-200 p-3">
      {/**
        * 🔴 CE QUI PARTIRA, MONTRÉ SANS RIEN À COCHER (2026-09-15). La case de confirmation est partie : elle
        * demandait de valider une formalité, donc personne ne la lisait, et elle bloquait sans le dire. Le
        * RÉSUMÉ reste, parce qu'il est la seule fois où l'on voit qu'un appel enverra une donnée de ses
        * contacts, voire leur dernier message, à un système tiers.
        */}
      <div className="rounded-lg bg-ink-50 p-3" data-testid="envoi-resume">
        <p className="text-xs font-medium text-ink-900">
          {t('Cet appel enverra à votre système :', 'This call will send to your system:')}
        </p>
        {requete.variables.length === 0 ? (
          <p className="mt-1 text-xs text-ink-500">{t('aucune donnée variable', 'no variable data')}</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {requete.variables.map((v) => (
              <li key={v.nom} className="text-xs text-ink-500">
                <code>{v.nom}</code> : {t(...libelleOrigine(v.origine))}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* PREMIÈRE QUESTION, et la seule quand la réponse est « ça pousse ». */}
      <div className="flex flex-col gap-1" data-testid="outil-nature">
        <p className="text-xs font-medium text-ink-900">
          {t('Que fait cet appel ?', 'What does this call do?')}
        </p>
        <label className="flex items-start gap-2 text-xs text-ink-900">
          <input
            type="radio" name={`nature-${requete.id}`} data-testid="nature-pousse" className="mt-0.5"
            checked={nature === 'pousse'} onChange={() => { setNature('pousse'); setChamps([]); }}
          />
          <span>
            {t('Il POUSSE de l’information vers votre système', 'It PUSHES information to your system')}
            <span className="ml-1 text-ink-500">
              {t('(poser une étiquette, créer une fiche). L’agent saura seulement si c’est passé.',
                '(add a tag, create a record). The agent will only know whether it worked.')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-ink-900">
          <input
            type="radio" name={`nature-${requete.id}`} data-testid="nature-integre" className="mt-0.5"
            checked={nature === 'integre'} onChange={() => { setNature('integre'); setChamps(requete.outputPaths); }}
          />
          <span>
            {t('Il RÉCUPÈRE de l’information, que l’agent intègre à la conversation',
              'It FETCHES information, which the agent brings into the conversation')}
          </span>
        </label>
      </div>

      {/**
        * SECONDE QUESTION, posée UNIQUEMENT quand la première vaut « récupérer » (décision de Julien du
        * 2026-09-15). Elle n'est pas un oui/non : c'est le CHOIX de ce que l'agent lira.
        */}
      {nature === 'integre' && (
        <div className="flex flex-col gap-2 rounded-lg border border-ink-200 p-2" data-testid="outil-champs">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-ink-900">
              {t('Que doit-il récupérer ?', 'What should it read?')}
            </p>
            <Bouton variante="secondaire" taille="petite" enCours={essai}
              data-testid="outil-essayer" disabled={essai}
              onClick={() => { void essayer(); }}
            >
              {essai ? t('Essai…', 'Trying…') : t('Essayer pour voir la réponse', 'Try it to see the response')}
            </Bouton>
          </div>
          {erreurEssai !== null && (
            <p className="text-xs text-danger" data-testid="outil-essai-erreur">{erreurEssai}</p>
          )}
          {proposes.length === 0 ? (
            <p className="text-xs text-ink-500" data-testid="outil-champs-vides">
              {t('Lancez l’essai pour voir ce que votre système répond, puis cochez ce que l’agent a le droit de lire.',
                'Run the test to see what your system answers, then tick what the agent may read.')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {proposes.map((c) => (
                <label key={c} className="flex items-center gap-2 text-xs text-ink-900">
                  <input
                    type="checkbox" data-testid={`outil-champ-${c}`} checked={champs.includes(c)}
                    onChange={(e) => setChamps((v) => (e.target.checked ? [...v, c] : v.filter((x) => x !== c)))}
                  />
                  <code>{c}</code>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-ink-500">
            {t('Seuls les champs cochés partent chez le fournisseur du modèle.',
              'Only the ticked fields reach the model provider.')}
          </p>
        </div>
      )}

      <label className="text-xs text-ink-500">
        {t('Nom technique (vu par l’agent)', 'Technical name (seen by the agent)')}
        <input className={`${inputCls} mt-1`} data-testid="outil-nom" value={name} onChange={(e) => setName(e.target.value)} placeholder="lire_commande" />
      </label>
      <label className="text-xs text-ink-500">
        {t('Titre lisible', 'Readable title')}
        <input className={`${inputCls} mt-1`} data-testid="outil-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        {t('À quoi ça sert (l’agent le lit pour décider quand appeler)', 'What it does (the agent reads this to decide when to call)')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Quand NE PAS l’appeler', 'When NOT to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-nepasutiliser" value={nePasUtiliser} onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>

      {/* 🔴 LA RAISON EST VISIBLE, PAS SEULEMENT EN INFOBULLE. Une infobulle suppose qu'on survole un bouton
          gris, ce que personne ne fait : on cherche ailleurs ce qu'on a raté. Le titre reste, pour le clavier. */}
      <div className="flex flex-wrap items-center gap-2">
        <Bouton taille="petite"
          data-testid="outil-creer"
          disabled={manque !== null}
          title={manque ?? ''}
          onClick={() => onCreer({
            name: name.trim(), title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim(),
            // ⚠️ Un `pousse` envoie une liste VIDE quoi qu'il y ait dans l'état : le serveur la force aussi,
            // et deux endroits qui écrivent la même cohérence valent mieux qu'un seul qui l'oublie.
            nature, outputPaths: nature === 'pousse' ? [] : champs,
          })}
          className="self-start"
        >
          {t('Donner cet appel à l’agent', 'Give this call to the agent')}
        </Bouton>
        {manque !== null && <span className="text-xs text-ink-500" data-testid="outil-creer-manque">{manque}</span>}
      </div>
    </div>
  );
}
