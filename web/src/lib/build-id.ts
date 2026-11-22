/* Build identifier shown in the footer.
 *
 * The coordinator stamps ROTOR_BUILD_ID at compile time; the Astro build has
 * no binary to read, so it uses the environment override first and the short
 * git HEAD second. The value is informational: it lets a visitor name the
 * build they see. */
import { execFileSync } from 'node:child_process';

export function getBuildId(): string {
  const fromEnv = process.env.ROTOR_BUILD_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'astro';
  }
}
