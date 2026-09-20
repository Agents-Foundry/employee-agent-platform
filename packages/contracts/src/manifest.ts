// Version 1 signing format: JSON values with ordinally sorted object keys.
// Shared by the server and employee client; array order is significant.
export function canonicalManifest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalManifest).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalManifest(object[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_MANIFEST_VALUE');
  return encoded;
}
