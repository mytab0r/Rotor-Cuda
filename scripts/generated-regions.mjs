// One registry for every generated region in a first-party CSS file.
//
// Generators write between these markers; scanners (token usage, chain identity,
// future gates) skip the same spans instead of hardcoding marker strings again.
// Add a region here once and both sides pick it up.

export const GENERATED_REGIONS = [
  {
    name: "tokens",
    start: "/* tokens:start */",
    end: "/* tokens:end */",
  },
  {
    name: "chains",
    start: "/* chains:start */",
    end: "/* chains:end */",
  },
];

export function generatedRegion(name) {
  const region = GENERATED_REGIONS.find((candidate) => candidate.name === name);
  if (!region) throw new Error(`unknown generated region: ${name}`);
  return region;
}

export const TOKENS_REGION = generatedRegion("tokens");
export const CHAINS_REGION = generatedRegion("chains");

// Return every generated span found in `text`, in file order. Offsets point at
// the original text: `start` is the opening marker, `end` the closing marker,
// so `index >= start && index < end` means "inside the generated region".
export function findGeneratedRegions(text, { file = "CSS" } = {}) {
  const regions = [];
  for (const definition of GENERATED_REGIONS) {
    let cursor = 0;
    while (true) {
      const start = text.indexOf(definition.start, cursor);
      if (start === -1) break;
      const end = text.indexOf(definition.end, start + definition.start.length);
      if (end === -1) {
        throw new Error(`unclosed ${definition.start} in ${file}`);
      }
      regions.push({
        name: definition.name,
        start,
        end,
        bodyStart: start + definition.start.length,
        bodyEnd: end,
        startMarker: definition.start,
        endMarker: definition.end,
      });
      cursor = end + definition.end.length;
    }
  }
  regions.sort((left, right) => left.start - right.start);
  return regions;
}
