import type { Strings } from './en';

/**
 * Mandarin Chinese, simplified script.
 *
 * **This table has not been reviewed by a native speaker.** The keys are all
 * present and the structure is checked by the compiler, but fluency is not
 * something a type can assert — treat the wording as a first draft. It is
 * shipped rather than withheld because a rough Chinese interface is still a
 * Chinese interface, and because the alternative was offering the language in
 * the picker and giving English.
 *
 * Three things are genuinely different here rather than translated:
 *
 * - **No plurals.** 3 个 and 1 个 are the same word, so the `count` functions
 *   ignore the branch English needs. The measure word (量词) matters instead:
 *   条 for verses, 张 for photos, 个 for the general case.
 * - **Dates run largest-first** — 2026年3月3日, and the weekday follows rather
 *   than leads. This is why `dates` hands the parts over separately.
 * - **Large numbers group in 万 and 亿**, not thousands and millions. 一亿 is
 *   10^8, so "1.4 billion years" is naturally 14亿年 rather than a translated
 *   "billion". `deepTime` does that regrouping itself, which is the reason
 *   those entries are functions taking a number.
 *
 * Punctuation is full-width (。，：「」) because half-width marks in Chinese
 * text sit wrong at the baseline and are the most immediate tell that a
 * translation was done by someone not reading it.
 */
export const zh: Strings = {
  locale: {
    heading: '语言',
  },

  common: {
    close: '关闭',
    cancel: '取消',
    save: '保存',
    saving: '保存中…',
    delete: '删除',
    loading: '加载中…',
    working: '请稍候…',
    somethingWentWrong: '出错了。',
    today: '今天',
    tomorrow: '明天',
    yesterday: '昨天',
    noDate: '无日期',
  },

  signIn: {
    appName: 'Agnte',
    tagline: '属于你人生的时间线。',
    email: '邮箱',
    password: '密码',
    signIn: '登录',
    createAccount: '注册',
    createAnAccount: '注册账号',
    haveAnAccount: '我已有账号',
    forgotPassword: '发送重置链接',
    checkYourEmail: '请查收邮件',
    emailConfirmed: '邮箱已确认。登录即可开始。',
    linkExpired: '该确认链接已过期。请重新注册以获取新的链接。',
    linkInvalid: '该确认链接无效。请检查是否复制了完整地址。',
    couldNotFinish: '登录未能完成。',
    forgotMyPassword: '我忘记密码了',
    or: '或',
    continueWithGoogle: '使用 Google 继续',
    resetLinkOnItsWay: (email: string) => `如果 ${email} 有账号，重置链接已经发出。`,
    linkWaitingAt: (email: string) => `${email} 里有一个链接。点击之后账号才会创建。`,
    checkSpam:
      '如果一分钟内还没收到，请查看垃圾邮件——并把它标记为「非垃圾邮件」，这样下一封才能正常送达。',
  },

  password: {
    heading: '修改密码',
    current: '当前密码',
    next: '新密码',
    changing: '修改中…',
    change: '修改密码',
    failed: '修改失败。',
    everyDeviceSignedOut: '所有设备都会退出登录，包括这一台。之后请用新密码重新登录。',
    changed: '密码已修改',
    noResetLink: '没有重置链接',
    setNew: '设置新密码',
    setPassword: '设置密码',
    signedOutEverywhere: '所有设备都已退出登录，包括这一台。请用新密码登录。',
    goToSignIn: '去登录',
    backToSignIn: '返回登录',
    needsTheLink:
      '这个页面需要邮件里的链接。如果链接已经有些时候了，请重新申请一个——它们会过期。',
  },

  menu: {
    label: '菜单',
    tags: '标签',
    reminders: '提醒',
    password: '密码',
    yourData: '你的数据',
    signOut: '退出登录',
  },

  timeline: {
    search: '搜索',
    searchPlaceholder: '搜索时间线',
    clear: '清除',
    stopFilteringBy: (tag: string) => `取消按 ${tag} 筛选`,
    addAVerse: '添加一条记录',
    endOfFuture: '往后你还没有写过什么。',
    endOfPast: '这就是起点。',
    catalogue: '在你的记录之前',
    offline: '无法连接服务器。你写的内容会先保存在这里，恢复连接后再发送。',
    couldNotLoad: '时间线加载失败。',
    photoProcessing: '照片仍在处理中',
    queuedSaving: '保存中',
    queuedNotSaved: '未保存',
    queuedSavingEdit: '正在保存修改',
    queuedEditNotSaved: '修改未保存',
    queuedDeleting: '删除中',
    queuedNotDeleted: '未删除',
    queuedFailed: '没有发送成功。',
    tryAgain: '重试',
    discard: '丢弃',
    empty: '时间线上还没有内容。用下方的按钮添加第一条记录。',
    emptyUnderTag: '该标签下没有内容。',
    emptyUnderTags: (tags: string) => `${tags} 下没有内容。`,
    nothingMatches: (text: string) => `没有找到与「${text}」匹配的内容。`,
    nothingMatchesUnder: (tags: string, text: string) =>
      `${tags} 下没有找到与「${text}」匹配的内容。`,
    // Chinese lists join with the enumeration comma, not a word.
    andJoin: '、',
  },

  verse: {
    editHeading: '编辑这条记录',
    addHeading: '添加一条记录',
    whatHappened: '发生了什么',
    xpPlaceholder: '可不填 — 一条记录可以只有一个标签。',
    when: '时间',
    starts: '开始',
    ends: '结束',
    rating: '评分',
    ratingPlaceholder: '0–10',
    visibility: '可见性',
    inheritFromTags: '跟随标签',
    private: '私密',
    shared: '共享',
    public: '公开',
    photos: '照片',
    removePhoto: '移除这张照片',
    photoFailed: '失败',
    addPhotos: '添加照片',
    addAnother: '再添加一张',
    tags: '标签',
    newTagsPlaceholder: '或新建：.barcelona、.restaurant',
    newTag: '新标签',
    uploading: '上传中…',
    where: '地点',
    wherePlaceholder: '可不填',
    details: '详情',
    detailNamePlaceholder: '例如：座位',
    detailName: '详情名称',
    detailValuePlaceholder: '例如：14A',
    detailValue: '详情内容',
    label: '记录',
    stillProcessing: '处理中…',
    photoUnprocessable: '这张照片无法处理。',
    needsATag: '一条记录至少需要一个标签。',
    ratingRange: '评分是 0 到 10 之间的数字。',
    couldNotSave: '保存失败。',
    couldNotLoadTags: '标签加载失败。',
    couldNotAddImage: '无法添加该图片。',
    couldNotOpen: '无法打开这条记录。',
    add: '添加',
    addADetail: '添加一个详情',
    removeDetail: (name: string) => `移除${name}`,
    thisDetail: '这个详情',
    couldNotDelete: '删除失败。',
    fromItsTags: '（跟随标签）',
    deleteForGood: '永久删除',
    edit: '编辑',
    visibilityPrivate: '私密',
    visibilityShared: '共享',
    visibilityPublic: '公开',
  },

  tags: {
    heading: '标签',
    couldNotLoad: '标签加载失败。',
    none: '还没有标签。每条记录至少需要一个，所以你添加的第一个会出现在这里。',
  },

  dashboard: {
    heading: '概览',
    verses: '记录',
    undated: '无日期',
    deepTime: '深时',
    photos: '照片',
    properties: '属性',
    alsoTagged: '同时标记为',
    forTag: (tag: string) => `${tag} 的概览`,
    span: '时间跨度',
    ratingHeading: '评分',
    average: (value: number) => `平均 ${value}`,
    ratedOf: (rated: number, total: number) => `${total} 条中有 ${rated} 条已评分`,
    mediaAcross: (photos: number, verses: number) => `${verses} 条记录中共 ${photos} 张`,
    fromOf: (numeric: number, total: number) => `来自 ${total} 条中的 ${numeric} 条`,
    across: (total: number) => `共 ${total} 条`,
    on: (total: number) => `${total} 条`,
    truncated: '这个标签下的内容超过了一个概览能读取的范围。下面的数字只涵盖最近的条目。',
    couldNotOpen: '无法打开该概览。',
  },

  reminders: {
    heading: '提醒',
    none: '没有安排任何提醒。',
    titlePlaceholder: '吃药',
    tags: '标签',
    reminderTag: '.reminder',
    newTagsPlaceholder: '或新建：.barcelona、.flight',
    schedule: '安排',
    quietHours: '免打扰时段',
    pickADateAndTime: '请选择日期和时间。',
    pickTwoTimes: '请选择两个时间。',
    couldNotSave: '保存失败。',
    couldNotLoad: '提醒加载失败。',
    couldNotChangeNotifications: '无法修改通知设置。',
    onThisDevice: '提醒会以通知的形式显示在这台设备上。',
    byEmail: '提醒通过邮件送达。通知会更快。',
    justAMoment: '请稍候…',
    turnOff: '关闭',
    turnOn: '开启',
    everyDay: '每天',
    everyWeekday: '每个工作日',
    everyWeek: '每周',
    everyMonth: '每月',
    everyYear: '每年',
    once: '一次',
    reminderLabel: '提醒内容',
    when: '时间',
    repeats: '重复',
    landsAsAVerse:
      '它会作为一条记录出现在时间线上，并带有 .reminder 标签。可以再加几个标签，和这趟旅程的其他内容归在一起。',
    from: '从',
    to: '到',
    quietWindowNote: (zone: string) =>
      `${zone}。落在这个时段内的提醒会等到时段结束再发送，而不会被丢弃。`,
    setQuietHours: '设置免打扰时段',
    notificationsUnsupported:
      '这个浏览器无法在这里显示通知，所以提醒会通过邮件送达。在 iPhone 上，请先把 Agnte 添加到主屏幕。',
    notificationsBlocked:
      '这个网站的通知已被阻止，所以提醒会通过邮件送达。只能在浏览器的网站设置里解除。',
  },

  yourData: {
    heading: '你的数据',
    copyHeading: '全部内容的副本',
    checking: '检查中…',
    noneYet: '你还没有申请过。',
    lastAsked: (at: string) => `上次申请于 ${at} — `,
    askForACopy: '申请一份副本',
    download: '下载',
    building: '正在生成。通常需要一小会儿；页面不会自动更新，请稍后回来重新打开。',
    couldNotAsk: '申请副本失败。',
    couldNotDownload: '下载失败。',
    couldNotRead: '无法读取状态。',
    importHeading: '重新导入',
    importNote:
      '一个 agnte.export.v1 文件 — 你自己的，或别人分享的。同一个文件导入两次不会有任何变化，所以可以修正被拒绝的内容后再试一次。',
    chooseAFile: '选择文件',
    readingIt: '读取中…',
    refused: '已拒绝：',
    importedSummary: (tags: string, verses: string) => `已添加 ${tags} 和 ${verses}。`,
    // No number agreement to make: 已经存在 reads the same for one row or many.
    alreadyHere: (rows: string) => `${rows} 已经存在。`,
    erasedDone: '完成。你的记录、标签、照片和提醒都已删除',
    erasedPurged: (parts: string) => `应用的 ${parts} 已清除`,
    erasedFailed: (n: number) => `，其中 ${n} 个未能清除，会在账号删除前重试`,
    notJson: '该文件不是 JSON。',
    couldNotImport: '导入失败。',
    deleteHeading: '删除此账号',
    deleteWarning: (graceDays: number) =>
      `这会立即删除你的记录、标签、照片和提醒，而不是等 ${graceDays} 天后。`,
    deleteNoUndo: (graceDays: number) =>
      ` 应用内无法撤销。只有账号记录本身会在 ${graceDays} 天后才被删除。`,
    deleteKeepFirst: '如果你想保留其中任何内容，请先在上方申请并下载一份副本。',
    deleteEverything: '全部删除',
    keepMyAccount: '保留我的账号',
    couldNotDelete: '删除账号失败。',
    erasedRecordRemoved: (graceDays: number) =>
      `账号记录本身会在 ${graceDays} 天后删除。`,
  },

  email: {
    openInAgnte: '在 Agnte 中打开：',
    reminderFooter: '这条提醒是你在 Agnte 中设置的。可以在「提醒」页面修改或取消。',
  },

  count: {
    // No plural form. The measure word carries the work English does with -s.
    verses: (n: number) => `${n} 条记录`,
    tags: (n: number) => `${n} 个标签`,
    photos: (n: number) => `${n} 张照片`,
    parts: (n: number) => `${n} 个部分`,
    rows: (n: number) => `${n} 行`,
  },

  dates: {
    months: [
      '1月',
      '2月',
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
      '8月',
      '9月',
      '10月',
      '11月',
      '12月',
    ],
    days: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
    // Largest unit first, weekday last: "3月3日 星期二".
    dayMonth: (day: string, date: number, month: string) => `${month}${date}日 ${day}`,
    dayMonthYear: (day: string, date: number, month: string, year: number) =>
      `${year}年${month}${date}日 ${day}`,
    dateMonthYear: (date: number, month: string, year: number) =>
      `${year}年${month}${date}日`,
  },

  deepTime: {
    // Regrouped rather than translated. 亿 is 10^8, so 1.4 billion years is
    // 14亿年; 万 is 10^4, so a hundred thousand years is 10万年. Handing these
    // straight through as "billion"/"thousand" would be the literal answer and
    // the unreadable one.
    billionYears: (n: string) => `${round(Number(n) * 10)}亿年`,
    millionYears: (n: string) => `${round(Number(n) * 100)}万年`,
    thousandYears: (n: string) => {
      const years = Number(n) * 1000;
      return years >= 10_000 ? `${round(years / 10_000)}万年` : `${round(years)}年`;
    },
    years: (n: number) => `${n}年`,
    lessThanAYear: '不到一年',
    ago: (span: string) => `${span}前`,
    ahead: (span: string) => `${span}后`,
  },
};

/** One decimal place, with no trailing ".0" — the same rule `format.ts` uses. */
function round(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
