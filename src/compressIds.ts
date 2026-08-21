/**
 * 264-bit Bloom filter for frontmatter syncedIds.
 *
 * Fixed 44-character base64url output regardless of ID count.
 * Uses UUID bytes directly as hash input via double-hashing (k=4).
 *
 * False positive rate: ~8% at 50 elements.
 */

const BLOOM_BYTES = 33;
const BLOOM_BITS = BLOOM_BYTES * 8; // 264
const BLOOM_K = 4;
export const BLOOM_ENCODED_LEN = 44; // base64url length: 33 * 4/3 = 44

// ── helpers ──────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

function toBase64Url(b64: string): string {
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url: string): string {
	let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = (4 - (b64.length % 4)) % 4;
	b64 += "=".repeat(pad);
	return b64;
}

/** Parse UUID string to 16 raw bytes. */
function uuidToBytes(uuid: string): Uint8Array {
	return hexToBytes(uuid.toLowerCase().replace(/-/g, ""));
}

/**
 * Compute k=4 bit positions from 16 UUID bytes using double hashing.
 *
 * Uses a hash-combine loop over the first 8 and last 8 bytes
 * to derive two independent 32-bit hash values h1 and h2.
 * pos[i] = (h1 + i * h2) % 264,  i = 0,1,...,3
 */
function bloomPositions(uuidBytes: Uint8Array): number[] {
	let h1 = 0;
	for (let i = 0; i < 8; i++) {
		h1 = ((h1 << 5) - h1 + uuidBytes[i]) | 0;
	}
	let h2 = 0;
	for (let i = 8; i < 16; i++) {
		h2 = ((h2 << 5) - h2 + uuidBytes[i]) | 0;
	}
	// Ensure h2 is odd for better position diversity
	h2 = h2 | 1;

	const positions: number[] = [];
	for (let i = 0; i < BLOOM_K; i++) {
		positions.push(((h1 + i * h2) % BLOOM_BITS + BLOOM_BITS) % BLOOM_BITS);
	}
	return positions;
}

function decodeFilter(encoded: string): Uint8Array {
	const b64 = fromBase64Url(encoded);
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encodeFilter(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return toBase64Url(btoa(binary));
}

// ── public API ───────────────────────────────────────────────────────

/** Cached empty filter (always the same string). */
const EMPTY_FILTER = encodeFilter(new Uint8Array(BLOOM_BYTES));

/** Create an empty 264-bit Bloom filter encoded as base64url. */
export function createBloomFilter(): string {
	return EMPTY_FILTER;
}

/** Add a UUID to a Bloom filter. Returns the updated filter string. */
export function bloomAddId(filter: string, id: string): string {
	const bytes = decodeFilter(filter);
	const positions = bloomPositions(uuidToBytes(id));

	let changed = false;
	for (const pos of positions) {
		const byteIdx = pos >>> 3;
		const bitMask = 1 << (pos & 7);
		if (!(bytes[byteIdx] & bitMask)) {
			bytes[byteIdx] |= bitMask;
			changed = true;
		}
	}

	return changed ? encodeFilter(bytes) : filter;
}

/** Check whether a UUID is (probably) in the Bloom filter. */
export function bloomHasId(filter: string, id: string): boolean {
	const bytes = decodeFilter(filter);
	const positions = bloomPositions(uuidToBytes(id));

	for (const pos of positions) {
		const byteIdx = pos >>> 3;
		const bitMask = 1 << (pos & 7);
		if (!(bytes[byteIdx] & bitMask)) return false;
	}
	return true;
}

/** Build a Bloom filter from an array of UUIDs. */
export function bloomFromIds(ids: string[]): string {
	const bytes = new Uint8Array(BLOOM_BYTES);
	for (const id of ids) {
		const positions = bloomPositions(uuidToBytes(id));
		for (const pos of positions) {
			bytes[pos >>> 3] |= 1 << (pos & 7);
		}
	}
	return encodeFilter(bytes);
}

/**
 * Read synced IDs filter from frontmatter.
 *
 * - `syncedIds` string (44 chars) → return as-is (already a Bloom filter)
 * - `messages` array → extract IDs, build Bloom filter
 * - neither → return empty filter
 */
export function readSyncedFilter(
	frontmatter: Record<string, unknown> | null | undefined,
): string {
	if (!frontmatter) return EMPTY_FILTER;

	// New Bloom filter format (validate length to avoid corrupted data)
	if (
		typeof frontmatter.syncedIds === "string" &&
		(frontmatter.syncedIds).length === BLOOM_ENCODED_LEN
	) {
		return frontmatter.syncedIds;
	}

	// Legacy messages array → convert to Bloom filter
	if (Array.isArray(frontmatter.messages)) {
		const ids: string[] = [];
		for (const msg of frontmatter.messages) {
			if (msg != null && typeof msg === "object" && "id" in msg) {
				const val = (msg as Record<string, unknown>).id;
				if (typeof val === "string") {
					ids.push(val);
				}
			}
		}
		return bloomFromIds(ids);
	}

	return EMPTY_FILTER;
}
