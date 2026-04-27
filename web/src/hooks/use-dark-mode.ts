import { useState, useEffect } from "react"

const KEY = "mihop-dark-mode"

export function useDarkMode() {
  const [dark, setDark] = useState<boolean>(() => {
    const saved = localStorage.getItem(KEY)
    if (saved !== null) return saved === "true"
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  })

  useEffect(() => {
    const root = document.documentElement
    if (dark) {
      root.classList.add("dark")
    } else {
      root.classList.remove("dark")
    }
    localStorage.setItem(KEY, String(dark))
  }, [dark])

  return { dark, toggle: () => setDark(d => !d) }
}
