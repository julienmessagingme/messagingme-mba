'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { C, Encadre, EnTetePage, LienDoc, LienErreur, LienExterne, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';

/**
 * LES PIÈGES DE META (lot 17) : ce que la plateforme de Meta impose et qui surprend un développeur la première fois.
 * Chaque piège renvoie à son code dans le catalogue des erreurs (`LienErreur`, typé sur les deux listes de codes).
 *
 * ⚠️ AUCUN PRIX (décision de Julien du 2026-10-12) : ce qui est facturé et quand, et un lien vers la grille officielle de
 * Meta. Un chiffre écrit ici périmerait en silence au prochain changement de Meta.
 */
const GRILLE_META = 'https://developers.facebook.com/docs/whatsapp/pricing';

export default function ApiPiegesMetaPage() {
  return <CadreDoc page="meta-pitfalls">{() => <Pieges />}</CadreDoc>;
}

function Pieges() {
  const t = useT();
  return (
    <>
      <EnTetePage page="meta-pitfalls">
        <p>
          {t(
            'Messaging Me passe par la plateforme officielle de Meta pour WhatsApp. Ses règles s’appliquent à chaque message, quel que soit l’outil qui l’envoie : les voici, avec le code que vous recevrez quand l’une d’elles bloque.',
            'Messaging Me goes through Meta’s official WhatsApp platform. Its rules apply to every message, whatever tool sends it: here they are, with the code you will get when one of them blocks.',
          )}
        </p>
      </EnTetePage>

      <Section id="fenetre" titre={t('La fenêtre de 24 h', 'The 24-hour window')}>
        <p>
          {t(
            'Un message libre (texte, image, boutons) ne part que dans les 24 h qui suivent le dernier message de la personne. Passé ce délai, seul un modèle approuvé par Meta peut partir. Quand elle le sait, l’API refuse avant Meta : ',
            'A free-form message (text, image, buttons) only goes out within 24 hours of the person’s last message. After that, only a template approved by Meta can go out. When it knows, the API refuses before Meta: ',
          )}
          <LienErreur code="window_closed" />
          {t(' ; sinon Meta répond ', '; otherwise Meta answers ')}<LienErreur meta={131047} />.
        </p>
        <p>
          {t('Une conversation dit si sa fenêtre est ouverte : ', 'A conversation says whether its window is open: ')}
          <LienDoc page="conversations" ancre="lire">GET /v1/conversations/{'{conversationId}'}</LienDoc>.{' '}
          <LienDoc page="concepts" ancre="fenetre-24h">{t('La règle en détail', 'The rule in detail')}</LienDoc>.
        </p>
      </Section>

      <Section id="modeles" titre={t('Les modèles et leur validation', 'Templates and their review')}>
        <Liste>
          <li>{t('Meta valide chaque modèle, en quelques minutes ou jusqu’à 24 h. Seul un modèle approuvé part.', 'Meta reviews each template, in a few minutes or up to 24 hours. Only an approved template goes out.')}</li>
          <li>
            {t('Trois catégories : marketing, utility (transactionnel) et authentication. Meta peut changer la catégorie que vous avez choisie, et le prix change avec elle.', 'Three categories: marketing, utility (transactional) and authentication. Meta can change the category you chose, and the price changes with it.')}
          </li>
          <li>
            {t('Un modèle peut être mis en pause pour mauvaise qualité (', 'A template can be paused for low quality (')}<LienErreur meta={132015} />
            {t('), puis désactivé pour de bon s’il recommence (', '), then permanently disabled if it happens again (')}<LienErreur meta={132016} />).
          </li>
          <li>
            {t('Les paramètres d’un envoi doivent correspondre au modèle, en nombre (', 'A send’s parameters must match the template, in number (')}<LienErreur meta={132000} />
            {t(') et en format (', ') and format (')}<LienErreur meta={132012} />).
          </li>
          <li>
            {t('Suivre le statut : ', 'Follow the status: ')}<LienDoc page="templates" ancre="statut">GET /v1/templates/{'{name}'}</LienDoc>
            {t(', ou l’événement ', ', or the event ')}<C>template.status_changed</C>.
          </li>
        </Liste>
      </Section>

      <Section id="facturation" titre={t('Ce que Meta facture', 'What Meta charges for')}>
        <p>
          {t(
            'Meta facture les messages de modèle selon leur catégorie et le pays du destinataire. Les messages de service (les réponses dans la fenêtre de 24 h) ont leurs propres conditions, qui ont changé le 1er octobre 2026. Messaging Me ne fixe pas ces prix : la grille officielle de Meta fait foi.',
            'Meta charges template messages by category and by the recipient’s country. Service messages (replies within the 24-hour window) have their own terms, which changed on October 1, 2026. Messaging Me does not set these prices: Meta’s official rate card is the reference.',
          )}
        </p>
        <p><LienExterne href={GRILLE_META}>{t('La grille de prix de Meta', 'Meta’s pricing')}</LienExterne></p>
      </Section>

      <Section id="paiement" titre={t('La carte dans le Business Manager', 'The card in Business Manager')}>
        <p>
          {t(
            'Meta exige un moyen de paiement valide sur le compte WhatsApp pour ce qu’il facture, à commencer par les modèles, quelle que soit l’offre Messaging Me. Sans lui : ',
            'Meta requires a valid payment method on the WhatsApp account for what it charges, starting with templates, whatever the Messaging Me plan. Without it: ',
          )}
          <LienErreur meta={131042} />.
        </p>
      </Section>

      <Section id="consentement" titre={t('Le consentement et STOP', 'Consent and STOP')}>
        <p>
          {t(
            'Meta demande un consentement avant d’écrire en premier à quelqu’un. Messaging Me le garde sur la fiche et refuse un envoi marketing sans lui (',
            'Meta requires consent before writing first to someone. Messaging Me keeps it on the record and refuses a marketing send without it (',
          )}
          <LienErreur code="no_consent" />
          {t('). Une personne qui répond STOP est désabonnée (', '). A person who replies STOP is opted out (')}
          <LienErreur code="opted_out" />
          {t(') : l’API ne la réabonne jamais.', '): the API never resubscribes them.')}
        </p>
        <p>
          {t('La personne peut aussi refuser le marketing de votre entreprise dans WhatsApp même : ', 'The person can also refuse your business’s marketing within WhatsApp itself: ')}
          <LienErreur meta={131050} />.{' '}
          <LienDoc page="concepts" ancre="consentement">{t('La règle en détail', 'The rule in detail')}</LienDoc>.
        </p>
      </Section>

      <Section id="qualite" titre={t('La qualité du numéro', 'Number quality')}>
        <p>
          {t(
            'Meta note la qualité de chaque numéro selon les blocages et les signalements qu’il reçoit, et elle décide du nombre de personnes différentes qu’il peut joindre par 24 h. Une qualité basse restreint les envois (',
            'Meta rates each number’s quality from the blocks and reports it receives, and decides how many different people it can reach per 24 hours. Low quality restricts sending (',
          )}
          <LienErreur meta={131048} />
          {t(
            ') : une campagne Messaging Me se met alors en pause, et rien ne la relance seule. Écrivez à des personnes qui l’ont accepté, avec un contenu qu’elles attendent.',
            '): a Messaging Me campaign then pauses, and nothing restarts it on its own. Write to people who agreed to it, with content they expect.',
          )}
        </p>
      </Section>

      <Section id="debit" titre={t('Le débit', 'Throughput')}>
        <Liste>
          <li>{t('Un numéro a un débit d’envoi maximal : ', 'A number has a maximum sending throughput: ')}<LienErreur meta={130429} />.</li>
          <li>{t('Trop de messages vers la même personne en peu de temps : ', 'Too many messages to the same person in a short time: ')}<LienErreur meta={131056} />{t('. Les autres destinataires ne sont pas touchés.', '. The other recipients are not affected.')}</li>
          <li>
            {t('L’API a aussi ses propres limites, par minute et par jour : ', 'The API also has its own limits, per minute and per day: ')}
            <LienErreur code="rate_limited" />, <LienErreur code="quota_exceeded" />
            {t(' (attendre ', ' (wait for ')}<C>retry-after</C>). <LienDoc page="reference" ancre="debit">{t('Les limites', 'The limits')}</LienDoc>.
          </li>
        </Liste>
      </Section>

      <Section id="marketing" titre={t('La limite marketing par personne', 'The per-person marketing limit')}>
        <p>
          {t(
            'Meta limite le nombre de messages marketing qu’une personne reçoit, toutes entreprises confondues. Au-delà, votre message n’est pas délivré (',
            'Meta limits how many marketing messages a person receives, across all businesses. Beyond it, your message is not delivered (',
          )}
          <LienErreur meta={131049} />
          {t(
            '), sans que vous ayez rien fait de travers. Ne réessayez pas aussitôt : attendez au moins 24 h.',
            '), without you having done anything wrong. Do not retry right away: wait at least 24 hours.',
          )}
        </p>
      </Section>

      <Section id="nom-affiche" titre={t('Le nom affiché', 'The display name')}>
        <p>
          {t(
            'Le nom que la personne voit en face du numéro passe par la validation de Meta. Suivez son état dans le WhatsApp Manager avant de lancer des envois, et corrigez-le là s’il est refusé.',
            'The name the person sees for the number goes through Meta’s review. Check its status in WhatsApp Manager before sending, and fix it there if it is rejected.',
          )}
        </p>
      </Section>

      <Section id="injoignable" titre={t('Le numéro injoignable', 'The unreachable number')}>
        <p>
          {t(
            'Un numéro qui n’est pas sur WhatsApp, une personne qui n’a pas accepté les conditions de WhatsApp ou dont l’application est trop ancienne : ',
            'A number that is not on WhatsApp, a person who has not accepted WhatsApp’s terms or whose app is too old: ',
          )}
          <LienErreur meta={131026} />
          {t('. Passez par un autre canal (RCS, e-mail).', '. Use another channel (RCS, email).')}
        </p>
      </Section>

      <Section id="medias" titre={t('Les fichiers', 'Files')}>
        <Liste>
          <li>
            {t('Meta ne garde un fichier reçu que 7 jours : téléchargez-le dès l’événement ', 'Meta keeps a received file for 7 days only: download it as soon as the event ')}
            <C>message.received</C>{t(' (', ' arrives (')}<LienDoc page="conversations" ancre="media">GET /v1/messages/{'{messageId}'}/media</LienDoc>
            {t('). Après : ', '). After that: ')}<LienErreur code="media_expired" />.
          </li>
          <li>{t('Un fichier envoyé doit avoir un type et une taille que WhatsApp accepte : ', 'A file sent must have a type and size WhatsApp accepts: ')}<LienErreur meta={131053} />.</li>
        </Liste>
        <Encadre sorte="note">
          <p>
            {t('Tous les codes, et ce que Messaging Me fait déjà de lui-même : ', 'All the codes, and what Messaging Me already does on its own: ')}
            <LienDoc page="errors" ancre="meta">{t('les erreurs de Meta', 'Meta errors')}</LienDoc>.
          </p>
        </Encadre>
      </Section>
    </>
  );
}
