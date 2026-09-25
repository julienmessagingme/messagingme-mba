'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { dateHeure } from '@/lib/day';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { RequetesConnecteur } from '@/components/RequetesConnecteur';
import {
  creerSource, eprouverSource, listSources, patchSource, supprimerSource,
  type AuthSource, type SourceAgent,
} from '@/lib/api-agent-sources';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';

/**
 * LA BIBLIOTHÈQUE DE SYSTÈMES du workspace (menu Tools).
 *
 * 🔴 POURQUOI ELLE EST ICI ET PAS DANS UN AGENT. Un système appartient au CLIENT, pas à un agent : l'adresse,
 * l'authentification et le secret sont les mêmes quel que soit l'agent qui s'en sert, et plusieurs agents
 * tapent dans la même bibliothèque. La poser dans un agent aurait fait croire qu'elle lui appartient, et on
 * l'aurait supprimée en cassant les autres. En base, `agent_tool_sources` porte `tenant_id` et pas
 * `agent_id` : cet écran ne fait que le rendre visible.
 *
 * Ce que chaque agent fait ensuite, dans SON onglet Outils : choisir un système d'ici et déclarer les appels
 * qu'il a le droit d'y faire, avec ses mots à lui. Deux agents peuvent donc taper le même système avec des
 * consignes différentes, ce qui est exactement le besoin.
 */

export function ConnecteursBibliotheque({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [sources, setSources] = useState<SourceAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [epreuves, setEpreuves] = useState<Record<string, string>>({});
  /**
   * 🔴 UN SEUL SYSTEME OUVERT A LA FOIS, ET RIEN D'OUVERT AU DEPART. L'ecran depliait TOUT : chaque systeme
   * en grande fiche, le formulaire « brancher un systeme » toujours ouvert AU MILIEU, puis les appels de tous
   * les systemes a la suite. On arrivait donc sur un formulaire de creation coince entre ce qu'on a deja et
   * ce qu'on venait chercher. Ici : la liste, on clique, ca s'ouvre.
   */
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [ajout, setAjout] = useState(false);

  const charger = useCallback(async () => {
    try {
      setSources(await listSources(tenantId));
    } catch (err) {
      setErreur(erreurDeChargement(err, t));
    }
  }, [tenantId, t]);
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

  return (
    <div className="flex flex-col gap-4">
      {erreur && <MbaNotice kind="error" testid="connecteurs-erreur">{erreur}</MbaNotice>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-900">{t('Vos systèmes', 'Your systems')}</h2>
        <Bouton variante="secondaire"
          type="button"
          data-testid="source-ajouter"
          onClick={() => { setAjout((v) => !v); setOuvert(null); }}
        >
          {ajout ? t('Annuler', 'Cancel') : <><Icone nom="ajouter" />{t('Brancher un système', 'Connect a system')}</>}
        </Bouton>
      </div>

      {/* Le formulaire d'ajout : REPLIE par défaut, et au-dessus de la liste quand il s'ouvre, là où on
          regarde après avoir cliqué. Déplié en permanence au MILIEU de la page, il séparait les systèmes de
          leurs appels et faisait croire qu'il fallait le remplir pour continuer. */}
      {ajout && (
        <NouvelleSource
          busy={busy}
          onCreer={(input) => agir(async () => { await creerSource(tenantId, input); setAjout(false); })}
        />
      )}

      {sources === null && <Squelette forme="lignes" />}
      {sources?.length === 0 && !ajout && (
        <p data-testid="sources-vide" className="text-sm text-ink-500">
          {t('Aucun système branché : déclarez-en un pour que vos agents puissent y chercher une information.', 'No system connected: declare one so your agents can look up information in it.')}
        </p>
      )}

      {(sources ?? []).map((s) => (
        <div key={s.id} className="flex flex-col gap-3">
          {/* LA LIGNE : ce qu'on lit d'un coup d'oeil pour choisir. Le détail et les appels sont dessous, à
              la demande. */}
          <button
            type="button"
            data-testid={`source-ligne-${s.id}`}
            aria-expanded={ouvert === s.id}
            onClick={() => setOuvert((v) => (v === s.id ? null : s.id))}
            className={`flex w-full items-center gap-3 rounded-carte border px-4 py-3 text-left transition-colors duration-150 ${
              ouvert === s.id ? 'border-brand-500 bg-brand-50/40' : 'border-ink-200 bg-white hover:bg-ink-50'
            }`}
          >
            <Icone nom="deplier" taille="petite" className={`text-ink-400 transition-transform duration-150 ${ouvert === s.id ? '' : '-rotate-90'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-ink-900">{s.label}</span>
                <span className={`rounded-controle px-1.5 py-0.5 text-xs ${s.status === 'active' ? 'bg-succes-100 text-succes-700' : 'bg-ink-100 text-ink-500'}`}>
                  {s.status === 'active' ? t('Actif', 'Active') : s.status === 'draft' ? t('Brouillon', 'Draft') : t('Désactivé', 'Disabled')}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-ink-500">{s.baseUrl}</span>
            </span>
            {/* 🔴 QUI TAPE DEDANS, dès la liste : sans ce chiffre on croirait le système lié à l'agent d'où
                on l'a vu, et on le supprimerait en cassant les autres. */}
            <span data-testid={`source-usage-${s.id}`} className="shrink-0 text-right text-xs text-ink-500">
              {s.agents === 0
                ? t('aucun agent', 'no agent')
                : t(`${s.agents} agent(s)`, `${s.agents} agent(s)`)}
              <span className="block text-ink-500">
                {t(`${s.outilsActifs} appel(s) actif(s)`, `${s.outilsActifs} active call(s)`)}
              </span>
            </span>
          </button>

          {ouvert === s.id && (
            <>
              <Source
                source={s}
                busy={busy}
                epreuve={epreuves[s.id]}
                onEprouver={(chemin) => agir(async () => {
                  const r = await eprouverSource(tenantId, s.id, chemin);
                  setEpreuves((e) => ({
                    ...e,
                    [s.id]: r.ok
                      ? t(`Répond (HTTP ${r.httpStatus})`, `Responds (HTTP ${r.httpStatus})`)
                      : t(`Échec : ${r.erreur ?? 'inconnu'}`, `Failed: ${r.erreur ?? 'unknown'}`),
                  }));
                })}
                onPatch={(patch) => agir(async () => { await patchSource(tenantId, s.id, patch); })}
                onSupprimer={() => agir(async () => { await supprimerSource(tenantId, s.id); setOuvert(null); })}
              />

              {/* Les APPELS DE CE SYSTÈME, sous lui. C'est la suite logique du geste : on ne met pas au point
                  un appel sans regarder le système, et l'écran ne montre plus les appels des autres. */}
              <div className="border-t border-ink-200 pt-4">
                <RequetesConnecteur tenantId={tenantId} sources={sources ?? []} sourceFiltre={s.id} />
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Source({ source, busy, epreuve, onEprouver, onPatch, onSupprimer }: {
  source: SourceAgent;
  busy: boolean;
  epreuve?: string;
  onEprouver: (chemin: string) => void;
  onPatch: (patch: { status?: SourceAgent['status']; authSecret?: string }) => void;
  onSupprimer: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [chemin, setChemin] = useState('/');
  const [secret, setSecret] = useState('');

  return (
    <div className={`${cardCls} flex flex-col gap-3`} data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* ⚠️ NI LE NOM NI L'ADRESSE ICI : ils sont dans la ligne qu'on vient de déplier, juste au-dessus.
            Les répéter donnait deux fois la même information et repoussait les boutons hors de vue. */}
        <div className="min-w-0">
          <p className="text-xs text-ink-500">
            {source.authKind === 'none'
              ? t('Sans authentification', 'No authentication')
              : source.authKind === 'bearer'
                ? t('Jeton (Bearer)', 'Token (Bearer)')
                : t(`En-tête ${source.authHeaderName ?? ''}`, `Header ${source.authHeaderName ?? ''}`)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Bouton variante="secondaire"
            data-testid={`source-statut-${source.id}`}
            disabled={busy}
            onClick={() => onPatch({ status: source.status === 'active' ? 'disabled' : 'active' })}
          >
            {source.status === 'active' ? t('Désactiver', 'Disable') : t('Activer', 'Activate')}
          </Bouton>
          <button
            data-testid={`source-supprimer-${source.id}`}
            disabled={busy}
            onClick={onSupprimer}
            className="rounded-controle border border-ink-300 px-3 py-1.5 text-sm text-danger hover:bg-danger-50 disabled:opacity-40"
          >
            {t('Supprimer', 'Delete')}
          </button>
        </div>
      </div>

      {/*
        🔴 LES DEUX GESTES NE FONT PAS LA MÊME CHOSE, ET L'ÉCRAN NE LE DISAIT PAS (Julien, 2026-09-24 :
        « la différence entre désactiver et supprimer, je sais pas si ça vaut le coup de garder les 2 »).
        Ils se ressemblent parce que rien ne les distinguait à l'écran, pas parce qu'ils se valent :
        désactiver garde la ligne, son historique d'épreuves et les outils qui en dépendent, et fait échouer
        chaque appel avec une raison lisible ; supprimer efface, et la route REFUSE en 409 tant qu'un outil
        actif s'en sert. On garde donc les deux, et on dit lequel fait quoi.
        ⚠️ ET LE MOT « DÉSACTIVER » NE VEUT PAS DIRE LA MÊME CHOSE ICI QUE SUR UN OUTIL, ce qui est la vraie
        cause de la confusion : désactiver un OUTIL le retire de la vue du modèle, désactiver un CONNECTEUR
        laisse l'outil visible et fait échouer l'appel. La phrase ci-dessous nomme cet écart.
      */}
      <p className="text-xs text-ink-500" data-testid={`source-deux-gestes-${source.id}`}>
        {t(
          'Désactiver garde ce connecteur et les outils qui s’en servent : ils restent proposés à l’agent, mais chaque appel échoue en disant pourquoi. Supprimer l’efface, et c’est refusé tant qu’un outil actif l’utilise.',
          'Disabling keeps this connector and the tools that use it: they stay offered to the agent, but every call fails with a reason. Deleting removes it, and is refused while an active tool uses it.',
        )}
      </p>

      {/* 🔴 L'ÉPREUVE. Un jeton expiré ne produit aucune erreur applicative : l'agent dégraderait en silence
          au milieu d'une conversation. C'est le seul endroit où ça se voit avant qu'un contact ne le trouve. */}
      <div className="flex flex-wrap items-end gap-2 rounded-controle border border-ink-200 px-3 py-2">
        <label className="flex-1 text-xs text-ink-500">
          {t('Éprouver la connexion sur ce chemin', 'Test the connection on this path')}
          <input className={`${inputCls} mt-1`} data-testid={`source-chemin-${source.id}`} value={chemin} onChange={(e) => setChemin(e.target.value)} />
        </label>
        <Bouton variante="secondaire"
          data-testid={`source-eprouver-${source.id}`}
          disabled={busy}
          onClick={() => onEprouver(chemin)}
        >
          {t('Éprouver', 'Test')}
        </Bouton>
        {/*
          🔴 CE QU'ELLE ÉPROUVE, DIT À L'ÉCRAN (Julien, 2026-09-24 : « à quoi sert Éprouver la connexion sur
          ce chemin, quand on choisit un système déjà branché ? »). La question était juste : l'écran offrait
          un bouton sans dire qu'il fait un VRAI appel avec le VRAI en-tête d'authentification, donc qu'il
          éprouve le SECRET et pas seulement l'adresse. Sans cette phrase, il passe pour une revalidation
          d'URL, c'est-à-dire pour rien sur un système déjà branché.
        */}
        <p className="w-full text-xs text-ink-500" data-testid={`source-epreuve-a-quoi-${source.id}`}>
          {t(
            'Un vrai appel, avec votre authentification : c’est le seul endroit où un jeton expiré se voit avant qu’un client ne le trouve, parce qu’un jeton mort ne produit aucune erreur ailleurs.',
            'A real call, with your authentication: this is the only place an expired token shows up before a customer finds it, because a dead token raises no error anywhere else.',
          )}
        </p>
        <p data-testid={`source-epreuve-${source.id}`} className="w-full text-xs text-ink-500">
          {epreuve ?? (source.lastError
            ? t(`Dernière erreur : ${source.lastError}`, `Last error: ${source.lastError}`)
            : source.lastOkAt
              ? t(`Dernière réussite : ${dateHeure(source.lastOkAt, locale)}`, `Last success: ${dateHeure(source.lastOkAt, locale)}`)
              : t('Jamais éprouvée', 'Never tested'))}
        </p>
      </div>

      {/*
        🔴 LE JETON SE REMPLACE, ET L'ÉCRAN LE DISAIT SI MAL QUE JULIEN A CRU QUE C'ÉTAIT IMPOSSIBLE
        (2026-09-24 : « il faut qu'on puisse vraiment le remplacer, le bouton est tout le temps grisé, c'est
        donc pas clair »). Le bouton n'a JAMAIS été bloqué : sa seule condition est que le champ ne soit pas
        vide, et il se dégrise à la première frappe. Le défaut était l'AFFORDANCE, pas la capacité.
        Trois choses le réparent, et aucune ne touche au mécanisme : le libellé dit quoi taper au lieu de
        décrire une sémantique de formulaire qui n'existe pas ici (« laisser vide = inchangé » décrivait un
        envoi global, alors qu'un bouton dédié ne part que quand on le clique) ; une phrase dit pourquoi le
        champ est vide, sinon le client croit avoir effacé son secret ; et le bouton grisé porte enfin la
        raison de l'être.
        ⚠️ LE CHAMP RESTE VIDE À CHAQUE OUVERTURE, ET CE N'EST PAS NÉGOCIABLE : un secret ne se relit pas, ni
        chez Meta ni chez nous. Le pré-remplir demanderait de le renvoyer au navigateur.
      */}
      {source.authKind !== 'none' && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 text-xs text-ink-500">
              {source.authKind === 'bearer'
                ? t('Nouveau jeton', 'New token')
                : t(`Nouveau secret pour l’en-tête ${source.authHeaderName ?? ''}`, `New secret for header ${source.authHeaderName ?? ''}`)}
              <input
                type="password" autoComplete="off" className={`${inputCls} mt-1`}
                data-testid={`source-secret-${source.id}`}
                value={secret} onChange={(e) => setSecret(e.target.value)}
                placeholder={source.aAuthentification ? '••••••••' : t('aucun secret enregistré', 'no secret stored')}
              />
            </label>
            <Bouton variante="secondaire"
              disabled={busy || secret.trim() === ''}
              title={secret.trim() === ''
                ? t('Tapez le nouveau secret pour activer ce bouton.', 'Type the new secret to enable this button.')
                : undefined}
              onClick={() => { onPatch({ authSecret: secret.trim() }); setSecret(''); }}
            >
              {t('Remplacer', 'Replace')}
            </Bouton>
          </div>
          <p className="text-xs text-ink-500" data-testid={`source-secret-aide-${source.id}`}>
            {source.aAuthentification
              ? t('Ce champ part toujours vide : un secret ne se relit jamais, pas même par nous. Le vôtre est bien enregistré. Tapez le nouveau, puis « Remplacer ».',
                'This field always starts empty: a secret is never read back, not even by us. Yours is stored. Type the new one, then “Replace”.')
              : t('Aucun secret enregistré : tapez-en un, puis « Remplacer ».',
                'No secret stored yet: type one, then “Replace”.')}
          </p>
        </div>
      )}
    </div>
  );
}

function NouvelleSource({ busy, onCreer }: {
  busy: boolean;
  onCreer: (input: { label: string; baseUrl: string; authKind: AuthSource; authHeaderName?: string; authSecret?: string }) => void;
}) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [authKind, setAuthKind] = useState<AuthSource>('bearer');
  const [authHeaderName, setAuthHeaderName] = useState('x-api-key');
  const [authSecret, setAuthSecret] = useState('');

  return (
    <div className={`${cardCls} flex flex-col gap-3`}>
      <p className="text-sm font-medium text-ink-900">{t('Brancher un système', 'Connect a system')}</p>
      <label className="text-xs text-ink-500">
        {t('Nom (pour vous)', 'Name (for you)')}
        <input className={`${inputCls} mt-1`} data-testid="source-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ERP, CRM…" />
      </label>
      <label className="text-xs text-ink-500">
        {t('Adresse de base (HTTPS, publique)', 'Base address (HTTPS, public)')}
        <input className={`${inputCls} mt-1`} data-testid="source-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.mon-systeme.fr/v1" />
        <span className="mt-1 block text-xs text-ink-500">
          {t('Vos agents ne pourront jamais appeler ailleurs que sous cette adresse.', 'Your agents will never be able to call outside this address.')}
        </span>
      </label>
      <label className="text-xs text-ink-500">
        {t('Authentification', 'Authentication')}
        <select className={`${inputCls} mt-1`} data-testid="source-auth" value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthSource)}>
          <option value="bearer">{t('Jeton (Bearer)', 'Token (Bearer)')}</option>
          <option value="header">{t('En-tête nommé', 'Named header')}</option>
          <option value="none">{t('Aucune', 'None')}</option>
        </select>
      </label>
      {authKind === 'header' && (
        <label className="text-xs text-ink-500">
          {t('Nom de l’en-tête', 'Header name')}
          <input className={`${inputCls} mt-1`} data-testid="source-entete" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} />
        </label>
      )}
      {authKind !== 'none' && (
        <label className="text-xs text-ink-500">
          {t('Secret', 'Secret')}
          <input type="password" autoComplete="off" className={`${inputCls} mt-1`} data-testid="source-secret" value={authSecret} onChange={(e) => setAuthSecret(e.target.value)} />
          <span className="mt-1 block text-xs text-ink-500">
            {t('Chiffré chez nous, jamais réaffiché.', 'Encrypted on our side, never displayed again.')}
          </span>
        </label>
      )}
      <Bouton
        data-testid="source-creer"
        disabled={busy || label.trim() === '' || baseUrl.trim() === ''}
        onClick={() => onCreer({
          label: label.trim(), baseUrl: baseUrl.trim(), authKind,
          ...(authKind === 'header' ? { authHeaderName: authHeaderName.trim() } : {}),
          ...(authKind !== 'none' ? { authSecret: authSecret.trim() } : {}),
        })}
        className="self-start"
      >
        {t('Brancher', 'Connect')}
      </Bouton>
    </div>
  );
}
