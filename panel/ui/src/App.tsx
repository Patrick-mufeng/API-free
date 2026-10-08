import { useEffect, useState } from 'react'
import { Sidebar, type Route } from './components/Sidebar'
import { Toaster } from './components/ui'
import { OverviewPage } from './pages/Overview'
import { ServicePage } from './pages/ServicePage'
import { StatsPage } from './pages/StatsPage'
import { LogsPage } from './pages/LogsPage'
import { SettingsPage } from './pages/SettingsPage'
import { fetchServices } from './api'
import { toViews, type SvcView } from './data/services'

export default function App() {
  const [route, setRoute] = useState<Route>(() => {
    const p = new URLSearchParams(location.search).get('page')
    return p?.startsWith('svc:') ? { svc: p.slice(4) } : (p as Route) || 'overview'
  })

  useEffect(() => {
    const p = typeof route === 'string' ? route : 'svc:' + route.svc
    const url = new URL(location.href)
    url.searchParams.set('page', p)
    history.replaceState(null, '', url)
    window.scrollTo(0, 0)
  }, [route])

  // 侧栏服务列表 + 状态点：都来自监督器真状态
  const [svcs, setSvcs] = useState<SvcView[]>([])
  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const list = await fetchServices()
        if (alive) setSvcs(toViews(list))
      } catch { /* 后端未起时保持空列表 */ }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  return (
    <>
      <Sidebar route={route} services={svcs} onNav={setRoute} />
      <div className="stage">
        {route === 'overview' && <OverviewPage onOpenService={(id) => setRoute({ svc: id })} />}
        {route === 'stats' && <StatsPage />}
        {route === 'logs' && <LogsPage />}
        {route === 'settings' && <SettingsPage />}
        {typeof route !== 'string' && <ServicePage id={route.svc} />}
      </div>
      <Toaster />
    </>
  )
}
