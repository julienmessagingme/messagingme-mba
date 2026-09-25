'use client';

import { useState } from 'react';
import { useT, useLocale } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { cardCls, inputCls, kickerCls } from '@/lib/ui';
import type { ReponseConnexionChaine } from '@/lib/api-chaine';
import { Bouton } from '@/components/Bouton';
import { Squelette } from '@/components/Squelette';

/**
 * L'état de la connexion à Channels Me : la chaîne branchée et ses chiffres, ou l'écran vide qui explique
 * qu'une chaîne se crée à la main.
 *
 * 🔴 TROIS ÉTATS, PAS DEUX, et c'est toute la raison d'être de ce composant. « Aucune connexion enregistrée »
 * et « connexion enregistrée mais fournisseur muet » se ressemblent à l'écran et n'appellent pas du tout la
 * même action : le premier demande de saisir des identifiants, le second demande d'attendre. Les confondre
 * pousse le client à ressaisir des identifiants qui sont bons, puis à conclure que le produit est cassé.
 * Le serveur les distingue par `distant`, on les distingue ici.
 */

export interface ChaineConnexionProps {
  /** `null` = chargement en cours. Distinct de « chargé, et il n'y a rien ». */
  etat: ReponseConnexionChaine | null;
  /** Le chargement lui-même a échoué (réseau, 500). Distinct de « le fournisseur est muet ». */
  erreur: string | null;
  /** `null` tant qu'on ne l'a pas chargé : la mesure se masque plutôt que d'afficher un zéro faux. */
  nbLiens: number | null;
  onEnregistrer: (c: { orgId: string; channelId: string; apiKey: string; secret: string }) => Promise<void>;
  onTester: () => Promise<void>;
  onDemanderActivation: (message: string) => Promise<void>;
}

const PASTILLE = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium';

export function ChaineConnexion(props: ChaineConnexionProps) {
  const t = useT();
  const { locale } = useLocale();
  const { etat, erreur, nbLiens } = props;

  if (erreur !== null) {
    return (
      <div className={cardCls} data-testid="chaine-connexion-erreur">
        <p className="text-sm text-danger">{erreur}</p>
      </div>
    );
  }
  if (etat === null) {
    return (
      <div className={cardCls} data-testid="chaine-connexion-chargement">
        <Squelette forme="carte" />
      </div>
    );
  }
  if (etat.connection === null) {
    return (
      <EtatVide
        onDemanderActivation={props.onDemanderActivation}
        onEnregistrer={props.onEnregistrer}
      />
    );
  }
  return (
    <Connectee
      etat={etat}
      nbLiens={nbLiens}
      locale={locale}
      t={t}
      onEnregistrer={props.onEnregistrer}
      onTester={props.onTester}
    />
  );
}

// --- La chaîne est branchée -----------------------------------------------------------------------

function Connectee({
  etat, nbLiens, locale, t, onEnregistrer, onTester,
}: {
  etat: ReponseConnexionChaine;
  nbLiens: number | null;
  locale: ReturnType<typeof useLocale>['locale'];
  t: ReturnType<typeof useT>;
  onEnregistrer: ChaineConnexionProps['onEnregistrer'];
  onTester: ChaineConnexionProps['onTester'];
}) {
  const [edition, setEdition] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ton: 'ok' | 'ko'; texte: string } | null>(null);

  // La chaîne dont l'identifiant est celui de la connexion. Le fournisseur peut en rendre plusieurs.
  const chaine = etat.channels.find((c) => c.id === etat.connection!.channelId) ?? etat.channels[0] ?? null;
  const muet = etat.distant === 'injoignable';

  async function tester() {
    setBusy(true);
    setMessage(null);
    try {
      await onTester();
      setMessage({ ton: 'ok', texte: t('Connexion vérifiée.', 'Connection verified.') });
    } catch (err) {
      // 🔴 Le refus arrive en 422, donc par une exception : il n'y a pas de branche `ok: false` à lire.
      setMessage({ ton: 'ko', texte: err instanceof Error ? err.message : t('Test impossible', 'Test failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cardCls} data-testid="chaine-connexion">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={kickerCls}>{t('Chaîne WhatsApp', 'WhatsApp channel')}</p>
          <h2 className="mt-1 text-lg font-semibold text-ink-900" data-testid="chaine-nom">
            {chaine?.name ?? etat.connection!.channelId}
          </h2>
          {etat.organisation?.name ? (
            <p className="mt-0.5 text-sm text-ink-500">{etat.organisation.name}</p>
          ) : null}
        </div>
        <span
          className={`${PASTILLE} ${muet ? 'bg-alerte-50 text-alerte' : 'bg-succes-50 text-succes-700'}`}
          data-testid="chaine-etat-distant"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${muet ? 'bg-alerte-500' : 'bg-succes-400'}`} />
          {muet
            ? t('Channels Me est injoignable', 'Channels Me unreachable')
            : t('Chaîne active', 'Channel active')}
        </span>
      </div>

      {/* ⚠️ Le bandeau dit ce qui reste VRAI quand le fournisseur est muet : la connexion est enregistrée,
          rien n'a été perdu. Sans lui, l'écran ressemble à « il n'y a rien », et le réflexe est de ressaisir
          des identifiants qui sont bons. */}
      {muet ? (
        <p className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-sm text-ink-500" data-testid="chaine-injoignable">
          {t(
            'Les identifiants sont bien enregistrés : c’est Channels Me qui ne répond pas. Rien à ressaisir, réessaie dans un moment.',
            'Your credentials are saved: Channels Me is not answering. Nothing to re-enter, try again shortly.',
          )}
        </p>
      ) : null}

      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Mesure
          libelle={t('Publications', 'Posts')}
          valeur={chaine?.messages_count === undefined ? null : fmtNum(chaine.messages_count, locale)}
          testid="chaine-mesure-publications"
        />
        {/* Le quota MENSUEL de l organisation, pas de la chaine. Masque si le fournisseur ne le donne pas :
            une mesure absente se masque, elle ne s affiche pas a zero. */}
        <Mesure
          libelle={t('Ce mois-ci', 'This month')}
          valeur={
            etat.organisation?.monthly_messages_count === undefined
              ? null
              : etat.organisation.allowed_message_quota === undefined
                ? fmtNum(etat.organisation.monthly_messages_count, locale)
                : `${fmtNum(etat.organisation.monthly_messages_count, locale)} / ${fmtNum(etat.organisation.allowed_message_quota, locale)}`
          }
          testid="chaine-mesure-quota"
        />
        <Mesure
          libelle={t('Liens de scénario', 'Scenario links')}
          valeur={nbLiens === null ? null : fmtNum(nbLiens, locale)}
          testid="chaine-mesure-liens"
        />
        <Mesure
          libelle={t('Dernière vérification', 'Last verified')}
          valeur={
            etat.connection!.verifiedAt === null
              ? t('Jamais', 'Never')
              : new Date(etat.connection!.verifiedAt).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR')
          }
          testid="chaine-mesure-verifiee"
        />
      </dl>

      {/* ⚠️ Aucune garde de rôle ici : `AppShell` impose `adminOnly` sur tout ce qui n'est pas l'inbox
          (`active !== 'inbox'`), donc un non-admin est renvoyé sur l'inbox avant d'atteindre cette page.
          Une garde de plus n'aurait jamais pu être fausse, et laisserait croire à un cas qui n'existe pas. */}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4">
        <Bouton variante="secondaire" enCours={busy}
          type="button"
          onClick={() => void tester()}
          disabled={busy}
          data-testid="chaine-tester"
        >
          {busy ? t('Test en cours…', 'Testing…') : t('Tester la connexion', 'Test connection')}
        </Bouton>
        <button
          type="button"
          onClick={() => setEdition((v) => !v)}
          className="text-sm font-medium text-brand-600 hover:text-brand-700"
          data-testid="chaine-modifier"
        >
          {edition ? t('Annuler', 'Cancel') : t('Changer les identifiants', 'Change credentials')}
        </button>
        {message ? (
          <span
            className={`text-sm ${message.ton === 'ok' ? 'text-succes-600' : 'text-danger'}`}
            data-testid="chaine-test-resultat"
          >
            {message.texte}
          </span>
        ) : null}
      </div>

      {edition ? (
        <FormulaireIdentifiants
          connexion={etat.connection!}
          onEnregistrer={async (c) => {
            await onEnregistrer(c);
            setEdition(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Mesure({ libelle, valeur, testid }: { libelle: string; valeur: string | null; testid: string }) {
  // Une mesure qu'on n'a pas se MASQUE. Afficher « 0 » serait une affirmation, et elle serait fausse.
  if (valeur === null) return null;
  return (
    <div data-testid={testid}>
      <dt className="text-xs text-ink-500 font-medium">{libelle}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink-900">{valeur}</dd>
    </div>
  );
}

// --- Saisie des identifiants ----------------------------------------------------------------------

/**
 * 🔴 Les QUATRE champs sont toujours redemandés, y compris ceux qui n'ont pas changé. Ce n'est pas une
 * maladresse : les deux secrets ne redescendent JAMAIS du serveur (`hasApiKey` / `hasSecret` ne sont que des
 * booléens), donc l'écran ne peut pas renvoyer ce qu'il n'a jamais eu. La route est un remplacement complet.
 */
function FormulaireIdentifiants({
  connexion, onEnregistrer,
}: {
  connexion: { orgId: string; channelId: string };
  onEnregistrer: (c: { orgId: string; channelId: string; apiKey: string; secret: string }) => Promise<void>;
}) {
  const t = useT();
  const [orgId, setOrgId] = useState(connexion.orgId);
  const [channelId, setChannelId] = useState(connexion.channelId);
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const complet = orgId.trim() !== '' && channelId.trim() !== '' && apiKey.trim() !== '' && secret.trim() !== '';

  async function soumettre() {
    setBusy(true);
    setErreur(null);
    try {
      await onEnregistrer({ orgId: orgId.trim(), channelId: channelId.trim(), apiKey: apiKey.trim(), secret: secret.trim() });
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 grid gap-3 rounded-carte bg-ink-50 p-4 sm:grid-cols-2" data-testid="chaine-identifiants">
      <Champ label={t('Organisation', 'Organisation')} value={orgId} onChange={setOrgId} testid="chaine-org" />
      <Champ label={t('Chaîne', 'Channel')} value={channelId} onChange={setChannelId} testid="chaine-canal" />
      <Champ label={t('Clé d’API', 'API key')} value={apiKey} onChange={setApiKey} type="password" testid="chaine-cle" />
      <Champ label={t('Secret', 'Secret')} value={secret} onChange={setSecret} type="password" testid="chaine-secret" />
      <p className="text-xs text-ink-500 sm:col-span-2">
        {t(
          'La clé et le secret ne sont jamais réaffichés : ressaisis les quatre champs pour en changer un.',
          'The key and secret are never shown again: re-enter all four fields to change one.',
        )}
      </p>
      {erreur ? <p className="text-sm text-danger sm:col-span-2" data-testid="chaine-identifiants-erreur">{erreur}</p> : null}
      <div className="sm:col-span-2">
        <Bouton enCours={busy}
          type="button"
          onClick={() => void soumettre()}
          disabled={busy || !complet}
          data-testid="chaine-identifiants-enregistrer"
        >
          {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
      </div>
    </div>
  );
}

function Champ({
  label, value, onChange, testid, type,
}: {
  label: string; value: string; onChange: (v: string) => void; testid: string; type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-500">{label}</span>
      <input
        className={inputCls}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        autoComplete="off"
      />
    </label>
  );
}

// --- Aucune chaîne -------------------------------------------------------------------------------

/**
 * L'état vide, et la demande d'activation.
 *
 * Une chaîne WhatsApp se crée A LA MAIN chez le fournisseur : il n'y a rien à provisionner en autonomie,
 * donc l'écran vide n'est pas un formulaire, c'est une demande. Le dire franchement évite au client de
 * chercher un bouton qui n'existe pas.
 */
function EtatVide({
  onDemanderActivation, onEnregistrer,
}: {
  onDemanderActivation: (message: string) => Promise<void>;
  onEnregistrer: ChaineConnexionProps['onEnregistrer'];
}) {
  const t = useT();
  const [message, setMessage] = useState('');
  const [etat, setEtat] = useState<'repos' | 'envoi' | 'envoyee'>('repos');
  const [erreur, setErreur] = useState<string | null>(null);
  /**
   * 🔴 LE SECOND CHEMIN, SANS LEQUEL L ECRAN EST UN CUL-DE-SAC. La premiere version ne proposait QUE la
   * demande d activation, parce qu elle supposait que toute chaine se provisionne par nous. C est faux des
   * le premier client qui a deja sa chaine et ses identifiants : il voyait un ecran qui lui demandait de
   * reclamer ce qu il possedait deja, et aucun champ ou le saisir. Le formulaire n existait que DERRIERE une
   * connexion enregistree, donc il fallait deja en avoir une pour pouvoir en creer une.
   */
  const [saisie, setSaisie] = useState(false);

  async function envoyer() {
    setEtat('envoi');
    setErreur(null);
    try {
      await onDemanderActivation(message.trim());
      setEtat('envoyee');
    } catch (err) {
      setEtat('repos');
      setErreur(err instanceof Error ? err.message : t('Envoi impossible', 'Could not send'));
    }
  }

  return (
    <div className={`${cardCls} text-center`} data-testid="chaine-vide">
      <p className={kickerCls}>{t('Chaîne WhatsApp', 'WhatsApp channel')}</p>
      <h2 className="mt-2 text-lg font-semibold text-ink-900">
        {t('Aucune chaîne branchée', 'No channel connected')}
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-ink-500">
        {t(
          'Une chaîne WhatsApp diffuse un message à tous ses abonnés, gratuitement. Chaque publication peut porter un bouton « Discuter » qui démarre un de tes scénarios. La chaîne se crée à la main : demande-nous son activation et nous la branchons.',
          'A WhatsApp channel broadcasts to all its subscribers, for free. Each post can carry a "Chat" button that starts one of your scenarios. Channels are created manually: ask us to activate yours and we will connect it.',
        )}
      </p>

      {saisie ? (
        <div className="mx-auto mt-5 max-w-xl text-left">
          <FormulaireIdentifiants connexion={{ orgId: '', channelId: '' }} onEnregistrer={onEnregistrer} />
          <button
            type="button"
            onClick={() => setSaisie(false)}
            className="mt-3 text-sm font-medium text-ink-500 hover:text-ink-900"
            data-testid="chaine-saisie-annuler"
          >
            {t('Annuler', 'Cancel')}
          </button>
        </div>
      ) : etat === 'envoyee' ? (
        <p className="mt-5 rounded-controle bg-succes-50 px-3 py-2 text-sm text-succes-700" data-testid="chaine-demande-envoyee">
          {t('Demande envoyée. Nous revenons vers toi rapidement.', 'Request sent. We will get back to you shortly.')}
        </p>
      ) : (
        <div className="mx-auto mt-5 max-w-xl text-left">
          <textarea
            className={`${inputCls} min-h-[80px]`}
            placeholder={t('Un mot sur ton projet (facultatif)', 'A word about your project (optional)')}
            value={message}
            maxLength={2000}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="chaine-demande-message"
          />
          {erreur ? <p className="mt-2 text-sm text-danger" data-testid="chaine-demande-erreur">{erreur}</p> : null}
          <Bouton
            type="button"
            onClick={() => void envoyer()}
            disabled={etat === 'envoi'}
            className="mt-3"
            data-testid="chaine-demande-envoyer"
          >
            {etat === 'envoi' ? t('Envoi…', 'Sending…') : t('Demander l’activation', 'Request activation')}
          </Bouton>
          <p className="mt-4 border-t border-ink-100 pt-4 text-sm text-ink-500">
            {t('Ta chaîne existe déjà ?', 'Already have a channel?')}{' '}
            <button
              type="button"
              onClick={() => setSaisie(true)}
              className="font-medium text-brand-600 hover:text-brand-700"
              data-testid="chaine-saisir-identifiants"
            >
              {t('Saisis ses identifiants', 'Enter its credentials')}
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
