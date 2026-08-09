import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function runtimeAssetManifestSource(fileNames: string[]): string | null {
  const assets = Array.from(
    new Set(
      fileNames
        .map((fileName) => `/${fileName.replaceAll("\\", "/")}`)
        .filter((fileName) => fileName.startsWith("/assets/")),
    ),
  ).sort();
  if (!assets.length) return null;

  const deploymentId = createHash("sha256")
    .update(JSON.stringify(assets))
    .digest("hex")
    .slice(0, 20);
  const manifest = {
    version: 1,
    deploymentId,
    assets,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeCompleteRuntimeAssetManifest(root: string): Promise<void> {
  const clientDirectory = resolve(root, "dist", "client");
  const assetDirectory = resolve(clientDirectory, "assets");
  if (!(await exists(assetDirectory))) return;
  const files = await readdir(assetDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const source = runtimeAssetManifestSource(
    files
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const parentPath = entry.parentPath.slice(assetDirectory.length);
        return `assets${parentPath}/${entry.name}`;
      }),
  );
  if (!source) return;
  await writeFile(
    resolve(clientDirectory, "runtime-assets.json"),
    source,
    "utf8",
  );
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_outputOptions, bundle) {
      if (this.environment.name !== "client") return;
      const source = runtimeAssetManifestSource(
        Object.values(bundle).map((entry) => entry.fileName),
      );
      if (!source) return;
      // Emitting during the client bundle makes the file part of the hosting
      // platform's served asset table. Writing it in closeBundle leaves a file
      // on disk that Vinext/Wrangler cannot serve.
      this.emitFile({
        type: "asset",
        fileName: "runtime-assets.json",
        source,
      });
    },
    async writeBundle() {
      if (this.environment.name !== "client") return;
      // Vinext copies its local fonts alongside the generated client bundle.
      // Re-read the complete output while the manifest is already a declared
      // Vite asset so those hashes are protected too.
      await writeCompleteRuntimeAssetManifest(root);
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }

      // closeBundle runs after Vinext has copied its local font assets. The
      // manifest was already declared during generateBundle, so this final
      // content refresh does not create an untracked hosting asset.
      await writeCompleteRuntimeAssetManifest(root);
    },
  };
}
