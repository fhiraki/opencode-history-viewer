import path from "node:path";

// サーバーとテストで共有する純粋関数群（DOM・DB・FS に触らない）。
// server.ts から切り出し、test/ から直接 import して検証できるようにする。

export function parsePort(raw: string | undefined, fallback = 8083): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return Math.floor(n);
}

/** クエリ数値を有限の非負整数に正規化する（NaN・負数・Infinity を排除） */
export function clampInt(raw: string | null, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), 0), max);
}

/** ms epoch を有限の非負整数に正規化する（不正値は 0 = 無指定扱い） */
export function clampMs(raw: string | null): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** セッション/プロジェクト ID として妥当な文字だけ通す（巨大入力・制御文字を排除） */
export function isValidId(id: string): boolean {
  return id.length >= 1 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * 静的ファイルの解決。null は不正リクエスト（400）、"forbidden" は 403 を表す。
 * publicDir を引数で受け取る純粋関数にし、テスト可能にする。
 */
export function resolveStaticPath(
  pathname: string,
  publicDir: string,
): string | null | "forbidden" {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" ? "/index.html" : decoded;
  // "." 付きで publicDir 基準に解決し、外側への脱出を封じる
  const filePath = path.resolve(publicDir, `.${rel}`);
  if (
    filePath !== publicDir &&
    !filePath.startsWith(`${publicDir}${path.sep}`)
  ) {
    return "forbidden";
  }
  return filePath;
}

export function parseQuery(url: string | undefined): {
  pathname: string;
  params: URLSearchParams;
} {
  const u = new URL(url ?? "/", "http://localhost");
  return { pathname: u.pathname, params: u.searchParams };
}
