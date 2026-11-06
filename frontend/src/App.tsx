import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom'
import { STATIC_DEMO } from './api'
import { AuthProvider, useAuth } from './auth'
import { LiveProvider } from './live'
import { ConfirmProvider, Forbidden, Loading, ToastProvider } from './components/ui'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Devices from './pages/Devices'
import DeviceDetail from './pages/DeviceDetail'
import Sessions from './pages/Sessions'
import SessionCreate from './pages/SessionCreate'
import SessionDetail from './pages/SessionDetail'
import Live from './pages/Live'
import Results from './pages/Results'
import Contents from './pages/Contents'
import Reports from './pages/Reports'
import SettingsPage from './pages/Settings'
import UsersPage from './pages/Users'
import Logs from './pages/Logs'

function Gate() {
  const { user, loading, can } = useAuth()
  if (loading) return <Loading text="확인 중…" />
  if (!user) return <Login />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="devices" element={<Devices />} />
        <Route path="devices/:id" element={<DeviceDetail />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="sessions/new" element={can('admin', 'operator') ? <SessionCreate /> : <Forbidden />} />
        <Route path="sessions/:id" element={<SessionDetail />} />
        <Route path="live" element={<Live />} />
        <Route path="results" element={<Results />} />
        <Route path="contents" element={<Contents />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="users" element={can('admin') ? <UsersPage /> : <Forbidden />} />
        <Route path="logs" element={can('admin') ? <Logs /> : <Forbidden />} />
        <Route path="*" element={<div className="py-20 text-center text-slate-500">페이지를 찾을 수 없습니다</div>} />
      </Route>
    </Routes>
  )
}

// 정적 호스팅(GitHub Pages)은 새로고침 시 하위 경로를 찾지 못하므로 # 주소 방식 사용
const Router = STATIC_DEMO ? HashRouter : BrowserRouter

export default function App() {
  return (
    <Router>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <LiveProvider>
              <Gate />
            </LiveProvider>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </Router>
  )
}
