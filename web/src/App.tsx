import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { Sidebar } from "@/components/Sidebar"
import { ProxyPage } from "@/pages/ProxyPage"
import { ListenerPage } from "@/pages/ListenerPage"
import { TunnelPage } from "@/pages/TunnelPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { DnsPage } from "@/pages/DnsPage"
import { RulesPage } from "@/pages/RulesPage"
import { LoginPage } from "@/pages/LoginPage"
import { Toaster } from "@/components/ui/toaster"
import { useDarkMode } from "@/hooks/use-dark-mode"
import { auth } from "@/lib/api"

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5000 } },
})

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!auth.isLoggedIn()) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Layout() {
  const { dark, toggle } = useDarkMode()
  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-950 overflow-hidden">
      <Sidebar dark={dark} onToggleDark={toggle} />
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/listeners" element={<ListenerPage />} />
          <Route path="/proxies"   element={<ProxyPage />} />
          <Route path="/tunnels"   element={<TunnelPage />} />
          <Route path="/rules"     element={<RulesPage />} />
          <Route path="/dns"       element={<DnsPage />} />
          <Route path="/settings"  element={<SettingsPage />} />
          <Route path="*"          element={<Navigate to="/listeners" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          } />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  )
}
