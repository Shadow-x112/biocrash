// Shared constants for the M0 tech test.

/** Cells per chunk edge. One cell = 1 metre. */
export const CHUNK = 32;
/** Density samples per padded chunk edge: one extra sample on the low side, one on the high side. */
export const PAD = CHUNK + 2;
/** Vertical chunk range (inclusive). World y spans MIN_CY*CHUNK .. (MAX_CY+1)*CHUNK. */
export const MIN_CY = -2;
export const MAX_CY = 2;
/** Horizontal view radius in chunks. */
export const VIEW_RADIUS = 4;
/** Chunks around the player that get physics colliders. */
export const COLLIDER_RADIUS = 1;

/** Bump when the world generator changes so old saves are not misread. */
export const GEN_VERSION = 1;
/** Bump when the save format changes. */
export const SAVE_VERSION = 2;

export const DIG_RADIUS = 2.2;
export const DIG_STRENGTH = 3;
export const REACH = 7;

export const chunkKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
