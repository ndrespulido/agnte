# Agnte — user's manual

*A timeline for your life: write to it like a journal, query it like a database.*

This manual describes what the app does **today**. Where something exists in
the system but is not yet reachable from the screen, it says so (see
[What is not in the app yet](#14-what-is-not-in-the-app-yet)).

---

## 1. What Agnte is

Agnte is one long timeline of your life. Each entry on it is a **verse**: a
fragment of something that happened, is happening, or will happen. You can put
a verse in the past, today, or the future.

A verse can be as small as a photo and a tag, or as full as a trip with dates,
a place, a rating, notes and attachments. Nothing about a verse is required
except one thing: **a tag**.

| Word | Meaning |
|---|---|
| **Verse** | One entry on the timeline. |
| **Tag** | A label written with a leading dot — `.travel`, `.restaurant`. A verse can have many. |
| **Detail** (property) | Any extra `name: value` you attach — `seat: 4A`, `dessert: ice cream`. |
| **Note** | The free text of a verse (what happened). |
| **Day / moment** | A verse is placed either on a whole day or at a specific time. |

---

## 2. Getting started

### Create an account
1. Open the app and choose **Create an account**.
2. Enter your email and a password of at least **12 characters**.
3. Open the link in the email Agnte sends you. The link works once and expires.
4. Sign in.

You can also choose **Continue with Google**. If you forget your password, use
**I forgot my password** and follow the emailed link.

### Put it on your phone
Agnte is a web app that installs to your home screen.
- **iPhone:** open it in Safari → Share → **Add to Home Screen**. Notifications
  on an iPhone only work from the home-screen icon.
- **Android:** open it in Chrome → menu → **Install app** / **Add to Home
  screen**.

### Language
Agnte speaks **English, Spanish, French and Mandarin Chinese**. The language
picker is in the menu. Your choice is remembered, and it also decides which
words the composer understands (see [section 4](#4-writing-a-verse-the-composer-bar)).

### Light and dark
The app follows your device's light or dark setting.

---

## 3. The timeline

The timeline reads like a chat:

- **Today is at the bottom**, just above the composer bar.
- **Scroll up to go back in time.** Older verses load as you go.
- **Scroll down to go into the future** — things you wrote for later, or
  reminders.
- A **date at the top** always tells you where you are. It changes as you
  scroll.
- Verses on the same day sit under one date heading, with the time on the left
  when a verse has one.

### "Before your own record"
When you scroll up past your oldest verse, the timeline carries on into shared
history — the Great Pyramid, the first photograph, the Moon landing, and back
to the Big Bang. These entries are not yours, cannot be opened, and disappear
whenever you filter the timeline.

### What a row shows
A photo strip (if any), then the note, the place, your details, the tags and
the rating. A verse you made in the composer bar also shows **what you typed**
as a bubble on the right, above it.

A row that has not reached the server yet shows a small status — see
[section 10](#10-working-offline).

---

## 4. Writing a verse: the composer bar

The bar at the bottom of the screen is the fast way in. Type the way you would
message yourself.

```
Trip to Recife from: 5 January 2027 to: 24/02/27 where: Recife Airport rating: 5 .travel
```

As you type, a **card appears above the bar** showing what Agnte understood —
before anything is saved. If it read something wrongly, retype it.

### The rules
1. **`.name` is a tag.** Anywhere in the text. A tag name uses lowercase
   letters, digits and hyphens (`.barcelona-trip`).
2. **`key: value` sets a field or a detail.** If the key is one of the reserved
   words below, it sets that field. Any other key becomes a detail of your own.
3. A value runs **until the next `key:` or the next `.tag`**.
4. **Whatever comes before the first key** is the note.

### Reserved words
Each language has its own; the **English ones work in every language**.

| Field | English | Español | Français | 中文 |
|---|---|---|---|---|
| Start | `from` | `desde`, `de` | `du`, `depuis` | `从`, `开始` |
| End | `to` | `hasta` | `au`, `à`, `jusque` | `到`, `结束` |
| Date (one day) | `when` | `cuando`, `cuándo`, `fecha` | `quand` | `时间`, `日期` |
| Place | `where` | `donde`, `dónde`, `lugar` | `où`, `lieu` | `地点` |
| Rating | `rating` | `nota`, `valoración` | `note` | `评分` |
| Visibility | `visibility` | `visibilidad` | `visibilité` | `可见性` |

A word that is reserved in one language is an ordinary detail name in another.
`nota: 8` is a rating in Spanish and a detail called "nota" in English. The
text you typed is stored exactly as typed and is never re-read in another
language.

Visibility values: `private`, `shared`, `public` (and their Spanish, French and
Chinese equivalents).

### Dates you can type
| You type | Meaning |
|---|---|
| `2027-01-05` | 5 January 2027 |
| `5 January 2027`, `January 5, 2027`, `5 Jan 2027` | the same |
| `5th of January 2027` | the same |
| `24/02/27`, `24.02.2027` | 24 February 2027 |
| `5 January` | 5 January **this year** |
| `today`, `tomorrow`, `yesterday` | relative to now |
| `5 de enero de 2027`, `1er mars 2027`, `2027年1月5日` | Spanish, French, Chinese forms |
| any of the above + `17:30` | a **moment** at that time |

- **Ambiguous numbers** such as `05/01/27` are read **day first** (5 January).
  If only one reading is a real date (`02/24/27`), that one wins.
- A date with **no time** is a whole day. A date **with** a time is a moment,
  in the time zone you are in.
- In a range, a time on only one end is ignored — a range is either days or
  moments.
- An end date typed **without a year** comes after its start (`from: 20
  December 2027 to: 5 January` ends in 2028).
- Impossible dates (31 February) are not guessed at.

### Ratings
A number from 0 to 10. `5`, `7.5`, `7,5` and `8/10` all work.

### When Agnte cannot read something
It never throws your words away. A reserved field it cannot read — `rating:
lots`, `from: sometime` — is kept as a detail under the word you typed, and the
card says **"Not understood, kept as written"** with what it kept.

Two limits to know:
- **A leading `Note: …` is read as a detail**, not as text, because it looks
  like `key: value`. The card shows it, so you can see it.
- A **time such as `10:30`** and **links such as `https://…`** are not
  mistaken for keys.

### A verse needs a tag
Text with no `.tag` cannot be sent — the card says so. Tags that do not exist
yet are created when you send, and marked **new** on the card. If you have
given a tag a shortcut, typing the shortcut files it under that tag.

### Visibility
Leave it out and the verse is **private** (more on this in
[section 11](#11-privacy-and-visibility)). Visibility is only ever set from a
word that exactly names one: `visibility: publik` leaves it unset — it never
guesses towards "public".

### Attachments in the bar
Inside the bar's pill, on the right:
- **Paperclip** — pick photos or files.
- **Microphone** — **tap to start recording a voice note, tap again to stop.**
  The browser asks for microphone permission the first time.
- **Paste** — paste a screenshot or a file straight into the bar.

Each attachment appears as a chip above the bar and uploads while you keep
typing. **The send button waits until uploads finish.** Remove a chip with its
×. A refused file's chip shows why.

### Send
Press the round arrow button (or Enter). The bar clears and the verse appears
on the timeline.

### The plus: continue in the form
The round **+** on the left opens the full form **with what you typed already
filled in** — your note, place, dates, rating, details, tags and any
attachments. Use it for things typing cannot say, or to add photos to the verse
you just started. Saving from the form clears the bar. Closing the form without
saving leaves the bar as it was.

---

## 5. The form

The form has one rounded box per field, with the name inside it:

| Field | Notes |
|---|---|
| **Attachments** (at the top of the form) | **Photo library**, **Take a photo or video** (opens the camera on a phone) and **Choose files** — one tap each, no second menu. Photos are shrunk automatically; videos, voice notes and files go up as they are. Chips and thumbnails show what is attached; they sit in **one strip that scrolls sideways**, with voice notes, videos and files shown as tiles with their names. Remove one with its ✕. |
| **What happened** | The note, below the attachments. Up to 20,000 characters. The box grows with what you write. |
| **Where** | A place, up to 200 characters. If place suggestions are switched on, they appear as you type. |
| **Starts / Ends** + times | A date and an **optional** time for each end. Leave the time empty for a whole day. If the start has a time, the end needs one too. A time needs a date. |
| **Rating** | 0 to 10. |
| **Visibility** | *Inherit from tags* (the default), Private, Shared or Public. |
| **Tags** | Tap existing tags to choose them; type new ones in the box, separated by commas (`.barcelona, .restaurant`). |
| **Add a detail** | Any `name` and `value`. Up to 50 per verse. Names may use letters in any script, digits and hyphens: `entrée`, `座位`, `seat` are all fine. `entree` and `entrée` are different names. |

If you do not give a date, the verse is placed **now**, as a moment.

**Closing.** A small chevron at the top right of the form (and of a verse opened read-only) closes it, as do **Cancel** and **Esc**.

**Minimise.** When you opened the form from the bar with **+**, a small **chevron**
at the top right puts the form down and **moves everything back into the bar**
— your note, place, dates, rating, details and tags as one line of text, and
the attachments as chips — so you can keep writing there. It is greyed out
while something is still uploading. If the bar cannot say what the form says
(a colon in the note or place, or a detail named like a field such as
`rating`), the form stays open and tells you; reword it or save from the form.
A note's line breaks become spaces when it moves to the bar.

**Add** saves. While a photo is still uploading the button waits, so a verse
never quietly loses its picture.

---

## 6. Photos, voice notes, video and files

| Kind | What you get on the timeline |
|---|---|
| **Photos** | A swipeable strip, large enough to read, with the next photo peeking at the edge. |
| **Voice notes** | An audio player. |
| **Video** | A video player (up to 50 MB). |
| **Files** | A link showing the file's name. |

### The photo viewer
**Tap a photo** to open it full screen on black.
- **Swipe** left and right to move between this verse's photos.
- On a computer: arrow keys, or the on-screen arrows.
- **Tap the dark area, the ✕, or press Esc** to close.
- A counter ("2 / 3") shows where you are.

Tapping a photo opens the viewer — not the editor.

### What can be attached
| | Allowed types | Limit |
|---|---|---|
| Photos | JPEG, PNG, WebP | 15 MB (photos are reduced automatically) |
| Voice | WebM, MP4/M4A, MP3, Ogg, WAV | 15 MB |
| Video | MP4, WebM, QuickTime | **50 MB** |
| Files | PDF, plain text, CSV, calendar invites (`.ics`), contact cards (`.vcf`), Word (`.docx`), Excel (`.xlsx`) | 15 MB |

Anything that a browser could run if it were opened (web pages, scripts, SVG)
is refused on purpose. A contact is stored as a `.vcf` file; it is not yet
turned into fields.

Voice notes are **stored, not transcribed** — see
[section 14](#14-what-is-not-in-the-app-yet).

---

## 7. Editing and deleting

### Tap to edit
**Tapping a verse on the timeline opens it straight in the editor, on the part
you tapped:**

| You tap | The editor opens on |
|---|---|
| The note | the note |
| The place | the place |
| The time | the date |
| The rating | the rating |
| A detail | that detail's value |
| Anywhere else | the note |

Change what you want and press **Save**. Cancel (or **Esc**) closes it with no
change.

### Delete
Inside the editor, the **bin icon** at the left of the buttons starts a delete.
You are asked once more ("Delete for good") before anything happens.

### If it changed somewhere else
If you edit a verse on your phone and your laptop at once, the second save is
refused with *"This was changed somewhere else. Reload and try again."* Nothing
is lost; reload and redo the change.

### Verses opened from search
Opening a verse from search results shows it first, with an **Edit** button.

---

## 8. Searching and filtering

Tap the **magnifier** at the top. Everything below narrows the timeline itself,
and combines. The bar stays visible while anything is narrowing, so you can
always see — and clear — what is hiding verses.

| Filter | How it works |
|---|---|
| **Text** | Every word you type must appear somewhere in the verse: its note, its details' values, or its tag names. Matching is by **fragments**, so `olive` finds "olives". It ignores capitals and accents (`cafe` finds "Café"). Quotes are allowed but only ignored — `"red bus"` means the words *red* and *bus* both appear, not that exact phrase. `-word` excludes verses containing that word. There is no fuzzy matching. |
| **Tags** | Tap a tag chip to keep only verses with it; tap more to narrow further. Tapping a tag on any row does the same. Tags you have not scrolled to are listed while the search is open. |
| **Place** | A fragment of the verse's place, ignoring capitals and accents. `lisb` finds "Lisboa". |
| **From / To** | A range of days; **both days are included**. A verse counts if it overlaps the range, so a hotel stay that started before it and runs into it still shows. Undated and deep-time verses are never in a range. |

**Clear** removes every filter at once, and closing the search does too. When
nothing matches, the screen says so and names what you filtered by.

While filtering, "Before your own record" is hidden.

---

## 9. Reminders and notifications

Open **Menu → Reminders**.

- Add a reminder with a **title** and a **date and time**. It lands on the
  timeline as a verse tagged `.reminder` (add more tags to file it with a
  trip).
- **Repeats:** once, every day, every weekday, every week, every month, every
  year.
- **Quiet hours:** choose a window (and your time zone). A reminder that falls
  inside it **waits until the window ends** rather than being dropped.

### How a reminder reaches you
- **Notification on this device** — press **Turn on** and allow notifications.
  Press **Send a test notification** to check it works.
- **Email** — if notifications are off, blocked, unsupported or switched off
  on the server, the reminder is emailed instead.

If notifications are **blocked** for the site, only your browser's own site
settings can undo it. On an iPhone, add Agnte to your home screen first.

If a test says the subscription "had expired", it has been removed: turn
notifications off and on again.

---

## 10. Working offline

Agnte keeps working without a connection. Anything you write is **saved on
your device and sent when you are back online**. A banner says when the server
cannot be reached.

Rows that have not reached the server show their state:

| Label | Meaning |
|---|---|
| *Saving* | On its way. |
| *Not saved* | The server refused it; the reason is shown, with **Try again** and **Discard**. |
| *Saving the change* / *Change not saved* | The same, for an edit. |
| *Deleting* / *Not deleted* | The same, for a delete. |

Photos and other attachments need a connection to upload.

---

## 11. Privacy and visibility

Everything is **private to you by default.**

A verse's visibility is decided like this:
1. If you set one on the verse, that wins.
2. Otherwise it takes the **most restrictive** visibility among its tags.
3. Otherwise it is **private**.

It always fails towards *more* private, never less. A single mis-tag cannot
make a verse public.

- **Photos and files** are not stored in a public place. They are served
  through short-lived private links, so a copied link stops working.
- Your files are protected by the storage provider's encryption at rest.
  Agnte does **not** add its own encryption on top, because that would prevent
  thumbnails being made.
- Voice notes and files are stored as they arrive and are **not inspected**.

Sharing a tag with another person is built into the system but **not yet
reachable from the screen** — see [section 14](#14-what-is-not-in-the-app-yet).

---

## 12. Your data

Open **Menu → Your data**.

### A copy of everything
**Ask for a copy**, then **Download** it when it is ready (come back and reopen
the screen — it does not update on its own). You can ask **once a day**. The
file is an `agnte.export.v1` document.

### Read one back in
**Choose a file** to import an `agnte.export.v1` file — yours or one someone
shared. Importing the same file twice changes nothing. Rows that cannot be read
are listed with the reason; they are never dropped silently.

### Delete your account
**Delete everything** erases your verses, tags, photos and reminders
**immediately**. There is no undo in the app. Only the account record itself
waits **30 days** before it is removed too. If you want to keep anything, ask
for a copy and download it first.

If you contributed verses to someone else's shared tag, deleting your account
**keeps their content but removes your name from it**, so one person cannot
destroy another's record.

### Password
**Menu → Password** changes it. Passwords need at least 12 characters.

---

## 13. Troubleshooting

| Problem | What to try |
|---|---|
| The send button is grey | The card tells you why: usually **no tag**, or an attachment is still uploading. |
| "Add a tag to save this" | Add `.something` to the text. |
| My text turned into details I did not expect | Look at the card. A leading `Note:` or any `word:` becomes a detail. Remove the colon or reword. |
| `rating: 11` or a strange date was not read | The card lists it under *Not understood, kept as written*. Ratings are 0–10; dates must be real. |
| "That kind of file cannot be added" | The type is not on the allowed list in [section 6](#6-photos-voice-notes-video-and-files). |
| "That file is larger than the … limit" | Video up to 50 MB; everything else 15 MB. |
| Recording does nothing | The browser blocked the microphone. Allow it in the site settings and try again. |
| A reminder did not notify me | Check **Menu → Reminders**: notifications on and not blocked, then **Send a test notification**. Otherwise it arrives by email. |
| The timeline shows less than I expect | A filter is on. Open the magnifier and press **Clear**. |
| A verse near midnight is on the "wrong" day in a date range | Ranges count days in UTC; the timeline shows your local time. Widen the range by a day. |
| "This was changed somewhere else" | Reload and make the change again. |

---

## 14. What is not in the app yet

Honest list of things you may expect and will not find:

- **Voice-note transcription.** Recordings are stored and playable, not turned
  into text.
- **Reading photos and screenshots** (extracting dates, reservation numbers or
  seats) and **automatic tags**.
- **Sharing a tag with another person**, and **public timelines or tags** with a
  public link. The server supports sharing; there is no screen for it yet.
- **Choosing a tag's visibility or shortcut** from the screen. Tags are created
  and chosen; their visibility and shortcut cannot yet be edited in the app.
- **Suggested fields for flights, hotels, restaurants, concerts and movies.**
  The tags exist; the pre-filled fields do not appear in the form.
- **Reply-to-edit** (answering a verse to change it).
- **Cropping photos.**
- **Periods of time** whose contents inherit the period's tags or place.
- **Searching by distance or "near here".** Place is text.
- **Native iPhone and Android apps.** Today it is a web app you install to your
  home screen.
- **Live updates across devices.** A second device shows changes when it
  reloads.
- **Non-Latin tag names.** Tags use lowercase letters a–z, digits and hyphens;
  *details* may use any script.
- Error messages are translated for the common cases; a rare one may appear in
  English.
- The **Mandarin** text has not been reviewed by a native speaker.

---

## 15. Quick reference

```
Dinner at Ramiro when: 5 January 2027 20:30 where: Lisbon rating: 9 plat: prawns .restaurant
```

- `.tag` → tag · `key: value` → field or detail · the rest → note
- No date → now · date only → whole day · date + time → moment
- No visibility → private
- **+** → open the form with this draft · **paperclip** → attach · **mic** →
  record · **arrow** → send
- Tap a verse → edit it where you tapped · tap a photo → full screen
- Magnifier → text, tags, place, From/To · **Clear** → everything
