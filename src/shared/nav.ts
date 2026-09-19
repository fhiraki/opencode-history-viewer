// やり取りナビのスクロール同期用ヘルパー（DOM 非依存の純粋関数）。
// tops: 各アンカーのコンテナ上端からの相対位置（el.getBoundingClientRect().top - container.getBoundingClientRect().top）。
// threshold: 「現在位置」とみなす上端からの許容距離 px。moveNav の着地点（12px）より大きめに取る。
export function resolveNavIndex(tops: number[], threshold: number): number {
  if (tops.length === 0) return 0;
  const limit = Number.isFinite(threshold) ? threshold : 0;
  let lo = 0;
  let hi = tops.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 先頭アンカーより上（ヘッダー領域）にいる場合は先頭を選択中にする
  return found < 0 ? 0 : found;
}
