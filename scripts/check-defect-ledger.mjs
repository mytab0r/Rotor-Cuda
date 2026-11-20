import fs from "node:fs";

const ledgerPath = "docs/process/defects.json";
const offenders = [];

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
} catch (error) {
  console.error(`defect-ledger: cannot read ${ledgerPath}: ${error.message}`);
  process.exit(1);
}

const sources = new Map();
function source(path) {
  if (!sources.has(path)) {
    try {
      sources.set(path, fs.readFileSync(path, "utf8"));
    } catch {
      sources.set(path, null);
    }
  }
  return sources.get(path);
}

for (const entry of ledger.defects || []) {
  for (const field of ["id", "reported", "symptom", "detector", "where"]) {
    if (!entry[field]) offenders.push(`${entry.id || "(unnamed)"}: missing ${field}`);
  }
  const text = entry.where ? source(entry.where) : null;
  if (text === null) {
    offenders.push(`${entry.id}: detector file ${entry.where} does not exist`);
  } else if (entry.detector && entry.detector !== "*" && !text.includes(entry.detector)) {
    offenders.push(`${entry.id}: detector "${entry.detector}" is not present in ${entry.where}`);
  }
}

if (offenders.length) {
  console.error(`defect-ledger: ${offenders.length} problem(s)`);
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`defect-ledger: ${(ledger.defects || []).length} entries, all detectors present`);
