import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PENDING_CLIPS, capEntries } from "../lib/pendingUploads.ts";

// The upload queue is what keeps a clip alive across an app switch. Its one
// dangerous property is unbounded growth: a phone that stays offline would
// fill the origin's storage quota with video, which breaks every other thing
// the site persists, not just recordings. capEntries is that bound.

const entry = (id: number, size: number, createdAt: number) => ({ id, size, createdAt });

test("nothing is dropped while both caps are respected", () => {
  const entries = [entry(1, 1000, 100), entry(2, 1000, 200)];
  assert.deepEqual(capEntries(entries, 5, 10_000), []);
});

test("the oldest clips go first when the count cap is hit", () => {
  const entries = [entry(3, 10, 300), entry(1, 10, 100), entry(2, 10, 200)];
  assert.deepEqual(capEntries(entries, 2, 10_000), [1]);
  assert.deepEqual(capEntries(entries, 1, 10_000), [1, 2]);
});

test("the byte cap drops oldest-first until it fits", () => {
  const entries = [entry(1, 100, 100), entry(2, 100, 200), entry(3, 100, 300)];
  assert.deepEqual(capEntries(entries, 99, 250), [1]);
  assert.deepEqual(capEntries(entries, 99, 150), [1, 2]);
});

test("insertion order doesn't decide eviction — createdAt does", () => {
  // getAll() returns key order, which is not necessarily time order after
  // deletes and reinserts. Evicting by array position would drop the wrong clip.
  const entries = [entry(9, 10, 100), entry(1, 10, 900)];
  assert.deepEqual(capEntries(entries, 1, 10_000), [9]);
});

test("a single clip over the byte cap is still dropped rather than wedging the queue", () => {
  assert.deepEqual(capEntries([entry(1, 999_999, 100)], 5, 1000), [1]);
});

test("an empty queue is a no-op", () => {
  assert.deepEqual(capEntries([], 5, 1000), []);
});

test("the shipped cap keeps a normal session entirely intact", () => {
  // 20s rotations during a few minutes of scanning must never self-evict.
  const clips = Array.from({ length: MAX_PENDING_CLIPS }, (_, i) => entry(i + 1, 3_000_000, i));
  assert.deepEqual(capEntries(clips), []);
});
