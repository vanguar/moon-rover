/** Grid indices of a chunk's border, as a closed loop: north edge eastward, east edge southward, etc. */
export function perimeter(n: number): number[] {
  const p: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let i = 0; i < n; i++) p.push(v(i, 0));
  for (let j = 0; j < n; j++) p.push(v(n, j));
  for (let i = n; i > 0; i--) p.push(v(i, n));
  for (let j = n; j > 0; j--) p.push(v(0, j));
  return p;
}
