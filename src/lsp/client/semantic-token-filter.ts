export function filterCommentTokens(data: Uint32Array, remove: number) {
  const filteredData: number[] = [];
  let line = 0;
  let start = 0;
  let retainedLine = 0;
  let retainedStart = 0;

  for (let i = 0; i < data.length; i += 5) {
    const [deltaLine, deltaStart, length, tokenType, modifiers] = [
      data[i],
      data[i + 1],
      data[i + 2],
      data[i + 3],
      data[i + 4],
    ];

    // Decode against the previous input token, including removed comments.
    line += deltaLine;
    start = deltaLine === 0 ? start + deltaStart : deltaStart;
    if (tokenType === remove) {
      continue;
    }

    // Encode against the previous retained token. Same-line columns are relative;
    // columns on a new line are absolute.
    const retainedDeltaLine = line - retainedLine;
    filteredData.push(
      retainedDeltaLine,
      retainedDeltaLine === 0 ? start - retainedStart : start,
      length,
      tokenType,
      modifiers
    );
    retainedLine = line;
    retainedStart = start;
  }

  return filteredData;
}
