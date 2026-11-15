import {
  dark,
  fontSize,
  hairline,
  headerLabel,
  light,
  placementOf,
  space,
  stringsFor,
  timeLabel,
  type Placeable,
} from '@agnte/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

/**
 * THE SPIKE (architecture.md §12.7 step 2). Not the app.
 *
 * One question: can a single React Native codebase carry the hardest screen —
 * a timeline that opens on today, scrolls up into the past and down into the
 * future, loads more at both ends without the page jumping, keeps a sticky
 * date, and has a composer above the keyboard — on web, iOS and Android?
 *
 * The data is generated, there is no API, and nothing here is kept. What is
 * kept is the answer, written up in `SPIKE.md` beside this file.
 */

const PAGE_DAYS = 30;
const DAY_MS = 86_400_000;
const s = stringsFor('en');

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'verse'; key: string; text: string; time: string | null; mine: boolean };

const NOTES = [
  'Coffee with Marta',
  'Flight confirmed — seat 4A',
  'Croquetas, rice with setas, ice cream with brownie',
  'Renew the passport',
  'Dune, second viewing',
  'Dentist',
  'Paid the deposit for the flat in Recife',
  'Long walk along the river, nothing else',
];

/** Deterministic, so the same day always holds the same verses. */
function versesOn(day: number, today: Date, now: Date): Row[] {
  const at = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + day));
  const seed = (((day * 37 + 11) % 97) + 97) % 97;
  const count = seed % 4;
  if (count === 0 && day !== 0) return [];

  const verse: Placeable = {
    eventStart: at.toISOString(),
    eventPrecision: 'date',
    deepTimeYears: null,
    createdAt: at.toISOString(),
  };
  const rows: Row[] = [
    { kind: 'day', key: `d${day}`, label: headerLabel(placementOf(verse), now, s) },
  ];
  for (let i = 0; i < count; i += 1) {
    const timed = (seed + i) % 3 !== 0;
    const moment = new Date(at.getTime() + (8 + ((seed + i * 5) % 12)) * 3_600_000);
    rows.push({
      kind: 'verse',
      key: `v${day}.${i}`,
      // Varying lengths on purpose: equal-height rows hide every scroll bug.
      text: NOTES[(seed + i * 3) % NOTES.length]!.repeat(1 + ((seed + i) % 3)),
      time: timed
        ? timeLabel(
            placementOf({ ...verse, eventStart: moment.toISOString(), eventPrecision: 'minute' }),
          )
        : null,
      mine: (seed + i) % 2 === 0,
    });
  }
  return rows;
}

export default function App() {
  const palette = useColorScheme() === 'dark' ? dark : light;
  const now = useMemo(() => new Date(), []);
  const [range, setRange] = useState({ from: -PAGE_DAYS, to: PAGE_DAYS });
  const [typed, setTyped] = useState<{ key: string; text: string }[]>([]);
  const [draft, setDraft] = useState('');
  const list = useRef<FlatList<Row>>(null);
  const opened = useRef(false);
  const settled = useRef(false);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (let day = range.from; day <= range.to; day += 1) {
      out.push(...versesOn(day, now, now));
      if (day === 0) {
        for (const entry of typed) {
          out.push({ kind: 'verse', key: entry.key, text: entry.text, time: null, mine: true });
        }
      }
    }
    return out;
  }, [range, now, typed]);

  const sticky = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'day' ? [index] : [])),
    [rows],
  );
  const todayIndex = rows.findIndex((row) => row.key === 'd0');

  /*
   * Holding the page still while older days are added above it.
   *
   * On iOS and Android this is one prop, `maintainVisibleContentPosition`.
   * react-native-web does not implement it at all (0.21: the prop is not
   * mentioned anywhere in the package), so on web the list would jump by the
   * height of everything prepended. The compensation below is the standard
   * one: remember the content height before the prepend, and when the new
   * height arrives, move the scroll offset by the difference.
   */
  const offset = useRef(0);
  const heightBeforePrepend = useRef<number | null>(null);
  const contentHeight = useRef(0);
  const loading = useRef(false);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
  }, []);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const before = heightBeforePrepend.current;
    if (Platform.OS === 'web' && before !== null && height !== before) {
      list.current?.scrollToOffset({
        offset: offset.current + (height - before),
        animated: false,
      });
      heightBeforePrepend.current = null;
    }
    contentHeight.current = height;
  }, []);

  const loadPast = useCallback(() => {
    // Before the opening jump the list sits at its top, which *is* the start.
    if (loading.current || !settled.current) return;
    loading.current = true;
    // A stand-in for the network: the wait is where real jumps come from.
    setTimeout(() => {
      heightBeforePrepend.current = contentHeight.current;
      setRange((current) => ({ ...current, from: current.from - PAGE_DAYS }));
      loading.current = false;
    }, 250);
  }, []);

  const loadFuture = useCallback(() => {
    setTimeout(() => {
      setRange((current) => ({ ...current, to: current.to + PAGE_DAYS }));
    }, 250);
  }, []);

  const send = () => {
    const text = draft.trim();
    if (text === '') return;
    setTyped((current) => [...current, { key: `t${current.length}`, text }]);
    setDraft('');
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.fill, { backgroundColor: palette.paper }]}>
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <FlatList
            ref={list}
            testID="timeline"
            data={rows}
            keyExtractor={(row) => row.key}
            stickyHeaderIndices={sticky}
            // Not `initialScrollIndex`: without fixed row heights it renders a
            // window with no scrollable content on web (measured — see
            // SPIKE.md). Jump once the list has laid out instead.
            onLayout={() => {
              if (opened.current) return;
              opened.current = true;
              list.current?.scrollToIndex({ index: todayIndex, animated: false });
              setTimeout(() => {
                settled.current = true;
              }, 300);
            }}
            // On web the windowing works from *estimated* row heights, so
            // content height wobbles as rows mount and the offset maths
            // above is fed wrong numbers. Real DOM rows make it exact.
            disableVirtualization={Platform.OS === 'web'}
            onScrollToIndexFailed={({ index }) => {
              // Rows have no fixed height, so the first jump can land before
              // the target has been measured. Ask again once it has.
              setTimeout(
                () => list.current?.scrollToIndex({ index, animated: false }),
                50,
              );
            }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onStartReached={loadPast}
            onStartReachedThreshold={0.5}
            onEndReached={loadFuture}
            onEndReachedThreshold={0.5}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onContentSizeChange={onContentSizeChange}
            // The browser's own anchoring would compensate a second time in
            // Chromium and not at all in Safari. Off, so every browser takes
            // the one path above.
            style={Platform.OS === 'web' ? ({ overflowAnchor: 'none' } as object) : undefined}
            renderItem={({ item }) =>
              item.kind === 'day' ? (
                <View
                  style={[
                    styles.day,
                    { backgroundColor: palette.glass, borderBottomColor: palette.rule },
                  ]}
                >
                  <Text style={[styles.dayText, { color: palette.ink }]}>{item.label}</Text>
                </View>
              ) : (
                <View style={[styles.verse, item.mine ? styles.mine : styles.theirs]}>
                  <View
                    style={[
                      styles.bubble,
                      { backgroundColor: palette.paperRaised, borderColor: palette.rule },
                    ]}
                  >
                    <Text style={[styles.text, { color: palette.ink }]}>{item.text}</Text>
                    {item.time !== null && (
                      <Text style={[styles.time, { color: palette.inkSoft }]}>{item.time}</Text>
                    )}
                  </View>
                </View>
              )
            }
          />
          <View style={[styles.composer, { borderTopColor: palette.rule }]}>
            <TextInput
              testID="composer"
              style={[styles.input, { color: palette.ink, borderColor: palette.rule }]}
              placeholder="Write a verse"
              placeholderTextColor={palette.inkFaint}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={send}
              submitBehavior="submit"
            />
            <Pressable testID="send" onPress={send} style={styles.send}>
              <Text style={{ color: palette.accent, fontSize: fontSize.body }}>Add</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  day: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: hairline,
  },
  dayText: { fontSize: fontSize.date, fontVariant: ['tabular-nums'] },
  verse: { paddingHorizontal: space.lg, paddingVertical: space.xs, flexDirection: 'row' },
  mine: { justifyContent: 'flex-end' },
  theirs: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    padding: space.md,
    borderWidth: hairline,
    borderRadius: 14,
  },
  text: { fontSize: fontSize.body },
  time: { fontSize: fontSize.micro, marginTop: space.xs, fontVariant: ['tabular-nums'] },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.sm,
    borderTopWidth: hairline,
  },
  input: {
    flex: 1,
    fontSize: fontSize.body,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: hairline,
    borderRadius: 999,
  },
  send: { paddingHorizontal: space.md, paddingVertical: space.sm },
});
