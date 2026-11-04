/** The first lines of a text file, for agents to decide whether to read the rest (#126). */
export function textPreview(data: Uint8Array | Buffer, lines = 3, chars = 300): string {
  const head = Buffer.from(data.subarray(0, 4096)).toString('utf8').replace(/\uFFFD+$/, '');
  const picked = head.split(/\r?\n/).slice(0, lines).join('\n');
  return picked.length > chars ? `${picked.slice(0, chars)}…` : picked;
}
