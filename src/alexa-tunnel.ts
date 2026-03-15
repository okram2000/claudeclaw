/**
 * Alexa tunnel helper — exposes the local Alexa skill endpoint via HTTPS.
 *
 * Alexa requires a publicly accessible HTTPS endpoint with a valid certificate.
 * This helper auto-detects available tunnel tools (cloudflared, ngrok) and
 * launches one to create the tunnel, printing the URL for use in the
 * Alexa Developer Console.
 */


export type TunnelType = "cloudflared" | "ngrok" | "none";

interface TunnelResult {
  url: string;
  stop: () => void;
}

// --- cloudflared ---

async function startCloudflaredTunnel(port: number): Promise<TunnelResult> {
  console.log("[Alexa] Starting cloudflared tunnel...");

  const proc = Bun.spawn(["cloudflared", "tunnel", "--url", `http://localhost:${port}`], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // cloudflared prints the tunnel URL to stderr
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("cloudflared tunnel startup timed out (30s)"));
    }, 30_000);

    async function readStderr() {
      const reader = proc.stderr!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // cloudflared prints: "https://xxxx.trycloudflare.com"
        const match = buffer.match(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          clearTimeout(timeout);
          resolve({
            url: match[0].replace("http://", "https://"),
            stop: () => proc.kill(),
          });
          return;
        }
      }
      clearTimeout(timeout);
      reject(new Error("cloudflared exited without providing a tunnel URL"));
    }

    readStderr().catch(reject);
  });
}

// --- ngrok ---

async function startNgrokTunnel(port: number): Promise<TunnelResult> {
  console.log("[Alexa] Starting ngrok tunnel...");

  const proc = Bun.spawn(["ngrok", "http", String(port), "--log=stdout", "--log-format=json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("ngrok tunnel startup timed out (30s)"));
    }, 30_000);

    async function readStdout() {
      const reader = proc.stdout!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // ngrok JSON log has "url" field for tunnel URLs
        for (const line of buffer.split("\n")) {
          try {
            const obj = JSON.parse(line);
            if (obj.url && obj.url.startsWith("https://")) {
              clearTimeout(timeout);
              resolve({
                url: obj.url,
                stop: () => proc.kill(),
              });
              return;
            }
          } catch {
            // not JSON, skip
          }
        }
      }

      clearTimeout(timeout);
      reject(new Error("ngrok exited without providing a tunnel URL"));
    }

    readStdout().catch(reject);
  });
}

// --- Auto-detect and start tunnel ---

export async function startTunnel(
  port: number,
  preferredType: TunnelType = "none"
): Promise<TunnelResult | null> {
  // If explicitly set to none, skip
  if (preferredType === "none") {
    return tryAutoDetect(port);
  }

  if (preferredType === "cloudflared") {
    return startCloudflaredTunnel(port);
  }

  if (preferredType === "ngrok") {
    return startNgrokTunnel(port);
  }

  return null;
}

async function tryAutoDetect(port: number): Promise<TunnelResult | null> {
  const hasCloudflared = Bun.which("cloudflared");
  if (hasCloudflared) {
    try {
      return await startCloudflaredTunnel(port);
    } catch (err) {
      console.warn(`[Alexa] cloudflared failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const hasNgrok = Bun.which("ngrok");
  if (hasNgrok) {
    try {
      return await startNgrokTunnel(port);
    } catch (err) {
      console.warn(`[Alexa] ngrok failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return null;
}

export function printManualTunnelInstructions(port: number): void {
  console.log("");
  console.log("  No tunnel tool found. To expose the Alexa endpoint, choose one:");
  console.log("");
  console.log("  Option A — cloudflared (free, no account needed):");
  console.log("    brew install cloudflared");
  console.log(`    cloudflared tunnel --url http://localhost:${port}`);
  console.log("");
  console.log("  Option B — ngrok:");
  console.log("    brew install ngrok");
  console.log(`    ngrok http ${port}`);
  console.log("");
  console.log("  Option C — manual (any HTTPS proxy):");
  console.log(`    Point your HTTPS endpoint to http://localhost:${port}`);
  console.log("");
  console.log("  Then set the resulting https:// URL as the endpoint in:");
  console.log("    Alexa Developer Console → Your Skill → Build → Endpoint");
  console.log("");
}
