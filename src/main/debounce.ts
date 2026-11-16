export type Debounced<Args extends unknown[]> = ((
  ...args: Args
) => void) & { cancel: () => void }

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait: number
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null

  const debounced = ((...args: Args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }) as Debounced<Args>

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return debounced
}