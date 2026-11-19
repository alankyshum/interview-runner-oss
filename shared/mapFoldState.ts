// 2048 entries of 16 hex digits and a boolean, plus the writer and sequence,
// fit comfortably below the Fetch keepalive 64 KiB body limit.
export const MAP_FOLD_MAX_NODES = 2048;
export const MAP_FOLD_KEY = /^[a-f0-9]{16}$/;
export const MAP_FOLD_WRITER = /^[a-f0-9]{32}$/;
