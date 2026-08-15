import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSpawner, SIGKILL_GRACE_MS } from "../../src/chat/bridge.js";

/** Poll until `check` is true or the deadline passes. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

describe("nodeSpawner kill escalation", () => {
  it("SIGKILLs a child that ignores SIGTERM, so no process leaks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-"));
    // A script that traps SIGTERM and keeps running — the exact hang the
    // timeout path must not abandon.
    const script = join(dir, "stubborn.sh");
    writeFileSync(
      script,
      "#!/bin/bash\ntrap '' TERM\nwhile true; do sleep 0.1; done\n",
    );
    chmodSync(script, 0o755);

    const turn = nodeSpawner(["bash", script], {
      cwd: dir,
      env: process.env,
    });

    let exited = false;
    void turn.exitCode.then(() => {
      exited = true;
    });

    // Give it a moment to install the trap, then kill.
    await new Promise((r) => setTimeout(r, 100));
    turn.kill();

    // SIGTERM is trapped, so it must still be alive right after kill()...
    expect(exited).toBe(false);
    // ...but the SIGKILL escalation must reap it within the grace window.
    const reaped = await until(() => exited, SIGKILL_GRACE_MS + 1_000);
    expect(reaped).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
