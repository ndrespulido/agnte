import type { Strings } from './en';

/**
 * French.
 *
 * Two things this table does that English does not have to think about:
 * the narrow no-break space before `:` `?` `!` `»` (U+202F, written out as an
 * escape so it survives an editor that would helpfully normalise it), and
 * guillemets rather than curly quotes for quoted search text.
 */

/** U+202F, the space French typography puts before high punctuation. */
const NB = ' ';

/** The decimal separator is a comma: 13,8 rather than 13.8. */
const decimal = (n: string): string => n.replace('.', ',');

/** French takes the plural from 2, so "1,5 milliard" stays singular. */
const plural = (n: string, word: string): string =>
  Math.abs(Number(n)) >= 2 ? `${word}s` : word;

export const fr: Strings = {
  /**
   * The composer's reserved words (§12.3) — what `key:` means a field rather
   * than a property, in this language. English keys are accepted everywhere
   * as a fallback; these are *added* to them. Lowercase, and a word listed
   * here stops being available as a property name in this language.
   */
  composer: {
    keys: {
      from: ['du', 'depuis'],
      to: ['au', 'à', 'jusque'],
      when: ['quand'],
      where: ['où', 'lieu'],
      rating: ['note'],
      visibility: ['visibilité', 'visibilite'],
    } as Record<
      'from' | 'to' | 'when' | 'where' | 'rating' | 'visibility',
      readonly string[]
    >,
    visibility: {
      private: ['privé', 'privée', 'prive'],
      shared: ['partagé', 'partagée', 'partage'],
      public: ['public', 'publique'],
    } as Record<'private' | 'shared' | 'public', readonly string[]>,
    /** Whether 05/01/27 is the 5th of January. False would make it May 1st. */
    dayFirst: true as boolean,
  },

  /** The full-screen photo viewer. */
  photos: {
    close: 'Fermer',
    previous: 'Photo précédente',
    next: 'Photo suivante',
    open: 'Ouvrir la photo',
    position: (index: number, total: number) => `${index} / ${total}`,
  },

  /** The composer bar and the card that shows what it understood. */
  composerBar: {
    attach: 'Joindre une photo ou un fichier',
    record: 'Enregistrer une note vocale',
    stopRecording: 'Arrêter l’enregistrement',
    recording: 'Enregistrement…',
    voiceNote: 'Note vocale',
    file: 'Fichier',
    attachFailed: 'Impossible de joindre cela.',
    remove: 'Retirer',
    noMicrophone: 'Le microphone n’est pas disponible.',
    placeholder: 'Écrivez un verset — .étiquette, clé: valeur',
    send: 'Ajouter ce verset',
    openForm: 'Ajouter avec le formulaire',
    needsTag: 'Ajoutez une étiquette pour l’enregistrer, comme .voyage',
    notUnderstood: 'Non compris, conservé tel quel :',
    newTag: 'nouvelle',
    understood: 'Ce qu’agnte a compris',
  },

  /**
   * API failures, by the stable code the server sends (`error.code`).
   *
   * Only codes a person can reach from the screen. Anything not listed falls
   * back to the server's own English sentence — see `serverSaid`.
   */
  errors: {
    'identity.invalid_credentials': 'Cet e-mail et ce mot de passe ne correspondent pas.',
    'identity.email_invalid': 'Cela ne ressemble pas à une adresse e-mail.',
    'identity.password_too_short': 'Ce mot de passe est trop court.',
    'identity.password_too_long': 'Ce mot de passe est trop long.',
    'identity.verification_token_invalid': 'Ce lien de vérification n’est pas valide.',
    'identity.verification_token_expired':
      'Ce lien de vérification a expiré. Inscrivez-vous à nouveau pour en recevoir un autre.',
    'identity.verification_token_already_used':
      'Ce lien de vérification a déjà été utilisé. Essayez de vous connecter.',
    'identity.reset_token_invalid': 'Ce lien de réinitialisation n’est pas valide.',
    'identity.reset_token_expired':
      'Ce lien de réinitialisation a expiré. Demandez-en un nouveau.',
    'identity.reset_token_already_used':
      'Ce lien de réinitialisation a déjà été utilisé. Demandez-en un nouveau.',
    'identity.session_revoked': 'Vous avez été déconnecté. Reconnectez-vous.',
    'identity.refresh_token_invalid': 'Votre session a pris fin. Reconnectez-vous.',
    'identity.oauth_email_unverified': 'Google n’a pas vérifié cette adresse e-mail.',
    'identity.oauth_exchange_failed': 'Impossible de terminer la connexion avec Google.',
    'identity.oauth_state_invalid': 'Cette connexion Google a expiré. Recommencez.',
    unauthenticated: 'Votre session a pris fin. Reconnectez-vous.',
    rate_limited: 'Trop de requêtes. Réessayez dans un instant.',
    'verse.no_tags': 'Un verset a besoin d’au moins une étiquette.',
    'verse.not_found': 'Ce verset n’existe plus.',
    'verse.forbidden': 'Vous ne pouvez pas modifier cela.',
    'verse.version_conflict': 'Ceci a été modifié ailleurs. Rechargez et réessayez.',
    'verse.date_invalid': 'Cette date n’est pas valide.',
    'verse.event_precision_invalid': 'Cette date et cette heure ne vont pas ensemble.',
    'verse.event_range_inverted': 'La fin précède le début.',
    'verse.time_conflict': 'Utilisez soit une date, soit le temps profond, pas les deux.',
    'verse.deep_time_out_of_range':
      'C’est plus loin que ce que la chronologie peut atteindre.',
    'verse.rating_out_of_range': 'Une note va de 0 à 10.',
    'verse.xp_too_long': 'Cette note est trop longue.',
    'verse.location_invalid': 'Ce lieu n’est pas valide.',
    'verse.property_key_invalid':
      'Un nom de propriété peut contenir des lettres, des chiffres et des tirets.',
    'verse.property_value_too_long': 'La valeur de cette propriété est trop longue.',
    'verse.too_many_properties': 'Cela fait trop de propriétés pour un verset.',
    'verse.media_not_found': 'L’une de ces images n’est plus là.',
    'verse.visibility_invalid': 'Cette visibilité ne fait pas partie des choix.',
    'verse.search_query_invalid': 'Cette recherche ne peut pas être lancée.',
    'verse.tag_name_invalid':
      'Un nom d’étiquette peut contenir des minuscules, des chiffres et des tirets.',
    'verse.tag_already_exists': 'Vous avez déjà une étiquette portant ce nom.',
    'verse.tag_not_found': 'Cette étiquette n’existe plus.',
    'verse.tag_shortcut_invalid': 'Ce raccourci n’est pas valide.',
    'verse.tag_shortcut_taken': 'Une autre étiquette utilise déjà ce raccourci.',
    'verse.share_invalid': 'Cela ne peut pas être partagé ainsi.',
    'verse.share_not_permitted': 'Seul le propriétaire peut partager cela.',
    'media.content_type_not_allowed': 'Ce type de fichier ne peut pas être ajouté.',
    'media.too_large': 'Ce fichier est trop volumineux.',
    'media.not_found': 'Cette image n’est plus là.',
    'media.storage_unavailable': 'Le stockage ne répond pas. Réessayez dans un instant.',
    'media.upload_mismatch': 'Cet envoi n’est pas arrivé intact. Réessayez.',
    'notifications.invalid_reminder': 'Ce rappel n’est pas valide.',
    'notifications.invalid_recurrence': 'Cette règle de répétition n’est pas valide.',
    'notifications.invalid_quiet_hours':
      'Les heures calmes nécessitent un début, une fin et un fuseau horaire, ou aucun des trois.',
    'places.unavailable': 'Impossible de joindre le service de lieux.',
    'privacy.export_too_soon':
      'Vous pouvez demander une copie par jour. Réessayez demain.',
    'privacy.export_expired': 'Cet export n’est plus disponible.',
    'privacy.no_export': 'Aucun export n’est prêt à être téléchargé.',
  },

  locale: {
    heading: 'Langue',
  },

  common: {
    close: 'Fermer',
    cancel: 'Annuler',
    save: 'Enregistrer',
    saving: 'Enregistrement…',
    delete: 'Supprimer',
    loading: 'Chargement…',
    working: 'Un instant…',
    somethingWentWrong: 'Une erreur est survenue.',
    today: "Aujourd'hui",
    tomorrow: 'Demain',
    yesterday: 'Hier',
    noDate: 'Sans date',
  },

  signIn: {
    appName: 'Agnte',
    tagline: 'Une chronologie pour votre vie.',
    email: 'E-mail',
    password: 'Mot de passe',
    signIn: 'Se connecter',
    createAccount: 'Créer un compte',
    createAnAccount: 'Créer un compte',
    haveAnAccount: "J'ai déjà un compte",
    forgotPassword: 'Envoyer un lien de réinitialisation',
    checkYourEmail: 'Consultez votre boîte mail',
    emailConfirmed: 'E-mail confirmé. Connectez-vous pour commencer.',
    linkExpired:
      'Ce lien de confirmation a expiré. Inscrivez-vous à nouveau pour en recevoir un autre.',
    linkInvalid:
      "Ce lien de confirmation n'est pas valide. Vérifiez que vous avez copié l'adresse entière.",
    couldNotFinish: "La connexion n'a pas pu aboutir.",
    forgotMyPassword: "J'ai oublié mon mot de passe",
    or: 'ou',
    continueWithGoogle: 'Continuer avec Google',
    resetLinkOnItsWay: (email: string) =>
      `Si ${email} a un compte, un lien de réinitialisation est en route.`,
    linkWaitingAt: (email: string) =>
      `Un lien vous attend à ${email}. Le compte existera dès que vous l'aurez ouvert.`,
    checkSpam:
      "S'il n'arrive pas dans la minute, regardez dans les spams ou les indésirables — et marquez-le comme légitime, pour que le suivant arrive correctement.",
  },

  password: {
    heading: 'Changer votre mot de passe',
    current: 'Mot de passe actuel',
    next: 'Nouveau mot de passe',
    changing: 'Changement…',
    change: 'Changer le mot de passe',
    failed: "Le changement n'a pas abouti.",
    everyDeviceSignedOut:
      'Tous les appareils sont déconnectés, celui-ci compris. Vous vous reconnecterez avec le nouveau mot de passe.',
    changed: 'Mot de passe changé',
    noResetLink: 'Aucun lien de réinitialisation',
    setNew: 'Définir un nouveau mot de passe',
    setPassword: 'Définir le mot de passe',
    signedOutEverywhere:
      'Tous les appareils ont été déconnectés, celui-ci compris. Connectez-vous avec le nouveau mot de passe.',
    goToSignIn: 'Aller à la connexion',
    backToSignIn: 'Retour à la connexion',
    needsTheLink:
      'Cette page a besoin du lien reçu par e-mail. Demandez-en un nouveau si celui-ci est ancien — ils expirent.',
  },

  menu: {
    label: 'Menu',
    tags: 'Étiquettes',
    reminders: 'Rappels',
    password: 'Mot de passe',
    yourData: 'Vos données',
    signOut: 'Se déconnecter',
  },

  timeline: {
    search: 'Rechercher',
    searchPlaceholder: 'Rechercher dans la chronologie',
    clear: 'Effacer',
    stopFilteringBy: (tag: string) => `Ne plus filtrer par ${tag}`,
    addAVerse: 'Ajouter un verset',
    endOfFuture: "C'est tout ce que vous avez écrit pour la suite.",
    endOfPast: "C'est le début.",
    catalogue: 'Avant votre propre récit',
    offline:
      'Serveur injoignable. Ce que vous écrivez est conservé ici et envoyé à votre retour.',
    couldNotLoad: "La chronologie n'a pas pu être chargée.",
    photoProcessing: 'Photo en cours de traitement',
    queuedSaving: 'Enregistrement',
    queuedNotSaved: 'Non enregistré',
    queuedSavingEdit: 'Enregistrement de la modification',
    queuedEditNotSaved: 'Modification non enregistrée',
    queuedDeleting: 'Suppression',
    queuedNotDeleted: 'Non supprimé',
    queuedFailed: "L'envoi n'a pas abouti.",
    tryAgain: 'Réessayer',
    discard: 'Abandonner',
    empty:
      "Rien dans la chronologie pour l'instant. Ajoutez le premier verset avec le bouton ci-dessous.",
    emptyUnderTag: 'Rien sous cette étiquette.',
    emptyUnderTags: (tags: string) => `Rien sous ${tags}.`,
    nothingMatches: (text: string) => `Rien ne correspond à «${NB}${text}${NB}».`,
    nothingMatchesUnder: (tags: string, text: string) =>
      `Rien sous ${tags} ne correspond à «${NB}${text}${NB}».`,
    andJoin: ' et ',
  },

  verse: {
    editHeading: 'Modifier ce verset',
    addHeading: 'Ajouter un verset',
    whatHappened: "Ce qu'il s'est passé",
    xpPlaceholder: 'Facultatif — un verset peut être une simple étiquette.',
    when: 'Quand',
    starts: 'Début',
    ends: 'Fin',
    startTime: 'Heure de début, facultative',
    endTime: 'Heure de fin',
    endNeedsTime: "Ajoutez une heure de fin, ou effacez l'heure de début.",
    timeNeedsDate: "Une heure a besoin d'une date.",
    rating: 'Note',
    ratingPlaceholder: '0–10',
    visibility: 'Visibilité',
    inheritFromTags: 'Hériter des étiquettes',
    private: 'Privé',
    shared: 'Partagé',
    public: 'Public',
    photos: 'Photos',
    removePhoto: 'Retirer cette photo',
    photoFailed: 'Échec',
    addPhotos: 'Ajouter des photos',
    addAnother: 'En ajouter une autre',
    tags: 'Étiquettes',
    newTagsPlaceholder: 'ou de nouvelles : .barcelone, .restaurant',
    newTag: 'Nouvelle étiquette',
    uploading: 'Envoi…',
    where: 'Où',
    wherePlaceholder: 'Facultatif',
    details: 'Détails',
    detailNamePlaceholder: 'p. ex. siège',
    detailName: 'Nom du détail',
    detailValuePlaceholder: 'p. ex. 14A',
    detailValue: 'Valeur du détail',
    label: 'Verset',
    stillProcessing: 'Traitement en cours…',
    photoUnprocessable: "Cette photo n'a pas pu être traitée.",
    needsATag: "Un verset a besoin d'au moins une étiquette.",
    ratingRange: 'La note est un nombre de 0 à 10.',
    couldNotSave: "L'enregistrement n'a pas abouti.",
    couldNotLoadTags: "Vos étiquettes n'ont pas pu être chargées.",
    couldNotAddImage: "Cette image n'a pas pu être ajoutée.",
    couldNotOpen: "Ce verset n'a pas pu être ouvert.",
    add: 'Ajouter',
    addADetail: 'Ajouter un détail',
    removeDetail: (name: string) => `Retirer ${name}`,
    thisDetail: 'ce détail',
    couldNotDelete: "La suppression n'a pas abouti.",
    fromItsTags: ' (hérité de ses étiquettes)',
    deleteForGood: 'Supprimer définitivement',
    edit: 'Modifier',
    visibilityPrivate: 'privé',
    visibilityShared: 'partagé',
    visibilityPublic: 'public',
  },

  tags: {
    heading: 'Étiquettes',
    couldNotLoad: "Les étiquettes n'ont pas pu être chargées.",
    none: "Aucune étiquette pour l'instant. Chaque verset en a besoin d'au moins une, donc la première que vous ajouterez apparaîtra ici.",
  },

  dashboard: {
    heading: 'Tableau de bord',
    verses: 'Versets',
    undated: 'Sans date',
    deepTime: 'Temps profond',
    photos: 'Photos',
    properties: 'Propriétés',
    alsoTagged: 'Également étiqueté',
    forTag: (tag: string) => `Tableau de bord de ${tag}`,
    span: 'Période',
    ratingHeading: 'Note',
    average: (value: number) => `moyenne ${value}`,
    ratedOf: (rated: number, total: number) => `${rated} sur ${total} notés`,
    mediaAcross: (photos: number, verses: number) => `${photos} sur ${verses}`,
    fromOf: (numeric: number, total: number) => `sur ${numeric} de ${total}`,
    across: (total: number) => `sur ${total}`,
    on: (total: number) => `sur ${total}`,
    truncated:
      "Cette étiquette contient plus que ce qu'un tableau de bord lit. Les chiffres ci-dessous ne couvrent que les entrées les plus récentes.",
    couldNotOpen: "Ce tableau de bord n'a pas pu être ouvert.",
  },

  reminders: {
    heading: 'Rappels',
    none: 'Rien de programmé.',
    titlePlaceholder: 'Prendre le comprimé',
    tags: 'Étiquettes',
    reminderTag: '.reminder',
    newTagsPlaceholder: 'ou de nouvelles : .barcelone, .vol',
    schedule: 'Programmer',
    quietHours: 'Heures silencieuses',
    pickADateAndTime: 'Choisissez une date et une heure.',
    pickTwoTimes: 'Choisissez deux heures.',
    couldNotSave: "L'enregistrement n'a pas abouti.",
    couldNotLoad: "Les rappels n'ont pas pu être chargés.",
    couldNotChangeNotifications: "Les notifications n'ont pas pu être modifiées.",
    onThisDevice: 'Les rappels apparaissent en notifications sur cet appareil.',
    byEmail: 'Les rappels arrivent par e-mail. Les notifications sont plus rapides.',
    justAMoment: 'Un instant…',
    turnOff: 'Désactiver',
    turnOn: 'Activer',
    sendTest: 'Envoyer une notification de test',
    testSending: 'Envoi…',
    testArrived:
      'Envoyée. Elle devrait apparaître sur cet appareil dans quelques secondes.',
    testNoSubscription:
      "Aucun navigateur n'est encore abonné sur ce compte. Activez d'abord les notifications.",
    pushNotConfigured:
      'Les notifications push sont désactivées sur ce serveur, les rappels arrivent donc par e-mail.',
    testFailed: (reason: string) => `Elle n'est pas arrivée${NB}: ${reason}`,
    testGone:
      "L'abonnement de ce navigateur avait expiré, il a donc été supprimé. Désactivez puis réactivez les notifications.",
    everyDay: 'Chaque jour',
    everyWeekday: 'Chaque jour ouvré',
    everyWeek: 'Chaque semaine',
    everyMonth: 'Chaque mois',
    everyYear: 'Chaque année',
    once: 'Une fois',
    reminderLabel: 'Rappel',
    when: 'Quand',
    repeats: 'Répétition',
    landsAsAVerse:
      "Il apparaît sur la chronologie comme un verset, étiqueté .reminder. Ajoutez-en d'autres pour le classer avec le reste du voyage.",
    from: 'De',
    to: 'À',
    quietWindowNote: (zone: string) =>
      `${zone}. Un rappel qui tombe dans cette plage attend qu'elle se termine au lieu d'être abandonné.`,
    setQuietHours: 'Définir des heures silencieuses',
    notificationsUnsupported:
      "Ce navigateur ne peut pas afficher de notifications ici, les rappels arrivent donc par e-mail. Sur un iPhone, ajoutez d'abord Agnte à votre écran d'accueil.",
    notificationsBlocked:
      'Les notifications sont bloquées pour ce site, les rappels arrivent donc par e-mail. Seuls les paramètres de site de votre navigateur peuvent revenir là-dessus.',
  },

  yourData: {
    heading: 'Vos données',
    copyHeading: 'Une copie de tout',
    checking: 'Vérification…',
    noneYet: "Vous n'en avez pas encore demandé.",
    lastAsked: (at: string) => `Demandée le ${at} — `,
    askForACopy: 'Demander une copie',
    download: 'Télécharger',
    building:
      'Préparation en cours. Cela prend généralement un instant ; la page ne se met pas à jour toute seule, alors revenez et rouvrez-la.',
    couldNotAsk: "La demande de copie n'a pas abouti.",
    couldNotDownload: "Le téléchargement n'a pas abouti.",
    couldNotRead: "L'état n'a pas pu être lu.",
    importHeading: 'Recharger une copie',
    importNote:
      "Un fichier agnte.export.v1 — le vôtre, ou celui de quelqu'un qui l'a partagé. Charger deux fois le même fichier ne change rien, vous pouvez donc corriger ce qui a été refusé et réessayer.",
    chooseAFile: 'Choisir un fichier',
    readingIt: 'Lecture…',
    refused: `Refusé${NB}:`,
    importedSummary: (tags: string, verses: string) => `${tags} et ${verses} ajoutés.`,
    alreadyHere: (rows: string, count: number) =>
      `${rows} ${count === 1 ? 'était' : 'étaient'} déjà là.`,
    erasedDone: 'Terminé. Vos versets, étiquettes, photos et rappels ont disparu',
    erasedPurged: (parts: string) => `${parts} de l'application purgées`,
    erasedFailed: (n: number) =>
      `, ${n} n'ont pas pu l'être et seront réessayées avant la suppression du compte`,
    notJson: "Ce fichier n'est pas du JSON.",
    couldNotImport: "L'import n'a pas abouti.",
    deleteHeading: 'Supprimer ce compte',
    deleteWarning: (graceDays: number) =>
      `Cela supprime vos versets, étiquettes, photos et rappels maintenant, pas dans ${graceDays} jours.`,
    deleteNoUndo: (graceDays: number) =>
      ` Il n'y a pas de retour en arrière dans l'application. Seul l'enregistrement du compte attend ${graceDays} jours avant d'être supprimé à son tour.`,
    deleteKeepFirst:
      "Si vous voulez en garder quelque chose, demandez une copie ci-dessus et téléchargez-la d'abord.",
    deleteEverything: 'Tout supprimer',
    keepMyAccount: 'Garder mon compte',
    couldNotDelete: "La suppression du compte n'a pas abouti.",
    erasedRecordRemoved: (graceDays: number) =>
      `L'enregistrement du compte lui-même est supprimé au bout de ${graceDays} jours.`,
  },

  email: {
    openInAgnte: `Ouvrir dans Agnte${NB}:`,
    reminderFooter:
      "Vous avez programmé ce rappel dans Agnte. Vous pouvez le modifier ou l'annuler depuis l'écran Rappels.",
  },

  count: {
    // French puts zero in the singular: "0 verset", not "0 versets".
    verses: (n: number) => (n < 2 ? `${n} verset` : `${n} versets`),
    tags: (n: number) => (n < 2 ? `${n} étiquette` : `${n} étiquettes`),
    photos: (n: number) => (n < 2 ? `${n} photo` : `${n} photos`),
    parts: (n: number) => (n < 2 ? `${n} partie` : `${n} parties`),
    rows: (n: number) => (n < 2 ? `${n} ligne` : `${n} lignes`),
  },

  dates: {
    months: [
      'janvier',
      'février',
      'mars',
      'avril',
      'mai',
      'juin',
      'juillet',
      'août',
      'septembre',
      'octobre',
      'novembre',
      'décembre',
    ],
    days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    // "lundi 3 mars", and "lundi 1er mars" — the first of the month is the one
    // ordinal French keeps.
    dayMonth: (day: string, date: number, month: string) =>
      `${day} ${date === 1 ? '1er' : date} ${month}`,
    dayMonthYear: (day: string, date: number, month: string, year: number) =>
      `${day} ${date === 1 ? '1er' : date} ${month} ${year}`,
    dateMonthYear: (date: number, month: string, year: number) =>
      `${date === 1 ? '1er' : date} ${month} ${year}`,
  },

  deepTime: {
    // French "milliard" is 10^9; "billion" is 10^12, so the cognate is wrong
    // here in exactly the way it is wrong in Spanish.
    //
    // Two things the English version has no reason to do: the decimal
    // separator is a comma, and the scale word takes the plural from 2 (so
    // "1 milliard" but "13,8 milliards"). Both were visible on screen before
    // they were fixed — "13.8 milliard d'années" was wrong twice in four
    // words.
    billionYears: (n: string) => `${decimal(n)} ${plural(n, 'milliard')} d'années`,
    millionYears: (n: string) => `${decimal(n)} ${plural(n, 'million')} d'années`,
    thousandYears: (n: string) => `${decimal(n)} mille ans`,
    years: (n: number) => `${n} ans`,
    lessThanAYear: "moins d'un an",
    ago: (span: string) => `il y a ${span}`,
    ahead: (span: string) => `dans ${span}`,
  },
};
