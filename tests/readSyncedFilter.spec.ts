import {
  createBloomFilter,
  bloomFromIds,
  bloomHasId,
  readSyncedFilter,
} from "../src/compressIds";

describe("readSyncedFilter", () => {
  const sampleIds = [
    "550e8400-e29b-41d4-a716-446655440000",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  ];

  it("returns empty filter for null frontmatter", () => {
    expect(readSyncedFilter(null)).toBe(createBloomFilter());
  });

  it("returns empty filter for undefined frontmatter", () => {
    expect(readSyncedFilter(undefined)).toBe(createBloomFilter());
  });

  it("returns empty filter when no relevant fields", () => {
    expect(readSyncedFilter({})).toBe(createBloomFilter());
    expect(readSyncedFilter({ otherField: 42 })).toBe(createBloomFilter());
  });

  it("passes through valid 44-char syncedIds string", () => {
    const filter = bloomFromIds(sampleIds);
    expect(filter.length).toBe(44);
    const fm = { syncedIds: filter };
    expect(readSyncedFilter(fm)).toBe(filter);
  });

  it("rejects invalid-length syncedIds string and returns empty filter", () => {
    const fm = { syncedIds: "too-short" };
    expect(readSyncedFilter(fm)).toBe(createBloomFilter());
  });

  it("converts legacy messages array to Bloom filter", () => {
    const fm = {
      messages: sampleIds.map(id => ({ id })),
    };
    const filter = readSyncedFilter(fm);
    expect(filter).not.toBe(createBloomFilter());
    for (const id of sampleIds) {
      expect(bloomHasId(filter, id)).toBe(true);
    }
  });

  it("skips invalid elements in messages array", () => {
    const fm = {
      messages: [
        null,
        { id: sampleIds[0] },
        undefined,
        { content: "no id" },
        { id: sampleIds[1] },
      ],
    };
    const filter = readSyncedFilter(fm);
    for (const id of sampleIds) {
      expect(bloomHasId(filter, id)).toBe(true);
    }
  });

  it("returns empty filter when messages is not an array", () => {
    expect(readSyncedFilter({ messages: "not-array" })).toBe(createBloomFilter());
    expect(readSyncedFilter({ messages: 42 })).toBe(createBloomFilter());
  });

  it("syncedIds takes priority over messages when valid length", () => {
    const filter = bloomFromIds([sampleIds[0]]);
    const fm = {
      syncedIds: filter,
      messages: [{ id: sampleIds[1] }],
    };
    expect(readSyncedFilter(fm)).toBe(filter);
  });
});
