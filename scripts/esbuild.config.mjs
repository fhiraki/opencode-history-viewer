// esbuild の共有設定（build.mjs / dev.mjs から利用）。
export const clientConfig = {
  entryPoints: ["src/client/app.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "esm",
  outdir: "public/dist",
  entryNames: "app",
  loader: { ".css": "css" },
  logLevel: "info",
};

export const serverConfig = {
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
};
