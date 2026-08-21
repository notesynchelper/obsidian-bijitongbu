import {
  createBloomFilter,
  bloomAddId,
  bloomHasId,
  bloomFromIds,
} from "../src/compressIds";

describe("Bloom filter core", () => {
  it("createBloomFilter returns a 44-char base64url string", () => {
    const f = createBloomFilter();
    expect(f).toMatch(/^[A-Za-z0-9_-]{44}$/);
  });

  it("empty filter has no IDs", () => {
    const f = createBloomFilter();
    expect(bloomHasId(f, "550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("added ID is found", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const f = bloomAddId(createBloomFilter(), id);
    expect(bloomHasId(f, id)).toBe(true);
  });

  it("un-added ID is not found", () => {
    const id1 = "550e8400-e29b-41d4-a716-446655440000";
    const id2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const f = bloomAddId(createBloomFilter(), id1);
    expect(bloomHasId(f, id2)).toBe(false);
  });

  it("multiple IDs all found after adding", () => {
    const ids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ];
    const f = bloomFromIds(ids);
    for (const id of ids) {
      expect(bloomHasId(f, id)).toBe(true);
    }
  });

  it("bloomFromIds([]) returns empty filter", () => {
    expect(bloomFromIds([])).toBe(createBloomFilter());
  });

  it("bloomAddId is idempotent", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const f1 = bloomAddId(createBloomFilter(), id);
    const f2 = bloomAddId(f1, id);
    expect(f2).toBe(f1);
  });

  it("handles uppercase UUID input", () => {
    const upper = "550E8400-E29B-41D4-A716-446655440000";
    const lower = "550e8400-e29b-41d4-a716-446655440000";
    const f = bloomAddId(createBloomFilter(), upper);
    expect(bloomHasId(f, lower)).toBe(true);
  });

  it("filter string is always exactly 44 characters", () => {
    const ids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    ];
    let f = createBloomFilter();
    expect(f.length).toBe(44);
    for (const id of ids) {
      f = bloomAddId(f, id);
      expect(f.length).toBe(44);
    }
  });
});
