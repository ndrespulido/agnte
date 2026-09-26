/**
 * English — the source of truth.
 *
 * `Strings` is derived from this object (`type Strings = typeof en`), so every
 * other table is checked against it: a missing key is a compile error, and so
 * is a key that exists nowhere else. That is the whole reason the tables are
 * TypeScript rather than JSON — a translation file that silently omits a line
 * fails at the moment someone reads that screen, in a language nobody here
 * speaks.
 *
 * **Anything with a value in it is a function, not a template with holes.**
 * `nothingMatches(text)` rather than `"Nothing matches {text}"`. No format
 * parser, no runtime key errors, and the translator sees the value's position
 * as code — which matters because word order moves between languages far more
 * than the words do.
 *
 * Counting is a function for the same reason. English and Spanish need two
 * forms, French agrees with English on everything except zero, and Chinese has
 * one form for all counts; a `{n, plural, ...}` syntax would encode English's
 * rules in the key and make the others fight it.
 */
export const en = {
  locale: {
    /** The picker's own heading — the one line that must be guessable. */
    heading: 'Language',
  },

  common: {
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    delete: 'Delete',
    loading: 'Loading…',
    working: 'Working…',
    somethingWentWrong: 'Something went wrong.',
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    noDate: 'No date',
  },

  signIn: {
    appName: 'Agnte',
    tagline: 'A timeline for your life.',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    createAccount: 'Create account',
    createAnAccount: 'Create an account',
    haveAnAccount: 'I already have an account',
    forgotPassword: 'Send a reset link',
    checkYourEmail: 'Check your email',
    emailConfirmed: 'Email confirmed. Sign in to start.',
    linkExpired: 'That confirmation link has expired. Register again to get a new one.',
    linkInvalid:
      'That confirmation link is not valid. Check you copied the whole address.',
    couldNotFinish: 'Could not finish signing in.',
    forgotMyPassword: 'I forgot my password',
    or: 'or',
    continueWithGoogle: 'Continue with Google',
    resetLinkOnItsWay: (email: string) =>
      `If ${email} has an account, a reset link is on its way.`,
    linkWaitingAt: (email: string) =>
      `There is a link waiting at ${email}. The account exists once you click it.`,
    checkSpam:
      'If it is not there in a minute, look in spam or junk — and mark it as not spam, so the next one arrives properly.',
  },

  password: {
    heading: 'Change your password',
    current: 'Current password',
    next: 'New password',
    changing: 'Changing…',
    change: 'Change password',
    failed: 'Could not change it.',
    everyDeviceSignedOut:
      'Every device is signed out, including this one. You will sign in again with the new password.',
    changed: 'Password changed',
    noResetLink: 'No reset link',
    setNew: 'Set a new password',
    setPassword: 'Set password',
    signedOutEverywhere:
      'Every device was signed out, including this one. Sign in with the new password.',
    goToSignIn: 'Go to sign in',
    backToSignIn: 'Back to sign in',
    needsTheLink:
      'This page needs the link from the email. Ask for a fresh one if that link is old — they expire.',
  },

  menu: {
    label: 'Menu',
    tags: 'Tags',
    reminders: 'Reminders',
    password: 'Password',
    yourData: 'Your data',
    signOut: 'Sign out',
  },

  timeline: {
    search: 'Search',
    searchPlaceholder: 'Search the timeline',
    clear: 'Clear',
    stopFilteringBy: (tag: string) => `Stop filtering by ${tag}`,
    addAVerse: 'Add a verse',
    endOfFuture: 'That is as far ahead as you have written.',
    endOfPast: 'That is the beginning.',
    catalogue: 'Before your own record',
    offline:
      'Cannot reach the server. Anything you write is kept here and sent when you are back.',
    couldNotLoad: 'Could not load the timeline.',
    photoProcessing: 'Photo still processing',
    /** Queue states shown on a row that has not reached the server yet. */
    queuedSaving: 'Saving',
    queuedNotSaved: 'Not saved',
    queuedSavingEdit: 'Saving the change',
    queuedEditNotSaved: 'Change not saved',
    queuedDeleting: 'Deleting',
    queuedNotDeleted: 'Not deleted',
    queuedFailed: 'It did not go through.',
    tryAgain: 'Try again',
    discard: 'Discard',
    empty: 'Nothing on the timeline yet. Add the first verse with the button below.',
    emptyUnderTag: 'Nothing filed under that tag.',
    emptyUnderTags: (tags: string) => `Nothing filed under ${tags}.`,
    nothingMatches: (text: string) => `Nothing matches “${text}”.`,
    nothingMatchesUnder: (tags: string, text: string) =>
      `Nothing under ${tags} matches “${text}”.`,
    /** Joins the named tags in an empty-state sentence: ".a and .b". */
    andJoin: ' and ',
  },

  verse: {
    editHeading: 'Edit this verse',
    addHeading: 'Add a verse',
    whatHappened: 'What happened',
    xpPlaceholder: 'Optional — a verse can be just a tag.',
    when: 'When',
    starts: 'Starts',
    ends: 'Ends',
    rating: 'Rating',
    ratingPlaceholder: '0–10',
    visibility: 'Visibility',
    inheritFromTags: 'Inherit from tags',
    private: 'Private',
    shared: 'Shared',
    public: 'Public',
    photos: 'Photos',
    removePhoto: 'Remove this photo',
    photoFailed: 'Failed',
    addPhotos: 'Add photos',
    addAnother: 'Add another',
    tags: 'Tags',
    newTagsPlaceholder: 'or new ones: .barcelona, .restaurant',
    newTag: 'New tag',
    uploading: 'Uploading…',
    where: 'Where',
    wherePlaceholder: 'Optional',
    details: 'Details',
    detailNamePlaceholder: 'e.g. seat',
    detailName: 'Detail name',
    detailValuePlaceholder: 'e.g. 14A',
    detailValue: 'Detail value',
    label: 'Verse',
    stillProcessing: 'Still processing…',
    photoUnprocessable: 'This photo could not be processed.',
    needsATag: 'A verse needs at least one tag.',
    ratingRange: 'A rating is a number from 0 to 10.',
    couldNotSave: 'Could not save.',
    couldNotLoadTags: 'Could not load your tags.',
    couldNotAddImage: 'Could not add that image.',
    couldNotOpen: 'Could not open that verse.',
    add: 'Add',
    addADetail: 'Add a detail',
    removeDetail: (name: string) => `Remove ${name}`,
    thisDetail: 'this detail',
    couldNotDelete: 'Could not delete it.',
    fromItsTags: ' (from its tags)',
    deleteForGood: 'Delete for good',
    edit: 'Edit',
    visibilityPrivate: 'private',
    visibilityShared: 'shared',
    visibilityPublic: 'public',
  },

  tags: {
    heading: 'Tags',
    couldNotLoad: 'Could not load tags.',
    none: 'No tags yet. Every verse needs at least one, so the first one you add will show up here.',
  },

  dashboard: {
    heading: 'Dashboard',
    verses: 'Verses',
    undated: 'Undated',
    deepTime: 'Deep time',
    photos: 'Photos',
    properties: 'Properties',
    alsoTagged: 'Also tagged',
    forTag: (tag: string) => `Dashboard for ${tag}`,
    span: 'Span',
    ratingHeading: 'Rating',
    average: (value: number) => `average ${value}`,
    ratedOf: (rated: number, total: number) => `${rated} of ${total} rated`,
    mediaAcross: (photos: number, verses: number) => `${photos} across ${verses}`,
    fromOf: (numeric: number, total: number) => `from ${numeric} of ${total}`,
    across: (total: number) => `across ${total}`,
    on: (total: number) => `on ${total}`,
    truncated:
      'This tag holds more than one dashboard reads. The figures below cover the most recent entries only.',
    couldNotOpen: 'Could not open that dashboard.',
  },

  reminders: {
    heading: 'Reminders',
    none: 'Nothing scheduled.',
    titlePlaceholder: 'Take the tablet',
    tags: 'Tags',
    reminderTag: '.reminder',
    newTagsPlaceholder: 'or new ones: .barcelona, .flight',
    schedule: 'Schedule',
    quietHours: 'Quiet hours',
    pickADateAndTime: 'Pick a date and time.',
    pickTwoTimes: 'Pick two times.',
    couldNotSave: 'Could not save that.',
    couldNotLoad: 'Could not load reminders.',
    couldNotChangeNotifications: 'Could not change notifications.',
    onThisDevice: 'Reminders show as notifications on this device.',
    byEmail: 'Reminders arrive by email. Notifications are quicker.',
    justAMoment: 'Just a moment…',
    turnOff: 'Turn off',
    turnOn: 'Turn on',
    everyDay: 'Every day',
    everyWeekday: 'Every weekday',
    everyWeek: 'Every week',
    everyMonth: 'Every month',
    everyYear: 'Every year',
    once: 'Once',
    reminderLabel: 'Reminder',
    when: 'When',
    repeats: 'Repeats',
    landsAsAVerse:
      'It lands on the timeline as a verse, tagged .reminder. Add more to file it with the rest of the trip.',
    from: 'From',
    to: 'To',
    quietWindowNote: (zone: string) =>
      `${zone}. A reminder that falls inside this window waits until it ends rather than being dropped.`,
    setQuietHours: 'Set quiet hours',
    notificationsUnsupported:
      'This browser cannot show notifications here, so reminders arrive by email. On an iPhone, add Agnte to your home screen first.',
    notificationsBlocked:
      'Notifications are blocked for this site, so reminders arrive by email. Your browser’s site settings are the only place that can undo it.',
  },

  yourData: {
    heading: 'Your data',
    copyHeading: 'A copy of everything',
    checking: 'Checking…',
    noneYet: 'You have not asked for one yet.',
    lastAsked: (at: string) => `Last asked ${at} — `,
    askForACopy: 'Ask for a copy',
    download: 'Download',
    building:
      'Building it now. It usually takes a moment; the page will not update on its own, so come back and reopen this.',
    couldNotAsk: 'Could not ask for a copy.',
    couldNotDownload: 'Could not download it.',
    couldNotRead: 'Could not read the status.',
    importHeading: 'Read one back in',
    importNote:
      'An agnte.export.v1 file — one of yours, or one someone shared. Running the same file twice changes nothing, so it is safe to fix what was refused and try again.',
    chooseAFile: 'Choose a file',
    readingIt: 'Reading it…',
    refused: 'Refused:',
    importedSummary: (tags: string, verses: string) => `${tags} and ${verses} added.`,
    alreadyHere: (rows: string, count: number) =>
      `${rows} ${count === 1 ? 'was' : 'were'} already here.`,
    erasedDone: 'Done. Your verses, tags, photos and reminders are gone',
    erasedPurged: (parts: string) => `${parts} of the app purged`,
    erasedFailed: (n: number) =>
      `, ${n} could not and will be retried before the account is removed`,
    notJson: 'That file is not JSON.',
    couldNotImport: 'Could not import that.',
    deleteHeading: 'Delete this account',
    deleteWarning: (graceDays: number) =>
      `This deletes your verses, tags, photos and reminders now, not in ${graceDays} days.`,
    deleteNoUndo: (graceDays: number) =>
      ` There is no undo in the app. Only the account record waits ${graceDays} days before it is removed too.`,
    deleteKeepFirst:
      'If you want to keep any of it, ask for a copy above and download it first.',
    deleteEverything: 'Delete everything',
    keepMyAccount: 'Keep my account',
    couldNotDelete: 'Could not delete the account.',
    erasedRecordRemoved: (graceDays: number) =>
      `The account record itself is removed after ${graceDays} days.`,
  },

  /**
   * Written by the server, not the browser.
   *
   * A reminder email is composed by the nightly tick from the language stored
   * on the user row — there is no request to read a header from — which is the
   * whole reason that column exists. They live in the same table as the screen
   * text so a language is added in one place rather than two.
   */
  email: {
    openInAgnte: 'Open it in Agnte:',
    reminderFooter:
      'You set this reminder in Agnte. Change or cancel it from the Reminders screen.',
  },

  /**
   * Counted things. One function per noun rather than a general pluraliser,
   * because the general one has to be told which noun it is counting anyway
   * and every language disagrees about how.
   */
  count: {
    verses: (n: number) => (n === 1 ? '1 verse' : `${n} verses`),
    tags: (n: number) => (n === 1 ? '1 tag' : `${n} tags`),
    photos: (n: number) => (n === 1 ? '1 photo' : `${n} photos`),
    parts: (n: number) => (n === 1 ? '1 part' : `${n} parts`),
    rows: (n: number) => (n === 1 ? '1 row' : `${n} rows`),
  },

  /**
   * Dates. The month and day names are spelled out rather than left to `Intl`
   * because the header sets them in a condensed face at a size where the
   * platform's own abbreviations ("Mon", "lun.") vary in ways the layout
   * notices — and because a table that lists them can be read and corrected,
   * which a call into the platform cannot.
   */
  dates: {
    months: [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
    /** Sunday first, matching `Date#getUTCDay`. */
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    /**
     * "Monday 3 March", and with the year when it is not this one.
     *
     * A function because the order is not universal: Spanish wants "lunes, 3
     * de marzo" and Chinese writes the year first. Handing the parts over and
     * letting each table arrange them is the only version that does not read
     * as a translation.
     */
    dayMonth: (day: string, date: number, month: string) => `${day} ${date} ${month}`,
    dayMonthYear: (day: string, date: number, month: string, year: number) =>
      `${day} ${date} ${month} ${year}`,
    dateMonthYear: (date: number, month: string, year: number) =>
      `${date} ${month} ${year}`,
  },

  /**
   * Deep time: "66 million years ago", not "-66000000".
   *
   * Scale words are a real translation problem rather than a lookup — Chinese
   * counts in 万 (ten thousand) and 亿 (hundred million), so "1.4 billion" is
   * naturally 14亿. Each table decides for itself; the caller only supplies a
   * magnitude and a rounded number.
   */
  deepTime: {
    billionYears: (n: string) => `${n} billion years`,
    millionYears: (n: string) => `${n} million years`,
    thousandYears: (n: string) => `${n} thousand years`,
    years: (n: number) => `${n} years`,
    lessThanAYear: 'less than a year',
    ago: (span: string) => `${span} ago`,
    ahead: (span: string) => `in ${span}`,
  },
};

/**
 * The shape every language must fill.
 *
 * Derived from English rather than declared separately, so there is one place
 * a new line is added and the tables cannot drift from a hand-written
 * interface that someone forgot to update.
 */
export type Strings = typeof en;
