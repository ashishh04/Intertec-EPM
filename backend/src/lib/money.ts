/** Money to two places, the way every cost figure is reported. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
