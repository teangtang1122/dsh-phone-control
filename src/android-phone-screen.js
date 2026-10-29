// Classify screenshot protection from WindowManager's public diagnostic output.
// Return only counts: window names and titles can contain private information.
function booleanField(block, name) {
  const matches = [...block.matchAll(new RegExp(`(?:^|\\s)${name}=(true|false)(?=\\s|$)`, 'gm'))];
  return matches.length ? matches.at(-1)[1] === 'true' : undefined;
}

function secureFlags(block) {
  const fields = [
    ...block.matchAll(/^\s*fl=([^\r\n}]*)/gm),
    ...block.matchAll(/^\s*mAttrs\s*=.*?\bfl=([^\r\n}]*)/gm)
  ];
  return fields.some(([, flags]) => {
    if (/(?:^|\s)SECURE(?:\s|$)/.test(flags.trim())) return true;
    const hex = /^(?:0x)?([\da-f]+)(?=\s|$)/i.exec(flags.trim());
    if (!hex) return false;
    try { return (BigInt(`0x${hex[1]}`) & 0x2000n) !== 0n; } catch { return false; }
  });
}

function visibleSurface(block) {
  if (booleanField(block, 'mHasSurface') !== true) return false;
  const visible = booleanField(block, 'isVisible');
  const onScreen = booleanField(block, 'isOnScreen');
  if (visible === false || onScreen === false) return false;
  const view = /(?:^|\s)mViewVisibility=(0x[\da-f]+|\d+)(?=\s|$)/im.exec(block);
  if (view && Number(view[1]) !== 0) return false;
  if (booleanField(block, 'mPolicyVisibility') === false) return false;
  return visible === true || onScreen === true;
}

export function detectProtectedScreen(dump) {
  const result = { protected: false, secureWindowCount: 0, visibleSecureWindowCount: 0 };
  if (typeof dump !== 'string' || !dump.trim()) return result;
  const headers = [...dump.matchAll(/^\s*Window\s+#\d+\s+Window\{[^\r\n]*\}:\s*$/gm)];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    // Exclude the header entirely so a window title containing SECURE or a
    // diagnostic-looking string never supplies a flag/visibility value.
    const block = dump.slice(header.index + header[0].length, headers[i + 1]?.index ?? dump.length);
    if (!secureFlags(block)) continue;
    result.secureWindowCount++;
    if (visibleSurface(block)) result.visibleSecureWindowCount++;
  }
  result.protected = result.visibleSecureWindowCount > 0;
  return result;
}
