import type { Strings } from './en';

/**
 * Spanish.
 *
 * Annotated `: Strings`, which is what makes the compiler useful here: a
 * missing line and a typo'd key are both errors, and a function whose
 * arguments were reordered does not compile either.
 *
 * Voseo and regional vocabulary are avoided where there is a neutral choice —
 * this is one table for every Spanish speaker, and "ordenador" versus
 * "computadora" is the kind of decision that makes half the readers feel the
 * app was written for somebody else.
 */
/** The decimal separator is a comma: 13,8 rather than 13.8. */
const decimal = (n: string): string => n.replace('.', ',');

export const es: Strings = {
  locale: {
    heading: 'Idioma',
  },

  common: {
    close: 'Cerrar',
    cancel: 'Cancelar',
    save: 'Guardar',
    saving: 'Guardando…',
    delete: 'Eliminar',
    loading: 'Cargando…',
    working: 'Un momento…',
    somethingWentWrong: 'Algo ha salido mal.',
    today: 'Hoy',
    tomorrow: 'Mañana',
    yesterday: 'Ayer',
    noDate: 'Sin fecha',
  },

  signIn: {
    appName: 'Agnte',
    tagline: 'Una línea de tiempo para tu vida.',
    email: 'Correo',
    password: 'Contraseña',
    signIn: 'Entrar',
    createAccount: 'Crear cuenta',
    createAnAccount: 'Crear una cuenta',
    haveAnAccount: 'Ya tengo una cuenta',
    forgotPassword: 'Enviar un enlace para restablecerla',
    checkYourEmail: 'Revisa tu correo',
    emailConfirmed: 'Correo confirmado. Entra para empezar.',
    linkExpired:
      'Ese enlace de confirmación ha caducado. Regístrate otra vez para recibir uno nuevo.',
    linkInvalid:
      'Ese enlace de confirmación no es válido. Comprueba que has copiado la dirección entera.',
    couldNotFinish: 'No se ha podido completar el inicio de sesión.',
    forgotMyPassword: 'He olvidado mi contraseña',
    or: 'o',
    continueWithGoogle: 'Continuar con Google',
    resetLinkOnItsWay: (email: string) =>
      `Si ${email} tiene una cuenta, el enlace para restablecerla ya va de camino.`,
    linkWaitingAt: (email: string) =>
      `Hay un enlace esperándote en ${email}. La cuenta existirá en cuanto lo abras.`,
    checkSpam:
      'Si no llega en un minuto, mira en spam o correo no deseado — y márcalo como deseado para que el siguiente llegue bien.',
  },

  password: {
    heading: 'Cambiar la contraseña',
    current: 'Contraseña actual',
    next: 'Contraseña nueva',
    changing: 'Cambiando…',
    change: 'Cambiar contraseña',
    failed: 'No se ha podido cambiar.',
    everyDeviceSignedOut:
      'Se cierra la sesión en todos los dispositivos, incluido este. Volverás a entrar con la contraseña nueva.',
    changed: 'Contraseña cambiada',
    noResetLink: 'Sin enlace de restablecimiento',
    setNew: 'Establecer una contraseña nueva',
    setPassword: 'Establecer contraseña',
    signedOutEverywhere:
      'Se ha cerrado la sesión en todos los dispositivos, incluido este. Entra con la contraseña nueva.',
    goToSignIn: 'Ir a iniciar sesión',
    backToSignIn: 'Volver a iniciar sesión',
    needsTheLink:
      'Esta página necesita el enlace del correo. Pide uno nuevo si el enlace es antiguo — caducan.',
  },

  menu: {
    label: 'Menú',
    tags: 'Etiquetas',
    reminders: 'Recordatorios',
    password: 'Contraseña',
    yourData: 'Tus datos',
    signOut: 'Salir',
  },

  timeline: {
    search: 'Buscar',
    searchPlaceholder: 'Buscar en la línea de tiempo',
    clear: 'Limpiar',
    stopFilteringBy: (tag: string) => `Dejar de filtrar por ${tag}`,
    addAVerse: 'Añadir un verso',
    endOfFuture: 'Hasta aquí llega lo que has escrito.',
    endOfPast: 'Este es el principio.',
    catalogue: 'Antes de tu propio registro',
    offline:
      'No se puede conectar con el servidor. Lo que escribas se guarda aquí y se envía cuando vuelvas.',
    couldNotLoad: 'No se ha podido cargar la línea de tiempo.',
    photoProcessing: 'La foto se está procesando',
    queuedSaving: 'Guardando',
    queuedNotSaved: 'Sin guardar',
    queuedSavingEdit: 'Guardando el cambio',
    queuedEditNotSaved: 'Cambio sin guardar',
    queuedDeleting: 'Eliminando',
    queuedNotDeleted: 'Sin eliminar',
    queuedFailed: 'No ha llegado a enviarse.',
    tryAgain: 'Reintentar',
    discard: 'Descartar',
    empty:
      'Aún no hay nada en la línea de tiempo. Añade el primer verso con el botón de abajo.',
    emptyUnderTag: 'No hay nada con esa etiqueta.',
    emptyUnderTags: (tags: string) => `No hay nada en ${tags}.`,
    nothingMatches: (text: string) => `Nada coincide con «${text}».`,
    nothingMatchesUnder: (tags: string, text: string) =>
      `Nada en ${tags} coincide con «${text}».`,
    andJoin: ' y ',
  },

  verse: {
    editHeading: 'Editar este verso',
    addHeading: 'Añadir un verso',
    whatHappened: 'Qué ha pasado',
    xpPlaceholder: 'Opcional — un verso puede ser solo una etiqueta.',
    when: 'Cuándo',
    starts: 'Empieza',
    ends: 'Termina',
    rating: 'Valoración',
    ratingPlaceholder: '0–10',
    visibility: 'Visibilidad',
    inheritFromTags: 'Heredar de las etiquetas',
    private: 'Privado',
    shared: 'Compartido',
    public: 'Público',
    photos: 'Fotos',
    removePhoto: 'Quitar esta foto',
    photoFailed: 'Ha fallado',
    addPhotos: 'Añadir fotos',
    addAnother: 'Añadir otra',
    tags: 'Etiquetas',
    newTagsPlaceholder: 'o nuevas: .barcelona, .restaurante',
    newTag: 'Etiqueta nueva',
    uploading: 'Subiendo…',
    where: 'Dónde',
    wherePlaceholder: 'Opcional',
    details: 'Detalles',
    detailNamePlaceholder: 'p. ej. asiento',
    detailName: 'Nombre del detalle',
    detailValuePlaceholder: 'p. ej. 14A',
    detailValue: 'Valor del detalle',
    label: 'Verso',
    stillProcessing: 'Procesando…',
    photoUnprocessable: 'No se ha podido procesar esta foto.',
    needsATag: 'Un verso necesita al menos una etiqueta.',
    ratingRange: 'La valoración es un número del 0 al 10.',
    couldNotSave: 'No se ha podido guardar.',
    couldNotLoadTags: 'No se han podido cargar tus etiquetas.',
    couldNotAddImage: 'No se ha podido añadir esa imagen.',
    couldNotOpen: 'No se ha podido abrir ese verso.',
    add: 'Añadir',
    addADetail: 'Añadir un detalle',
    removeDetail: (name: string) => `Quitar ${name}`,
    thisDetail: 'este detalle',
    couldNotDelete: 'No se ha podido eliminar.',
    fromItsTags: ' (de sus etiquetas)',
    deleteForGood: 'Eliminar definitivamente',
    edit: 'Editar',
    visibilityPrivate: 'privado',
    visibilityShared: 'compartido',
    visibilityPublic: 'público',
  },

  tags: {
    heading: 'Etiquetas',
    couldNotLoad: 'No se han podido cargar las etiquetas.',
    none: 'Todavía no hay etiquetas. Cada verso necesita al menos una, así que la primera que añadas aparecerá aquí.',
  },

  dashboard: {
    heading: 'Panel',
    verses: 'Versos',
    undated: 'Sin fecha',
    deepTime: 'Tiempo profundo',
    photos: 'Fotos',
    properties: 'Propiedades',
    alsoTagged: 'También etiquetado',
    forTag: (tag: string) => `Panel de ${tag}`,
    span: 'Periodo',
    ratingHeading: 'Valoración',
    average: (value: number) => `media ${value}`,
    ratedOf: (rated: number, total: number) => `${rated} de ${total} valorados`,
    mediaAcross: (photos: number, verses: number) => `${photos} en ${verses}`,
    fromOf: (numeric: number, total: number) => `de ${numeric} de ${total}`,
    across: (total: number) => `en ${total}`,
    on: (total: number) => `en ${total}`,
    truncated:
      'Esta etiqueta tiene más de lo que un panel abarca. Las cifras de abajo cubren solo las entradas más recientes.',
    couldNotOpen: 'No se ha podido abrir ese panel.',
  },

  reminders: {
    heading: 'Recordatorios',
    none: 'Nada programado.',
    titlePlaceholder: 'Tomar la pastilla',
    tags: 'Etiquetas',
    reminderTag: '.reminder',
    newTagsPlaceholder: 'o nuevas: .barcelona, .vuelo',
    schedule: 'Programar',
    quietHours: 'Horas de silencio',
    pickADateAndTime: 'Elige una fecha y una hora.',
    pickTwoTimes: 'Elige dos horas.',
    couldNotSave: 'No se ha podido guardar.',
    couldNotLoad: 'No se han podido cargar los recordatorios.',
    couldNotChangeNotifications: 'No se han podido cambiar las notificaciones.',
    onThisDevice: 'Los recordatorios aparecen como notificaciones en este dispositivo.',
    byEmail: 'Los recordatorios llegan por correo. Las notificaciones son más rápidas.',
    justAMoment: 'Un momento…',
    turnOff: 'Desactivar',
    turnOn: 'Activar',
    everyDay: 'Cada día',
    everyWeekday: 'Cada día laborable',
    everyWeek: 'Cada semana',
    everyMonth: 'Cada mes',
    everyYear: 'Cada año',
    once: 'Una vez',
    reminderLabel: 'Recordatorio',
    when: 'Cuándo',
    repeats: 'Se repite',
    landsAsAVerse:
      'Aparece en la línea de tiempo como un verso, con la etiqueta .reminder. Añade más para archivarlo con el resto del viaje.',
    from: 'Desde',
    to: 'Hasta',
    quietWindowNote: (zone: string) =>
      `${zone}. Un recordatorio que caiga dentro de esta franja espera a que termine en lugar de descartarse.`,
    setQuietHours: 'Establecer horas de silencio',
    notificationsUnsupported:
      'Este navegador no puede mostrar notificaciones aquí, así que los recordatorios llegan por correo. En un iPhone, añade Agnte a la pantalla de inicio primero.',
    notificationsBlocked:
      'Las notificaciones están bloqueadas para este sitio, así que los recordatorios llegan por correo. Solo puedes deshacerlo en los ajustes de sitio de tu navegador.',
  },

  yourData: {
    heading: 'Tus datos',
    copyHeading: 'Una copia de todo',
    checking: 'Comprobando…',
    noneYet: 'Todavía no has pedido ninguna.',
    lastAsked: (at: string) => `Pedida el ${at} — `,
    askForACopy: 'Pedir una copia',
    download: 'Descargar',
    building:
      'Se está preparando. Suele tardar un momento; la página no se actualiza sola, así que vuelve y ábrela de nuevo.',
    couldNotAsk: 'No se ha podido pedir una copia.',
    couldNotDownload: 'No se ha podido descargar.',
    couldNotRead: 'No se ha podido leer el estado.',
    importHeading: 'Volver a cargar una copia',
    importNote:
      'Un archivo agnte.export.v1 — tuyo o de alguien que lo haya compartido. Cargar el mismo archivo dos veces no cambia nada, así que puedes corregir lo rechazado y volver a intentarlo.',
    chooseAFile: 'Elegir un archivo',
    readingIt: 'Leyéndolo…',
    refused: 'Rechazado:',
    importedSummary: (tags: string, verses: string) =>
      `Se han añadido ${tags} y ${verses}.`,
    alreadyHere: (rows: string, count: number) =>
      `${rows} ${count === 1 ? 'ya estaba' : 'ya estaban'} aquí.`,
    erasedDone: 'Listo. Tus versos, etiquetas, fotos y recordatorios han desaparecido',
    erasedPurged: (parts: string) => `${parts} de la app purgadas`,
    erasedFailed: (n: number) =>
      `, ${n} no han podido y se reintentarán antes de eliminar la cuenta`,
    notJson: 'Ese archivo no es JSON.',
    couldNotImport: 'No se ha podido importar.',
    deleteHeading: 'Eliminar esta cuenta',
    deleteWarning: (graceDays: number) =>
      `Esto elimina tus versos, etiquetas, fotos y recordatorios ahora, no dentro de ${graceDays} días.`,
    deleteNoUndo: (graceDays: number) =>
      ` No hay forma de deshacerlo desde la app. Solo el registro de la cuenta espera ${graceDays} días antes de eliminarse también.`,
    deleteKeepFirst:
      'Si quieres conservar algo, pide una copia arriba y descárgala primero.',
    deleteEverything: 'Eliminarlo todo',
    keepMyAccount: 'Conservar mi cuenta',
    couldNotDelete: 'No se ha podido eliminar la cuenta.',
    erasedRecordRemoved: (graceDays: number) =>
      `El registro de la cuenta se elimina al cabo de ${graceDays} días.`,
  },

  email: {
    openInAgnte: 'Ábrelo en Agnte:',
    reminderFooter:
      'Programaste este recordatorio en Agnte. Puedes cambiarlo o cancelarlo desde la pantalla de Recordatorios.',
  },

  count: {
    verses: (n: number) => (n === 1 ? '1 verso' : `${n} versos`),
    tags: (n: number) => (n === 1 ? '1 etiqueta' : `${n} etiquetas`),
    photos: (n: number) => (n === 1 ? '1 foto' : `${n} fotos`),
    parts: (n: number) => (n === 1 ? '1 parte' : `${n} partes`),
    rows: (n: number) => (n === 1 ? '1 fila' : `${n} filas`),
  },

  dates: {
    months: [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ],
    days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
    // "lunes, 3 de marzo" — the comma and the "de" are both required, and
    // neither exists in the English arrangement.
    dayMonth: (day: string, date: number, month: string) => `${day}, ${date} de ${month}`,
    dayMonthYear: (day: string, date: number, month: string, year: number) =>
      `${day}, ${date} de ${month} de ${year}`,
    dateMonthYear: (date: number, month: string, year: number) =>
      `${date} de ${month} de ${year}`,
  },

  deepTime: {
    // "mil millones", not "billón" — a Spanish billón is 10^12, so the
    // English cognate is the one wrong answer available.
    //
    // The decimal separator is a comma, like French. "millón" takes the
    // singular at exactly 1.
    billionYears: (n: string) => `${decimal(n)} mil millones de años`,
    millionYears: (n: string) =>
      `${decimal(n)} ${Math.abs(Number(n)) === 1 ? 'millón' : 'millones'} de años`,
    thousandYears: (n: string) => `${decimal(n)} mil años`,
    years: (n: number) => `${n} años`,
    lessThanAYear: 'menos de un año',
    ago: (span: string) => `hace ${span}`,
    ahead: (span: string) => `dentro de ${span}`,
  },
};
