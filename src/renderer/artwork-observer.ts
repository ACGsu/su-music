const listeners = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

export function observeArtwork(element: Element, callback: (visible: boolean) => void): () => void {
  if (!observer) observer = new IntersectionObserver(entries => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
  }, { rootMargin: '64px', threshold: 0 })
  listeners.set(element, callback)
  observer.observe(element)
  return () => {
    observer?.unobserve(element); listeners.delete(element)
    if (!listeners.size) { observer?.disconnect(); observer = null }
  }
}
